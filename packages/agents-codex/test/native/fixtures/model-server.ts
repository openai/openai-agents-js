import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from 'node:http';
import {
  createServer as createTlsServer,
  type Server as TlsServer,
  type ServerOptions as TlsOptions,
} from 'node:https';
import type { Duplex } from 'node:stream';
import type { JsonObject, JsonValue } from '../../../src/runtime/binding';
import type { NativeConfig } from '../../../src/runtime/config';

type ResponseValue =
  | JsonObject[]
  | { status: number; body: string; headers?: Record<string, string> };
type Response =
  | ResponseValue
  | ((request: JsonObject) => ResponseValue | Promise<ResponseValue>);
const servers: ModelServer[] = [];

export function message(text: string): JsonObject {
  return {
    type: 'message',
    id: randomUUID(),
    role: 'assistant',
    content: [{ type: 'output_text', text }],
  };
}

export function call(
  name: string,
  args: JsonValue,
  options: { callId: string; namespace?: string },
): JsonObject {
  return {
    type: 'function_call',
    name,
    call_id: options.callId,
    ...(options.namespace ? { namespace: options.namespace } : {}),
    arguments: typeof args === 'string' ? args : JSON.stringify(args),
  };
}

/** A real Responses SSE endpoint with explicitly prescribed native output. */
export class ModelServer {
  static async closeAll(): Promise<void> {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  }
  readonly requests: JsonObject[] = [];
  readonly requestHeaders: IncomingHttpHeaders[] = [];
  readonly completedFrames: string[] = [];
  onRecord?: (phase: string, detail?: unknown) => void;
  private readonly failures: unknown[] = [];
  private readonly rawUsage: readonly (
    string | ((request: JsonObject) => string | undefined)
  )[];
  private readonly server: Server | TlsServer;
  private readonly respond = async (
    request: IncomingMessage,
    response: ServerResponse,
  ) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      this.requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      this.requestHeaders.push({ ...request.headers });
      const requestIndex = this.requests.length - 1;
      const requestBody = this.requests[requestIndex]!;
      this.onRecord?.('MODEL_REQUEST', {
        method: request.method,
        path: request.url,
        requestIndex,
        body: requestBody,
      });
      const selected = this.responses[requestIndex];
      assert(selected, 'Unexpected provider request');
      const output =
        typeof selected === 'function' ? await selected(requestBody) : selected;
      if (!Array.isArray(output)) {
        response.writeHead(output.status, output.headers);
        if (this.beforeBody) {
          response.flushHeaders();
          await this.beforeBody(requestBody);
        }
        if (this.beforeEnd) {
          response.write(output.body);
          await this.beforeEnd(requestBody);
          response.end();
        } else response.end(output.body);
        return;
      }
      const id = `response-${requestIndex + 1}`;
      const selectedUsage = this.rawUsage[requestIndex];
      const usage =
        typeof selectedUsage === 'function'
          ? selectedUsage(requestBody)
          : selectedUsage;
      // Check syntax only; emit the original text so large JSON integers stay exact.
      if (usage !== undefined) JSON.parse(usage);
      const completed =
        this.terminalFrames?.[requestIndex] ??
        (usage === undefined
          ? JSON.stringify({ type: 'response.completed', response: { id } })
          : `{"type":"response.completed","response":{"id":${JSON.stringify(id)},"usage":${usage}}}`);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const events = [
        { type: 'response.created', response: { id } },
        ...output.map((item, output_index) => ({
          type: 'response.output_item.done',
          output_index,
          item,
        })),
      ];
      for (const event of events) {
        if (this.beforeOutput && 'item' in event)
          await this.beforeOutput(event.item, event.output_index, requestBody);
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      this.completedFrames.push(completed);
      this.onRecord?.('MODEL_COMPLETED_FRAME', {
        requestIndex,
        frame: completed,
      });
      response.write(`data: ${completed}\n\n`);
      if (this.beforeEnd) await this.beforeEnd(requestBody);
      response.end();
    } catch (error) {
      this.failures.push(error);
      this.onRecord?.('MODEL_REQUEST_ERROR', error);
      response.writeHead(500).end('Provider fixture failed');
    }
  };
  private readonly ready: Promise<void>;

  constructor(
    private readonly responses: readonly Response[],
    usage:
      | JsonObject
      | readonly (
          string | ((request: JsonObject) => string | undefined)
        )[] = [],
    private readonly beforeOutput?: (
      item: JsonObject,
      index: number,
      request: JsonObject,
    ) => void | Promise<void>,
    private readonly terminalFrames?: readonly string[],
    private readonly beforeBody?: (request: JsonObject) => void | Promise<void>,
    tls?: TlsOptions,
    private readonly beforeEnd?: (request: JsonObject) => void | Promise<void>,
  ) {
    this.rawUsage = Array.isArray(usage)
      ? usage
      : responses.map(() => JSON.stringify(usage));
    this.server = tls
      ? createTlsServer(tls, this.respond)
      : createServer(this.respond);
    this.ready = new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    servers.push(this);
  }

  /** Attach an independent provider WebSocket protocol to the same test origin. */
  onUpgrade(
    listener: (request: IncomingMessage, socket: Duplex, head: Buffer) => void,
  ): void {
    this.server.on('upgrade', listener);
  }

  async port(): Promise<number> {
    await this.ready;
    const address = this.server.address();
    assert(address && typeof address !== 'string');
    return address.port;
  }

  async config(): Promise<NativeConfig> {
    return {
      model_provider: 'fixture',
      'model_providers.fixture': {
        name: 'Scripted native provider',
        base_url: `http://127.0.0.1:${await this.port()}/v1`,
        wire_api: 'responses',
        requires_openai_auth: false,
        supports_websockets: false,
        request_max_retries: 0,
        stream_max_retries: 0,
      },
    };
  }

  assertExhausted(): void {
    assert.deepEqual(this.failures, []);
    assert.equal(this.requests.length, this.responses.length);
  }

  private async close(): Promise<void> {
    this.onRecord?.('MODEL_CLOSE_BEGIN');
    await this.ready;
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    );
    this.onRecord?.('MODEL_CLOSE_END');
    assert.deepEqual(this.failures, []);
  }
}
