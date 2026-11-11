import { once } from 'node:events';
import { createServer } from 'node:http';
import OpenAI from 'openai';
import { expect, it } from 'vitest';
import { Agent, NativeProvider, ResponsesModel } from '../../src';
import { nativeDescendantModel } from './fixtures/native-descendant-model';

it.each([
  [false, true],
  [true, true],
  [true, false],
])(
  'preserves borrowed Responses original usage with capture=%s and providerId=%s',
  async (capture, providerId) => {
    const usage = {
      input_tokens: 3,
      output_tokens: 2,
      total_tokens: 5,
      provider_extension: {
        active: false,
        values: [0, null, 'synthetic-original-usage'],
      },
    };
    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(request.url ?? '');
      request.resume();
      response.writeHead(200, {
        'content-type': 'application/json',
        'x-request-id': 'req_borrowed_usage',
      });
      response.end(
        JSON.stringify({
          ...(providerId ? { id: 'resp_borrowed_usage' } : {}),
          object: 'response',
          status: 'completed',
          created_at: 0,
          model: nativeDescendantModel,
          output: [
            {
              type: 'message',
              id: 'msg_borrowed',
              role: 'assistant',
              status: 'completed',
              content: [
                { type: 'output_text', text: 'adapter done', annotations: [] },
              ],
            },
          ],
          usage,
        }),
      );
    }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing local peer');
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const client = new OpenAI({
        apiKey: 'synthetic',
        baseURL: `${origin}/v1`,
        maxRetries: 0,
      });
      await using provider = new NativeProvider({
        baseUrl: `${origin}/fallback/v1`,
        modelBackend: new ResponsesModel(client),
      });
      const result = await new Agent({
        model: nativeDescendantModel,
        instructions: 'Answer.',
        provider,
      }).run('Continue.', { returnRawUsage: capture, returnHistory: true });
      expect(result.finalOutput).toBe('adapter done');
      expect(result.runUsage.requests).toBe(1);
      expect(requests).toEqual(['/v1/responses']);
      expect(JSON.stringify(result.history)).not.toContain(
        'synthetic-original-usage',
      );
      if (capture && providerId)
        expect(result.rawUsage).toEqual([
          {
            responseId: 'resp_borrowed_usage',
            upstreamRequestId: 'req_borrowed_usage',
            usage,
          },
        ]);
      else if (capture) expect(result.rawUsage).toEqual([]);
      else expect(result).not.toHaveProperty('rawUsage');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
