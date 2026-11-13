import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
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
  tool,
} from '../../src';

it.each([false, true])(
  'executes one native tool across a provider pause/inject with terminal-before-ack=%s',
  async (terminalBeforeAck) => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const frames: Record<string, any>[] = [];
    const beta: unknown[] = [];
    const incoming: unknown[] = [];
    const observed: unknown[] = [];
    let connections = 0;
    let closes = 0;
    let effects = 0;
    const call = {
      type: 'function_call',
      id: 'fc_hosted',
      call_id: 'call_hosted',
      name: 'lookup',
      arguments: '{}',
      agent: { agent_name: '/worker' },
      vendor: { enabled: false },
    };
    const final = {
      type: 'message',
      id: 'msg_done',
      role: 'assistant',
      status: 'completed',
      phase: 'final_answer',
      agent: { agent_name: '/root' },
      content: [{ type: 'output_text', text: 'done' }],
    };
    server.on('connection', (socket, request) => {
      connections++;
      beta.push(request.headers['openai-beta']);
      socket.on('close', () => closes++);
      const emit = (event: object) => {
        incoming.push(event);
        socket.send(JSON.stringify(event));
      };
      socket.on('message', (raw) => {
        const frame = JSON.parse(raw.toString());
        frames.push(frame);
        if (frame.type === 'response.create') {
          expect(frame).not.toHaveProperty('stream');
          expect(frame.multi_agent).toEqual({
            enabled: true,
            max_concurrent_subagents: 2,
          });
          emit({
            type: 'response.created',
            response: { id: 'resp_hosted', output: [] },
          });
          emit({
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              ...final,
              id: 'msg_other',
              agent: { agent_name: '/other' },
              content: [{ type: 'output_text', text: 'private sibling' }],
            },
          });
          emit({
            type: 'response.output_item.done',
            output_index: 1,
            item: call,
          });
        } else {
          expect(frame).toMatchObject({
            type: 'response.inject',
            response_id: 'resp_hosted',
            input: [{ type: 'function_call_output', call_id: call.call_id }],
          });
          const done = {
            type: 'response.completed',
            response: {
              id: 'resp_hosted',
              status: 'completed',
              output: [
                call,
                { type: 'agent_message', id: 'collaboration' },
                { ...final, id: 'msg_other', agent: { agent_name: '/other' } },
                final,
              ],
              usage: {
                input_tokens: 3,
                output_tokens: 2,
                total_tokens: 5,
                input_tokens_details: {
                  cached_tokens: 2,
                  cache_write_tokens: 1,
                },
                output_tokens_details: { reasoning_tokens: 1 },
              },
            },
          };
          const ack = {
            type: 'response.inject.created',
            response_id: 'resp_hosted',
          };
          for (const event of terminalBeforeAck ? [done, ack] : [ack, done])
            emit(event);
        }
      });
    });
    const client = new OpenAI({
      apiKey: 'synthetic-hosted',
      baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    });
    const model = new HostedResponsesWebSocketModel(
      (_request, options) =>
        new ResponsesWS(client, { headers: options.headers as any }),
      undefined,
      {
        maxConcurrentSubagents: 2,
        requestOptions: { headers: { 'OpenAI-Beta': 'existing-beta' } },
      },
    );
    const lookup = tool({
      name: 'lookup',
      description: 'Read the synthetic record.',
      parameters: z.object({}),
      execute: () => {
        effects++;
        expect(closes).toBe(0);
        expect(frames).toHaveLength(1);
        return 'synthetic record';
      },
    });
    try {
      await using provider = new NativeProvider({
        modelBackend: model,
        baseUrl: 'https://example.invalid/v1',
        apiKey: 'synthetic-provider',
      });
      const agent = new Agent({
        provider,
        model: 'gpt-5.5',
        instructions: 'Use lookup.',
        tools: [lookup],
        programmaticToolCalling: false,
      });
      await using session = await agent.session({
        includeRawProviderEvents: true,
        observationRetention: 'all',
      });
      const turn = await session.submit('start');
      for await (const event of turn.events({
        includeExecutionDetails: true,
      })) {
        if (event.type === 'raw_provider_event')
          observed.push([event.source, event.transport, event.payload]);
      }
      const result = await turn.wait();
      expect(result.finalOutput).toBe('done');
      expect(observed).toEqual(
        incoming.map((event) => ['responses', 'websocket', event]),
      );
      expect(result.runUsage).toEqual({
        inputTokens: 3,
        outputTokens: 2,
        totalTokens: 5,
        cachedInputTokens: 2,
        cacheWriteInputTokens: 1,
        reasoningOutputTokens: 1,
        requests: 1,
        missingUsageRequests: 0,
      });
      expect(effects).toBe(1);
      expect(connections).toBe(1);
      expect(frames.map((frame) => frame.type)).toEqual([
        'response.create',
        'response.inject',
      ]);
      expect(beta).toEqual(['existing-beta,responses_multi_agent=v1']);
      await expect.poll(() => closes).toBe(1);
      if (process.env.HOSTED_BETA_WIRE_RECEIPT)
        await writeFile(
          process.env.HOSTED_BETA_WIRE_RECEIPT +
            '-' +
            String(terminalBeforeAck) +
            '.json',
          JSON.stringify(
            {
              frames,
              beta,
              effects,
              connections,
              closes,
              nativeUsage: result.runUsage,
              providerCreates: frames.filter(
                (frame) => frame.type === 'response.create',
              ).length,
            },
            null,
            2,
          ) + '\n',
        );
    } finally {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  20_000,
);

