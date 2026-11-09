import { createServer } from 'node:http';
import { once } from 'node:events';
import OpenAI from 'openai';
import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  ChatCompletionsModel,
  NativeProvider,
  tool,
  type ModelRequest,
  type ModelResponse,
} from '../../src';

it('keeps custom model tool calls, results and continuation in native Core', async () => {
  const seen: ModelRequest[] = [];
  const effects: number[] = [];
  const double = tool({
    name: 'double',
    description: 'Double.',
    parameters: z.object({ value: z.number() }),
    execute: ({ value }) => {
      effects.push(value);
      return String(value * 2);
    },
  });
  await using provider = new NativeProvider({
    baseUrl: 'https://example.invalid/v1',
    modelBackend: {
      complete(request): ModelResponse {
        seen.push(request);
        if (seen.length === 1)
          return {
            output: [
              {
                type: 'function_call',
                name: 'double',
                call_id: 'call_double',
                arguments: '{"value":21}',
              },
            ],
            usage: { input_tokens: 3, output_tokens: 2 },
          };
        expect(
          (request.body.input as any[]).some(
            (item) =>
              item.type === 'function_call_output' &&
              JSON.stringify(item.output).includes('42'),
          ),
        ).toBe(true);
        return {
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: '42' }],
            },
          ],
          usage: { input_tokens: 5, output_tokens: 1 },
        };
      },
    },
  });
  const result = await new Agent({
    model: 'custom-model',
    instructions: 'Use double.',
    tools: [double],
    provider,
  }).run('Double21.', { context: { tenant: 'synthetic' } });
  expect(result.finalOutput).toBe('42');
  expect(effects).toEqual([21]);
  expect(seen).toHaveLength(2);
  expect(seen[0].context).toEqual({ tenant: 'synthetic' });
}, 20_000);

it('uses an injected OpenAI Chat client while Core executes tools and resumes the model', async () => {
  const seen: any[] = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    seen.push(body);
    const message =
      seen.length === 1
        ? {
            content: null,
            tool_calls: [
              {
                type: 'function',
                id: 'call_echo',
                function: { name: 'echo', arguments: '{"value":"from-tool"}' },
              },
            ],
          }
        : { content: 'native chat finished' };
    response
      .writeHead(200, { 'content-type': 'application/json' })
      .end(
        JSON.stringify({
          id: `chat_${seen.length}`,
          object: 'chat.completion',
          created: 0,
          model: 'chat-model',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', ...message },
              finish_reason: seen.length === 1 ? 'tool_calls' : 'stop',
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }),
      );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected port');
  try {
    const client = new OpenAI({
      apiKey: 'synthetic-key',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
    });
    const echo = tool({
      name: 'echo',
      description: 'Echo.',
      parameters: z.object({ value: z.string() }),
      execute: ({ value }) => value,
    });
    await using provider = new NativeProvider({
      modelBackend: new ChatCompletionsModel(client, 'chat-model'),
    });
    const result = await new Agent({
      instructions: 'Use echo.',
      tools: [echo],
      provider,
    }).run('Call echo.');
    expect(result.finalOutput).toBe('native chat finished');
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ model: 'chat-model', stream: false });
    expect(
      seen[1].messages.some(
        (item: any) =>
          item.role === 'tool' && item.content.includes('from-tool'),
      ),
    ).toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 20_000);

it('joins admitted asynchronous model work and discards a late tool call on cancellation', async () => {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const effects: string[] = [];
  const forbidden = tool({
    name: 'forbidden',
    description: 'Forbidden.',
    parameters: z.object({}),
    execute: () => {
      effects.push('called');
      return 'bad';
    },
  });
  await using provider = new NativeProvider({
    modelBackend: {
      async complete() {
        enter();
        await released;
        return {
          output: [
            {
              type: 'function_call',
              name: 'forbidden',
              call_id: 'late',
              arguments: '{}',
            },
          ],
        };
      },
    },
  });
  await using session = await new Agent({
    instructions: 'Answer.',
    tools: [forbidden],
    provider,
  }).session();
  const turn = await session.submit('Begin.');
  await entered;
  let stopped = false;
  const stopping = turn.cancel().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  release();
  await stopping;
  await expect(turn.wait()).rejects.toThrow();
  expect(effects).toEqual([]);
}, 20_000);
