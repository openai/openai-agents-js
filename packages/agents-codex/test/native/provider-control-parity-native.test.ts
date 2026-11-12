import { once } from 'node:events';
import { createServer } from 'node:http';
import OpenAI from 'openai';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, NativeProvider, ResponsesModel, tool } from '../../src';

it.each([false, true])(
  'inherits, restores and clears Responses controls on the wire (borrowed=%s)',
  async (borrowed) => {
    const requests: Record<string, any>[] = [];
    const server = createServer(async (request, response) => {
      let raw = '';
      for await (const chunk of request) raw += String(chunk);
      const body = JSON.parse(raw);
      requests.push(body);
      const result = {
        id: `resp_parity_${requests.length}`,
        object: 'response',
        status: 'completed',
        output: [
          {
            type: 'message',
            id: `msg_parity_${requests.length}`,
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'Done.', annotations: [] }],
          },
        ],
      };
      if (!body.stream) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(result));
        return;
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const frame of [
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: result.output[0],
        },
        { type: 'response.completed', response: result },
      ]) {
        response.write(`data: ${JSON.stringify(frame)}\n\n`);
      }
      response.end();
    }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing local peer');
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const client = new OpenAI({
      apiKey: 'synthetic',
      baseURL: baseUrl,
      maxRetries: 0,
    });
    try {
      const backend = borrowed
        ? new ResponsesModel(client, 'fixture-adapter-model', {
            promptCacheKey: '',
          })
        : undefined;
      await using provider = new NativeProvider({
        baseUrl,
        apiKey: 'synthetic',
        supportsWebsockets: false,
        modelBackend: backend,
      });
      const unused = tool({
        name: 'unused',
        parameters: z.object({}),
        execute: () => {
          throw new Error('The scripted response has no tool call');
        },
      });
      const agent = new Agent({
        model: 'fixture-initial-model',
        instructions: 'Answer briefly.',
        provider,
        tools: [unused],
      });
      let saved;
      {
        await using session = await agent.session();
        expect(
          (await (await session.submit('Initial')).wait()).finalOutput,
        ).toBe('Done.');
        await session.update({
          model: 'fixture-updated-model',
          modelSettings: { toolChoice: 'none', promptCacheRetention: '24h' },
        });
        for (const prompt of ['Updated', 'Inherited']) {
          expect(
            (await (await session.submit(prompt)).wait()).finalOutput,
          ).toBe('Done.');
        }
        saved = await session.saveState();
      }
      {
        await using restored = await agent.session({ state: saved });
        expect(
          (await (await restored.submit('Restored')).wait()).finalOutput,
        ).toBe('Done.');
        await restored.update({
          modelSettings: { toolChoice: null, promptCacheRetention: null },
        });
        expect(
          (await (await restored.submit('Cleared')).wait()).finalOutput,
        ).toBe('Done.');
      }
      expect(requests).toHaveLength(5);
      expect(requests.map((request) => request.model)).toEqual(
        borrowed
          ? Array(5).fill('fixture-adapter-model')
          : [
              'fixture-initial-model',
              ...Array(4).fill('fixture-updated-model'),
            ],
      );
      expect(requests[0]).not.toHaveProperty('prompt_cache_retention');
      for (const request of requests.slice(1, 4)) {
        expect(request.tool_choice).toBe('none');
        expect(request.prompt_cache_retention).toBe('24h');
      }
      expect(requests[4]!.tool_choice ?? 'auto').toBe('auto');
      expect(requests[4]).not.toHaveProperty('prompt_cache_retention');
      const keys = requests.map((request) => request.prompt_cache_key);
      if (borrowed) expect(keys).toEqual(Array(5).fill(''));
      else {
        for (const sessionKeys of [keys.slice(0, 3), keys.slice(3)]) {
          expect(sessionKeys[0]).toEqual(expect.any(String));
          expect(sessionKeys[0]).not.toBe('');
          expect(sessionKeys).toEqual(
            Array(sessionKeys.length).fill(sessionKeys[0]),
          );
        }
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  },
  30_000,
);
