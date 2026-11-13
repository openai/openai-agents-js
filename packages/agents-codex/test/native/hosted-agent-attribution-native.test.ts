import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import OpenAI from 'openai';
import { ResponsesWS } from 'openai/resources/responses/ws';
import { WebSocketServer } from 'ws';
import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  HostedResponsesWebSocketModel,
  NativeProvider,
  getHostedAgentMetadata,
  tool,
} from '../../src';

it('keeps hosted attribution on the exact selected handoff callback across reused provider IDs', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const frames: Record<string, any>[] = [];
  const effects: string[] = [];
  const seen: unknown[] = [];
  let runs = 0;
  const rootMessage = {
    type: 'message',
    id: 'msg_root',
    role: 'assistant',
    status: 'completed',
    phase: 'final_answer',
    agent: { agent_name: '/root' },
    content: [{ type: 'output_text', text: 'done' }],
  };
  server.on('connection', (socket) => {
    const run = runs++;
    let injections = 0;
    const handoff = {
      type: 'function_call',
      id: 'fc_handoff',
      call_id: 'call_handoff',
      name: 'transfer_to_b',
      arguments: '{}',
      agent: { agent_name: '/remote-owner' },
      phase: 'analysis',
    };
    const lookup = {
      type: 'function_call',
      id: 'fc_reused',
      call_id: 'call_reused',
      name: 'lookup',
      arguments: '{}',
      ...(run < 2
        ? {
            agent: { agent_name: run === 0 ? '/worker-one' : '/worker-two' },
            phase: run === 0 ? 'analysis' : 'commentary',
          }
        : {}),
    };
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      frames.push(frame);
      if (frame.type === 'response.create') {
        socket.send(
          JSON.stringify({
            type: 'response.created',
            response: { id: 'resp_reused', output: [] },
          }),
        );
        socket.send(
          JSON.stringify({
            type: 'response.output_item.done',
            output_index: 0,
            item: handoff,
          }),
        );
      } else {
        expect(frame.type).toBe('response.inject');
        injections++;
        socket.send(
          JSON.stringify({
            type: 'response.inject.created',
            response_id: 'resp_reused',
          }),
        );
        if (injections === 1)
          socket.send(
            JSON.stringify({
              type: 'response.output_item.done',
              output_index: 1,
              item: lookup,
            }),
          );
        else {
          expect(injections).toBe(2);
          socket.send(
            JSON.stringify({
              type: 'response.completed',
              response: {
                id: 'resp_reused',
                status: 'completed',
                output: [
                  handoff,
                  lookup,
                  {
                    ...rootMessage,
                    id: 'msg_private',
                    agent: { agent_name: '/other' },
                    content: [
                      { type: 'output_text', text: 'not final user text' },
                    ],
                  },
                  rootMessage,
                ],
                usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
              },
            }),
          );
        }
      }
    });
  });
  const client = new OpenAI({
    apiKey: 'synthetic',
    baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
  });
  const model = new HostedResponsesWebSocketModel(
    (_request, options) =>
      new ResponsesWS(client, { headers: options.headers as any }),
  );
  const parent = tool({
    name: 'lookup',
    description: 'Return parent.',
    parameters: z.object({}),
    execute: async () => {
      effects.push('parent');
      return 'wrong owner';
    },
  });
  const selected = tool({
    name: 'lookup',
    description: 'Return selected.',
    parameters: z.object({}),
    execute: async (_args, context) => {
      effects.push('selected');
      seen.push(getHostedAgentMetadata(context));
      expect(context?.call?.tool.name).toBe('lookup');
      expect(context?.call?.route).toBe('direct');
      expect(context?.call?.childId).toBeNull();
      return 'selected result';
    },
  });
  try {
    await using provider = new NativeProvider({
      modelBackend: model,
      apiKey: 'synthetic',
      baseUrl: 'https://example.invalid/v1',
    });
    const target = new Agent({
      name: 'B',
      instructions: 'Use lookup and finish.',
      tools: [selected],
    });
    const agent = new Agent({
      name: 'A',
      model: 'gpt-5.5',
      instructions: 'Transfer to B.',
      provider,
      tools: [parent],
      handoffs: [target],
      programmaticToolCalling: false,
    });
    for (let run = 0; run < 3; run++)
      expect(
        (await agent.run('start', { signal: AbortSignal.timeout(10000) }))
          .finalOutput,
      ).toBe('done');
    expect(effects).toEqual(['selected', 'selected', 'selected']);
    expect(seen).toEqual([
      { agentName: '/worker-one', phase: 'analysis' },
      { agentName: '/worker-two', phase: 'commentary' },
      undefined,
    ]);
    expect(frames.map((frame) => frame.type)).toEqual(
      Array.from({ length: 3 }, () => [
        'response.create',
        'response.inject',
        'response.inject',
      ]).flat(),
    );
  } finally {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 30000);