it('closes the paused provider response before joining an entered native tool on abort', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const frames: string[] = [];
  let effects = 0;
  server.on('connection', (socket) => {
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      frames.push(frame.type);
      const call = {
        type: 'function_call',
        id: 'fc_abort',
        call_id: 'call_abort',
        name: 'lookup',
        arguments: '{}',
      };
      socket.send(
        JSON.stringify({
          type: 'response.created',
          response: { id: 'resp_abort', output: [] },
        }),
      );
      socket.send(
        JSON.stringify({
          type: 'response.output_item.done',
          output_index: 0,
          item: call,
        }),
      );
    });
  });
  const client = new OpenAI({
    apiKey: 'synthetic-hosted',
    baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
  });
  const model = new HostedResponsesWebSocketModel((_request, options) => {
    const socket = new ResponsesWS(client, { headers: options.headers as any });
    socket.socket.once('close', () => closed.resolve());
    return socket;
  });
  const lookup = tool({
    name: 'lookup',
    description: 'Read the synthetic record.',
    parameters: z.object({}),
    execute: async () => {
      effects++;
      entered.resolve();
      await release.promise;
      return 'synthetic record';
    },
  });
  const controller = new AbortController();
  let pending: Promise<unknown> | undefined;
  try {
    await using provider = new NativeProvider({
      modelBackend: model,
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'synthetic-provider',
    });
    pending = new Agent({
      provider,
      model: 'gpt-5.5',
      instructions: 'Use lookup.',
      tools: [lookup],
      programmaticToolCalling: false,
    }).run('start', { signal: controller.signal });
    void pending.catch(() => {});
    await Promise.race([entered.promise, pending]);
    controller.abort(new Error('synthetic abort'));
    await closed.promise;
    expect(frames).toEqual(['response.create']);
    release.resolve();
    await expect(pending).rejects.toThrow();
    expect(frames).toEqual(['response.create']);
    expect(effects).toBe(1);
  } finally {
    release.resolve();
    await pending?.catch(() => {});
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 20_000);

