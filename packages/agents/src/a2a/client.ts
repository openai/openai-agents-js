import { AgentCard } from '@a2a-js/sdk';
import {
  ClientFactory,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  type Client,
} from '@a2a-js/sdk/client';
import {
  TraceContext,
  type TraceContextHeaders,
} from '../runtime/trace-context';

export type A2AOperation = 'start' | 'observe' | 'respond' | 'cancel';

/** Fixed host configuration. Neither the model nor the remote card selects routes. */
export interface A2AEndpoint {
  readonly name: string;
  readonly cardUrl: string;
  readonly rpcUrl: string;
}

/** Defensive adapter bounds, independent of provider quotas. */
export interface A2ALimits {
  readonly bodyBytes?: number;
  readonly inputBytes?: number;
  readonly checkpointBytes?: number;
  readonly timeoutMs?: number;
}

export class A2AError extends Error {
  constructor(
    readonly reason: 'unsupported' | 'authorization' | 'unavailable' | 'limit',
  ) {
    super(`A2A ${reason}`);
    this.name = 'A2AError';
  }
}

export function fixedUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new A2AError('unsupported');
  }
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      ))
  )
    throw new A2AError('unsupported');
  return url.href;
}

export function bound(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0 || result > 2 ** 31 - 1)
    throw new A2AError('unsupported');
  return result;
}

export function checkBytes(value: unknown, limit: number): void {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new A2AError('unsupported');
  }
  if (encoded === undefined || Buffer.byteLength(encoded) > limit)
    throw new A2AError('limit');
}

async function boundedResponse(
  response: Response,
  limit: number,
): Promise<Response> {
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new A2AError('unavailable');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) throw new A2AError('limit');
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return new Response(Buffer.concat(chunks), {
    status: response.status,
    headers: response.headers,
  });
}

export interface A2AConnectionOptions {
  /** Resolve credentials only after exact interface admission. Return an unprefixed bearer token. */
  authorization(operation: A2AOperation): Promise<string>;
  /** The host's egress implementation. Redirects are always refused. */
  fetch?: typeof fetch;
  limits?: A2ALimits;
  signal?: AbortSignal;
  /** Explicit caller-owned trace parent; never loaded from a remote card or saved journal. */
  parentTrace?: TraceContext | TraceContextHeaders | null;
  /** Current host policy/ownership fence, repeated after asynchronous boundaries. */
  current?(): Promise<void>;
  /** Durable one-shot reservation immediately before a mutation is sent. */
  reserve?(operation: Exclude<A2AOperation, 'observe'>): Promise<void>;
}

/** Discover anonymously, admit one exact A2A 1.0 JSON-RPC interface, then use the official client. */
export async function connectA2A(
  endpoint: A2AEndpoint,
  options: A2AConnectionOptions,
): Promise<Client> {
  const cardUrl = fixedUrl(endpoint.cardUrl);
  const rpcUrl = fixedUrl(endpoint.rpcUrl);
  if (!endpoint.name) throw new A2AError('unsupported');
  const maxBody = bound(options.limits?.bodyBytes, 2 * 1024 * 1024);
  const timeout = bound(options.limits?.timeoutMs, 30_000);
  const inputLimit = bound(options.limits?.inputBytes, 1024 * 1024);
  const transportFetch = options.fetch ?? fetch;
  const parent =
    options.parentTrace == null
      ? undefined
      : options.parentTrace instanceof TraceContext
        ? options.parentTrace
        : new TraceContext(options.parentTrace);
  const current = async () => {
    options.signal?.throwIfAborted();
    try {
      await options.current?.();
    } catch {
      throw new A2AError('authorization');
    }
    options.signal?.throwIfAborted();
  };
  const request = async (
    url: string,
    init: RequestInit,
    credential?: string,
  ): Promise<Response> => {
    try {
      const signal = AbortSignal.any([
        AbortSignal.timeout(timeout),
        ...(options.signal ? [options.signal] : []),
        ...(init.signal ? [init.signal] : []),
      ]);
      const headers = new Headers(init.headers);
      if (credential !== undefined && parent)
        for (const [key, value] of Object.entries(parent.toHeaders()))
          headers.set(key, value);
      if (credential !== undefined)
        headers.set('Authorization', `Bearer ${credential}`);
      return await boundedResponse(
        await transportFetch(url, {
          ...init,
          headers,
          signal,
          redirect: 'error',
          credentials: 'omit',
        }),
        maxBody,
      );
    } catch (error) {
      if (error instanceof A2AError) throw error;
      throw new A2AError('unavailable');
    }
  };
  await current();
  const resolver = new DefaultAgentCardResolver({
    fetchImpl: async (url, init) => {
      if (String(url) !== cardUrl) throw new A2AError('unsupported');
      return request(cardUrl, init ?? {});
    },
  });
  let card: AgentCard;
  try {
    card = await resolver.resolve(cardUrl, '');
  } catch (error) {
    if (error instanceof A2AError) throw error;
    throw new A2AError('unsupported');
  }
  if (
    !card ||
    typeof card !== 'object' ||
    !Array.isArray(card.supportedInterfaces)
  )
    throw new A2AError('unsupported');
  const admitted = card.supportedInterfaces.find(
    (entry) =>
      entry &&
      entry.protocolVersion === '1.0' &&
      entry.protocolBinding === 'JSONRPC' &&
      entry.url === rpcUrl &&
      !entry.tenant,
  );
  if (!admitted) throw new A2AError('unsupported');
  await current();
  return new ClientFactory({
    transports: [
      new JsonRpcTransportFactory({
        fetchImpl: async (url, init) => {
          if (String(url) !== rpcUrl || typeof init?.body !== 'string')
            throw new A2AError('unsupported');
          checkBytes(init.body, inputLimit);
          let rpc: {
            method: string;
            id: unknown;
            params?: { message?: { taskId?: string } };
          };
          try {
            rpc = JSON.parse(init.body);
          } catch {
            throw new A2AError('unsupported');
          }
          const method = rpc.method;
          const operation: A2AOperation =
            method === 'GetTask'
              ? 'observe'
              : method === 'CancelTask'
                ? 'cancel'
                : method === 'SendMessage'
                  ? rpc.params?.message?.taskId
                    ? 'respond'
                    : 'start'
                  : (() => {
                      throw new A2AError('unsupported');
                    })();
          init.signal?.throwIfAborted();
          await current();
          let token: string;
          try {
            token = await options.authorization(operation);
            if (typeof token !== 'string' || !token || /[\r\n]/.test(token))
              throw new A2AError('authorization');
            new Headers().set('Authorization', `Bearer ${token}`);
          } catch {
            throw new A2AError('authorization');
          }
          await current();
          if (operation !== 'observe') {
            try {
              await options.reserve?.(operation);
            } catch {
              throw new A2AError('authorization');
            }
            await current();
          }
          init.signal?.throwIfAborted();
          const response = await request(rpcUrl, init, token);
          // Peer exception text and malformed JSON must not enter the caller's error chain.
          let result: unknown;
          try {
            result = await response.json();
          } catch {
            throw new A2AError('unsupported');
          }
          if (
            !result ||
            typeof result !== 'object' ||
            'error' in result ||
            !('id' in result) ||
            result.id !== rpc.id
          )
            throw new A2AError('unavailable');
          return new Response(JSON.stringify(result), {
            status: response.status,
            headers: response.headers,
          });
        },
      }),
    ],
    clientConfig: { polling: true },
  }).createFromAgentCard({ ...card, supportedInterfaces: [{ ...admitted }] });
}
