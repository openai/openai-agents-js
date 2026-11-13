import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import OpenAI from 'openai';
import { ResponsesWS } from 'openai/resources/responses/ws';
import { WebSocketServer, type WebSocket } from 'ws';
import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Handoff,
  HostedResponsesWebSocketModel,
  NativeProvider,
  tool,
} from '../../src';

function instructions(frame: Record<string, any>): string {
  return frame.input
    .filter(
      (item: { type: string; role?: string }) =>
        item.type === 'message' && item.role === 'developer',
    )
    .flatMap(
      (item: { content: Array<{ type: string; text?: string }> }) =>
        item.content,
    )
    .filter((part: { type: string }) => part.type === 'input_text')
    .map((part: { text?: string }) => part.text)
    .join('\n');
}

it.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true],
  [false, 'unsettled'],
  [true, 'unsettled'],
  [false, 'terminal-before-ack'],
  [true, 'terminal-before-ack'],
] as const)(
  'applies the destination profile to a fresh hosted response (store=%s closed-old-terminal=%s)',
  async (store, closedOld) => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const frames: Array<{ connection: number; frame: Record<string, any> }> =
      [];
    const effects: string[] = [];
    const race = closedOld === 'terminal-before-ack';
    const primeCall = {
      type: 'function_call',
      id: 'fc_prime',
      call_id: 'call_prime',
      name: 'prime',
      arguments: '{}',
    };
    let connections = 0;
    let old: WebSocket | undefined;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const call = {
      type: 'function_call',
      id: 'fc_transfer',
      call_id: 'call_transfer',
      name: 'route_to_target',
      arguments: '{}',
    };
    const answer = {
      type: 'message',
      id: 'msg_destination',
      role: 'assistant',
      status: 'completed',
      phase: 'final_answer',
      agent: { agent_name: '/root' },
      content: [{ type: 'output_text', text: 'resolved' }],
    };
    server.on('connection', (socket) => {
      const connection = ++connections;
      if (connection === 1) old = socket;
      const emit = (event: object) => socket.send(JSON.stringify(event));
      socket.on('message', (raw) => {
        const frame = JSON.parse(raw.toString());
        frames.push({ connection, frame });
        if (frames.length === 1) {
          emit({ type: 'response.created', response: { id: 'resp_source' } });
          emit({
            type: 'response.output_item.done',
            output_index: 0,
            item: race ? primeCall : call,
          });
          return;
        }
        if (race && frames.length === 2) {
          emit({
            type: 'response.output_item.done',
            output_index: 1,
            item: call,
          });
          emit({
            type: 'response.completed',
            response: {
              id: 'resp_source',
              status: 'completed',
              store,
              output: [primeCall, call],
              usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
            },
          });
          emit({ type: 'response.inject.created', response_id: 'resp_source' });
          return;
        }
        // Finish the old request on the broken path so its recorded wire
        // frames give an assertion failure without a transport timeout.
        if (frame.type === 'response.inject') {
          emit({ type: 'response.inject.created', response_id: 'resp_source' });
        } else {
          emit({
            type: 'response.created',
            response: { id: 'resp_destination' },
          });
        }
        emit({
          type: 'response.completed',
          response: {
            id:
              frame.type === 'response.inject'
                ? 'resp_source'
                : 'resp_destination',
            status: 'completed',
            store,
            output: [answer],
          },
        });
      });
    });
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const client = new OpenAI({
      apiKey: 'test-hosted-handoff',
      baseURL: endpoint,
    });
    const model = new HostedResponsesWebSocketModel(
      (_request, options) =>
        new ResponsesWS(client, { headers: options.headers as any }),
    );
    try {
      await using provider = new NativeProvider({
        baseUrl: endpoint,
        apiKey: 'test-hosted-handoff',
        modelBackend: model,
      });
      const destinationTool = tool({
        name: 'destination_only',
        parameters: z.object({}),
        execute: () => 'destination',
      });
      const route = tool({
        name: call.name,
        parameters: z.object({}),
        execute: async () => {
          effects.push('route');
          if (closedOld && !race) {
            entered.resolve();
            await release.promise;
          }
          return 'accepted transfer';
        },
      });
      const prime = tool({
        name: 'prime',
        parameters: z.object({}),
        execute: () => {
          effects.push('prime');
          return 'primed';
        },
      });
      const target = new Agent({
        instructions: 'DESTINATION_ONLY instructions',
        tools: [destinationTool],
      });
      await using session = await new Agent({
        instructions: 'SOURCE_ONLY instructions',
        ...(race ? { tools: [prime] } : {}),
        provider,
        model: 'gpt-5.5',
        modelSettings: { store },
        programmaticToolCalling: false,
        handoffs: [new Handoff(target, route)],
      }).session();
      const turn = await session.submit('Route this');
      if (closedOld && !race) {
        await entered.promise;
        const closed = once(old!, 'close');
        if (closedOld !== 'unsettled')
          old!.send(
            JSON.stringify({
              type: 'response.completed',
              response: {
                id: 'resp_source',
                status: 'completed',
                store,
                output: [call],
                usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
              },
            }),
          );
        old!.close();
        await closed;
        release.resolve();
      }
      if (closedOld === 'unsettled') {
        await expect(turn.wait()).rejects.toThrow(/genuine terminal/);
        expect(effects).toEqual(['route']);
        expect(frames).toHaveLength(1);
        expect(connections).toBe(1);
        return;
      }
      const result = await turn.wait();
      expect(result.finalOutput).toBe('resolved');
      expect(result.runUsage.requests).toBe(2);
      if (closedOld)
        expect(result.runUsage).toMatchObject({
          inputTokens: 2,
          outputTokens: 3,
          totalTokens: 5,
        });
      expect(await session.getActiveAgent()).toBe(target);
      expect(effects).toEqual(race ? ['prime', 'route'] : ['route']);
      expect(frames).toHaveLength(race ? 3 : 2);
      expect(instructions(frames[0]!.frame)).toContain('SOURCE_ONLY');
      const destinationFrame = frames[race ? 2 : 1]!;
      expect(destinationFrame.connection).toBe(2);
      if (race)
        expect(frames.slice(0, 2).map(({ frame }) => frame.type)).toEqual([
          'response.create',
          'response.inject',
        ]);
      const destination = destinationFrame.frame;
      expect(destination.type).toBe('response.create');
      expect(instructions(destination)).toContain('DESTINATION_ONLY');
      expect(
        destination.tools.map(({ name }: { name: string }) => name),
      ).toContain('destination_only');
      expect(
        destination.tools.map(({ name }: { name: string }) => name),
      ).not.toContain(call.name);
      expect(destination.previous_response_id).not.toBe('resp_source');
      expect(destination.input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'function_call',
            call_id: call.call_id,
          }),
          expect.objectContaining({
            type: 'function_call_output',
            call_id: call.call_id,
          }),
        ]),
      );
    } finally {
      release.resolve();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
