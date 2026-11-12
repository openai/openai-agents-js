import {
  firstNativeBatchWire,
  replaceSingletonNativeBatchEvent,
} from '../fixtures/native-event-batches';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  OutputValidationError,
  TurnNotSubmitted,
  tool,
} from '../../src';
import { binding, type NativeThread } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-lifecycle-admission',
    supportsWebsockets: false,
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});

it.each(['graph', 'graph-with-before-step', 'no-graph'] as const)(
  'prepares a direct request with %s',
  async (mode) => {
    const server = new ModelServer([[message('done')]]);
    await using provider = await providerFor(server);
    const target = new Agent({
      name: 'B',
      instructions: 'Answer.',
      model: 'gpt-5.5',
      provider,
    });
    await using session = await new Agent({
      instructions: 'Answer.',
      model: 'gpt-5.5',
      provider,
      handoffs: mode === 'no-graph' ? [] : [target],
    }).session();
    const prepareRequest = vi.fn(() => undefined);
    const beforeStep = vi.fn(() => undefined);
    const turn = await session.submit('go', {
      prepareRequest,
      ...(mode === 'graph-with-before-step' ? { beforeStep } : {}),
    });
    expect((await turn.wait()).finalOutput).toBe('done');
    expect(prepareRequest).toHaveBeenCalledTimes(1);
    if (mode === 'graph-with-before-step')
      expect(beforeStep).toHaveBeenCalledTimes(1);
    expect(server.requests).toHaveLength(1);
    server.assertExhausted();
  },
);

it('settles both handles when a queued request becomes invalid after handoff', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const hold = tool({
    name: 'hold',
    parameters: z.object({}),
    async execute() {
      entered.resolve();
      await release.promise;
      return 'held';
    },
  });
  const server = new ModelServer([
    [call('hold', {}, { callId: 'hold' })],
    [call('transfer_to_b', {}, { callId: 'handoff' })],
    [message('{"label":"first"}')],
    [message('{"label":"fresh"}')],
  ]);
  await using provider = await providerFor(server);
  const schema = z.object({ label: z.string() });
  const target = new Agent({
    name: 'B',
    instructions: 'Answer.',
    model: 'gpt-5.5',
    provider,
    outputType: { mode: 'prompted', schema, maxRetries: 1 },
  });
  await using session = await new Agent({
    name: 'A',
    instructions: 'Transfer to B.',
    model: 'gpt-5.5',
    provider,
    tools: [hold],
    handoffs: [target],
    outputType: { mode: 'prompted', schema, maxRetries: 0 },
  }).session();
  try {
    const first = await session.submit('first');
    await entered.promise;
    const prepareRequest = vi.fn(() => undefined);
    const queued = await session.enqueue('queued', { prepareRequest });
    expect(queued.turnId).toBeNull();
    const rejected = queued.wait().catch((error: unknown) => error);
    release.resolve();
    expect((await first.wait()).finalOutput).toEqual({ label: 'first' });
    expect(await rejected).toBeInstanceOf(TypeError);
    expect(await rejected).toHaveProperty(
      'message',
      'prepareRequest does not support output correction attempts; use native output or prompted maxRetries: 0',
    );
    expect(prepareRequest).not.toHaveBeenCalled();
    expect(await session.getActiveAgent()).toBe(target);
    expect((await (await session.submit('fresh')).wait()).finalOutput).toEqual({
      label: 'fresh',
    });
    server.assertExhausted();
  } finally {
    release.resolve();
  }
});

it.each([
  {
    predecessor: 'invalid',
    successor: '{"label":"continued"}',
    maxRetries: 0,
    refused: false,
  },
  {
    predecessor: 'invalid',
    successor: '{"label":"continued"}',
    maxRetries: 1,
    refused: false,
  },
  {
    predecessor: 'invalid',
    successor: 'invalid successor',
    maxRetries: 0,
    refused: false,
  },
  {
    predecessor: 'invalid',
    successor: 'invalid successor',
    maxRetries: 1,
    refused: false,
  },
  {
    predecessor: '{"label":"predecessor"}',
    successor: '',
    maxRetries: 1,
    refused: true,
  },
  { predecessor: 'invalid', successor: '', maxRetries: 1, refused: true },
])(
  'validates the owned continuation or typed fallback: %j',
  async ({ predecessor, successor, maxRetries, refused }) => {
    const native = await binding();
    const nextEvent = native.NativeThread.prototype._next_session_events;
    const submit = native.NativeThread.prototype._submit;
    let originalId: string | undefined;
    let continuations = 0;
    // Project Core's terminal-to-idle boundary, as in turn-controls.test.ts.
    // Model requests and output validation still use the real native runtime.
    vi.spyOn(
      native.NativeThread.prototype,
      '_next_session_events',
    ).mockImplementation(async function (this: NativeThread) {
      const raw = await nextEvent.call(this);
      const event = JSON.parse(firstNativeBatchWire(raw));
      if (
        !originalId &&
        !event.subagent_id &&
        ['task_complete', 'turn_complete'].includes(event.msg.type)
      ) {
        originalId = event.id;
        event.sdk_unsampled_steering = true;
        return replaceSingletonNativeBatchEvent(raw, event);
      }
      return raw;
    });
    vi.spyOn(native.NativeThread.prototype, '_submit').mockImplementation(
      async function (this: NativeThread, raw) {
        const request = JSON.parse(raw);
        if (request.mode !== 'continue_if_idle') return submit.call(this, raw);
        continuations++;
        expect(request.expected_previous_turn_id).toBe(originalId);
        expect(request.input).toEqual([]);
        if (refused) throw new TurnNotSubmitted({ type: 'superseded' });
        return submit.call(
          this,
          JSON.stringify({
            mode: 'start_if_idle',
            input: [{ type: 'text', text: 'projected continuation admission' }],
          }),
        );
      },
    );
    const repair =
      !refused && successor === 'invalid successor' && maxRetries > 0;
    const server = new ModelServer([
      [message(predecessor)],
      ...(refused ? [] : [[message(successor)]]),
      ...(repair ? [[message('{"label":"repaired successor"}')]] : []),
      [message('{"label":"later"}')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Answer.',
      model: 'gpt-5.5',
      provider,
      outputType: {
        mode: 'prompted',
        schema: z.object({ label: z.string() }),
        maxRetries,
      },
    }).session({ includeRequestAttempts: true });
    const turn = await session.submit('first');
    if (
      (refused && predecessor === 'invalid') ||
      (!refused && successor === 'invalid successor' && !repair)
    ) {
      const error = await turn.wait().catch((error: unknown) => error);
      expect(error).toBeInstanceOf(OutputValidationError);
      expect((error as OutputValidationError).rawOutput).toBe(
        refused ? predecessor : successor,
      );
    } else {
      const result = await turn.wait();
      expect(result.finalOutput).toEqual({
        label: refused
          ? 'predecessor'
          : repair
            ? 'repaired successor'
            : 'continued',
      });
      expect(result.repairAttempts).toHaveLength(repair ? 1 : 0);
    }
    expect(continuations).toBe(1);
    expect(turn.requestAttempts?.counts[0]?.count).toBe(1);
    expect(turn.submissionRequestAttempts?.counts[0]?.count).toBe(
      refused ? 1 : repair ? 3 : 2,
    );
    expect((await (await session.submit('later')).wait()).finalOutput).toEqual({
      label: 'later',
    });
    expect(server.requests).toHaveLength(
      2 + (refused ? 0 : 1) + (repair ? 1 : 0),
    );
    server.assertExhausted();
  },
);
