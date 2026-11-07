import {
  createServer,
  validateHeaderName,
  validateHeaderValue,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { Duplex } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import * as wsModule from 'ws';
import type { WebSocket, WebSocketServer } from 'ws';
import { once } from 'node:events';
import type {
  NativeModelResponse,
  NativeModelWebSocket,
  _ProviderHttpTransports,
} from '../../native/index.js';
import {
  binding,
  decode,
  encode,
  jsonObject,
  parseNative,
  type JsonObject,
  type JsonValue,
  type Engine,
} from './binding';
import type { NativeConfig } from './config';
import type { RuntimeOptions } from './options';
import type { TokenUsageInfo } from './run-events';
import { NativeError } from './session';

const maxWebsocketRequestBytes = 64 * 1024 * 1024;

const privateHeaders = new Set([
  'connection',
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'upgrade',
  'x-agents-model-grant',
  'x-codex-agents-native-route',
  'x-sdk-sentinel-grant',
]);

function responseHeaders(headers: [string, string][]): [string, string][] {
  const nominated = headers
    .filter(([name]) => name.toLowerCase() === 'connection')
    .flatMap(([, value]) =>
      value.split(',').map((name) => name.trim().toLowerCase()),
    );
  return headers.filter(
    ([name]) =>
      !privateHeaders.has(name.toLowerCase()) &&
      !nominated.includes(name.toLowerCase()),
  );
}

const responseFields = new Set([
  'type',
  'input',
  'previous_response_id',
  'generate',
  'client_metadata',
  'stream_options',
  'access_programs',
]);
function properties(request: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(request).filter(([key]) => !responseFields.has(key)),
  );
}
async function joinCleanup(tasks: Iterable<Promise<unknown>>): Promise<void> {
  const results = await Promise.allSettled(tasks);
  const errors = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, 'Native provider cleanup failed', {
      cause: errors[0],
    });
}
class Prefix {
  id?: string;
  nativeInput: JsonValue[] = [];
  originalLength = 0;
  providerInput?: JsonValue[];
  properties?: JsonObject;
  activeId?: string;
  warmup = false;
  constructor(public remote: NativeModelWebSocket) {}
  encode(edited: JsonObject): string {
    if (!Array.isArray(edited.input))
      throw new NativeError('Edited Responses input must be a list');
    const outgoing: JsonObject = { ...edited, type: 'response.create' };
    if (
      this.providerInput &&
      isDeepStrictEqual(this.properties, properties(edited)) &&
      isDeepStrictEqual(
        edited.input.slice(0, this.providerInput.length),
        this.providerInput,
      )
    ) {
      outgoing.previous_response_id = this.id ?? null;
      outgoing.input = edited.input.slice(this.providerInput.length);
    } else delete outgoing.previous_response_id;
    return encode(outgoing);
  }
  commit(
    id: string,
    original: JsonValue[],
    edited: JsonObject | undefined,
    items: JsonValue[],
  ): void {
    this.id = id;
    this.originalLength = original.length;
    this.nativeInput = [...original, ...items];
    this.providerInput =
      edited && Array.isArray(edited.input)
        ? [...edited.input, ...items]
        : undefined;
    this.properties = edited ? properties(edited) : undefined;
    this.activeId = undefined;
  }
}
/** A selected producer uses this carrier without importing the classic runtime. */
export interface SelectedModelTerminal {
  turnId: string;
  kind: 'task_complete' | 'turn_complete' | 'turn_aborted';
  reason: JsonValue | undefined;
  nativeError: JsonValue | undefined;
  priorFailure: unknown;
  nativeFailure: unknown;
  error: unknown;
  usage: TokenUsageInfo | null;
}

export interface SelectedModelRoute {
  bindRoot(root: string): void;
  accepted(receipt: Promise<{ turn_id: string }>): void;
  expected(): Promise<string>;
  fail(error: unknown): void;
  produce(
    body: JsonObject,
    signal: AbortSignal,
    current: () => Promise<void>,
    finish: () => Promise<void>,
  ): Promise<string | undefined>;
}

