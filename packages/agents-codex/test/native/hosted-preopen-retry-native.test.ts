import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import OpenAI from 'openai';
import { WebSocketServer } from 'ws';
import { expect, it } from 'vitest';
import {
  Agent,
  HostedResponsesWebSocketModel,
  NativeProvider,
  type ModelRetryAdvice,
} from '../../src';

it.each(['buffered', 'streamed'] as const)(
  'retries a hosted create after the connecting socket closes before any frame (%s)',
  async (mode) => {
    const http = createServer();
    const sockets = new WebSocketServer({ noServer: true });
    let upgrades = 0;
    let frames = 0;
    let retries = 0;
    const upgradesSeen: {
      url: string | undefined;
      beta: string | string[] | undefined;
      marker: string | string[] | undefined;
      removed: string | string[] | undefined;
    }[] = [];
    const advice: (ModelRetryAdvice | undefined)[] = [];
    http.on('upgrade', (request, socket, head) => {
      upgrades++;
      upgradesSeen.push({
        url: request.url,
        beta: request.headers['openai-beta'],
        marker: request.headers['x-owned-socket'],
        removed: request.headers['x-remove'],
      });
      if (upgrades === 1) {
        socket.destroy();
        return;
      }
      sockets.handleUpgrade(request, socket, head, (peer) => {
        peer.on('message', () => {
          frames++;
          const item = {
            type: 'message',
            id: 'msg_preopen',
            role: 'assistant',
            status: 'completed',
            phase: 'final_answer',
            agent: { agent_name: '/root' },
            content: [{ type: 'output_text', text: 'recovered' }],
          };
          peer.send(
            JSON.stringify({
              type: 'response.created',
              response: { id: 'resp_preopen', output: [] },
            }),
          );
          peer.send(
            JSON.stringify({
              type: 'response.output_item.done',
              output_index: 0,
              item,
            }),
          );
          peer.send(
            JSON.stringify({
              type: 'response.completed',
              response: {
                id: 'resp_preopen',
                status: 'completed',
                output: [item],
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
              },
            }),
          );
        });
      });
    });
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    const client = new OpenAI({
      apiKey: 'synthetic-preopen',
      defaultQuery: { caller: 'preserved', shared: 'base' },
      defaultHeaders: { 'X-Remove': 'base' },
      baseURL: `http://127.0.0.1:${(http.address() as AddressInfo).port}/v1`,
    });
    const model = HostedResponsesWebSocketModel.fromOpenAI(client, undefined, {
      requestOptions: {
        headers: {
          'OpenAI-Beta': 'existing-beta',
          'X-Owned-Socket': 'selected',
          'X-Remove': null,
        },
        query: {
          shared: 'request',
          scoped: 'yes',
          include: ['first', 'second'],
        },
      },
    });
    const original = model.getRetryAdvice.bind(model);
    model.getRetryAdvice = (request) => {
      const value = original(request);
      advice.push(value);
      return value;
    };
    try {
      await using provider = new NativeProvider({
        modelBackend:
          mode === 'streamed'
            ? model
            : {
                complete: model.complete.bind(model),
                getRetryAdvice: model.getRetryAdvice.bind(model),
                cleanupOnRunEnd: model.cleanupOnRunEnd.bind(model),
              },
      });
      const result = await new Agent({
        provider,
        model: 'gpt-5.5',
        instructions: 'Answer.',
        modelSettings: {
          retry: {
            maxRetries: 1,
            policy() {
              retries++;
              return { retry: true, delayMs: 0 };
            },
          },
        },
      }).run('Begin.');
      expect(result.finalOutput).toBe('recovered');
      expect(result.runUsage).toMatchObject({
        requests: 1,
        missingUsageRequests: 0,
        totalTokens: 2,
      });
      expect(upgrades).toBe(2);
      expect(frames).toBe(1);
      expect(retries).toBe(1);
      for (const opening of upgradesSeen) {
        const url = new URL(opening.url!, 'http://fixture');
        expect(url.searchParams.getAll('include[]')).toEqual([
          'first',
          'second',
        ]);
        url.searchParams.delete('include[]');
        expect(Object.fromEntries(url.searchParams)).toEqual({
          caller: 'preserved',
          shared: 'request',
          scoped: 'yes',
        });
        expect(opening.beta).toBe('existing-beta,responses_multi_agent=v1');
        expect(opening.marker).toBe('selected');
        expect(opening.removed).toBeUndefined();
      }
      expect(advice).toEqual([
        expect.objectContaining({
          suggested: true,
          replaySafety: 'safe',
          responseStarted: false,
        }),
      ]);
    } finally {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  },
  30_000,
);

it('keeps a hosted create unsafe after a physical write and close', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  let frames = 0;
  let upgrades = 0;
  let policies = 0;
  server.on('connection', (peer) => {
    upgrades++;
    peer.on('message', () => {
      frames++;
      peer.terminate();
    });
  });
  const client = new OpenAI({
    apiKey: 'synthetic-dispatched',
    baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
  });
  const model = HostedResponsesWebSocketModel.fromOpenAI(client);
  try {
    await using provider = new NativeProvider({ modelBackend: model });
    await expect(
      new Agent({
        provider,
        model: 'gpt-5.5',
        instructions: 'Answer.',
        modelSettings: {
          retry: {
            maxRetries: 1,
            policy() {
              policies++;
              return { retry: true, delayMs: 0 };
            },
          },
        },
      }).run('Begin.'),
    ).rejects.toThrow();
    expect(frames).toBe(1);
    expect(upgrades).toBe(1);
    expect(policies).toBe(0);
  } finally {
    for (const peer of server.clients) peer.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 30_000);

it.each(['cancel', 'timeout'] as const)(
  'settles a connecting hosted socket on %s without a physical frame',
  async (mode) => {
    const http = createServer();
    const held = new Set<import('node:stream').Duplex>();
    const controller = new AbortController();
    const closed = Promise.withResolvers<void>();
    let upgrades = 0;
    let policies = 0;
    http.on('upgrade', (_request, socket) => {
      upgrades++;
      held.add(socket);
      socket.resume();
      socket.on('end', () => socket.end());
      socket.on('close', () => {
        held.delete(socket);
        closed.resolve();
      });
      if (mode === 'cancel')
        controller.abort(new Error('cancel connecting fixture'));
    });
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    const client = new OpenAI({
      apiKey: 'synthetic-connecting',
      baseURL: `http://127.0.0.1:${(http.address() as AddressInfo).port}/v1`,
    });
    const model = HostedResponsesWebSocketModel.fromOpenAI(client);
    try {
      await using provider = new NativeProvider({ modelBackend: model });
      const started = Date.now();
      await expect(
        new Agent({
          provider,
          model: 'gpt-5.5',
          instructions: 'Answer.',
          modelSettings: {
            ...(mode === 'timeout' ? { attemptTimeoutMs: 150 } : {}),
            retry: {
              maxRetries: 0,
              policy() {
                policies++;
                return { retry: false };
              },
            },
          },
        }).run('Begin.', { signal: controller.signal }),
      ).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(upgrades).toBe(1);
      expect(policies).toBe(0);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          closed.promise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error('Connecting socket was retained after settlement'),
                ),
              1_000,
            );
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
      expect(held.size).toBe(0);
    } finally {
      for (const socket of held) socket.destroy();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  },
  15_000,
);

it('keeps caller-owned factories unsafe even when readyState claims no dispatch', async () => {
  const { EventEmitter } = await import('node:events');
  const { bindProviderRequestAccounting } =
    await import('../../src/runtime/provider-request-accounting');
  const shared = new Error('shared transport failure');
  let sent = 0;
  let connecting = true;
  const model = new HostedResponsesWebSocketModel(() => {
    const socket = Object.assign(new EventEmitter(), {
      readyState: connecting ? 0 : 1,
    });
    return {
      socket,
      send() {
        sent++;
      },
      close() {
        socket.readyState = 3;
        socket.emit('close');
      },
      async *[Symbol.asyncIterator]() {
        await Promise.reject(shared);
        yield { type: 'open' };
      },
    } as unknown as import('../../src').ResponsesSocket;
  });
  const failures: unknown[] = [];
  for (const turnId of ['opening', 'dispatched']) {
    const runOwner = Object.freeze({ sessionId: 'error-reuse', turnId });
    const request = {
      body: { model: 'gpt-5.5', input: [] },
      context: undefined,
      sessionId: runOwner.sessionId,
      turnId,
      signal: new AbortController().signal,
      runOwner,
    };
    bindProviderRequestAccounting(request, (operation) =>
      operation.operation === 'create' ? 'shared-error-lineage' : null,
    );
    try {
      for await (const _event of model.stream(request)) {
        /* Both transports have been rejecting their first read. */
      }
    } catch (error) {
      failures.push(error);
    } finally {
      await model.cleanupOnRunEnd(runOwner);
    }
    connecting = false;
  }
  expect(sent).toBe(1);
  const advice = (error: unknown) =>
    model.getRetryAdvice({ error } as Parameters<
      typeof model.getRetryAdvice
    >[0]);
  expect(advice(failures[0])).toMatchObject({ replaySafety: 'unsafe' });
  expect(advice(failures[1])).toMatchObject({ replaySafety: 'unsafe' });
});
