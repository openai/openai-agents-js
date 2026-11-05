import { randomUUID } from 'node:crypto';
import {
  StreamableHTTPClientTransport,
  type FetchLike,
} from '@modelcontextprotocol/client';
import {
  encodeMcpName,
  makeRequest,
  VERSION,
  type TasksMethod,
} from './protocol';

const MAX_RESPONSE_BYTES = 256 * 1024;
let activeExchanges = 0;
const waiting: Array<() => void> = [];

/** Fixed messages keep peer responses and host callback causes private. */
export class TaskTransportError extends Error {
  constructor(
    readonly kind:
      'unavailable' | 'unsupported' | 'authorization' | 'interrupted',
  ) {
    super(`MCP Tasks exchange ${kind}.`);
    this.name = 'TaskTransportError';
  }
}

function completion() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function acquire(signal: AbortSignal): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const release = () => {
      activeExchanges--;
      waiting.shift()?.();
    };
    const grant = () => {
      signal.removeEventListener('abort', abort);
      activeExchanges++;
      resolve(release);
    };
    const abort = () => {
      const index = waiting.indexOf(grant);
      if (index !== -1) waiting.splice(index, 1);
      reject(new TaskTransportError('interrupted'));
    };
    if (signal.aborted) abort();
    else if (activeExchanges < 4) grant();
    else {
      waiting.push(grant);
      signal.addEventListener('abort', abort, { once: true });
    }
  });
}

export interface TaskExchangeOptions {
  endpoint: URL;
  tool: string;
  fetch: FetchLike;
  authorize: (signal: AbortSignal) => Promise<string>;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface TaskExchange {
  request(
    method: TasksMethod,
    params?: Record<string, unknown>,
    options?: { beforeDispatch?: (signal: AbortSignal) => Promise<void> },
  ): Promise<Record<string, unknown>>;
}

interface PendingRequest {
  id: string;
  method: TasksMethod;
  body: string;
  name?: string;
  dispatched: boolean;
  terminal: boolean;
  sse: boolean;
  result?: Record<string, unknown>;
  failure?: TaskTransportError;
  beforeDispatch?: (signal: AbortSignal) => Promise<void>;
  stopBody?: () => Promise<void>;
  ended: ReturnType<typeof completion>;
  outcome: ReturnType<typeof completion>;
}

export function fixedEndpoint(endpoint: string | URL): URL {
  const raw = typeof endpoint === 'string' ? endpoint : endpoint.href;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TaskTransportError('unsupported');
  }
  if (
    raw.includes('?') ||
    raw.includes('#') ||
    url.username ||
    url.password ||
    url.port === '0' ||
    (url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      ))
  )
    throw new TaskTransportError('unsupported');
  return url;
}

