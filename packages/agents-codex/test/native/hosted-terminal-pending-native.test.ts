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
  HostedResponsesWebSocketModel,
  hostedTool,
  tool,
} from '../../src';
it.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
] as const)(
  'admits queued calls before terminal fallback (store=%s terminal-only=%s)',
  async (store, terminalOnly) => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const captured: Record<string, any>[] = [];
    const effects: number[] = [];
    const calls = [1, 2].map((n) => ({
      type: 'function_call',
      id: `fc_item_${n}`,
      call_id: `call_${n}`,
      name: 'lookup',
      arguments: JSON.stringify({ n }),
    }));
    server.on('connection', (socket) =>
      socket.on('message', (raw) => {
        const frame = JSON.parse(raw.toString());
        captured.push(frame);
        const send = (event: unknown) => socket.send(JSON.stringify(event));
        if (captured.length === 1) {
          send({ type: 'response.created', response: { id: 'response' } });
          send({ type: 'response.output_item.done', item: calls[0] });
          return;
        }
        if (captured.length === 2) {
          if (!terminalOnly)
            send({ type: 'response.output_item.done', item: calls[1] });
          send({
            type: 'response.completed',
            response: {
              id: 'response',
              store,
              status: 'completed',
              output: calls,
            },
          });
          send({
            type: 'response.inject.failed',
            error: { code: 'response_already_completed' },
          });
          return;
        }
        send({ type: 'response.created', response: { id: 'continued' } });
        send({
          type: 'response.completed',
          response: {
            id: 'continued',
            status: 'completed',
            output: [
              {
                type: 'message',
                id: 'msg_answer',
                role: 'assistant',
                status: 'completed',
                phase: 'final_answer',
                agent: { agent_name: '/root' },
                content: [{ type: 'output_text', text: 'complete' }],
              },
            ],
          },
        });
      }),
    );
    const client = new OpenAI({
      apiKey: 'synthetic',
      baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    });
    const backend = new HostedResponsesWebSocketModel(
      (_request, options) =>
        new ResponsesWS(client, {
          headers: options.headers as Record<string, string>,
        }),
    );
    try {
      await using provider = new NativeProvider({ modelBackend: backend });
      const lookup = tool({
        name: 'lookup',
        parameters: z.object({ n: z.number() }),
        allowedCallers: ['direct', 'programmatic'],
        execute: ({ n }) => {
          effects.push(n);
          return `result_${n}`;
        },
      });
      const agent = new Agent({
        provider,
        model: 'gpt-5.5',
        instructions: 'Use both lookups.',
        modelSettings: { store },
        tools: [lookup, hostedTool({ type: 'programmatic_tool_calling' })],
      });
      const outcome = await agent.run('Look up both values.', {
        signal: AbortSignal.timeout(7000),
      });
      expect(outcome.finalOutput).toBe('complete');
      expect(effects).toEqual([1, 2]);
      expect(captured.map((frame) => frame.type)).toEqual([
        'response.create',
        'response.inject',
        'response.create',
      ]);
      expect(
        captured[2]?.input
          .filter(
            (item: Record<string, any>) => item.type === 'function_call_output',
          )
          .map((item: Record<string, any>) => [item.call_id, item.output]),
      ).toEqual([
        ['call_1', 'result_1'],
        ['call_2', 'result_2'],
      ]);
      if (store) expect(captured[2]?.previous_response_id).toBe('response');
      else {
        expect(captured[2]?.previous_response_id).toBeUndefined();
        expect(
          captured[2]?.input
            .filter(
              (item: Record<string, any>) => item.type === 'function_call',
            )
            .map((item: Record<string, any>) => item.call_id),
        ).toEqual(['call_1', 'call_2']);
      }
    } finally {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  15000,
);
