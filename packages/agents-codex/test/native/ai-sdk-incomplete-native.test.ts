import { createServer } from 'node:http';
import { once } from 'node:events';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  AiSdkModel,
  NativeProvider,
  tool,
  type ModelRequest,
  type NativeModel,
} from '../../src';

it.each([false, true])(
  'preserves original incomplete cause without native success or tool dispatch (stream=%s)',
  async (stream) => {
    let requests = 0,
      executions = 0;
    const server = createServer(async (req, res) => {
      for await (const _ of req) {
        /* consume physical request */
      }
      requests++;
      const response = {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                { text: 'partial 海豚' },
                {
                  functionCall: {
                    name: 'danger',
                    args: { payload: 'private-tool-argument' },
                  },
                },
              ],
            },
            finishReason: 'MAX_TOKENS',
          },
        ],
        usageMetadata: {
          promptTokenCount: 9,
          candidatesTokenCount: 4,
          totalTokenCount: 13,
        },
        responseId: 'incomplete-native',
      };
      if (req.url?.includes('streamGenerateContent')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: ' + JSON.stringify(response) + '\n\n');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(response));
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing HTTP port');
    let original: unknown;
    const measurements: unknown[] = [];
    const google = createGoogleGenerativeAI({
      apiKey: 'local-fixture',
      baseURL: 'http://127.0.0.1:' + address.port + '/v1beta',
    });
    const adapter = new AiSdkModel(google('gemini-2.5-flash'), {}, { stream });
    const measured = (request: ModelRequest): ModelRequest => ({
      ...request,
      reportUsage(usage) {
        measurements.push(usage);
        request.reportUsage?.(usage);
      },
    });
    const backend: NativeModel = {
      async complete(request) {
        try {
          return await adapter.complete(measured(request));
        } catch (error) {
          original = error;
          throw error;
        }
      },
      ...(stream
        ? {
            async *stream(request: ModelRequest) {
              try {
                yield* adapter.stream!(measured(request));
              } catch (error) {
                original = error;
                throw error;
              }
            },
          }
        : {}),
    };
    try {
      await using provider = new NativeProvider({
        apiKey: 'local-fixture',
        modelBackend: backend,
      });
      const danger = tool({
        name: 'danger',
        description: 'Never dispatch incomplete calls.',
        parameters: z.object({ payload: z.string() }),
        execute() {
          executions++;
          return 'unsafe';
        },
      });
      const agent = new Agent({
        model: 'gemini-2.5-flash',
        provider,
        tools: [danger],
        instructions: 'Answer.',
      });
      await using session = await agent.session();
      const run = await session.submit('Continue.');
      let failure: unknown;
      try {
        await run.wait();
      } catch (error) {
        failure = error;
      }
      expect(failure).toBe(original);
      expect(failure).toBeInstanceOf(TypeError);
      expect((failure as Error).message).toBe(
        'AiSdkModel requires a completed response',
      );
      expect((failure as Error).cause).toMatchObject({
        finishReason: 'length',
        rawFinishReason: 'MAX_TOKENS',
        partialText: 'partial 海豚',
        usage: { input_tokens: 9, output_tokens: 4, total_tokens: 13 },
      });
      expect(JSON.stringify((failure as Error).cause)).not.toContain(
        'private-tool-argument',
      );
      expect(measurements).toHaveLength(1);
      expect(requests).toBe(1);
      expect(executions).toBe(0);
      const canonical = JSON.stringify(await session.historySnapshot());
      expect(canonical).not.toContain('partial 海豚');
      expect(canonical).not.toContain('private-tool-argument');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  20_000,
);

it.each([false, true])(
  'completes a real Google tool call once (stream=%s)',
  async (stream) => {
    let requests = 0,
      executions = 0;
    const server = createServer(async (req, res) => {
      for await (const _ of req) {
        /* consume physical request */
      }
      requests++;
      const response = {
        candidates: [
          {
            content: {
              role: 'model',
              parts:
                requests === 1
                  ? [
                      {
                        functionCall: {
                          name: 'danger',
                          args: { payload: 'allowed' },
                        },
                      },
                    ]
                  : [{ text: 'done' }],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 9,
          candidatesTokenCount: 4,
          totalTokenCount: 13,
        },
        responseId: 'successful-native-' + requests,
      };
      if (req.url?.includes('streamGenerateContent')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: ' + JSON.stringify(response) + '\n\n');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(response));
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing HTTP port');
    try {
      const google = createGoogleGenerativeAI({
        apiKey: 'local-fixture',
        baseURL: 'http://127.0.0.1:' + address.port + '/v1beta',
      });
      await using provider = new NativeProvider({
        apiKey: 'local-fixture',
        modelBackend: new AiSdkModel(
          google('gemini-2.5-flash'),
          {},
          { stream },
        ),
      });
      const danger = tool({
        name: 'danger',
        description: 'Echo payload.',
        parameters: z.object({ payload: z.string() }),
        execute({ payload }) {
          executions++;
          return payload;
        },
      });
      const agent = new Agent({
        model: 'gemini-2.5-flash',
        provider,
        tools: [danger],
        instructions: 'Call danger, then answer.',
      });
      const result = await agent.run('Go.');
      expect(result.finalOutput).toBe('done');
      expect(executions).toBe(1);
      expect(requests).toBe(2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  20_000,
);
