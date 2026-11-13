import { createServer } from 'node:http';
import { once } from 'node:events';
import { createOpenAI } from '@ai-sdk/openai';
import { expect, it } from 'vitest';
import { Agent, AiSdkModel, NativeProvider } from '../../src';
import type { JsonObject } from '../../src/runtime/binding';

it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1').each([false, true])(
  'retains real AI SDK stream parts and metadata in order, capture=%s',
  async (capture) => {
    const item = {
      type: 'message',
      id: 'msg_parts',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Visible.', annotations: [] }],
    };
    const response = {
      id: 'resp_parts',
      object: 'response',
      created_at: 0,
      model: 'gpt-4.1',
      status: 'completed',
      output: [item],
      service_tier: 'default',
      usage: {
        input_tokens: 3,
        output_tokens: 1,
        total_tokens: 4,
        input_tokens_details: { cached_tokens: 1 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    };
    const frames = [
      { type: 'response.created', response },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { ...item, status: 'in_progress', content: [] },
      },
      {
        type: 'response.content_part.added',
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      },
      {
        type: 'response.output_text.delta',
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: 'Visible.',
      },
      {
        type: 'response.output_text.done',
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        text: 'Visible.',
      },
      {
        type: 'response.content_part.done',
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: item.content[0],
      },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response },
    ];
    let requests = 0;
    const server = createServer(async (request, reply) => {
      for await (const _chunk of request) {
        /* consume the request */
      }
      requests++;
      reply.writeHead(200, { 'content-type': 'text/event-stream' });
      reply.end(
        frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing loopback address');
    const provider = createOpenAI({
      apiKey: 'synthetic',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
    });
    const real = provider.responses('gpt-4.1');
    const original: JsonObject[] = [];
    const model = new AiSdkModel(
      {
        specificationVersion: real.specificationVersion,
        provider: real.provider,
        modelId: real.modelId,
        doGenerate: (options) => real.doGenerate(options as never),
        async doStream(options) {
          const returned = await real.doStream(options as never);
          return {
            ...returned,
            stream: returned.stream.pipeThrough(
              new TransformStream({
                transform(part, controller) {
                  original.push(JSON.parse(JSON.stringify(part)));
                  controller.enqueue(part);
                },
              }),
            ),
          };
        },
      },
      {},
      { stream: true },
    );
    try {
      await using native = new NativeProvider({ modelBackend: model });
      await using session = await new Agent({
        model: 'gpt-4.1',
        instructions: 'Respond.',
        provider: native,
      }).session({
        includeRawProviderEvents: capture,
        observationRetention: 'all',
      });
      const turn = await session.submit('Begin.');
      expect((await turn.wait()).finalOutput).toBe('Visible.');
      const observed: JsonObject[] = [];
      const sources: string[] = [];
      for await (const event of turn.events({
        includeExecutionDetails: true,
      })) {
        if (event.type === 'raw_provider_event') {
          observed.push(event.payload);
          sources.push(event.source);
        }
      }
      expect(requests).toBe(1);
      expect(original.some((part) => part.providerMetadata !== undefined)).toBe(
        true,
      );
      expect(observed).toEqual(capture ? original : []);
      expect(new Set(sources)).toEqual(new Set(capture ? ['ai_sdk'] : []));
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  20_000,
);