it.each([
  [true, false, false],
  [true, true, true],
  [false, false, true],
  [false, true, false],
])(
  'continues a physically completed hosted response with store=%s terminal-before-rejection=%s steer=%s',
  async (store, terminalFirst, steer) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const steering = 'Apply the next instruction after lookup.';
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const frames: Record<string, any>[] = [];
    let effects = 0;
    const call = {
      type: 'function_call',
      id: 'fc_fallback',
      call_id: 'call_fallback',
      name: 'lookup',
      arguments: '{}',
      agent: { agent_name: '/worker' },
      vendor: { enabled: false },
    };
    const hidden = {
      type: 'agent_message',
      id: 'collaboration_fallback',
      vendor: { exact: 'retained' },
    };
    const final = {
      type: 'message',
      id: 'msg_fallback',
      role: 'assistant',
      status: 'completed',
      phase: 'final_answer',
      agent: { agent_name: '/root' },
      content: [{ type: 'output_text', text: 'done' }],
    };
    const completed = {
      id: 'resp_first',
      status: 'completed',
      store,
      output: [call, hidden],
      usage: {
        input_tokens: 3,
        output_tokens: 2,
        total_tokens: 5,
        input_tokens_details: { cached_tokens: 2, cache_write_tokens: 1 },
        output_tokens_details: { reasoning_tokens: 1 },
      },
    };
    server.on('connection', (socket) =>
      socket.on('message', (raw) => {
        const frame = JSON.parse(raw.toString());
        frames.push(frame);
        if (frames.length === 1) {
          expect(frame.type).toBe('response.create');
          expect(frame.store).toBe(store);
          socket.send(
            JSON.stringify({
              type: 'response.created',
              response: { id: 'resp_first', output: [] },
            }),
          );
          socket.send(
            JSON.stringify({ type: 'response.output_item.done', item: call }),
          );
        } else if (frames.length === 2) {
          expect(frame.type).toBe('response.inject');

          const terminal = { type: 'response.completed', response: completed };
          const rejection = {
            type: 'response.inject.failed',
            error: { code: 'response_already_completed' },
            input: frame.input,
          };
          for (const event of terminalFirst
            ? [terminal, rejection]
            : [rejection, terminal])
            socket.send(JSON.stringify(event));
        } else {
          expect(frame.type).toBe('response.create');
          expect(frame).not.toHaveProperty('stream');
          if (store) {
            expect(frame.previous_response_id).toBe('resp_first');
            expect(frame.input).toEqual(frames[1]!.input);
          } else {
            expect(frame).not.toHaveProperty('previous_response_id');
            expect(frame.input).toEqual([
              ...frames[0]!.input,
              ...completed.output,
              ...frames[1]!.input,
            ]);
          }
          socket.send(
            JSON.stringify({
              type: 'response.created',
              response: { id: 'resp_second', output: [] },
            }),
          );
          socket.send(
            JSON.stringify({
              type: 'response.completed',
              response: {
                id: 'resp_second',
                status: 'completed',
                output: [final],
                usage: {
                  input_tokens: 7,
                  output_tokens: 4,
                  total_tokens: 11,
                  input_tokens_details: {
                    cached_tokens: 3,
                    cache_write_tokens: 2,
                  },
                  output_tokens_details: { reasoning_tokens: 2 },
                },
              },
            }),
          );
        }
      }),
    );
    const address = server.address() as AddressInfo;
    const client = new OpenAI({
      apiKey: 'synthetic',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
    });
    const model = new HostedResponsesWebSocketModel(
      (_request, options) =>
        new ResponsesWS(client, { headers: options.headers as any }),
    );
    const lookup = tool({
      name: 'lookup',
      description: 'Return a synthetic result.',
      parameters: z.object({}),
      execute: async () => {
        effects++;
        if (steer) {
          entered.resolve();
          await release.promise;
        }
        return 'result';
      },
    });
    try {
      await using provider = new NativeProvider({
        modelBackend: model,
        baseUrl: 'https://example.invalid/v1',
        apiKey: 'synthetic',
      });
      const agent = new Agent({
        provider,
        model: 'gpt-5.5',
        instructions: 'Use lookup.',
        modelSettings: { store },
        tools: [lookup],
        programmaticToolCalling: false,
      });
      await using session = await agent.session();
      const turn = await session.submit('start');
      if (steer) {
        try {
          await entered.promise;
          await turn.steer(steering);
        } finally {
          release.resolve();
        }
      }
      const result = await turn.wait();
      expect(frames[1]?.input).toHaveLength(steer ? 2 : 1);
      const injected = JSON.stringify(frames[1]?.input);
      expect(injected.includes(steering)).toBe(steer);
      expect(injected).not.toContain('"text":"start"');
      expect(result.finalOutput).toBe('done');
      expect(effects).toBe(1);
      expect(frames.map((frame) => frame.type)).toEqual([
        'response.create',
        'response.inject',
        'response.create',
      ]);
      expect(result.runUsage).toEqual({
        inputTokens: 10,
        outputTokens: 6,
        totalTokens: 16,
        cachedInputTokens: 5,
        cacheWriteInputTokens: 3,
        reasoningOutputTokens: 3,
        requests: 2,
        missingUsageRequests: 0,
      });
    } finally {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);

it.each(['failed', 'incomplete'] as const)(
  'reports a hosted provider %s terminal without running or replaying a tool',
  async (status) => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    let creates = 0;
    let effects = 0;
    server.on('connection', (socket) => {
      socket.on('message', (wire) => {
        expect(JSON.parse(wire.toString()).type).toBe('response.create');
        creates++;
        socket.send(
          JSON.stringify({
            type: 'response.created',
            response: { id: 'resp_failure', output: [] },
          }),
        );
        socket.send(
          JSON.stringify({
            type: `response.${status}`,
            response: {
              id: 'resp_failure',
              status,
              output: [],
              ...(status === 'failed'
                ? {
                    error: {
                      code: 'server_error',
                      message: 'Synthetic hosted failure',
                    },
                  }
                : { incomplete_details: { reason: 'content_filter' } }),
            },
          }),
        );
      });
    });
    const client = new OpenAI({
      apiKey: 'synthetic-hosted',
      baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    });
    try {
      await using provider = new NativeProvider({
        modelBackend: new HostedResponsesWebSocketModel(
          (_request, options) =>
            new ResponsesWS(client, { headers: options.headers as any }),
        ),
        baseUrl: 'https://example.invalid/v1',
        apiKey: 'synthetic-provider',
      });
      const agent = new Agent({
        provider,
        model: 'gpt-5.5',
        instructions: 'Use lookup.',
        tools: [
          tool({
            name: 'lookup',
            description: 'Read the synthetic record.',
            parameters: z.object({}),
            execute() {
              effects++;
              return 'synthetic record';
            },
          }),
        ],
        programmaticToolCalling: false,
      });
      await using session = await agent.session({
        includeRawProviderEvents: true,
        observationRetention: 'all',
      });
      const turn = await session.submit('start');
      const observed: unknown[] = [];
      for await (const event of turn.events({
        includeExecutionDetails: true,
      })) {
        if (event.type === 'raw_provider_event')
          observed.push(event.payload.type);
      }
      await expect(turn.wait()).rejects.toThrow();
      expect(observed).toEqual(['response.created', `response.${status}`]);
      expect(creates).toBe(1);
      expect(effects).toBe(0);
    } finally {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  20_000,
);

it.each(['response.create', 'response.inject'] as const)(
  'keeps a hosted %s send failure on its admitted attempt',
  async (failOn) => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const sends: string[] = [];
    let effects = 0;
    server.on('connection', (socket) => {
      socket.on('message', () => {
        socket.send(
          JSON.stringify({
            type: 'response.created',
            response: { id: 'resp_send_error', output: [] },
          }),
        );
        socket.send(
          JSON.stringify({
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              type: 'function_call',
              id: 'fc_send_error',
              name: 'lookup',
              call_id: 'call_send_error',
              arguments: '{}',
            },
          }),
        );
      });
    });
    const client = new OpenAI({
      apiKey: 'synthetic-hosted',
      baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    });
    try {
      await using provider = new NativeProvider({
        modelBackend: new HostedResponsesWebSocketModel((_request, options) => {
          const ws = new ResponsesWS(client, {
            headers: options.headers as any,
          });
          return {
            socket: ws.socket,
            close: () => ws.close(),
            send(frame) {
              sends.push(frame.type);
              if (frame.type === failOn)
                throw new Error('synthetic send failure');
              ws.send(frame);
            },
            [Symbol.asyncIterator]: () => ws[Symbol.asyncIterator](),
          };
        }),
        baseUrl: 'https://example.invalid/v1',
        apiKey: 'synthetic-provider',
      });
      const agent = new Agent({
        provider,
        model: 'gpt-5.5',
        instructions: 'Use lookup.',
        tools: [
          tool({
            name: 'lookup',
            description: 'Read the synthetic record.',
            parameters: z.object({}),
            execute() {
              effects++;
              return 'synthetic record';
            },
          }),
        ],
        programmaticToolCalling: false,
      });
      await expect(agent.run('start')).rejects.toThrow();
      expect(sends).toEqual(
        failOn === 'response.create' ? [failOn] : ['response.create', failOn],
      );
      expect(effects).toBe(failOn === 'response.create' ? 0 : 1);
    } finally {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  20_000,
);

it.each([false, true])(
  'replays acknowledged and rejected tool outputs and steering in nonstored history, terminal first=%s',
  async (terminalFirst) => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(server, 'listening');
    const frames: Record<string, any>[] = [];
    const effects: string[] = [];
    const steps = ['one', 'two'].map((key) => ({
      key,
      entered: Promise.withResolvers<void>(),
      release: Promise.withResolvers<void>(),
    }));
    const steering = 'Keep the next answer short.';
    const calls = ['one', 'two'].map((key) => ({
      type: 'function_call',
      id: `fc_${key}`,
      namespace: 'functions',
      call_id: `call_${key}`,
      name: 'lookup',
      arguments: JSON.stringify({ key }),
    }));
    server.on('connection', (socket) => {
      const emit = (event: object) => socket.send(JSON.stringify(event));
      const emitCall = (index: number) =>
        emit({ type: 'response.output_item.done', item: calls[index] });
      socket.on('message', (raw) => {
        frames.push(JSON.parse(raw.toString()));
        if (frames.length === 1) {
          emit({
            type: 'response.created',
            response: { id: 'first', output: [] },
          });
          emitCall(0);
        } else if (frames.length === 2) {
          emit({ type: 'response.inject.created', response_id: 'first' });
          emitCall(1);
        } else if (frames.length === 3) {
          const terminal = {
            type: 'response.completed',
            response: {
              id: 'first',
              store: false,
              status: 'completed',
              output: calls,
            },
          };
          const rejected = {
            type: 'response.inject.failed',
            error: { code: 'response_already_completed' },
          };
          for (const event of terminalFirst
            ? [terminal, rejected]
            : [rejected, terminal]) {
            emit(event);
          }
        } else {
          emit({
            type: 'response.created',
            response: { id: 'second', output: [] },
          });
          emit({
            type: 'response.completed',
            response: {
              id: 'second',
              status: 'completed',
              output: [
                {
                  type: 'message',
                  id: 'msg_two',
                  role: 'assistant',
                  status: 'completed',
                  phase: 'final_answer',
                  agent: { agent_name: '/root' },
                  content: [{ type: 'output_text', text: 'finished' }],
                },
              ],
            },
          });
        }
      });
    });
    const address = server.address() as AddressInfo;
    const client = new OpenAI({
      apiKey: 'synthetic',
      baseURL: `http://127.0.0.1:${address.port}/v1`,
    });
    const model = new HostedResponsesWebSocketModel(
      (_request, options) =>
        new ResponsesWS(client, { headers: options.headers as any }),
    );
    const lookup = tool({
      name: 'lookup',
      description: 'Record a synthetic result.',
      parameters: z.object({ key: z.string() }),
      execute: async ({ key }) => {
        effects.push(key);
        const step = steps.find((step) => step.key === key)!;
        step.entered.resolve();
        await step.release.promise;
        return `result for ${key}`;
      },
    });
    try {
      await using provider = new NativeProvider({ modelBackend: model });
      const agent = new Agent({
        instructions: 'Use lookup.',
        tools: [lookup],
        provider,
        model: 'gpt-5.5',
        modelSettings: { store: false },
      });
      await using session = await agent.session();
      const turn = await session.submit('start');
      try {
        for (const step of steps) {
          await step.entered.promise;
          await turn.steer(steering);
          step.release.resolve();
        }
      } finally {
        for (const step of steps) step.release.resolve();
      }
      const result = await turn.wait();
      expect(result.finalOutput).toBe('finished');
      expect(result.runUsage.requests).toBe(2);
      expect(effects).toEqual(['one', 'two']);
      expect(frames.map((frame) => frame.type)).toEqual([
        'response.create',
        'response.inject',
        'response.inject',
        'response.create',
      ]);
      const [first, second] = [frames[1]!.input, frames[2]!.input];
      expect(first).toHaveLength(2);
      expect(second).toHaveLength(2);
      expect(first[1]).toMatchObject({ role: 'user', id: expect.any(String) });
      expect(second[1]).toMatchObject({ role: 'user', id: expect.any(String) });
      expect(second[1].id).not.toBe(first[1].id);
      expect(JSON.stringify(first[1])).toContain(steering);
      expect(JSON.stringify(second[1])).toContain(steering);
      expect(frames[3]!.input).toEqual([
        ...frames[0]!.input,
        calls[0],
        ...frames[1]!.input,
        calls[1],
        ...frames[2]!.input,
      ]);
    } finally {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  20_000,
);

it('rejects a compact hosted terminal above the native item count limit', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  server.on('connection', (socket) => {
    socket.on('message', () => {
      socket.send(
        JSON.stringify({
          type: 'response.created',
          response: { id: 'oversized-output', output: [] },
        }),
      );
      socket.send(
        JSON.stringify({
          type: 'response.completed',
          response: {
            id: 'oversized-output',
            status: 'completed',
            output: Array.from({ length: 4097 }, () => ({})),
          },
        }),
      );
    });
  });
  const client = new OpenAI({
    apiKey: 'synthetic-hosted',
    baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
  });
  try {
    await using provider = new NativeProvider({
      modelBackend: new HostedResponsesWebSocketModel(
        (_request, options) =>
          new ResponsesWS(client, { headers: options.headers as any }),
      ),
      baseUrl: 'https://example.invalid/v1',
      apiKey: 'synthetic-provider',
    });
    const agent = new Agent({
      provider,
      model: 'gpt-5.5',
      instructions: 'Answer once.',
      programmaticToolCalling: false,
    });
    await expect(agent.run('Start.')).rejects.toThrow(
      'native output-item limit',
    );
  } finally {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 20_000);