/** Private loopback routes preserve tool schemas before native provider dispatch. */
export class NativeProviderRoutes {
  private server?: Server;
  private localOrigin?: string;
  private websocketServer?: WebSocketServer;
  private readonly tasks = new Set<Promise<unknown>>();
  private readonly remoteSockets = new Set<Prefix>();
  private readonly sentinelEngines = new Map<string, Engine>();
  // Borrowed from the Provider across this Session's replacement Engines.
  private providerTransports?: _ProviderHttpTransports;
  private stopping?: Promise<void>;

  constructor(private readonly selected?: SelectedModelRoute) {}

  async start(config: NativeConfig, runtime: RuntimeOptions, apiKey?: string) {
    const server = createServer((request, response) => {
      const task = this.handle(request, response)
        .then((handled) => {
          if (!handled) response.writeHead(401).end();
        })
        .catch(() => {
          if (response.headersSent) response.destroy();
          else response.writeHead(502).end();
        });
      this.tasks.add(task);
      void task.finally(() => this.tasks.delete(task));
    });
    this.server = server;
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new NativeError('Native provider route could not bind');
    this.localOrigin = `http://127.0.0.1:${address.port}`;
    this.enableWebsockets();
    return { config, runtime, apiKey };
  }
  bindEngine(engine: Engine, transports = this.providerTransports): void {
    if (!this.localOrigin)
      throw new NativeError('Model request carrier has not started');
    const grant = randomBytes(32).toString('base64url');
    engine._sentinel_bind(this.localOrigin, grant, null, transports ?? null);
    this.providerTransports = transports;
    this.sentinelEngines.set(grant, engine);
  }
  /** Release only the retired engine's routing grants; the Session owns the carrier. */
  unbindEngine(engine: Engine): void {
    for (const [grant, owner] of this.sentinelEngines)
      if (owner === engine) this.sentinelEngines.delete(grant);
  }
  private sentinelRoute(
    request: IncomingMessage,
  ): { engine: Engine; provider: string; headers: string } | undefined {
    const segment = /^\/p-([A-Za-z0-9_-]+)\/responses$/.exec(request.url ?? '');
    const grant = request.headers['x-sdk-sentinel-grant'];
    const engine =
      typeof grant === 'string' ? this.sentinelEngines.get(grant) : undefined;
    if (!segment || !engine) return undefined;
    const decoded = Buffer.from(segment[1], 'base64url');
    if (decoded.toString('base64url') !== segment[1]) return undefined;
    const headers: string[][] = [];
    for (let i = 0; i < request.rawHeaders.length; i += 2)
      headers.push([request.rawHeaders[i], request.rawHeaders[i + 1]]);
    return {
      engine,
      provider: new TextDecoder('utf-8', { fatal: true }).decode(decoded),
      headers: encode(headers),
    };
  }
  private async sentinelPrepare(
    engine: Engine,
    provider: string,
    body: JsonObject,
  ): Promise<JsonObject> {
    const metadata = jsonObject.parse(body.client_metadata ?? {});
    const ticket = encode({
      sdk_sentinel_thread: metadata.sdk_sentinel_thread,
      sdk_sentinel_nonce: metadata.sdk_sentinel_nonce,
    });
    const receipt = jsonObject.parse(
      parseNative(await engine._sentinel_admit(provider, encode(metadata))),
    );
    if (
      receipt.model !== body.model ||
      !['generation', 'warmup'].includes(String(receipt.kind))
    ) {
      throw new NativeError('Invalid native model admission');
    }
    delete metadata.sdk_sentinel_thread;
    delete metadata.sdk_sentinel_nonce;
    body.client_metadata = metadata;
    return { ...receipt, ticket };
  }
  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> {
    const route = this.sentinelRoute(request);
    if (!route) return false;
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return true;
    }
    if (
      request.headers['content-encoding'] &&
      request.headers['content-encoding'] !== 'identity'
    ) {
      response.writeHead(415).end();
      return true;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      const data = Buffer.from(chunk);
      size += data.length;
      if (size > (this.selected ? 4 * 1024 * 1024 : 67108864)) {
        this.selected?.fail(new TypeError('Migration request exceeds 4 MiB'));
        response.writeHead(413).end();
        return true;
      }
      chunks.push(data);
    }
    const body = decode(jsonObject, Buffer.concat(chunks).toString('utf8'));
    if (this.selected) {
      const metadata = jsonObject.parse(body.client_metadata ?? {});
      const ticket = encode({
        sdk_sentinel_thread: metadata.sdk_sentinel_thread,
        sdk_sentinel_nonce: metadata.sdk_sentinel_nonce,
      });
      const expected = await this.selected.expected();
      const receipt = decode(
        jsonObject,
        await route.engine._sentinel_claim(route.provider, ticket, expected),
      );
      if (receipt.model !== body.model || receipt.kind !== 'generation')
        throw new NativeError('Invalid selected Model admission');
      delete metadata.sdk_sentinel_thread;
      delete metadata.sdk_sentinel_nonce;
      body.client_metadata = metadata;
      const current = async () => {
        await route.engine._sentinel_current(route.provider, ticket, expected);
      };
      const finish = async () => {
        await route.engine._sentinel_finish(route.provider, ticket, expected);
      };
      const disconnected = new AbortController();
      const cancel = () =>
        disconnected.abort(new NativeError('Selected Model connection closed'));
      response.once('close', cancel);
      if (response.destroyed) cancel();
      try {
        // Restoration and all producer awaits are part of the carrier's retained task.
        Object.assign(
          body,
          decode(
            jsonObject,
            await route.engine._sentinel_restore_schemas(
              route.provider,
              ticket,
              encode(body),
            ),
          ),
        );
        const wire = await this.selected.produce(
          body,
          disconnected.signal,
          current,
          finish,
        );
        // An owned policy stop joins the real connection close without a Model response.
        if (wire === undefined) return true;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(wire);
      } catch (error) {
        this.selected.fail(error);
        throw error;
      } finally {
        response.off('close', cancel);
      }
      return true;
    }
    const receipt = await this.sentinelPrepare(
      route.engine,
      route.provider,
      body,
    );
    Object.assign(
      body,
      decode(
        jsonObject,
        await route.engine._sentinel_restore_schemas(
          route.provider,
          String(receipt.ticket),
          encode(body),
        ),
      ),
    );
    const native = await binding();
    const owner = new native._ModelHttpRequest();
    const disconnected = new AbortController();
    const cancel = () => {
      owner.cancel();
      disconnected.abort();
    };
    response.once('close', cancel);
    if (response.destroyed) cancel();
    let remote: NativeModelResponse | undefined;
    try {
      remote = await route.engine._sentinel_stream(
        route.provider,
        route.headers,
        Buffer.from(encode(body)),
        String(receipt.ticket),
        owner,
      );
      const headers = responseHeaders(remote.headers);
      response.writeHead(remote.status, headers.flat());
      while (true) {
        const chunk = await remote.next_chunk();
        if (chunk === null) break;
        if (!response.write(chunk))
          await once(response, 'drain', { signal: disconnected.signal });
      }
      response.end();
    } finally {
      response.off('close', cancel);
      owner.cancel();
      await remote?.close();
    }
    return true;
  }
  private enableWebsockets(): void {
    const server = this.server;
    if (!server) throw new NativeError('Model carrier is closed');
    const wss = new wsModule.WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
      maxPayload: maxWebsocketRequestBytes,
    });
    this.websocketServer = wss;
    server.on('upgrade', (request, socket, head) => {
      const task = this.upgrade(request, socket, head);
      this.tasks.add(task);
      void task.then(
        () => this.tasks.delete(task),
        () => this.tasks.delete(task),
      );
    });
  }
  private async upgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const wss = this.websocketServer;
    const sentinel = this.sentinelRoute(request);
    if (sentinel && wss && !this.selected) {
      let prefix: Prefix | undefined;
      try {
        const remote = await sentinel.engine._sentinel_open(
          sentinel.provider,
          sentinel.headers,
        );
        prefix = new Prefix(remote);
        this.remoteSockets.add(prefix);
        if (!remote.available) {
          const body = remote.error_body.subarray(0, 64 * 1024);
          const headers = responseHeaders(remote.headers)
            .map(([name, value]) => {
              validateHeaderName(name);
              validateHeaderValue(name, value);
              return `${name}: ${value}\r\n`;
            })
            .join('');
          socket.end(
            Buffer.concat([
              Buffer.from(
                `HTTP/1.1 ${remote.status} Provider unavailable\r\n${headers}Content-Length: ${body.byteLength}\r\nConnection: close\r\n\r\n`,
              ),
              body,
            ]),
          );
          return;
        }
        const local = await new Promise<WebSocket>((resolve, reject) => {
          socket.once('error', reject);
          // The loopback handshake has its own protocol headers. Forward only
          // provider rate advice so Core can observe it on the live connection.
          const rateHeaders = responseHeaders(remote.headers).filter(([name]) =>
            /^(?:retry-after|x-ratelimit-(?:limit|remaining|reset)-(?:requests|tokens|project-tokens))$/i.test(
              name,
            ),
          );
          const appendRateHeaders = (
            headers: string[],
            source: IncomingMessage,
          ) => {
            if (source !== request) return;
            for (const [name, value] of rateHeaders) {
              validateHeaderName(name);
              validateHeaderValue(name, value);
              headers.push(`${name}: ${value}`);
            }
          };
          wss.on('headers', appendRateHeaders);
          try {
            wss.handleUpgrade(request, socket, head, resolve);
          } finally {
            wss.off('headers', appendRateHeaders);
          }
        });
        await this.sentinelSocket(
          local,
          prefix,
          sentinel.engine,
          sentinel.provider,
        );
      } catch {
        socket.destroy();
      } finally {
        if (prefix) {
          this.remoteSockets.delete(prefix);
          await prefix.remote.close(1000, '');
        }
      }
      return;
    }
    socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
  }
  private async send(local: WebSocket, payload: string): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      local.send(payload, (error) => (error ? reject(error) : resolve())),
    );
  }
  private async sentinelSocket(
    local: WebSocket,
    prefix: Prefix,
    engine: Engine,
    provider: string,
  ): Promise<void> {
    const finished = Promise.withResolvers<void>();
    let work = Promise.resolve();
    let pending: JsonObject | undefined;
    let control: JsonValue | undefined;
    local.on('error', finished.reject);
    local.on('close', () => {
      void prefix.remote
        .close(1000, '')
        .then(() => finished.resolve(), finished.reject);
    });
    local.on('message', (data, binary) => {
      try {
        if (binary) throw new NativeError('Native Responses expects text');
        const body = decode(jsonObject, data.toString());
        if (body.type === 'response.interrupt') {
          if (
            pending?.kind !== 'generation' ||
            !prefix.activeId ||
            body.response_id !== prefix.activeId ||
            body.mode !== 'discard_partial_items'
          )
            throw new NativeError('Interrupt does not own this response');
          void prefix.remote
            .send_text(encode(body))
            .catch(() => local.close(1011, 'Native provider failed'));
          return;
        }
        if (body.type !== 'response.create')
          throw new NativeError('Unexpected native WebSocket request');
        work = work.then(async () => {
          const admitted = await this.sentinelPrepare(engine, provider, body);
          if (control === undefined) control = admitted.control;
          else if (admitted.control !== control)
            throw new NativeError('Native WebSocket control changed');
          pending = admitted;
          if (!Array.isArray(body.input))
            throw new NativeError('Invalid native Responses input');
          const ref = body.previous_response_id;
          if (ref != null) {
            if (ref !== prefix.id)
              throw new NativeError('Unknown native WebSocket continuation');
            let tail: JsonValue[] = [];
            if (!prefix.warmup) {
              const completion = jsonObject.parse(admitted.completion);
              if (
                completion.response_id !== ref ||
                completion.model !== body.model ||
                !Array.isArray(completion.output)
              ) {
                throw new NativeError(
                  'Invalid native WebSocket completion receipt',
                );
              }
              tail = completion.output;
            }
            body.input = [
              ...prefix.nativeInput.slice(0, prefix.originalLength),
              ...tail,
              ...body.input,
            ];
            delete body.previous_response_id;
          }
          Object.assign(
            body,
            decode(
              jsonObject,
              await engine._sentinel_restore_schemas(
                provider,
                String(admitted.ticket),
                encode(body),
              ),
            ),
          );
          const original = body.input;
          let oversized = false;
          try {
            const payload = prefix.encode(body);
            if (Buffer.byteLength(payload, 'utf8') > maxWebsocketRequestBytes) {
              oversized = true;
              throw new NativeError(
                'Native WebSocket request exceeds the 64 MiB UTF-8 transport limit; model context limits are separate.',
              );
            }
            await prefix.remote.send_text(payload);
            const output: JsonValue[] = [];
            while (true) {
              const frame = await prefix.remote.receive();
              if (!frame || frame.type !== 'text')
                throw new NativeError(
                  'Native provider ended before completion',
                );
              const event = decode(jsonObject, frame.text);
              if (event.type === 'response.created') {
                const response = jsonObject.parse(event.response);
                prefix.activeId =
                  typeof response.id === 'string' ? response.id : undefined;
              } else if (
                event.type === 'response.output_item.done' &&
                event.item != null
              )
                output.push(event.item);
              const response =
                event.response == null
                  ? undefined
                  : jsonObject.parse(event.response);
              if (
                response &&
                (event.type === 'response.completed' ||
                  (event.type === 'response.incomplete' &&
                    response.incomplete_details &&
                    jsonObject.parse(response.incomplete_details).reason ===
                      'interrupted'))
              ) {
                const projected: JsonValue[] = JSON.parse(
                  prefix.remote.project_response_items(
                    encode(output),
                    admitted.content_item_kinds === true,
                  ),
                );
                prefix.commit(String(response.id), original, body, projected);
                prefix.warmup = admitted.kind === 'warmup';
                pending = undefined;
                await this.send(local, frame.text);
                return;
              }
              await this.send(local, frame.text);
              if (
                ['error', 'response.failed', 'response.incomplete'].includes(
                  String(event.type),
                )
              ) {
                pending = undefined;
                prefix.providerInput = undefined;
                prefix.properties = undefined;
                return;
              }
            }
          } catch (error) {
            if (pending) {
              await engine._sentinel_websocket_failed(
                provider,
                String(pending.ticket),
                oversized,
              );
              pending = undefined;
            }
            throw error;
          }
        });
        work.catch(() => local.close(1011, 'Native provider request failed'));
      } catch {
        local.close(1008, 'Invalid native provider request');
      }
    });
    try {
      await finished.promise;
    } finally {
      await work.catch(() => {});
    }
  }
  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    if (!this.stopping) {
      this.stopping = (async () => {
        for (const local of this.websocketServer?.clients ?? [])
          local.terminate();
        await joinCleanup(
          [...this.remoteSockets].map(async (prefix) =>
            prefix.remote.close(1000, ''),
          ),
        );
        const stopped = new Promise<void>((resolve, reject) =>
          server.close((error?: NodeJS.ErrnoException) =>
            error && error.code !== 'ERR_SERVER_NOT_RUNNING'
              ? reject(error)
              : resolve(),
          ),
        );
        server.closeAllConnections();
        await joinCleanup([stopped, ...this.tasks]);
        this.websocketServer?.close();
        this.websocketServer = undefined;
        this.sentinelEngines.clear();
        this.providerTransports = undefined;
        this.server = undefined;
        this.localOrigin = undefined;
      })().finally(() => {
        this.stopping = undefined;
      });
    }
    await this.stopping;
  }
}
