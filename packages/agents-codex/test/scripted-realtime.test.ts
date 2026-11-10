import { expect, it } from 'vitest';
import { Agent, NativeProvider, tool } from '../src';
import { z } from 'zod';
import { ScriptedRealtimeAdapter, type RealtimeScenario } from '../src/testing';

const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');
const scriptedContext = {
  url: 'wss://synthetic.invalid',
  headers: {},
  signal: new AbortController().signal,
};

it('coordinates asynchronous frames and preserves expectation snapshots', async () => {
  const adapter = new ScriptedRealtimeAdapter();
  const result = await adapter.runScenario({
    scenario: async ({ expectSend, emit }) => {
      const expected = { type: 'first', payload: { value: 1 } };
      const pending = expectSend(expected);
      expected.payload.value = 999;
      const frame = await pending;
      expect(frame).toEqual({ type: 'first', payload: { value: 1 } });
      (frame.payload as { value: number }).value = 999;
      emit({ type: 'ack' });
      expect(await expectSend((value) => value.type === 'last')).toEqual({
        type: 'last',
      });
    },
    exercise: async () => {
      await adapter.connect(scriptedContext);
      await adapter.send('{"type":"first","payload":{"value":1}}');
      const incoming = adapter.incoming[Symbol.asyncIterator]();
      expect(await incoming.next()).toEqual({
        value: '{"type":"ack"}',
        done: false,
      });
      await adapter.send('{"type":"last"}');
      await adapter.close();
      expect(await incoming.next()).toEqual({ value: undefined, done: true });
      return 42;
    },
  });
  expect(result).toBe(42);
  expect(adapter.sentEvents[0]).toEqual({
    type: 'first',
    payload: { value: 1 },
  });
  adapter.assertComplete();
  adapter.assertClosed();
});

it('consumes buffered sends before an asynchronous expectation', async () => {
  const adapter = new ScriptedRealtimeAdapter([], { strict: false });
  await adapter.connect(scriptedContext);
  await adapter.send('{"type":"buffered"}');
  await adapter.runScenario({
    scenario: async ({ expectSend }) => {
      expect(await expectSend('buffered')).toEqual({ type: 'buffered' });
    },
    exercise: () => adapter.close(),
  });
});

it.each([false, true])(
  'rejects unsatisfied expectations after exercise completion (late: %s)',
  async (late) => {
    const adapter = new ScriptedRealtimeAdapter();
    await expect(
      adapter.runScenario({
        scenario: async ({ expectSend }) => {
          if (late) {
            await Promise.resolve();
            await Promise.resolve();
          }
          await expectSend('missing');
        },
        exercise: () => undefined,
      }),
    ).rejects.toThrow('exercise completed');
  },
);

it.each(['frame', 'failure'] as const)(
  'rejects unconsumed scenario work (%s)',
  async (unused) => {
    const adapter = new ScriptedRealtimeAdapter();
    await expect(
      adapter.runScenario({
        scenario: ({ failNextSend }) => {
          if (unused === 'failure') failNextSend(new Error('unused'));
        },
        exercise: async () => {
          await adapter.connect(scriptedContext);
          if (unused === 'frame') await adapter.send('{"type":"unused"}');
          await adapter.close();
        },
      }),
    ).rejects.toThrow('unconsumed');
  },
);

it('preserves callback failures while releasing pending expectations', async () => {
  const adapter = new ScriptedRealtimeAdapter();
  const failure = new Error('exercise failed');
  let pending: Promise<unknown> | undefined;
  await expect(
    adapter.runScenario({
      scenario: ({ expectSend }) => {
        pending = expectSend('missing');
        return pending;
      },
      exercise: () => {
        throw failure;
      },
    }),
  ).rejects.toBe(failure);
  await expect(pending).rejects.toBe(failure);
  expect(() => adapter.assertComplete()).toThrow(failure);
});

it.each([false, true])(
  'preserves scenario errors before exercise completion (async: %s)',
  async (asynchronous) => {
    const adapter = new ScriptedRealtimeAdapter();
    const failure = new Error('scenario assertion failed');
    let pending: Promise<unknown> | undefined;
    const scenario = ({ expectSend }: RealtimeScenario) => {
      pending = expectSend('missing');
      throw failure;
    };
    await expect(
      adapter.runScenario({
        scenario: asynchronous
          ? async (context) => scenario(context)
          : scenario,
        exercise: () => undefined,
      }),
    ).rejects.toBe(failure);
    await expect(pending).rejects.toBe(failure);
    expect(() => adapter.assertComplete()).toThrow(failure);
  },
);

