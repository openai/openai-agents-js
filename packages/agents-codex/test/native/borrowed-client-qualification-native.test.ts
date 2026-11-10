import OpenAI from 'openai';
import { expect, it } from 'vitest';
import { Agent, ChatCompletionsModel, NativeProvider } from '../../src';

it('refreshes borrowed async Chat credentials through a custom transport on each native request', async () => {
  const keys = ['synthetic-first-key', 'synthetic-second-key'];
  const authorizations: (string | null)[] = [];
  const requests: {
    model: string;
    messages: { role: string; content: unknown }[];
  }[] = [];
  const client = new OpenAI({
    baseURL: 'https://borrowed-chat.invalid/v1',
    maxRetries: 0,
    apiKey: async () => {
      await Promise.resolve();
      const key = keys.shift();
      if (key === undefined) throw new Error('Unexpected credential refresh');
      return key;
    },
    fetch: async (url, init) => {
      expect(String(url)).toBe(
        'https://borrowed-chat.invalid/v1/chat/completions',
      );
      authorizations.push(new Headers(init?.headers).get('authorization'));
      requests.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          id: `chat-${requests.length}`,
          object: 'chat.completion',
          created: 0,
          model: 'borrowed-chat-model',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: `reply-${requests.length}`,
              },
              finish_reason: 'stop',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });
  await using provider = new NativeProvider({
    apiKey: 'synthetic-native-owner',
    modelBackend: new ChatCompletionsModel(client, 'borrowed-chat-model'),
  });
  await using session = await new Agent({
    instructions: 'Answer briefly.',
    provider,
  }).session();
  const first = await session.submit('first native request');
  expect((await first.wait()).finalOutput).toBe('reply-1');
  const second = await session.submit('second native request');
  expect((await second.wait()).finalOutput).toBe('reply-2');
  expect(authorizations).toEqual([
    'Bearer synthetic-first-key',
    'Bearer synthetic-second-key',
  ]);
  expect(requests).toHaveLength(2);
  expect(
    requests.every((request) => request.model === 'borrowed-chat-model'),
  ).toBe(true);
  expect(requests[1].messages).toContainEqual({
    role: 'assistant',
    content: [{ type: 'text', text: 'reply-1' }],
  });
}, 20_000);
