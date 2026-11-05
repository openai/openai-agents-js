import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { once } from 'node:events';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { withTaskExchange } from '../../src/experimental/mcp-tasks/transport';

const VERSION = '2026-07-28';
const BUDGET = 256 * 1024;
const complete = { resultType: 'complete', content: [] };
const cleanup: Array<() => Promise<void>> = [];
const deferred = <T = void>() => Promise.withResolvers<T>();
type Frame = {
  jsonrpc: string;
  id: string;
  method: string;
  params: Record<string, unknown>;
};
type Recorded = {
  method?: string;
  headers: IncomingMessage['headers'];
  body: Frame;
};

async function peer(handle: (frame: Frame, response: ServerResponse) => void) {
  const requests: Recorded[] = [];
  const failures: unknown[] = [];
  const server = createServer(async (request, response) => {
    try {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      const frame = body ? (JSON.parse(body) as Frame) : ({} as Frame);
      requests.push({
        method: request.method,
        headers: request.headers,
        body: frame,
      });
      handle(frame, response);
    } catch (error) {
      failures.push(error);
      response.destroy();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing test address');
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    expect(failures).toEqual([]);
  });
  return {
    endpoint: new URL(`http://127.0.0.1:${address.port}/mcp`),
    requests,
  };
}

function json(
  response: ServerResponse,
  id: string,
  result: unknown = complete,
) {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
}
function sse(response: ServerResponse) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  response.flushHeaders();
}
function event(response: ServerResponse, value: unknown) {
  response.write(`event: message\ndata: ${JSON.stringify(value)}\n\n`);
}
function options(endpoint: URL) {
  return {
    endpoint,
    tool: 'render',
    fetch: globalThis.fetch,
    authorize: async (_signal: AbortSignal) => 'synthetic-task-token',
    timeoutMs: 2_000,
    signal: new AbortController().signal,
  };
}
function get(endpoint: URL, extra: Partial<ReturnType<typeof options>> = {}) {
  return withTaskExchange({ ...options(endpoint), ...extra }, (exchange) =>
    exchange.request('tasks/get', { taskId: 'task-one' }),
  );
}
async function unsettled(promise: Promise<unknown>) {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
}

