import { createServer } from 'node:http';
import { once } from 'node:events';
import OpenAI from 'openai';
import { expect, it } from 'vitest';
import {
  Agent,
  NativeProvider,
  ResponsesModel,
  type ModelRequest,
  type RetryContext,
} from '../../src';

it('keeps borrowed client retries separate from native attempt usage and raw reports', async () => {
  const wire: Array<string | undefined> = [];
  const requests: ModelRequest[] = [];
  const contexts: RetryContext[] = [];
  const usage = {
    input_tokens: 3,
    output_tokens: 2,
    total_tokens: 5,
    input_tokens_details: { cached_tokens: 1 },
    output_tokens_details: { reasoning_tokens: 1 },
    provider_extension: { unit: 'synthetic-cost' },
  };
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* drain */
    }
    wire.push(request.headers['x-proof-attempt'] as string | undefined);
    response.setHeader('content-type', 'application/json');
    if (wire.length <= 2) {
      response.writeHead(503, { 'retry-after-ms': '0' });
      response.end(
        JSON.stringify({
          error: { message: 'synthetic retry', type: 'server_error' },
        }),
      );
      return;
    }
    response.writeHead(200, { 'x-request-id': 'req_recovered' });
    response.end(
      JSON.stringify({
        id: 'resp_recovered',
        object: 'response',
        status: 'completed',
        created_at: 0,
        model: 'gpt-5.5',
        output: [
          {
            id: 'msg',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [
              { type: 'output_text', text: 'recovered', annotations: [] },
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
    throw new Error('Expected TCP fixture');
  try {
    const client = new OpenAI({
      apiKey: 'synthetic-borrowed-retry',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      maxRetries: 5,
    });
    const model = new ResponsesModel(client, undefined, {
      requestOptions(request) {
        requests.push(request);
        return {
          maxRetries: 1,
          headers: { 'x-proof-attempt': String(request.attempt) },
        };
      },
    });
    await using provider = new NativeProvider({ modelBackend: model });
    const agent = new Agent({
      instructions: 'Answer.',
      model: 'gpt-5.5',
      provider,
      modelSettings: {
        retry: {
          maxRetries: 1,
          policy(context) {
            contexts.push(context);
            return { retry: true, delayMs: 0 };
          },
        },
      },
    });
    const result = await agent.run('Reply.', {
      modelSettings: { retry: { maxRetries: 1 } },
      returnRawUsage: true,
    });
    expect(result.finalOutput).toBe('recovered');
    expect(wire).toEqual(['1', '1', '2']);
    expect(requests).toHaveLength(2);
    expect(requests[0].attemptId).not.toBe(requests[1].attemptId);
    expect(requests.map((request) => request.disableProviderRetries)).toEqual([
      false,
      true,
    ]);
    expect(contexts).toHaveLength(1);
    expect(contexts[0].normalizedError.statusCode).toBe(503);
    expect(result.runUsage).toMatchObject({
      requests: 2,
      missingUsageRequests: 1,
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5,
      cachedInputTokens: 1,
      reasoningOutputTokens: 1,
    });
    expect(result.rawUsage).toEqual([
      {
        responseId: 'resp_recovered',
        upstreamRequestId: 'req_recovered',
        usage,
      },
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 20_000);