/** Own one sequential exchange; do not close the transport before its parser ends. */
export async function withTaskExchange<T>(
  options: TaskExchangeOptions,
  use: (exchange: TaskExchange) => Promise<T>,
): Promise<T> {
  const endpoint = fixedEndpoint(options.endpoint);
  const tool = options.tool;
  const fetch = options.fetch;
  const authorize = options.authorize;
  if (
    !Number.isFinite(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    options.timeoutMs > 2 ** 31 - 1
  ) {
    throw new TaskTransportError('unsupported');
  }
  const local = new AbortController();
  const signal = AbortSignal.any([options.signal, local.signal]);
  const timer = setTimeout(() => local.abort(), options.timeoutMs);
  let release: (() => void) | undefined;
  let current: PendingRequest | undefined;
  let running: Promise<unknown> | undefined;
  let accepting = true;
  let exchangeFailure: TaskTransportError | undefined;

  const fail = (slot: PendingRequest, kind: TaskTransportError['kind']) => {
    slot.failure ??= new TaskTransportError(kind);
    exchangeFailure ??= slot.failure;
    void slot.stopBody?.();
    slot.outcome.resolve();
  };
  const checkActive = () => {
    if (exchangeFailure) throw exchangeFailure;
    if (signal.aborted || !accepting)
      throw new TaskTransportError('interrupted');
  };

  const guardedFetch: FetchLike = async (input, init) => {
    const slot = current;
    checkActive();
    if (
      !slot ||
      slot.dispatched ||
      String(input) !== endpoint.href ||
      init?.method !== 'POST' ||
      init.body !== slot.body
    ) {
      throw new TaskTransportError('unsupported');
    }
    const headers = new Headers(init.headers);
    let routingHeader = false;
    headers.forEach((_value, name) => {
      if (name.toLowerCase().startsWith('mcp-param-')) routingHeader = true;
    });
    if (
      headers.get('mcp-protocol-version') !== VERSION ||
      headers.get('mcp-method') !== slot.method ||
      headers.get('content-type') !== 'application/json' ||
      routingHeader
    ) {
      throw new TaskTransportError('unsupported');
    }
    if (slot.name !== undefined) {
      if (
        slot.method === 'tools/call' &&
        headers.get('mcp-name') !== encodeMcpName(slot.name)
      ) {
        throw new TaskTransportError('unsupported');
      }
      headers.set('mcp-name', encodeMcpName(slot.name));
    } else if (headers.has('mcp-name'))
      throw new TaskTransportError('unsupported');
    // Reserve the sole dispatch before awaiting host callbacks; no retry may reuse it.
    slot.dispatched = true;
    let token: string;
    try {
      token = await authorize(signal);
    } catch {
      throw new TaskTransportError('authorization');
    }
    checkActive();
    if (typeof token !== 'string' || !/^[\x21-\x7e]+$/.test(token)) {
      throw new TaskTransportError('authorization');
    }
    headers.set('authorization', `Bearer ${token}`);
    headers.set('accept-encoding', 'identity');
    if (slot.beforeDispatch) {
      try {
        await slot.beforeDispatch(signal);
      } catch {
        throw new TaskTransportError('authorization');
      }
      checkActive();
    }
    const response = await fetch(endpoint, {
      ...init,
      headers,
      redirect: 'error',
      signal,
    });
    if (signal.aborted || !accepting) {
      await response.body?.cancel().catch(() => {});
      throw new TaskTransportError('interrupted');
    }
    if (response.status === 401 || response.status === 403) {
      slot.failure ??= new TaskTransportError('authorization');
    }
    const encoding = response.headers.get('content-encoding');
    const length = response.headers.get('content-length');
    if (
      (encoding && encoding.trim().toLowerCase() !== 'identity') ||
      (length !== null &&
        (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES))
    ) {
      await response.body?.cancel().catch(() => {});
      throw new TaskTransportError('unsupported');
    }
    slot.sse =
      response.ok &&
      response.status !== 202 &&
      response.headers
        .get('content-type')
        ?.split(';', 1)[0]
        .trim()
        .toLowerCase() === 'text/event-stream';
    if (!response.body) return response;

    const reader = response.body.getReader();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let stopped = false;
    let released = false;
    let received = 0;
    let reading: Promise<void> | undefined;
    let cancelling: Promise<void> | undefined;
    const releaseReader = () => {
      if (!released) {
        released = true;
        reader.releaseLock();
      }
    };
    slot.stopBody = () => {
      if (!stopped) {
        stopped = true;
        try {
          controller.close();
        } catch {
          /* The parser may already have cancelled its input. */
        }
        cancelling = reader
          .cancel()
          .catch(() => {})
          .then(async () => {
            await reading;
            releaseReader();
          });
      }
      return cancelling ?? Promise.resolve();
    };
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
      },
      pull() {
        reading = (async () => {
          try {
            const item = await reader.read();
            if (stopped) return;
            if (item.done) {
              stopped = true;
              controller.close();
              releaseReader();
              return;
            }
            received += item.value.byteLength;
            if (received > MAX_RESPONSE_BYTES) {
              fail(slot, 'unsupported');
              return;
            }
            controller.enqueue(item.value);
          } catch {
            if (!stopped) fail(slot, 'unavailable');
          }
        })();
        return reading;
      },
      cancel() {
        return slot.stopBody!();
      },
    });
    const bounded = new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
    // The transport flattens JSON batches. Reject them before that loses the boundary.
    const parseJson = bounded.json.bind(bounded);
    bounded.json = async () => {
      const value: unknown = await parseJson();
      if (Array.isArray(value)) throw new TaskTransportError('unsupported');
      return value;
    };
    return bounded;
  };

  const transport = new StreamableHTTPClientTransport(endpoint, {
    fetch: guardedFetch,
    reconnectionOptions: {
      maxRetries: 0,
      maxReconnectionDelay: 0,
      initialReconnectionDelay: 0,
      reconnectionDelayGrowFactor: 1,
    },
  });
  transport.onmessage = (message) => {
    const slot = current;
    if (!slot) return;
    if ('method' in message) {
      if ('id' in message) fail(slot, 'unsupported');
      return;
    }
    if (message.id !== slot.id || slot.terminal) {
      fail(slot, 'unsupported');
      return;
    }
    slot.terminal = true;
    if ('error' in message) fail(slot, 'unavailable');
    else {
      slot.result = message.result;
      void slot.stopBody?.();
      slot.outcome.resolve();
    }
  };
  transport.onerror = (error) => {
    if (current)
      fail(
        current,
        error instanceof TaskTransportError ? error.kind : 'unavailable',
      );
  };
  transport.onclose = () => {
    if (current) fail(current, 'unavailable');
  };

  const request: TaskExchange['request'] = (
    method,
    params = {},
    requestOptions,
  ) => {
    checkActive();
    if (current) throw new TaskTransportError('unsupported');
    // Capture nested arguments before the first await; the caller cannot change routing later.
    const captured: Record<string, unknown> = JSON.parse(
      JSON.stringify(params),
    );
    const id = randomUUID();
    const message = makeRequest(id, method, captured);
    const name =
      method === 'tools/call'
        ? captured.name
        : method.startsWith('tasks/')
          ? captured.taskId
          : undefined;
    if (
      (method === 'tools/call' && name !== tool) ||
      (method.startsWith('tasks/') && (typeof name !== 'string' || !name)) ||
      ((method === 'tasks/update' || method === 'tasks/cancel') &&
        !requestOptions?.beforeDispatch)
    ) {
      throw new TaskTransportError('unsupported');
    }
    const slot: PendingRequest = {
      id,
      method,
      name: typeof name === 'string' ? name : undefined,
      body: JSON.stringify(message),
      dispatched: false,
      terminal: false,
      sse: false,
      beforeDispatch: requestOptions?.beforeDispatch,
      ended: completion(),
      outcome: completion(),
    };
    current = slot;
    const abort = () => fail(slot, 'interrupted');
    signal.addEventListener('abort', abort, { once: true });
    running = (async () => {
      const sent = transport
        .send(message, {
          onRequestStreamEnd() {
            slot.ended.resolve();
            if (!slot.terminal) fail(slot, 'unavailable');
          },
        })
        .catch((error: unknown) => {
          fail(
            slot,
            error instanceof TaskTransportError ? error.kind : 'unavailable',
          );
        })
        .finally(() => {
          if (!slot.sse) slot.outcome.resolve();
        });
      try {
        await slot.outcome.promise;
        await sent;
        await slot.stopBody?.();
        if (slot.sse) await slot.ended.promise;
        if (slot.failure) throw slot.failure;
        if (!slot.result) throw new TaskTransportError('unavailable');
        return slot.result;
      } finally {
        signal.removeEventListener('abort', abort);
        current = undefined;
      }
    })();
    return running as Promise<Record<string, unknown>>;
  };

  try {
    release = await acquire(signal);
    checkActive();
    await transport.start();
    const result = await use({ request });
    if (exchangeFailure) throw exchangeFailure;
    return result;
  } catch (error) {
    throw error instanceof TaskTransportError
      ? error
      : new TaskTransportError('unavailable');
  } finally {
    accepting = false;
    local.abort();
    await running?.catch(() => {});
    transport.onmessage = undefined;
    transport.onerror = undefined;
    transport.onclose = undefined;
    await transport.close().catch(() => {});
    clearTimeout(timer);
    release?.();
  }
}
