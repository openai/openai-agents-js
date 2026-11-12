import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  OutputValidationError,
  type Observation,
} from '../../src';
import { binding, type NativeThread } from '../../src/runtime/binding';
import {
  firstNativeBatchWire,
  replaceSingletonNativeBatchEvent,
} from '../fixtures/native-event-batches';
import { ModelServer, message } from './fixtures/model-server';

afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-output-acceptance',
    supportsWebsockets: false,
  });
}

async function collect(events: AsyncIterable<Observation>) {
  const result: Observation[] = [];
  for await (const event of events) result.push(event);
  return result;
}

it('publishes metadata once for event-only consumption and multiple typed waiters', async () => {
  const server = new ModelServer([[message('{"count":2}')]]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Count.',
    provider,
  }).session({ includeOutputAccepted: true });
  const turn = await session.submit('go', {
    outputType: {
      mode: 'prompted',
      schema: z
        .object({ count: z.number() })
        .transform(({ count }) => new Set([count])),
    },
  });
  const events = await collect(turn.events());
  const accepted = events.filter((event) => event.type === 'output_accepted');
  expect(accepted).toEqual([
    {
      type: 'output_accepted',
      sessionId: session.id,
      submissionId: turn.submissionId,
      turnId: turn.turnId,
      sequence: expect.any(Number),
    },
  ]);
  expect(
    events.findIndex((event) => event.type === 'turn_finished'),
  ).toBeLessThan(events.findIndex((event) => event.type === 'output_accepted'));
  const results = await Promise.all([turn.wait(), turn.wait()]);
  expect(results[0]).toBe(results[1]);
  expect(results[0].finalOutput).toEqual(new Set([2]));
  expect(
    (await collect(turn.events())).filter(
      (event) => event.type === 'output_accepted',
    ),
  ).toEqual(accepted);
  server.assertExhausted();
});

it.each(['continue', 'repair'] as const)(
  'accepts only the final %s result',
  async (mode) => {
    const server = new ModelServer([
      [message(mode === 'repair' ? 'invalid' : 'private draft')],
      [message(mode === 'repair' ? '{"count":2}' : 'accepted')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Answer.',
      provider,
      ...(mode === 'continue'
        ? {
            beforeComplete: (context: { text?: string | null }) =>
              context.text === 'private draft'
                ? { action: 'continue' as const, instructions: 'Revise.' }
                : undefined,
          }
        : {}),
    }).session({ includeOutputAccepted: true });
    const turn =
      mode === 'repair'
        ? await session.submit('go', {
            outputType: {
              mode: 'prompted',
              schema: z.object({ count: z.number() }),
              maxRetries: 1,
            },
          })
        : await session.submit('go');
    const events = await collect(turn.events());
    const accepted = events.filter((event) => event.type === 'output_accepted');
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({
      sessionId: session.id,
      submissionId: turn.submissionId,
    });
    expect(JSON.stringify(accepted)).not.toContain('private draft');
    const result = await turn.wait();
    expect(result.finalOutput).toEqual(
      mode === 'repair' ? { count: 2 } : 'accepted',
    );
    expect(server.requests).toHaveLength(2);
    server.assertExhausted();
  },
);

it.each(['reject', 'cancel'] as const)(
  'omits acceptance after %s',
  async (mode) => {
    const entered = Promise.withResolvers<void>();
    const server = new ModelServer([[message('private rejected candidate')]]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Answer.',
      provider,
      beforeComplete: async (context) => {
        if (mode === 'reject') return { action: 'stop' as const };
        entered.resolve();
        await new Promise<void>((resolve) => {
          if (context.signal.aborted) resolve();
          else
            context.signal.addEventListener('abort', () => resolve(), {
              once: true,
            });
        });
      },
    }).session({ includeOutputAccepted: true });
    const turn = await session.submit('go');
    const observations = collect(turn.events());
    if (mode === 'cancel') {
      await entered.promise;
      await turn.cancel();
    }
    expect(
      (await observations).filter((event) => event.type === 'output_accepted'),
    ).toEqual([]);
    await expect(turn.wait()).rejects.toThrow();
    server.assertExhausted();
  },
);