it('preserves cancellation reasons without waiting for caller-owned work', async () => {
  const adapter = new ScriptedRealtimeAdapter();
  const controller = new AbortController();
  const reason = new Error('cancelled by fixture');
  await expect(
    adapter.runScenario({
      signal: controller.signal,
      scenario: ({ expectSend }) => expectSend('missing'),
      exercise: () => {
        controller.abort(reason);
        return new Promise<never>(() => {});
      },
    }),
  ).rejects.toBe(reason);
});

it('injects one send failure without losing the observed call', async () => {
  const adapter = new ScriptedRealtimeAdapter();
  const failure = new Error('synthetic send failure');
  await adapter.runScenario({
    scenario: async ({ failNextSend, expectSend }) => {
      failNextSend(failure);
      expect(await expectSend('first')).toEqual({ type: 'first' });
      await expectSend('last');
    },
    exercise: async () => {
      await adapter.connect(scriptedContext);
      await expect(adapter.send('{"type":"first"}')).rejects.toBe(failure);
      await adapter.send('{"type":"last"}');
      await adapter.close();
    },
  });
  adapter.assertComplete();
});

it('drains queued incoming frames before a controlled disconnect error', async () => {
  const adapter = new ScriptedRealtimeAdapter();
  const failure = new Error('synthetic disconnect');
  expect(() => adapter.assertClosed()).toThrow('not closed');
  await adapter.runScenario({
    scenario: async ({ expectSend, emit, disconnect }) => {
      await expectSend('first');
      emit({ type: 'last_incoming' });
      disconnect(failure);
    },
    exercise: async () => {
      await adapter.connect(scriptedContext);
      await adapter.send('{"type":"first"}');
      const incoming = adapter.incoming[Symbol.asyncIterator]();
      expect((await incoming.next()).value).toBe('{"type":"last_incoming"}');
      await expect(incoming.next()).rejects.toBe(failure);
      await adapter.close();
    },
  });
  adapter.assertClosed();
});

it('rejects mixed or repeated scenario modes before invoking callbacks', async () => {
  let calls = 0;
  const callbacks = {
    scenario: () => {
      calls++;
    },
    exercise: () => {
      calls++;
    },
  };
  const fixed = new ScriptedRealtimeAdapter([{ expect: 'fixed' }]);
  await expect(fixed.runScenario(callbacks)).rejects.toThrow('static steps');
  expect(calls).toBe(0);
  const adapter = new ScriptedRealtimeAdapter();
  await adapter.runScenario(callbacks);
  expect(calls).toBe(2);
  await expect(adapter.runScenario(callbacks)).rejects.toThrow('one scenario');
  expect(calls).toBe(2);
});

it('rejects retained scenario operations after completion', async () => {
  const adapter = new ScriptedRealtimeAdapter();
  let retained!: RealtimeScenario;
  await adapter.runScenario({
    scenario: (context) => {
      retained = context;
    },
    exercise: () => undefined,
  });
  expect(() => retained.emit({ type: 'late' })).toThrow('ended');
  expect(() => retained.failNextSend(new Error('late'))).toThrow('ended');
  expect(() => retained.disconnect()).toThrow('ended');
  await expect(retained.expectSend('late')).rejects.toThrow('ended');
  expect(adapter.sentEvents).toEqual([]);
});

nativeIt(
  'runs an asynchronous scenario through the native realtime owner',
  async () => {
    const adapter = new ScriptedRealtimeAdapter();
    await using provider = new NativeProvider({
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'synthetic-key',
      supportsWebsockets: false,
    });
    await using session = await new Agent({
      instructions: 'Speak.',
      provider,
    }).session();
    await adapter.runScenario({
      scenario: async ({ expectSend, emit }) => {
        const update = await expectSend('session.update');
        emit({
          type: 'session.updated',
          session: { ...(update.session as object), id: 'fixture' },
        });
        await expectSend('conversation.item.create');
        await expectSend('response.create');
        emit(
          { type: 'response.created', response: { id: 'reply' } },
          {
            type: 'response.output_audio_transcript.done',
            response_id: 'reply',
            item_id: 'answer',
            transcript: 'Asynchronous native answer.',
          },
          { type: 'response.done', response: { id: 'reply' } },
        );
      },
      exercise: async () => {
        const voice = await session.realtime({ model: 'fixture', adapter });
        try {
          await voice.sendText('Synthetic question');
          for await (const event of voice.events()) {
            if (
              event.type === 'text' &&
              event.final &&
              event.role === 'assistant'
            ) {
              expect(event.text).toBe('Asynchronous native answer.');
              break;
            }
          }
          expect(JSON.stringify(voice.history)).toContain(
            'Asynchronous native answer.',
          );
        } finally {
          await voice.close();
        }
      },
    });
    adapter.assertComplete();
    adapter.assertClosed();
  },
);

