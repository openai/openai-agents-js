import { expect, it } from 'vitest';
import { Agent, NativeProvider } from '../../src';
import type { JsonObject } from '../../src/runtime/binding';

const extra = {
  type: 'response.sdk_fixture.application_vendor',
  extension: { parts: [false, null, 0], id: 'synthetic-opaque' },
};
const delta = {
  type: 'response.output_text.delta',
  item_id: 'msg_app_raw',
  output_index: 0,
  content_index: 0,
  delta: 'Visible.',
  vendor: { opaque: ['nested', 0] },
};

const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');

nativeIt.each([false, true])(
  'preserves application stream raw event data opt-in=%s',
  async (capture) => {
    const frames: JsonObject[] = [
      { type: 'response.created', response: { id: 'resp_app_raw' } },
      extra,
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          type: 'message',
          id: 'msg_app_raw',
          role: 'assistant',
          content: [],
        },
      },
      delta,
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'message',
          id: 'msg_app_raw',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Visible.' }],
        },
      },
      { type: 'response.completed', response: { id: 'resp_app_raw' } },
    ];
    await using provider = new NativeProvider({
      modelBackend: {
        complete() {
          throw new Error('streaming request entered complete');
        },
        async *stream(): AsyncGenerator<JsonObject> {
          yield* frames;
        },
      },
    });
    await using session = await new Agent({
      provider,
      model: 'fixture-native',
      instructions: 'Respond.',
    }).session({
      includeRawProviderEvents: capture,
      observationRetention: 'all',
    });
    const turn = await session.submit('Begin.');
    expect((await turn.wait()).finalOutput).toBe('Visible.');
    const payloads: JsonObject[] = [];
    for await (const event of turn.events({ includeExecutionDetails: true })) {
      if (event.type === 'raw_provider_event') payloads.push(event.payload);
    }
    expect(payloads).toEqual(capture ? frames : []);
  },
  20_000,
);
