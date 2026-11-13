import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import OpenAI from 'openai';
import { ResponsesWS } from 'openai/resources/responses/ws';
import { WebSocketServer } from 'ws';
import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  ResponsesWebSocketModel,
  tool,
} from '../../src';

it('opens a fresh socket after the provider closes a completed response', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const closed = Promise.withResolvers<void>();
  let connections = 0;
  let creates = 0;
  let effects = 0;
  server.on('connection', (socket) => {
    connections++;
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      creates++;
      expect(frame.type).toBe('response.create');
      expect(frame).not.toHaveProperty('stream');
      const output =
        creates === 1
          ? [
              {
                type: 'function_call',
                id: 'fc_peer',
                call_id: 'call_peer',
                name: 'lookup',
                arguments: '{}',
              },
            ]
          : [
              {
                type: 'message',
                id: 'msg_done',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: 'done' }],
              },
            ];
      const id = 'resp_' + creates;
      socket.send(
        JSON.stringify({
          type: 'response.created',
          response: { id, output: [] },
        }),
      );
      for (const [output_index, item] of output.entries())
        socket.send(
          JSON.stringify({
            type: 'response.output_item.done',
            output_index,
            item,
          }),
        );
      socket.send(
        JSON.stringify({
          type: 'response.completed',
          response: {
            id,
            status: 'completed',
            output,
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          },
        }),
      );
      if (creates === 1) socket.close();
    });
  });
  const client = new OpenAI({
    apiKey: 'synthetic-peer',
    baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
  });
  let factories = 0;
  const model = new ResponsesWebSocketModel(() => {
    const socket = new ResponsesWS(client);
    if (++factories === 1) socket.socket.once('close', () => closed.resolve());
    return socket;
  });
  const lookup = tool({
    name: 'lookup',
    description: 'Read the synthetic record.',
    parameters: z.object({}),
    execute: async () => {
      effects++;
      await closed.promise;
      return 'found';
    },
  });
  try {
    await using provider = new NativeProvider({
      modelBackend: model,
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'synthetic-provider',
    });
    const result = await new Agent({
      provider,
      model: 'gpt-5.5',
      instructions: 'Use lookup.',
      tools: [lookup],
    }).run('start');
    expect(result.finalOutput).toBe('done');
    expect(factories).toBe(2);
    expect(connections).toBe(2);
    expect(creates).toBe(2);
    expect(effects).toBe(1);
  } finally {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 20_000);