nativeIt(
  'scripts ACK, transcript and completion through the native owner',
  async () => {
    const adapter = new ScriptedRealtimeAdapter([
      {
        expect: 'session.update',
        emit: (frame) => [
          {
            type: 'session.updated',
            session: { ...(frame.session as object), id: 'fixture' },
          },
        ],
      },
      { expect: 'conversation.item.create' },
      {
        expect: 'response.create',
        emit: [
          { type: 'response.created', response: { id: 'reply' } },
          {
            type: 'response.output_audio_transcript.done',
            response_id: 'reply',
            item_id: 'answer',
            transcript: 'Scripted native answer.',
          },
          { type: 'response.done', response: { id: 'reply' } },
        ],
      },
    ]);
    await using provider = new NativeProvider({
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'synthetic-key',
      supportsWebsockets: false,
    });
    await using session = await new Agent({
      instructions: 'Speak.',
      tools: [
        tool({
          name: 'lookup',
          description: 'Synthetic lookup.',
          parameters: z.object({}),
          execute: () => 'found',
        }),
      ],
      provider,
    }).session();
    const voice = await session.realtime({ model: 'fixture', adapter });
    try {
      await voice.sendText('Synthetic question');
      for await (const event of voice.events()) {
        if (
          event.type === 'text' &&
          event.final &&
          event.role === 'assistant'
        ) {
          expect(event.text).toBe('Scripted native answer.');
          break;
        }
      }
      expect(JSON.stringify(voice.history)).toContain(
        'Scripted native answer.',
      );
    } finally {
      await voice.close();
    }
    adapter.assertComplete();
    expect(adapter.connectCalls).toEqual([
      { model: 'fixture', headersProvided: true },
    ]);
    expect(JSON.stringify(adapter.connectCalls)).not.toContain('synthetic-key');
    const snapshot = adapter.sentEvents;
    snapshot[0].type = 'changed';
    expect(adapter.sentEvents[0].type).toBe('session.update');
  },
);

it('matches objects independent of key order and retains unexpected-send failures', async () => {
  const context = {
    url: 'wss://synthetic.invalid',
    headers: {},
    signal: new AbortController().signal,
  };
  const adapter = new ScriptedRealtimeAdapter([
    { expect: { type: 'first', nested: { value: 1 } } },
    { expect: (frame) => frame.type === 'last' },
  ]);
  await adapter.connect(context);
  await adapter.send('{"nested":{"value":1},"type":"first"}');
  expect(() => adapter.assertComplete()).toThrow('unconsumed');
  await adapter.send('{"type":"last"}');
  await adapter.close();
  adapter.assertComplete();
  const mismatch = new ScriptedRealtimeAdapter([{ expect: 'expected' }]);
  await mismatch.connect(context);
  await expect(mismatch.send('{"type":"unexpected"}')).rejects.toThrow(
    'Unexpected',
  );
  expect(() => mismatch.assertComplete()).toThrow('Unexpected');
  await mismatch.close();
});

nativeIt(
  'preserves scripted connection errors through native cleanup',
  async () => {
    const failure = new Error('Synthetic connection failure');
    const adapter = new ScriptedRealtimeAdapter([], { connectError: failure });
    await using provider = new NativeProvider({
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'synthetic-key',
      supportsWebsockets: false,
    });
    await using session = await new Agent({
      instructions: 'Speak.',
      provider,
    }).session();
    await expect(
      session.realtime({ model: 'fixture', adapter }),
    ).rejects.toThrow('Synthetic connection failure');
    expect(adapter.connectCalls).toHaveLength(1);
  },
);
