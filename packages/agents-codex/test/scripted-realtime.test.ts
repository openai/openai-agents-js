import { expect, it } from 'vitest';
import { Agent, NativeProvider, tool } from '../src';
import { z } from 'zod';
import { ScriptedRealtimeAdapter } from '../src/testing';

const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');

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
