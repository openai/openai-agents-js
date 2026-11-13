import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import OpenAI from 'openai';
import { ResponsesWS } from 'openai/resources/responses/ws';
import { WebSocketServer, type WebSocket } from 'ws';
import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  HostedResponsesWebSocketModel,
  NativeProvider,
  tool,
} from '../../src';

it.each([
  ['header', false],
  ['query', false],
  ['header', true],
  ['query', true],
] as const)(
  'refuses an active hosted continuation across changed %s scope with permissive retry=%s',
  async (scope, retry) => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let old: WebSocket | undefined,
      effects = 0,
      connections = 0;
    const frames: Array<{
      scope: string | null;
      type: string;
      previous: unknown;
    }> = [];
    const call = {
      type: 'function_call',
      id: 'fc_scope',
      call_id: 'call_scope',
      name: 'lookup',
      arguments: '{}',
    };
    server.on('connection', (socket, request) => {
      connections++;
      old ??= socket;
      const selected =
        scope === 'header'
          ? String(request.headers['x-synthetic-scope'])
          : new URL(request.url!, 'http://localhost').searchParams.get(
              'tenant',
            );
      socket.on('message', (raw) => {
        const frame = JSON.parse(raw.toString());
        frames.push({
          scope: selected,
          type: frame.type,
          previous: frame.previous_response_id,
        });
        const emit = (value: unknown) => socket.send(JSON.stringify(value));
        if (frames.length === 1) {
          emit({
            type: 'response.created',
            response: { id: 'resp_scope_a', output: [] },
          });
          emit({
            type: 'response.output_item.done',
            output_index: 0,
            item: call,
          });
        } else {
          emit({
            type: 'response.created',
            response: { id: 'resp_scope_b', output: [] },
          });
          emit({
            type: 'response.completed',
            response: {
              id: 'resp_scope_b',
              status: 'completed',
              output: [
                {
                  type: 'message',
                  id: 'msg_scope',
                  role: 'assistant',
                  status: 'completed',
                  phase: 'final_answer',
                  agent: { agent_name: '/root' },
                  content: [{ type: 'output_text', text: 'done' }],
                },
              ],
            },
          });
        }
      });
    });
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const model = new HostedResponsesWebSocketModel(
      (_, options) => {
        const url = new URL(endpoint);
        for (const [key, value] of Object.entries(options.query ?? {}))
          url.searchParams.set(key, String(value));
        const client = new OpenAI({
          baseURL: url.toString(),
          apiKey: 'synthetic',
        });
        return new ResponsesWS(client, {
          headers: options.headers as Record<string, string>,
        });
      },
      'gpt-5.5',
      {
        requestOptions: () =>
          scope === 'header'
            ? { headers: { 'x-synthetic-scope': effects ? 'b' : 'a' } }
            : { query: { tenant: effects ? 'b' : 'a' } },
      },
    );
    try {
      await using provider = new NativeProvider({ modelBackend: model });
      const lookup = tool({
        name: 'lookup',
        description: 'Return a synthetic value.',
        parameters: z.object({}),
        execute: async () => {
          effects++;
          entered.resolve();
          await release.promise;
          return 'result';
        },
      });
      await using session = await new Agent({
        provider,
        model: 'gpt-5.5',
        instructions: 'Use lookup.',
        modelSettings: {
          store: true,
          retry: {
            maxRetries: retry ? 1 : 0,
            policy: () => ({
              retry: true,
              delayMs: 0,
              approveUnsafeReplay: true,
            }),
          },
        },
        tools: [lookup],
      }).session();
      const turn = await session.submit('start');
      await entered.promise;
      const closed = once(old!, 'close');
      old!.send(
        JSON.stringify({
          type: 'response.completed',
          response: {
            id: 'resp_scope_a',
            status: 'completed',
            store: true,
            output: [call],
            usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
          },
        }),
      );
      old!.close();
      await closed;
      release.resolve();
      let failure: unknown;
      try {
        await turn.wait();
      } catch (error) {
        failure = error;
      }
      expect(effects).toBe(1);
      expect(frames).toEqual([
        { scope: 'a', type: 'response.create', previous: undefined },
      ]);
      expect(connections).toBe(1);
      expect(turn.runUsage).toMatchObject({
        requests: 1,
        inputTokens: 2,
        outputTokens: 3,
        totalTokens: 5,
      });
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toMatch(/transport scope/);
    } finally {
      release.resolve();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  12_000,
);