// Preserve real fetch and its body. Observe the source-reader lifecycle and delay
// cancellation cleanup; the production MCP transport still parses every frame.
function trackedFetch(cancelGate?: Promise<void>) {
  const cancellation = deferred();
  const ready = deferred();
  const cancellationState = { sourceRejected: false, cleanupFinished: false };
  const state = { fetches: 0, readers: 0, cancelled: 0, released: 0 };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    state.fetches++;
    let response: Response;
    try {
      response = await globalThis.fetch(input, init);
    } finally {
      state.fetches--;
    }
    if (!response.body) return response;
    const reader = response.body.getReader();
    state.readers++;
    ready.resolve();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      reader.releaseLock();
      state.readers--;
      state.released++;
    };
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const item = await reader.read();
          if (item.done) {
            release();
            controller.close();
          } else controller.enqueue(item.value);
        } catch (error) {
          release();
          controller.error(error);
        }
      },
      async cancel(reason) {
        state.cancelled++;
        cancellation.resolve();
        try {
          await reader.cancel(reason);
        } catch (error) {
          cancellationState.sourceRejected = true;
          throw error;
        } finally {
          await cancelGate;
          release();
          cancellationState.cleanupFinished = true;
        }
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  return {
    fetch,
    state,
    cancellation: cancellation.promise,
    cancellationState,
    ready: ready.promise,
  };
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

describe('MCP Tasks fixed HTTP exchange', () => {
  it('preserves raw task replies, exact fresh IDs, modern envelopes and rotated per-request authorization', async () => {
    const raw = {
      resultType: 'task',
      taskId: '任务/é',
      status: 'working',
      createdAt: '2026-11-01T00:00:00Z',
      lastUpdatedAt: '2026-11-01T00:00:00Z',
      ttlMs: -1,
      pollIntervalMs: 0,
      content: [{ type: 'text', text: 'not an immediate result' }],
    };
    const server = await peer((frame, response) =>
      json(response, frame.id, raw),
    );
    let authorization = 0;
    const order: string[] = [];
    await withTaskExchange(
      {
        ...options(server.endpoint),
        fetch: async (input, init) => {
          order.push('fetch');
          return globalThis.fetch(input, init);
        },
        authorize: async () => {
          order.push('authorize');
          return `synthetic-token-${++authorization}`;
        },
      },
      async (exchange) => {
        for (const [method, params] of [
          ['server/discover', {}],
          ['tools/list', {}],
          ['tools/call', { name: 'render', arguments: {} }],
          ['tasks/get', { taskId: '任务/é' }],
          ['tasks/update', { taskId: '任务/é', inputResponses: {} }],
          ['tasks/cancel', { taskId: '任务/é' }],
        ] as const) {
          const result = await exchange.request(method, params, {
            beforeDispatch: async () => {
              order.push('beforeDispatch');
            },
          });
          expect(result).toEqual(raw);
        }
      },
    );
    expect(server.requests).toHaveLength(6);
    expect(authorization).toBe(6);
    expect(order).toEqual(
      Array.from({ length: 6 }, () => [
        'authorize',
        'beforeDispatch',
        'fetch',
      ]).flat(),
    );
    const ids = server.requests.map((request) => request.body.id);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(
      true,
    );
    expect(new Set(ids).size).toBe(6);
    for (const [index, request] of server.requests.entries()) {
      expect(request.method).toBe('POST');
      expect(request.body.jsonrpc).toBe('2.0');
      expect(request.body.params._meta).toMatchObject({
        'io.modelcontextprotocol/protocolVersion': VERSION,
        'io.modelcontextprotocol/clientCapabilities': {
          extensions: { 'io.modelcontextprotocol/tasks': {} },
        },
      });
      expect(request.headers['mcp-protocol-version']).toBe(VERSION);
      expect(request.headers['mcp-method']).toBe(request.body.method);
      expect(request.headers.authorization).toBe(
        `Bearer synthetic-token-${index + 1}`,
      );
      expect(request.headers['accept-encoding']).toBe('identity');
      expect(
        Object.keys(request.headers).some((name) =>
          name.startsWith('mcp-param-'),
        ),
      ).toBe(false);
      if (request.body.method === 'tools/call')
        expect(request.headers['mcp-name']).toBe('render');
      if (request.body.method.startsWith('tasks/')) {
        expect(request.headers['mcp-name']).toBe(
          `=?base64?${Buffer.from('任务/é').toString('base64')}?=`,
        );
        expect(request.body.params.taskId).toBe('任务/é');
        expect(request.body.params).not.toHaveProperty('name');
      }
    }
  });

  it('does not treat a completion notification as a receipt before the exact reply', async () => {
    const notified = deferred();
    const release = deferred();
    const server = await peer((frame, response) => {
      sse(response);
      event(response, {
        jsonrpc: '2.0',
        method: 'notifications/tasks/status',
        params: { taskId: 'task-one', status: 'completed' },
      });
      notified.resolve();
      void release.promise.then(() => {
        event(response, {
          jsonrpc: '2.0',
          id: frame.id,
          result: {
            resultType: 'complete',
            taskId: 'task-one',
            status: 'working',
            createdAt: '2026-11-01T00:00:00Z',
            lastUpdatedAt: '2026-11-01T00:00:00Z',
          },
        });
        response.end();
      });
    });
    const running = get(server.endpoint);
    try {
      await notified.promise;
      await unsettled(running);
      release.resolve();
      expect(await running).toMatchObject({ status: 'working' });
      expect(server.requests).toHaveLength(1);
    } finally {
      release.resolve();
    }
  });

  for (const kind of [
    'wrong ID',
    'wrong ID type',
    'peer request',
    'batch',
    'duplicate terminal',
  ] as const) {
    it(`rejects ${kind} without GET, retry or accepting a forged receipt`, async () => {
      const server = await peer((frame, response) => {
        sse(response);
        const valid = { jsonrpc: '2.0', id: frame.id, result: complete };
        const value =
          kind === 'wrong ID'
            ? { ...valid, id: `${frame.id}-foreign` }
            : kind === 'wrong ID type'
              ? { ...valid, id: 1 }
              : kind === 'peer request'
                ? {
                    jsonrpc: '2.0',
                    id: 'peer-id',
                    method: 'sampling/createMessage',
                    params: {},
                  }
                : kind === 'batch'
                  ? [valid]
                  : valid;
        event(response, value);
        if (kind === 'duplicate terminal') event(response, valid);
        response.end();
      });
      await expect(get(server.endpoint)).rejects.toThrow();
      expect(server.requests.map((request) => request.method)).toEqual([
        'POST',
      ]);
    });
  }

  it('poisons an exchange after a caught wrong-ID failure and sends no successor', async () => {
    const server = await peer((frame, response) =>
      json(response, `${frame.id}-foreign`),
    );
    await expect(
      withTaskExchange(options(server.endpoint), async (exchange) => {
        await expect(
          exchange.request('tasks/get', { taskId: 'task-one' }),
        ).rejects.toThrow();
        await expect(
          Promise.resolve().then(() =>
            exchange.request('tasks/get', { taskId: 'task-two' }),
          ),
        ).rejects.toThrow();
        return 'caught failure cannot become success';
      }),
    ).rejects.toThrow();
    expect(server.requests.map((request) => request.method)).toEqual(['POST']);
  });

  it('limits active exchanges to four, aborts a queued caller without dispatch and releases slots', async () => {
    const occupied = deferred();
    const held: Array<{ frame: Frame; response: ServerResponse }> = [];
    const server = await peer((frame, response) => {
      if (held.length < 4) {
        held.push({ frame, response });
        sse(response);
        if (held.length === 4) occupied.resolve();
      } else json(response, frame.id);
    });
    const active = Array.from({ length: 4 }, () => get(server.endpoint));
    const joined = Promise.all(active);
    const abort = new AbortController();
    try {
      await occupied.promise;
      let authorization = 0;
      const queued = get(server.endpoint, {
        signal: abort.signal,
        authorize: async () => {
          authorization++;
          return 'synthetic-queued-token';
        },
      });
      const rejected = expect(queued).rejects.toThrow();
      await unsettled(queued);
      expect(authorization).toBe(0);
      expect(server.requests).toHaveLength(4);
      abort.abort();
      await rejected;
      expect(authorization).toBe(0);
      for (const { frame, response } of held) {
        event(response, { jsonrpc: '2.0', id: frame.id, result: complete });
        response.end();
      }
      expect(await joined).toEqual(Array.from({ length: 4 }, () => complete));
      expect(await get(server.endpoint)).toEqual(complete);
      expect(server.requests).toHaveLength(5);
    } finally {
      abort.abort();
      for (const { response } of held) response.end();
      await joined.catch(() => {});
    }
  });

  it('expires a queued exchange without dispatch and leaves later capacity usable', async () => {
    const occupied = deferred();
    const held: Array<{ frame: Frame; response: ServerResponse }> = [];
    const server = await peer((frame, response) => {
      if (held.length < 4) {
        held.push({ frame, response });
        sse(response);
        if (held.length === 4) occupied.resolve();
      } else json(response, frame.id);
    });
    const active = Array.from({ length: 4 }, () => get(server.endpoint));
    const joined = Promise.all(active);
    try {
      await occupied.promise;
      let authorizations = 0;
      await expect(
        get(server.endpoint, {
          timeoutMs: 100,
          authorize: async () => {
            authorizations++;
            return 'synthetic-queued-timeout-token';
          },
        }),
      ).rejects.toMatchObject({ kind: 'interrupted' });
      expect(authorizations).toBe(0);
      expect(server.requests).toHaveLength(4);
      for (const { frame, response } of held) {
        event(response, { jsonrpc: '2.0', id: frame.id, result: complete });
        response.end();
      }
      expect(await joined).toEqual(Array.from({ length: 4 }, () => complete));
      expect(await get(server.endpoint)).toEqual(complete);
      expect(server.requests).toHaveLength(5);
    } finally {
      for (const { response } of held) response.end();
      await joined.catch(() => {});
    }
  });

  it('retains an accepted task result after a real transport close rejects', async () => {
    const taskResult = {
      resultType: 'task',
      taskId: 'accepted-private-task',
      status: 'working',
      createdAt: '2026-11-01T00:00:00Z',
      lastUpdatedAt: '2026-11-01T00:00:00Z',
      ttlMs: null,
      pollIntervalMs: 0,
    };
    const observed = trackedFetch();
    const server = await peer((frame, response) => {
      sse(response);
      event(response, { jsonrpc: '2.0', id: frame.id, result: taskResult });
      // Leave the real SSE body open. The exchange must join parser/source
      // completion before its close call, even when that close later rejects.
    });
    const originalClose = StreamableHTTPClientTransport.prototype.close;
    let realCloseFinished = false;
    let stateAtClose: typeof observed.state | undefined;
    const fault = vi
      .spyOn(StreamableHTTPClientTransport.prototype, 'close')
      .mockImplementation(async function (this: StreamableHTTPClientTransport) {
        stateAtClose = { ...observed.state };
        await originalClose.call(this);
        realCloseFinished = true;
        // Fault injection is limited to a rejection after the actual close.
        throw new Error('synthetic-private-close-failure');
      });
    try {
      const result = await withTaskExchange(
        { ...options(server.endpoint), fetch: observed.fetch },
        (exchange) =>
          exchange.request('tools/call', { name: 'render', arguments: {} }),
      );
      expect(result).toEqual(taskResult);
      expect(fault).toHaveBeenCalledTimes(1);
      expect(realCloseFinished).toBe(true);
      expect(stateAtClose).toEqual({
        fetches: 0,
        readers: 0,
        cancelled: 1,
        released: 1,
      });
      expect(server.requests.map((request) => request.method)).toEqual([
        'POST',
      ]);
    } finally {
      fault.mockRestore();
    }
    // A later ordinary exchange proves the failed close released its slot.
    expect(await get(server.endpoint)).toEqual(taskResult);
    expect(server.requests).toHaveLength(2);
  });

  for (const status of [401, 403, 307, 503]) {
    it(`does not refresh, redirect or replay HTTP ${status}`, async () => {
      const server = await peer((_frame, response) => {
        response.writeHead(status, {
          'Content-Type': 'application/json',
          Location: '/other',
        });
        response.end(
          JSON.stringify({ privatePeerError: 'synthetic-peer-private-detail' }),
        );
      });
      let authorized = 0;
      const error = await get(server.endpoint, {
        authorize: async () => {
          authorized++;
          return 'synthetic-private-bearer';
        },
      }).catch((error) => error);
      expect(error).toBeInstanceOf(Error);
      expect(authorized).toBe(1);
      expect(server.requests.map((request) => request.method)).toEqual([
        'POST',
      ]);
      for (const privateValue of [
        'synthetic-peer-private-detail',
        'synthetic-private-bearer',
        server.endpoint.href,
      ])
        expect(inspect(error, { depth: null })).not.toContain(privateValue);
      expect(error).not.toHaveProperty('cause');
    });
  }

  it('ends a priming-only SSE stream without GET resumption', async () => {
    const server = await peer((_frame, response) => {
      sse(response);
      response.end('id: resume-forbidden\nretry: 1\ndata:\n\n');
    });
    await expect(get(server.endpoint)).rejects.toThrow();
    expect(server.requests.map((request) => request.method)).toEqual(['POST']);
  });

  it('admits exactly 256 KiB of JSON bytes, including multibyte text', async () => {
    const server = await peer((frame, response) => {
      const result = { resultType: 'complete', content: [], padding: 'é' };
      const envelope = { jsonrpc: '2.0', id: frame.id, result };
      result.padding += 'a'.repeat(
        BUDGET - Buffer.byteLength(JSON.stringify(envelope)),
      );
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(envelope));
    });
    expect(await get(server.endpoint)).toMatchObject({
      resultType: 'complete',
    });
  });

  for (const kind of [
    'JSON',
    'SSE',
    'HTTP error',
    'declared length',
    'content encoding',
  ] as const) {
    it(`rejects an inadmissible ${kind} body before accepting a receipt`, async () => {
      const server = await peer((frame, response) => {
        if (kind === 'SSE') {
          sse(response);
          response.write(`: ${'é'.repeat(BUDGET / 2)}\n\n`);
          event(response, { jsonrpc: '2.0', id: frame.id, result: complete });
          response.end();
        } else {
          response.writeHead(kind === 'HTTP error' ? 500 : 200, {
            'Content-Type': 'application/json',
            ...(kind === 'declared length'
              ? { 'Content-Length': String(BUDGET + 1) }
              : {}),
            ...(kind === 'content encoding'
              ? { 'Content-Encoding': 'gzip' }
              : {}),
          });
          response.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: frame.id,
              result: { ...complete, padding: 'é'.repeat(BUDGET / 2) },
            }),
          );
        }
      });
      await expect(get(server.endpoint)).rejects.toMatchObject({
        kind: 'unsupported',
      });
      expect(server.requests.map((request) => request.method)).toEqual([
        'POST',
      ]);
    });
  }

  for (const ending of [
    'matching receipt',
    'malformed event',
    'caller abort',
    'deadline',
  ] as const) {
    it(`joins source-reader cancellation before returning after ${ending} on an open SSE body`, async () => {
      const sent = deferred();
      const gate = deferred();
      const observed = trackedFetch(gate.promise);
      const abort = new AbortController();
      const server = await peer((frame, response) => {
        sse(response);
        if (ending === 'matching receipt')
          event(response, { jsonrpc: '2.0', id: frame.id, result: complete });
        else if (ending === 'malformed event')
          response.write('event: message\ndata: {bad-json\n\n');
        else response.write(': waiting\n\n');
        sent.resolve();
      });
      const running = get(server.endpoint, {
        fetch: observed.fetch,
        signal: abort.signal,
        timeoutMs: ending === 'deadline' ? 100 : 2_000,
      });
      const outcome = running.then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, error }),
      );
      try {
        await sent.promise;
        if (ending === 'caller abort') {
          await observed.ready;
          abort.abort(new Error('synthetic-caller-private-error'));
        }
        await observed.cancellation;
        await unsettled(outcome);
        expect(observed.cancellationState.cleanupFinished).toBe(false);
        gate.resolve();
        const result = await outcome;
        expect(observed.cancellationState.cleanupFinished).toBe(true);
        expect(result.ok).toBe(ending === 'matching receipt');
        expect(observed.state).toEqual({
          fetches: 0,
          readers: 0,
          cancelled: 1,
          released: 1,
        });
        expect(server.requests.map((request) => request.method)).toEqual([
          'POST',
        ]);
      } finally {
        gate.resolve();
        abort.abort();
      }
    });
  }

  it('joins an in-flight host fetch and releases its response after caller abort', async () => {
    const entered = deferred();
    const gate = deferred();
    const abort = new AbortController();
    const observed = trackedFetch();
    let fetchFinished = false;
    const server = await peer((frame, response) => json(response, frame.id));
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const response = await observed.fetch(input, init);
      entered.resolve();
      await gate.promise;
      fetchFinished = true;
      return response;
    };
    const running = get(server.endpoint, { fetch, signal: abort.signal });
    const rejected = expect(running).rejects.toThrow();
    try {
      await entered.promise;
      abort.abort();
      await unsettled(running);
      expect(fetchFinished).toBe(false);
      gate.resolve();
      await rejected;
      expect(fetchFinished).toBe(true);
      expect(observed.state.fetches).toBe(0);
      expect(observed.state.readers).toBe(0);
      expect(observed.state.released).toBe(1);
      expect(server.requests.map((request) => request.method)).toEqual([
        'POST',
      ]);
    } finally {
      gate.resolve();
      abort.abort();
    }
  });

  for (const phase of ['authorize', 'beforeDispatch'] as const) {
    it(`joins an entered ${phase} callback on abort and sends no request`, async () => {
      const entered = deferred();
      const gate = deferred();
      const abort = new AbortController();
      let callbackFinished = false;
      const server = await peer((frame, response) => json(response, frame.id));
      const held = async (signal: AbortSignal) => {
        entered.resolve();
        if (!signal.aborted)
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          );
        await gate.promise;
        callbackFinished = true;
      };
      const running = withTaskExchange(
        {
          ...options(server.endpoint),
          signal: abort.signal,
          authorize:
            phase === 'authorize'
              ? async (signal) => {
                  await held(signal);
                  return 'synthetic-token';
                }
              : options(server.endpoint).authorize,
        },
        (exchange) =>
          exchange.request(
            'tasks/cancel',
            { taskId: 'task-one' },
            {
              beforeDispatch:
                phase === 'beforeDispatch' ? held : async () => {},
            },
          ),
      );
      const rejected = expect(running).rejects.toThrow();
      try {
        await entered.promise;
        abort.abort();
        await unsettled(running);
        expect(callbackFinished).toBe(false);
        expect(server.requests).toEqual([]);
        gate.resolve();
        await rejected;
        expect(callbackFinished).toBe(true);
        expect(server.requests).toEqual([]);
      } finally {
        gate.resolve();
        abort.abort();
      }
    });
  }
});