it('keeps the default stream free of acceptance notifications', async () => {
  const server = new ModelServer([[message('answer')]]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Answer.',
    provider,
  }).session();
  const turn = await session.submit('go');
  expect(
    (await collect(turn.events())).some(
      (event) => event.type === 'output_accepted',
    ),
  ).toBe(false);
  expect((await turn.wait()).finalOutput).toBe('answer');
  expect(
    (await collect(turn.events())).some(
      (event) => event.type === 'output_accepted',
    ),
  ).toBe(false);
  server.assertExhausted();
});

it('publishes to a Session-only reader without a result waiter', async () => {
  const server = new ModelServer([[message('private answer')]]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Answer.',
    provider,
  }).session({ includeOutputAccepted: true });
  const stream = session.events();
  const turn = await session.submit('go');
  for await (const event of stream) {
    if (event.type !== 'output_accepted') continue;
    expect(event).toMatchObject({
      sessionId: session.id,
      submissionId: turn.submissionId,
      turnId: turn.turnId,
    });
    expect(JSON.stringify(event)).not.toContain('private answer');
    break;
  }
  server.assertExhausted();
});

it('omits acceptance after typed output validation fails', async () => {
  const server = new ModelServer([
    [message('{"count":"private invalid value"}')],
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Count.',
    provider,
  }).session({ includeOutputAccepted: true });
  const turn = await session.submit('go', {
    outputType: { mode: 'prompted', schema: z.object({ count: z.number() }) },
  });
  const events = await collect(turn.events());
  expect(events.filter((event) => event.type === 'output_accepted')).toEqual(
    [],
  );
  await expect(turn.wait()).rejects.toBeInstanceOf(OutputValidationError);
  server.assertExhausted();
});

it('uses final native turn identity with the original logical submission', async () => {
  const native = await binding();
  const next = native.NativeThread.prototype._next_session_events;
  const submit = native.NativeThread.prototype._submit;
  let projected = false;
  // Existing controlled tail projection: native turns and results remain real.
  vi.spyOn(
    native.NativeThread.prototype,
    '_next_session_events',
  ).mockImplementation(async function (this: NativeThread) {
    const raw = await next.call(this);
    const event = JSON.parse(firstNativeBatchWire(raw));
    if (
      !projected &&
      event &&
      !event.subagent_id &&
      ['task_complete', 'turn_complete'].includes(event.msg.type)
    ) {
      projected = true;
      event.sdk_unsampled_steering = true;
      return replaceSingletonNativeBatchEvent(raw, event);
    }
    return raw;
  });
  vi.spyOn(native.NativeThread.prototype, '_submit').mockImplementation(
    async function (this: NativeThread, raw) {
      const request = JSON.parse(raw);
      if (request.mode !== 'continue_if_idle') return submit.call(this, raw);
      return submit.call(
        this,
        JSON.stringify({
          mode: 'start_if_idle',
          input: [{ type: 'text', text: 'synthetic continuation' }],
          start: request.start,
        }),
      );
    },
  );
  const server = new ModelServer([
    [message('initial')],
    [message('final successor')],
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Answer.',
    provider,
  }).session({ includeOutputAccepted: true });
  const turn = await session.submit('go');
  const events = await collect(turn.events());
  const started = events.filter((event) => event.type === 'turn_started');
  const accepted = events.filter((event) => event.type === 'output_accepted');
  expect(started).toHaveLength(2);
  expect(accepted).toHaveLength(1);
  expect(accepted[0]).toMatchObject({
    submissionId: turn.submissionId,
    turnId: started[1].turnId,
  });
  expect(accepted[0].turnId).not.toBe(turn.turnId);
  expect((await turn.wait()).finalOutput).toBe('final successor');
  server.assertExhausted();
});
