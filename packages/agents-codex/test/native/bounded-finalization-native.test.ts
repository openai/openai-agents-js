import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  ToolTimeoutError,
  TurnAborted,
  ToolOutput,
  tool,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';
afterEach(() => ModelServer.closeAll());
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic',
    supportsWebsockets: false,
  });
}
it.each([
  ['error_as_result', 'return'],
  ['error_as_result', 'reject'],
  ['raise_exception', 'return'],
  ['raise_exception', 'reject'],
] as const)(
  'settles %s at deadline while owning late %s cleanup',
  async (timeoutBehavior, outcome) => {
    const stopped = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const effects: string[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    const after = vi.fn((output: ToolOutput) => output);
    let validated = false;
    let expectedError: unknown;
    const server = new ModelServer([
      [call('held', {}, { callId: 'held' })],
      [message('recovered')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Use held.',
      provider,
      tools: [
        tool({
          name: 'held',
          parameters: z.object({}),
          callbackTimeout: 0.01,
          timeoutBehavior,
          timeoutSettlement: 'at_deadline',
          result: z.string().transform((value) => {
            validated = true;
            return value;
          }),
          after,
          async execute(_input, context) {
            effects.push('entered');
            context.signal.addEventListener(
              'abort',
              () => {
                expectedError = context.signal.reason;
                stopped.resolve();
              },
              { once: true },
            );
            await release.promise;
            effects.push('late effect');
            if (outcome === 'reject') throw new Error('late body rejection');
            return 'private late value';
          },
        }),
      ],
    }).session();
    process.on('unhandledRejection', onUnhandled);
    const turn = await session.submit('read');
    let settled = false;
    const result = turn.wait().then(
      (value) => {
        settled = true;
        return { value };
      },
      (error: unknown) => {
        settled = true;
        return { error };
      },
    );
    let close: Promise<void> | undefined;
    let closed = false;
    try {
      await stopped.promise;
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 1500 });
      const value = await result;
      if (timeoutBehavior === 'raise_exception') {
        expect('error' in value && value.error).toBe(expectedError);
        expect(expectedError).toBeInstanceOf(ToolTimeoutError);
      } else
        expect('value' in value && value.value.finalOutput).toBe('recovered');
      expect(effects).toEqual(['entered']);
      close = session.close().then(() => {
        closed = true;
      });
      await sleep(30);
      expect(closed).toBe(false);
    } finally {
      release.resolve();
      await result;
      await close;
      await sleep(0);
      process.removeListener('unhandledRejection', onUnhandled);
    }
    expect(effects).toEqual(['entered', 'late effect']);
    expect(validated).toBe(false);
    expect(after).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
    const again = await turn.wait().then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    if (timeoutBehavior === 'raise_exception')
      expect('error' in again && again.error).toBe(expectedError);
    else expect('value' in again && again.value.finalOutput).toBe('recovered');
  },
  15000,
);

