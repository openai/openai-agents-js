import { createOpenAI } from '@ai-sdk/openai';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, AiSdkModel, NativeProvider, tool } from '../../src';

it.each([
  { retention: 'in_memory', override: undefined, expected: 'in_memory' },
  { retention: '24h', override: undefined, expected: '24h' },
  { retention: '24h', override: 'in_memory', expected: 'in_memory' },
  { retention: undefined, override: undefined, expected: undefined },
  { retention: undefined, override: '24h', expected: '24h' },
  { retention: undefined, override: null, expected: null },
  { retention: '24h', override: null, expected: null },
  { retention: null, override: null, expected: null },
] as const)(
  'projects cache retention $retention with provider override $override through real AI SDK wire',
  async ({ retention, override, expected }) => {
    const requests: Record<string, any>[] = [];
    let effects = 0;
    const server = createServer(async (incoming, outgoing) => {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      outgoing.writeHead(200, { 'content-type': 'application/json' });
      outgoing.end(
        JSON.stringify({
          id: `resp_cache_${requests.length}`,
          object: 'response',
          created_at: 1,
          model: 'gpt-4.1',
          status: 'completed',
          output:
            requests.length === 1
              ? [
                  {
                    type: 'function_call',
                    id: 'fc_cache',
                    call_id: 'call_cache',
                    name: 'lookup',
                    arguments: '{}',
                    status: 'completed',
                  },
                ]
              : [
                  {
                    type: 'message',
                    id: 'msg_cache',
                    role: 'assistant',
                    status: 'completed',
                    content: [
                      { type: 'output_text', text: 'done', annotations: [] },
                    ],
                  },
                ],
          usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
        }),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const { port } = server.address() as { port: number };
      const model = createOpenAI({
        apiKey: 'synthetic-cache',
        baseURL: `http://127.0.0.1:${port}/v1`,
      }).responses('gpt-4.1');
      await using provider = new NativeProvider({
        modelBackend: new AiSdkModel(
          model,
          override === undefined
            ? {}
            : { openai: { promptCacheRetention: override } },
        ),
      });
      const agent = new Agent({
        instructions: 'Use lookup and answer.',
        model: 'gpt-4.1',
        provider,
        modelSettings:
          retention === undefined ? {} : { promptCacheRetention: retention },
        tools: [
          tool({
            name: 'lookup',
            description: 'Look up a value.',
            parameters: z.object({}),
            execute: () => {
              effects++;
              return 'found';
            },
          }),
        ],
      });
      expect((await agent.run('Look it up.')).finalOutput).toBe('done');
      expect(effects).toBe(1);
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        if (expected === undefined)
          expect(request).not.toHaveProperty('prompt_cache_retention');
        else expect(request.prompt_cache_retention).toBe(expected);
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

it('rejects AI SDK v2 cache retention before provider I/O', async () => {
  let requests = 0;
  const model = new AiSdkModel({
    specificationVersion: 'v2',
    provider: 'openai.responses',
    modelId: 'gpt-4.1',
    doGenerate() {
      requests++;
      return {
        content: [{ type: 'text', text: 'unexpected' }],
        finishReason: 'stop',
      };
    },
  });
  await using provider = new NativeProvider({ modelBackend: model });
  const agent = new Agent({
    instructions: 'Answer.',
    model: 'gpt-4.1',
    provider,
    modelSettings: { promptCacheRetention: '24h' },
  });
  await expect(agent.run('Hello.')).rejects.toThrow(
    /cache retention.*v3 or v4/,
  );
  expect(requests).toBe(0);
});

it('projects cache retention through the native AI SDK v4 callback', async () => {
  const options: unknown[] = [];
  const model = new AiSdkModel({
    specificationVersion: 'v4',
    provider: 'openai.responses',
    modelId: 'gpt-4.1',
    doGenerate(request) {
      options.push(request.providerOptions);
      return {
        content: [{ type: 'text', text: 'done' }],
        finishReason: 'stop',
      };
    },
  });
  await using provider = new NativeProvider({ modelBackend: model });
  const agent = new Agent({
    instructions: 'Answer.',
    model: 'gpt-4.1',
    provider,
    modelSettings: { promptCacheRetention: '24h' },
  });
  expect((await agent.run('Hello.')).finalOutput).toBe('done');
  expect(options).toHaveLength(1);
  expect(options[0]).toMatchObject({
    openai: { store: false, promptCacheRetention: '24h' },
  });
});
