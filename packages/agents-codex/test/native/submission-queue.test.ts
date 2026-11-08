import {
  firstNativeBatchWire,
  replaceSingletonNativeBatchEvent,
} from '../fixtures/native-event-batches';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  manualTool,
  tool,
  type ActionRequested,
  type OutputSpec,
  type Turn,
} from '../../src';
import { binding, type NativeThread } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-queue',
    supportsWebsockets: false,
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});

describe('FIFO root enqueue', () => {
  it('rejects defined busy policies before registration and treats undefined as omission', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const server = new ModelServer([
      [call('hold', {}, { callId: 'hold' })],
      [message('first')],
      [message('undefined policy')],
      [message('omitted policy')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Use hold.',
      provider,
      tools: [
        tool({
          name: 'hold',
          parameters: z.object({}),
          async execute() {
            entered.resolve();
            await release.promise;
            return 'released';
          },
        }),
      ],
    }).session();
    const policy = { ifBusy: 'reject' as const, tools: [] };
    function typeCheck() {
      // @ts-expect-error enqueue always queues; submit owns busy rejection.
      void session.enqueue('not registered', { ifBusy: 'reject' });
    }
    void typeCheck;
    try {
      await expect(session.enqueue('idle refusal', policy)).rejects.toThrow(
        'enqueue queues work; use submit',
      );
      expect(server.requests).toHaveLength(0);
      const first = await session.submit('first');
      await entered.promise;
      await expect(session.enqueue('busy refusal', policy)).rejects.toThrow(
        'enqueue queues work; use submit',
      );
      const undefinedPolicy = { ifBusy: undefined, tools: [] };
      const second = await session.enqueue('second', undefinedPolicy);
      const third = await session.enqueue('third');
      expect(server.requests).toHaveLength(1);
      release.resolve();
      expect((await first.wait()).finalOutput).toBe('first');
      expect((await second.wait()).finalOutput).toBe('undefined policy');
      expect((await third.wait()).finalOutput).toBe('omitted policy');
      server.assertExhausted();
    } finally {
      release.resolve();
    }
  });

  it('acknowledges before admission, captures input/output, and progresses without result readers', async () => {
    const native = await binding();
    const submit = native.NativeThread.prototype._submit;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const modes: string[] = [];
    vi.spyOn(native.NativeThread.prototype, '_submit').mockImplementation(
      async function (this: NativeThread, raw) {
        modes.push(JSON.parse(raw).mode);
        if (modes.length === 1) {
          entered.resolve();
          await release.promise;
        }
        return submit.call(this, raw);
      },
    );
    const server = new ModelServer([
      [message('A')],
      [message('{"response":7}')],
      [message('C')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
    }).session();
    try {
      const a = await session.enqueue('A');
      await entered.promise;
      const input = {
        role: 'user' as const,
        content: [{ type: 'input_text' as const, text: 'B frozen' }],
      };
      const output = { mode: 'native' as const, schema: z.number() };
      const b = await session.enqueue(input, { outputType: output });
      const c = await session.enqueue('C');
      expectTypeOf(a).toEqualTypeOf<Turn<string, string | null>>();
      expectTypeOf(b).toEqualTypeOf<Turn<number, string | null>>();
      input.content[0].text = 'tampered';
      output.mode = 'native';
      output.schema = z.number().min(99);
      expect([a.turnId, b.turnId, c.turnId]).toEqual([null, null, null]);
      expect(
        new Set([a.submissionId, b.submissionId, c.submissionId]).size,
      ).toBe(3);
      expect(server.requests).toHaveLength(0);
      await expect(b.steer('not steering')).rejects.toThrow('no longer active');
      const chosen = { ifBusy: 'queue' as const };
      // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- Preserve the no-cast structural-erasure regression.
      const erased: {} = chosen;
      const rejected: Promise<Turn<string>> = session.submit(
        'not another root',
        erased,
      );
      await expect(rejected).rejects.toThrow('submit rejects busy work');
      await expect(
        session.update({ instructions: 'changed' }),
      ).rejects.toThrow();
      await expect(session.compact()).rejects.toThrow();
      await expect(session.saveState()).rejects.toThrow();
      release.resolve();
      // C alone drives no work: the Session must independently release A and B.
      expect((await c.wait()).finalOutput).toBe('C');
      const br = await b.wait();
      expect(br.finalOutput).toBe(7);
      expect(br.turn).toBe(b);
      expect(await b.wait()).toBe(br);
      expect((await a.wait()).turn).toBe(a);
      expect(
        [a.turnId, b.turnId, c.turnId].every((id) => typeof id === 'string'),
      ).toBe(true);
      expect(modes).toEqual([
        'start_if_idle',
        'start_if_idle',
        'start_if_idle',
      ]);
      expect(JSON.stringify(server.requests[1].input)).toContain('B frozen');
      expect(JSON.stringify(server.requests)).not.toContain('tampered');
      expect(server.requests[1]).toHaveProperty(
        'text.format.schema.properties.response',
      );
      expect(server.requests[2]).not.toHaveProperty('text.format');
      await a.cancel();
      await expect(a.steer('stale')).rejects.toThrow('no longer active');
      server.assertExhausted();
    } finally {
      release.resolve();
    }
  });

  it('withdraws a middle entry without a native request or fabricated terminal', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const server = new ModelServer([
      async () => {
        entered.resolve();
        await release.promise;
        return [message('A')];
      },
      [message('C')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
    }).session();
    try {
      const a = await session.submit('A');
      await entered.promise;
      const b = await session.enqueue('B');
      const c = await session.enqueue('C');
      const result = b.wait();
      const failure = expect(result).rejects.toThrow(
        'cancelled before admission',
      );
      await b.cancel();
      await b.cancel();
      await failure;
      expect(b.turnId).toBeNull();
      release.resolve();
      expect((await c.wait()).finalOutput).toBe('C');
      expect((await a.wait()).finalOutput).toBe('A');
      await session.close();
      const events = [];
      for await (const event of session.events()) events.push(event);
      expect(
        events.filter(
          (event) =>
            'submissionId' in event && event.submissionId === b.submissionId,
        ),
      ).toEqual([]);
      expect(JSON.stringify(server.requests)).not.toContain('"text":"B"');
      server.assertExhausted();
    } finally {
      release.resolve();
    }
  });

  it.each([
    ['before', 'cancel'],
    ['after', 'cancel'],
    ['before', 'close'],
    ['after', 'close'],
  ] as const)(
    '%s native acceptance: %s retires unknown admission',
    async (when, end) => {
      const native = await binding();
      const submit = native.NativeThread.prototype._submit;
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const receiptReturned = Promise.withResolvers<void>();
      let calls = 0;
      vi.spyOn(native.NativeThread.prototype, '_submit').mockImplementation(
        async function (this: NativeThread, raw) {
          calls++;
          if (when === 'before') {
            entered.resolve();
            await release.promise;
          }
          try {
            const value = await submit.call(this, raw);
            if (when === 'after') {
              entered.resolve();
              await release.promise;
            }
            return value;
          } finally {
            receiptReturned.resolve();
          }
        },
      );
      const server = new ModelServer([[message('possibly admitted A')]]);
      await using provider = await providerFor(server);
      await using session = await new Agent({
        instructions: 'Answer.',
        model: 'gpt-5',
        provider,
      }).session();
      try {
        const a = await session.enqueue('A');
        await entered.promise;
        const b = await session.enqueue('B');
        const ar = expect(a.wait()).rejects.toThrow();
        const br = expect(b.wait()).rejects.toThrow();
        // Must join without opening the receipt gate; timeout is a hang detector.
        await (end === 'cancel' ? a.cancel() : session.close());
        await Promise.all([ar, br]);
        await expect(session.enqueue('late')).rejects.toThrow();
        expect([a.turnId, b.turnId]).toEqual([null, null]);
        expect(calls).toBe(1);
        release.resolve();
        await receiptReturned.promise;
        expect([a.turnId, b.turnId]).toEqual([null, null]);
        expect(JSON.stringify(server.requests)).not.toContain('"text":"B"');
      } finally {
        release.resolve();
      }
    },
  );

  it.each(['root', 'all'] as const)(
    'interrupt validates then discards pending entries for %s scope',
    async (scope) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const server = new ModelServer([
        async () => {
          entered.resolve();
          await release.promise;
          return [message('A')];
        },
        [message('survivor')],
      ]);
      await using provider = await providerFor(server);
      await using session = await new Agent({
        instructions: 'Answer.',
        model: 'gpt-5',
        provider,
      }).session();
      try {
        const a = await session.submit('A');
        await entered.promise;
        const ar = a.wait().catch((error: unknown) => error);
        const b = await session.enqueue('B');
        const chosen = { mode: 'invalid' };
        await expect(
          session.interrupt(chosen as { mode: 'force' }),
        ).rejects.toThrow();
        expect(b.turnId).toBeNull();
        const br = expect(b.wait()).rejects.toThrow('Session interruption');
        await session.interrupt({ scope });
        await br;
        release.resolve();
        await ar;
        // Join the same owned stop before submitting fresh work.
        await a.cancel();
        expect(
          (await (await session.submit('survivor')).wait()).finalOutput,
        ).toBe('survivor');
        server.assertExhausted();
      } finally {
        release.resolve();
      }
    },
  );

  it('joins callback cleanup before FIFO promotion and rejects same-Session callback waits', async () => {
    const entered = Promise.withResolvers<void>();
    const inspect = Promise.withResolvers<void>();
    const checked = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let queued: Turn<string, string | null>;
    const hold = tool({
      name: 'hold',
      parameters: z.object({}),
      async execute(_args, context) {
        entered.resolve();
        await inspect.promise;
        expect(() => queued.wait()).toThrow();
        await expect(session.enqueue('callback reentry')).rejects.toThrow();
        checked.resolve();
        await new Promise<void>((resolve) =>
          context.signal.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        );
        cleanup.resolve();
        await release.promise;
        return 'joined';
      },
    });
    const server = new ModelServer([
      [call('hold', {}, { callId: 'held' })],
      [message('B')],
      [message('C')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Act.',
      model: 'gpt-5',
      provider,
      tools: [hold],
    }).session();
    try {
      const a = await session.submit('A');
      await entered.promise;
      queued = await session.enqueue('B');
      const c = await session.enqueue('C');
      const ar = a.wait().catch((error: unknown) => error);
      inspect.resolve();
      await checked.promise;
      let cancelled = false;
      const stopping = a.cancel().then(() => {
        cancelled = true;
      });
      await cleanup.promise;
      expect(cancelled).toBe(false);
      expect(queued.turnId).toBeNull();
      expect(c.turnId).toBeNull();
      expect(server.requests).toHaveLength(1);
      release.resolve();
      await stopping;
      expect(await ar).toBeInstanceOf(Error);
      expect((await c.wait()).finalOutput).toBe('C');
      expect((await queued.wait()).finalOutput).toBe('B');
      await a.cancel();
      server.assertExhausted();
    } finally {
      inspect.resolve();
      release.resolve();
    }
  });

  it('keeps active manual grants and output overrides ahead of queued work', async () => {
    const lookup = manualTool({
      name: 'lookup',
      description: 'Read.',
      parameters: z.object({}),
      result: z.string(),
    });
    const server = new ModelServer([
      [call('lookup', {}, { callId: 'manual-A' })],
      [message('A')],
      [message('{"response":8}')],
      [message('C')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Act.',
      model: 'gpt-5',
      provider,
      tools: [lookup],
    }).session();
    const a = await session.submit('A');
    let request: ActionRequested | undefined;
    for await (const event of session.events())
      if (event.type === 'action_requested') {
        request = event;
        break;
      }
    expect(request).toBeDefined();
    const b = await session.enqueue('B', { outputType: z.number() });
    const c = await session.enqueue('C');
    await expect(session.suspend()).rejects.toThrow('queued');
    const defaultResult = session.wait();
    await session.respond(request!.reply('answer'));
    expect((await defaultResult).turn).toBe(a);
    expect((await c.wait()).finalOutput).toBe('C');
    expect((await b.wait()).finalOutput).toBe(8);
    server.assertExhausted();
  });

  it('continues after an output parse failure but closes all unpromoted work', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const server = new ModelServer([
      [message('invalid JSON')],
      async () => {
        entered.resolve();
        await release.promise;
        return [message('B')];
      },
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
    }).session();
    try {
      const a = await session.enqueue('A', {
        outputType: {
          mode: 'prompted',
          schema: z.number(),
        },
      });
      const ar = expect(a.wait()).rejects.toThrow('output type');
      const b = await session.enqueue('B');
      const c = await session.enqueue('C');
      await entered.promise;
      await ar;
      const br = expect(b.wait()).rejects.toThrow();
      const cr = expect(c.wait()).rejects.toThrow('Session closed');
      await session.close();
      await Promise.all([br, cr]);
      expect(c.turnId).toBeNull();
      release.resolve();
      expect(server.requests).toHaveLength(2);
    } finally {
      release.resolve();
    }
  });
  it('does not retry a known native admission refusal and preserves the next root', async () => {
    const native = await binding();
    const submit = native.NativeThread.prototype._submit;
    let calls = 0;
    vi.spyOn(native.NativeThread.prototype, '_submit').mockImplementation(
      async function (this: NativeThread, raw) {
        if (++calls === 1) {
          // Ask the real native guard to reject this dispatch before any input effect.
          return submit.call(
            this,
            JSON.stringify({
              mode: 'start_if_idle',
              input: [{ type: 'text', text: 'not admitted' }],
              expected_turn_id: 'synthetic-invalid-for-start',
            }),
          );
        }
        return submit.call(this, raw);
      },
    );
    const server = new ModelServer([[message('B')]]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
    }).session();
    const a = await session.enqueue('rejected at the held native boundary');
    const ar = expect(a.wait()).rejects.toThrow('expected turn IDs');
    const b = await session.enqueue('B');
    await ar;
    expect(a.turnId).toBeNull();
    expect((await b.wait()).finalOutput).toBe('B');
    expect(calls).toBe(2);
    server.assertExhausted();
  });

  it('keeps successful entered callback acknowledgment ahead of the next root', async () => {
    const native = await binding();
    const respond = native.NativeThread.prototype._respond_python_tool;
    const next = native.NativeThread.prototype._next_session_events;
    const entered = Promise.withResolvers<void>();
    const terminal = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    vi.spyOn(
      native.NativeThread.prototype,
      '_respond_python_tool',
    ).mockImplementation(async function (this: NativeThread, raw) {
      const value = await respond.call(this, raw);
      entered.resolve();
      await release.promise;
      return value;
    });
    vi.spyOn(
      native.NativeThread.prototype,
      '_next_session_events',
    ).mockImplementation(async function (this: NativeThread) {
      const raw = await next.call(this);
      const event = JSON.parse(firstNativeBatchWire(raw));
      if (['task_complete', 'turn_complete'].includes(event.msg.type))
        terminal.resolve();
      return raw;
    });
    const server = new ModelServer([
      [call('done', {}, { callId: 'success' })],
      [message('A')],
      [message('B')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Act.',
      model: 'gpt-5',
      provider,
      tools: [
        tool({ name: 'done', parameters: z.object({}), execute: () => 'done' }),
      ],
    }).session();
    try {
      const a = await session.submit('A');
      await entered.promise;
      const b = await session.enqueue('B');
      await terminal.promise;
      expect(b.turnId).toBeNull();
      expect(server.requests).toHaveLength(2);
      release.resolve();
      expect((await b.wait()).finalOutput).toBe('B');
      expect((await a.wait()).finalOutput).toBe('A');
      server.assertExhausted();
    } finally {
      release.resolve();
    }
  });

  it('retires queued work when entered callback cleanup fails', async () => {
    const entered = Promise.withResolvers<void>();
    const server = new ModelServer([
      [call('cleanup', {}, { callId: 'cleanup' })],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Act.',
      model: 'gpt-5',
      provider,
      tools: [
        tool({
          name: 'cleanup',
          parameters: z.object({}),
          async execute(_args, context) {
            entered.resolve();
            await new Promise<void>((resolve) =>
              context.signal.addEventListener('abort', () => resolve(), {
                once: true,
              }),
            );
            throw new Error('synthetic cleanup failure');
          },
        }),
      ],
    }).session();
    const a = await session.submit('A');
    await entered.promise;
    const b = await session.enqueue('must not start');
    const ar = expect(a.wait()).rejects.toThrow();
    const br = expect(b.wait()).rejects.toThrow();
    await expect(a.cancel()).rejects.toThrow();
    await Promise.all([ar, br]);
    await expect(session.enqueue('late')).rejects.toThrow();
    expect(b.turnId).toBeNull();
    expect(server.requests).toHaveLength(1);
    // Cleanup failures remain visible on explicit close and async disposal.
    await session.close().catch(() => {});
  });

  it.each(['enqueue', 'close'] as const)(
    'holds lifecycle ownership through an abort listener that calls %s',
    async (action) => {
      const finishing = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let reentered:
        Promise<Turn<string, string | null>> | Promise<void> | undefined;
      const server = new ModelServer([
        [call('install', {}, { callId: 'install' })],
        async () => {
          finishing.resolve();
          await release.promise;
          return [message('A')];
        },
        ...(action === 'enqueue' ? [[message('B')], [message('C')]] : []),
      ]);
      await using provider = await providerFor(server);
      await using session = await new Agent({
        instructions: 'Act.',
        model: 'gpt-5',
        provider,
        tools: [
          tool({
            name: 'install',
            parameters: z.object({}),
            execute(_args, context) {
              context.signal.addEventListener(
                'abort',
                () => {
                  reentered =
                    action === 'enqueue'
                      ? session.enqueue('C')
                      : session.close();
                },
                { once: true },
              );
              return 'installed';
            },
          }),
        ],
      }).session();
      try {
        const a = await session.submit('A');
        await finishing.promise;
        const b = await session.enqueue('B');
        const ar = a.wait().catch((error: unknown) => error);
        const br = b.wait().catch((error: unknown) => error);
        release.resolve();
        const result = await br;
        expect(reentered).toBeDefined();
        if (action === 'enqueue') {
          const c = (await reentered) as Turn<string, string | null>;
          expect((await c.wait()).finalOutput).toBe('C');
          expect(result).toMatchObject({ finalOutput: 'B' });
          expect(await ar).toMatchObject({ finalOutput: 'A' });
          expect(JSON.stringify(server.requests[2].input)).toContain('B');
          server.assertExhausted();
        } else {
          await reentered;
          expect(result).toBeInstanceOf(Error);
          expect(await ar).toBeInstanceOf(Error);
          expect(b.turnId).toBeNull();
          expect(server.requests).toHaveLength(2);
        }
      } finally {
        release.resolve();
      }
    },
  );

  it.each(['complete', 'force'] as const)(
    'reserves an owned automatic continuation before FIFO: %s',
    async (end) => {
      const native = await binding();
      const nextEvent = native.NativeThread.prototype._next_session_events;
      const submit = native.NativeThread.prototype._submit;
      let initial: string | undefined;
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      vi.spyOn(
        native.NativeThread.prototype,
        '_next_session_events',
      ).mockImplementation(async function (this: NativeThread) {
        const raw = await nextEvent.call(this);
        const event = JSON.parse(firstNativeBatchWire(raw));
        if (
          !initial &&
          !event.subagent_id &&
          ['task_complete', 'turn_complete'].includes(event.msg.type)
        ) {
          initial = event.id;
          event.sdk_unsampled_steering = true;
          return replaceSingletonNativeBatchEvent(raw, event);
        }
        return raw;
      });
      vi.spyOn(native.NativeThread.prototype, '_submit').mockImplementation(
        async function (this: NativeThread, raw) {
          const request = JSON.parse(raw);
          if (request.mode === 'continue_if_idle') {
            expect(request.input).toEqual([]);
            expect(request.expected_previous_turn_id).toBe(initial);
            entered.resolve();
            await release.promise;
            // Existing qualified seam: Core's tail admission cannot be scheduled from JS.
            // Preserve real native admission/result/grants; project only the conditional continuation.
            return submit.call(
              this,
              JSON.stringify({
                mode: 'start_if_idle',
                input: [{ type: 'text', text: 'projected continuation' }],
                start: request.start,
              }),
            );
          }
          return submit.call(this, raw);
        },
      );
      const server = new ModelServer([
        [message('{"response":1}')],
        [message('{"response":9}')],
        [message('B')],
      ]);
      await using provider = await providerFor(server);
      await using session = await new Agent({
        instructions: 'Answer.',
        model: 'gpt-5',
        provider,
      }).session();
      try {
        const a = await session.enqueue('A', {
          outputType: {
            mode: 'prompted',
            schema: z
              .object({ response: z.number() })
              .transform((value) => value.response),
          },
        });
        await entered.promise;
        const b = await session.enqueue('B');
        expect(b.turnId).toBeNull();
        expect(server.requests).toHaveLength(1);
        if (end === 'force') {
          const ar = expect(a.wait()).rejects.toThrow();
          const br = expect(b.wait()).rejects.toThrow();
          const graceful = a.cancel({ mode: 'graceful' });
          await a.cancel();
          await graceful;
          await Promise.all([ar, br]);
          expect(a.turnId).toBe(initial);
          expect(b.turnId).toBeNull();
          expect(server.requests).toHaveLength(1);
          release.resolve();
        } else {
          release.resolve();
          expect((await b.wait()).finalOutput).toBe('B');
          const result = await a.wait();
          expect(result.finalOutput).toBe(9);
          expect(result.turn).toBe(a);
          expect(server.requests).toHaveLength(3);
          server.assertExhausted();
        }
      } finally {
        release.resolve();
      }
    },
  );
});

// Compile-only contract: optional schema includes both possible result types.
async function queueTypes(
  session: Awaited<ReturnType<Agent['session']>>,
  schema: OutputSpec<number> | undefined,
) {
  const optional = await session.enqueue('optional', { outputType: schema });
  expectTypeOf(optional).toEqualTypeOf<Turn<string | number, string | null>>();
  const ordinary = await session.submit('ordinary');
  expectTypeOf(ordinary.turnId).toEqualTypeOf<string>();
  // @ts-expect-error Queue intent has its own entrypoint.
  session.submit('queue', { ifBusy: 'queue' });
  // @ts-expect-error The admitted output method keeps its two-argument contract.
  session.submit('count', { ...{ ifBusy: 'queue' }, outputType: z.number() });
}
void queueTypes;