it('keeps cancellation joining an early soft timeout beside a fatal sibling', async () => {
  const softStopped = Promise.withResolvers<void>();
  const fatalStopped = Promise.withResolvers<void>();
  const softRelease = Promise.withResolvers<void>();
  const fatalRelease = Promise.withResolvers<void>();
  const effects: string[] = [];
  const server = new ModelServer([
    [
      call('soft', {}, { callId: 'soft' }),
      call('fatal', {}, { callId: 'fatal' }),
    ],
  ]);
  await using provider = await providerFor(server);
  const build = (name: 'soft' | 'fatal') =>
    tool({
      name,
      parameters: z.object({}),
      callbackTimeout: name === 'soft' ? 0.01 : 0.05,
      timeoutBehavior: name === 'soft' ? 'error_as_result' : 'raise_exception',
      timeoutSettlement: 'at_deadline',
      async execute(_input, context) {
        context.signal.addEventListener(
          'abort',
          () => (name === 'soft' ? softStopped : fatalStopped).resolve(),
          { once: true },
        );
        await (name === 'soft' ? softRelease : fatalRelease).promise;
        effects.push(name);
        if (name === 'soft') throw new Error('late soft rejection');
        return 'late fatal success';
      },
    });
  await using session = await new Agent({
    instructions: 'Use both.',
    provider,
    tools: [build('soft'), build('fatal')],
  }).session();
  const turn = await session.submit('read');
  const result = turn.wait().catch((error: unknown) => error);
  let cancelled = false;
  let cancel: Promise<void> | undefined;
  try {
    await Promise.all([softStopped.promise, fatalStopped.promise]);
    const error = await result;
    expect(error).toBeInstanceOf(ToolTimeoutError);
    expect(error).toMatchObject({ toolName: 'fatal' });
    cancel = turn.cancel().then(() => {
      cancelled = true;
    });
    fatalRelease.resolve();
    await sleep(30);
    expect(cancelled).toBe(false);
    expect(effects).toEqual(['fatal']);
  } finally {
    softRelease.resolve();
    fatalRelease.resolve();
    await cancel;
    await result;
  }
  expect(effects).toEqual(['fatal', 'soft']);
  expect(server.requests).toHaveLength(1);
}, 15000);

it('keeps cancellation before the deadline authoritative without late success', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const after = vi.fn((output: ToolOutput) => output);
  const server = new ModelServer([[call('held', {}, { callId: 'cancelled' })]]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Use held.',
    provider,
    tools: [
      tool({
        name: 'held',
        parameters: z.object({}),
        callbackTimeout: 1,
        timeoutSettlement: 'at_deadline',
        after,
        async execute() {
          entered.resolve();
          await release.promise;
          return 'late success';
        },
      }),
    ],
  }).session();
  const turn = await session.submit('read');
  const result = turn.wait().catch((error: unknown) => error);
  await entered.promise;
  let cancelled = false;
  const cancel = turn.cancel().then(() => {
    cancelled = true;
  });
  try {
    await sleep(30);
    expect(cancelled).toBe(false);
  } finally {
    release.resolve();
    await cancel;
  }
  expect(await result).toBeInstanceOf(TurnAborted);
  expect(after).not.toHaveBeenCalled();
  expect(server.requests).toHaveLength(1);
}, 15000);

it('keeps the concurrency permit until a timed-out callback physically settles', async () => {
  const firstEntered = Promise.withResolvers<number>();
  const timeoutObserved = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  const effects: string[] = [];
  const server = new ModelServer([
    [
      call('record', { sequence: 1 }, { callId: 'first' }),
      call('record', { sequence: 2 }, { callId: 'second' }),
    ],
    [message('done')],
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Run both calls.',
    provider,
    tools: [
      tool({
        name: 'record',
        parameters: z.object({ sequence: z.number() }),
        callbackTimeout: 0.03,
        timeoutBehavior: 'error_as_result',
        timeoutSettlement: 'at_deadline',
        async execute({ sequence }, context) {
          effects.push('start ' + sequence);
          if (effects.length === 1) {
            context.signal.addEventListener(
              'abort',
              () => timeoutObserved.resolve(),
              {
                once: true,
              },
            );
            firstEntered.resolve(sequence);
            await releaseFirst.promise;
          }
          effects.push('end ' + sequence);
          return 'recorded ' + sequence;
        },
      }),
    ],
  }).session({ maxFunctionConcurrency: 1 });
  const turn = await session.submit('Run first, then second.');
  const result = turn.wait();
  let first: number;
  try {
    first = await firstEntered.promise;
    await timeoutObserved.promise;
    await sleep(100);
    expect(effects).toEqual(['start ' + first]);
  } finally {
    releaseFirst.resolve();
    await result.catch(() => {});
  }
  expect((await result).finalOutput).toBe('done');
  const second = first === 1 ? 2 : 1;
  expect(effects).toEqual([
    'start ' + first,
    'end ' + first,
    'start ' + second,
    'end ' + second,
  ]);
});
