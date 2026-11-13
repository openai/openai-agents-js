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
  [false, true],
  [true, true],
  [false, false],
] as const)(
  'settles the closed old hosted response before replacing its socket (store=%s genuine-terminal=%s)',
  async (store, genuine) => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let old: WebSocket | undefined;
    let connections = 0;
    let effects = 0;
    const frames: Array<{ connection: number; frame: Record<string, any> }> =
      [];
    const observed: Record<string, any>[] = [];
    const call = {
      type: 'function_call',
      id: 'fc_lookup',
      call_id: 'call_lookup',
      name: 'lookup',
      arguments: '{}',
    };
    const message = (id: string, text: string) => ({
      type: 'message',
      id,
      role: 'assistant',
      status: 'completed',
      phase: 'final_answer',
      agent: { agent_name: '/root' },
      content: [{ type: 'output_text', text }],
    });
    const oldTerminal = {
      type: 'response.completed',
      response: {
        id: 'resp_closed',
        status: 'completed',
        store,
        output: [call, message('msg_old', 'old unpublished text')],
        usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
      },
    };
    server.on('connection', (socket) => {
      const connection = ++connections;
      if (connection === 1) old = socket;
      socket.on('message', (raw) => {
        const frame = JSON.parse(raw.toString());
        frames.push({ connection, frame });
        const emit = (value: unknown) => socket.send(JSON.stringify(value));
        if (connection === 1) {
          emit({
            type: 'response.created',
            response: { id: 'resp_closed', output: [] },
          });
          emit({
            type: 'response.output_item.done',
            output_index: 0,
            item: call,
          });
        } else if (frame.type === 'response.inject')
          emit({
            type: 'response.inject.failed',
            error: { code: 'response_already_completed' },
          });
        else {
          emit({
            type: 'response.created',
            response: { id: 'resp_new', output: [] },
          });
          emit({
            type: 'response.completed',
            response: {
              id: 'resp_new',
              status: 'completed',
              output: [message('msg_new', 'done')],
              usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 },
            },
          });
        }
      });
    });
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const client = new OpenAI({ baseURL: endpoint, apiKey: 'synthetic' });
    const model = new HostedResponsesWebSocketModel(
      (_, options) =>
        new ResponsesWS(client, {
          headers: options.headers as Record<string, string>,
        }),
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
      const agent = new Agent({
        provider,
        model: 'gpt-5.5',
        instructions: 'Use lookup.',
        modelSettings: { store },
        tools: [lookup],
      });
      await using session = await agent.session({
        includeRawProviderEvents: true,
        observationRetention: 'all',
      });
      const turn = await session.submit('start');
      const events = (async () => {
        for await (const event of turn.events({
          includeExecutionDetails: true,
        }))
          if (event.type === 'raw_provider_event')
            observed.push(event.payload as Record<string, any>);
      })();
      await entered.promise;
      const closed = once(old!, 'close');
      if (genuine) old!.send(JSON.stringify(oldTerminal));
      old!.close();
      await closed;
      release.resolve();
      if (!genuine) {
        await expect(turn.wait()).rejects.toThrow(/genuine terminal/);
        await events;
        expect(effects).toBe(1);
        expect(connections).toBe(1);
        expect(frames.map(({ frame }) => frame.type)).toEqual([
          'response.create',
        ]);
        return;
      }
      const outcome = await turn.wait();
      await events;
      expect(outcome.finalOutput).toBe('done');
      expect(effects).toBe(1);
      expect(connections).toBe(2);
      expect(frames.map(({ frame }) => frame.type)).toEqual([
        'response.create',
        'response.create',
      ]);
      expect(outcome.runUsage).toMatchObject({
        requests: 2,
        inputTokens: 7,
        outputTokens: 10,
        totalTokens: 17,
      });
      expect(
        observed.filter(
          (event) =>
            event.type === 'response.completed' &&
            event.response?.id === 'resp_closed',
        ),
      ).toEqual([oldTerminal]);
      const items = await Array.fromAsync(session.items());
      expect(JSON.stringify(items)).not.toContain('old unpublished text');
    } finally {
      release.resolve();
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  12_000,
);
