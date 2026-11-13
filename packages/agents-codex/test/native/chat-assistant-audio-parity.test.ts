import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  ChatCompletionsModel,
  NativeProvider,
  tool,
  type ModelResponse,
} from '../../src';
import { ModelServer, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

const audioMetadata = {
  id: 'audio_fixture',
  transcript: 'first sample',
  expires_at: 4102444800,
  format: 'wav',
  provider_label: 'fixture',
};
const audio = { ...audioMetadata, data: 'AA==' };
const audioOptions = { voice: 'alloy', format: 'wav' };

it.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
])(
  'keeps assistant audio in canonical history and replays it through Chat, stream=%s audioOnly=%s',
  async (stream, audioOnly) => {
    const requests: Array<{
      messages: Array<Record<string, unknown>>;
      modalities?: string[];
      audio?: typeof audioOptions;
    }> = [];
    const client = {
      chat: {
        completions: {
          async create(body: (typeof requests)[number]) {
            requests.push(structuredClone(body));
            const first = requests.length === 1;
            const id = `chat_fixture_${requests.length}`;
            if (stream) {
              return (async function* () {
                yield {
                  id,
                  choices: [
                    {
                      index: 0,
                      delta: {
                        role: 'assistant',
                        ...(first && audioOnly ? {} : { content: 'done' }),
                        ...(first
                          ? {
                              audio: {
                                ...audioMetadata,
                                data: 'AA',
                                transcript: 'first ',
                              },
                            }
                          : {}),
                      },
                      finish_reason: null,
                    },
                  ],
                };
                if (first) {
                  yield {
                    id,
                    choices: [
                      {
                        index: 0,
                        delta: { audio: { data: '==', transcript: 'sample' } },
                        finish_reason: null,
                      },
                    ],
                  };
                }
                yield {
                  id,
                  choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                };
              })();
            }
            return {
              id,
              object: 'chat.completion',
              created: 1,
              model: 'fixture',
              choices: [
                {
                  index: 0,
                  finish_reason: 'stop',
                  message: {
                    role: 'assistant',
                    content: first && audioOnly ? null : 'done',
                    ...(first ? { audio } : {}),
                  },
                },
              ],
            };
          },
        },
      },
    };
    await using provider = new NativeProvider({
      baseUrl: 'https://example.invalid/v1',
      modelBackend: new ChatCompletionsModel(client, undefined, { stream }),
    });
    const agent = new Agent({
      model: 'fixture',
      provider,
      instructions: 'Reply briefly.',
      modelSettings: {
        extraBody: { modalities: ['text', 'audio'], audio: audioOptions },
      },
    });
    await using session = await agent.session();
    const first = await session.submit('Give an audio reply.');
    const result = await first.wait();
    expect(result.finalOutput).toBe(audioOnly ? '' : 'done');
    const snapshot = await session.historySnapshot();
    const second = await session.submit('Refer to the previous reply.');
    expect((await second.wait()).finalOutput).toBe('done');

    const checkpoint = await session.saveState();
    await session.close();
    await using reopened = await agent.session({ state: checkpoint });
    const third = await reopened.submit(
      'Refer to the audio reply after restore.',
    );
    expect((await third.wait()).finalOutput).toBe('done');

    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request).toMatchObject({
        modalities: ['text', 'audio'],
        audio: audioOptions,
      });
    }
    for (const request of requests.slice(1)) {
      expect(
        request.messages.find(
          (message) => message.role === 'assistant' && 'audio' in message,
        )?.audio,
      ).toEqual(audioMetadata);
    }
    const history = JSON.stringify(snapshot.items);
    expect(history).toContain(audio.data);
    expect(history).toContain(audio.id);
    expect(history).toContain(audio.transcript);
  },
  20_000,
);

it('uses the audio-only final answer instead of earlier tool-step text', async () => {
  let requests = 0;
  const effects: string[] = [];
  const lookup = tool({
    name: 'lookup',
    description: 'Look up the answer.',
    parameters: z.object({}),
    execute: () => {
      effects.push('lookup');
      return 'found';
    },
  });
  await using provider = new NativeProvider({
    baseUrl: 'https://example.invalid/v1',
    modelBackend: {
      complete(): ModelResponse {
        requests++;
        if (requests === 1) {
          return {
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'Looking it up.' }],
              },
              {
                type: 'function_call',
                name: 'lookup',
                call_id: 'lookup-audio-fixture',
                arguments: '{}',
              },
            ],
          };
        }
        return {
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [
                {
                  type: 'output_audio',
                  audio: audio.data,
                  provider_data: audioMetadata,
                },
              ],
            },
          ],
        };
      },
    },
  });
  const result = await new Agent({
    model: 'fixture',
    instructions: 'Look up the answer and speak it.',
    provider,
    tools: [lookup],
  }).run('Speak the answer.');

  expect(effects).toEqual(['lookup']);
  expect(requests).toBe(2);
  expect(result.finalOutput).toBe('');
});

it('keeps imported assistant audio out of a physical Responses request', async () => {
  const server = new ModelServer([[message('unexpected request')]]);
  await using provider = new NativeProvider({
    baseUrl: `http://127.0.0.1:${await server.port()}/v1`,
    apiKey: 'synthetic-audio-route',
    supportsWebsockets: false,
  });
  await using session = await new Agent({
    model: 'gpt-5',
    instructions: 'Reply briefly.',
    provider,
  }).session();
  const history = await session.historySnapshot();
  await session.transactHistory({
    expectedRevision: history.revision,
    keep: 0,
    items: [
      {
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'output_audio',
            audio: audio.data,
            provider_data: audioMetadata,
          },
        ],
      },
    ],
  });
  const turn = await session.submit('Continue from the previous reply.');
  await expect(turn.wait()).rejects.toThrow(
    'Assistant audio history requires Chat Completions',
  );
  expect(server.requests).toHaveLength(0);
});
