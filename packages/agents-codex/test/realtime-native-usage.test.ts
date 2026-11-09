import { expect, it } from 'vitest';
import { Agent, NativeProvider } from '../src';
import { ScriptedRealtimeAdapter, type RealtimeStep } from '../src/testing';

it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'reports measured zero, missing and detailed usage without duplicate charging',
  async () => {
    const values = [
      undefined,
      { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
        input_token_details: {
          text_tokens: 1,
          audio_tokens: 9,
          cached_tokens: 3,
          cached_tokens_details: { audio_tokens: 3 },
        },
        output_token_details: { audio_tokens: 5 },
      },
    ];
    const steps: RealtimeStep[] = [
      {
        expect: 'session.update',
        emit: (frame) => [
          {
            type: 'session.updated',
            session: { ...(frame.session as object), id: 'fixture' },
          },
        ],
      },
    ];
    values.forEach((usage, index) => {
      const done = {
        type: 'response.done',
        response: {
          id: `r${index}`,
          ...(usage === undefined
            ? {}
            : { usage: { ...usage, vendor_counter: index } }),
        },
      };
      steps.push(
        { expect: 'conversation.item.create' },
        {
          expect: 'response.create',
          emit: [
            { type: 'response.created', response: { id: `r${index}` } },
            done,
            done,
          ],
        },
      );
    });
    const adapter = new ScriptedRealtimeAdapter(steps);
    await using provider = new NativeProvider({
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'synthetic-key',
      supportsWebsockets: false,
    });
    await using session = await new Agent({
      instructions: 'Speak.',
      provider,
    }).session();
    const voice = await session.realtime({ model: 'fixture', adapter });
    try {
      expect(voice.usage).toBeUndefined();
      for (let index = 0; index < values.length; index++) {
        await voice.sendText('Synthetic usage turn');
        for await (const event of voice.events()) {
          if (
            event.type === 'response' &&
            event.status === 'done' &&
            event.responseId === `r${index}`
          ) {
            expect(event.usage).toEqual(values[index]);
            break;
          }
        }
        expect(voice.usage).toEqual(values[index]);
      }
    } finally {
      await voice.close();
    }
    expect(voice.usage?.total_tokens).toBe(15);
    adapter.assertComplete();
  },
);
