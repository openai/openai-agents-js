import { AssertionError } from 'node:assert';
import { randomUUID } from 'node:crypto';
import {
  createServer,
  validateHeaderName,
  validateHeaderValue,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { Socket } from 'node:net';
import { z } from 'zod';
import {
  losslessJsonObjectSchema as jsonObject,
  type JsonObject,
} from '../runtime/binding';
import { NativeProvider } from '../runtime/provider';

export type ScriptedItem =
  | Readonly<{
      type: 'message';
      role: 'assistant';
      id: string;
      content: readonly Readonly<{ type: 'output_text'; text: string }>[];
    }>
  | Readonly<{
      type: 'function_call';
      name: string;
      namespace?: string;
      call_id: string;
      arguments: string;
    }>
  | Readonly<{
      type: 'custom_tool_call';
      name: string;
      call_id: string;
      input: string;
    }>;
export type ScriptedResponse =
  | readonly ScriptedItem[]
  | Readonly<{
      items: readonly ScriptedItem[];
      /** Provider-reported usage; omission leaves it unknown. */
      usage?: JsonObject;
      /** Additional HTTP metadata. Framing headers remain SDK-owned. */
      headers?: Readonly<Record<string, string>>;
    }>
  | Readonly<{
      kind: 'httpError';
      status: number;
      body: JsonObject;
      headers?: Readonly<Record<string, string>>;
    }>;

/** A callback-scoped native provider with detached request-body readback. */
export interface ScriptedResponses {
  readonly provider: NativeProvider;
  readonly requests: readonly Readonly<JsonObject>[];
  toolOutput(callId: string): string | undefined;
  assertExhausted(): void;
}
export function text(value: string): ScriptedItem {
  return {
    type: 'message',
    role: 'assistant',
    id: randomUUID(),
    content: [{ type: 'output_text', text: value }],
  };
}
export function toolCall(
  name: string,
  argumentsValue: JsonObject,
  options: { callId: string; namespace?: string },
): ScriptedItem {
  return {
    type: 'function_call',
    name,
    ...(options.namespace === undefined
      ? {}
      : { namespace: options.namespace }),
    call_id: options.callId,
    arguments: JSON.stringify(jsonObject.parse(argumentsValue)),
  };
}
export function customToolCall(
  name: string,
  input: string,
  options: { callId: string },
): ScriptedItem {
  return {
    type: 'custom_tool_call',
    name,
    call_id: options.callId,
    input,
  };
}
const errorBody = {
  error: { message: 'Scripted provider error', type: 'scripted_error' },
};
const statusSchema = z.number().int().min(400).max(599);
export function httpError(
  status: number,
  body: JsonObject = errorBody,
): ScriptedResponse {
  try {
    return {
      kind: 'httpError',
      status: statusSchema.parse(status),
      body: jsonObject.parse(body),
    };
  } catch {
    throw new TypeError('Invalid scripted HTTP error status or JSON body');
  }
}
const itemSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('message'),
      role: z.literal('assistant'),
      id: z.string(),
      content: z.array(
        z.object({ type: z.literal('output_text'), text: z.string() }).strict(),
      ),
    })
    .strict(),
  z
    .object({
      type: z.literal('function_call'),
      name: z.string(),
      namespace: z.string().optional(),
      call_id: z.string(),
      arguments: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal('custom_tool_call'),
      name: z.string(),
      call_id: z.string(),
      input: z.string(),
    })
    .strict(),
]);
const headersSchema = z
  .record(z.string(), z.string())
  .superRefine((headers, ctx) => {
    try {
      for (const [name, value] of Object.entries(headers)) {
        validateHeaderName(name);
        validateHeaderValue(name, value);
        if (
          ['content-type', 'content-length', 'transfer-encoding'].includes(
            name.toLowerCase(),
          )
        )
          throw new TypeError('Scripted framing headers are SDK-owned');
      }
    } catch {
      ctx.addIssue({
        code: 'custom',
        message: 'Invalid scripted response headers',
      });
    }
  });
const responseSchema = z.union([
  z.array(itemSchema),
  z
    .object({
      items: z.array(itemSchema),
      usage: jsonObject.optional(),
      headers: headersSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('httpError'),
      status: statusSchema,
      body: jsonObject,
      headers: headersSchema.optional(),
    })
    .strict(),
]);
interface BodyRead {
  request: IncomingMessage;
  teardownAbort: boolean;
}

class Peer implements ScriptedResponses {
  private providerValue: NativeProvider | undefined;
  private readonly bodies: JsonObject[] = [];
  private next = 0;
  private unexpected = 0;
  private failures = 0;
  private readonly sockets = new Set<Socket>();
  private readonly reads = new Set<BodyRead>();
  private readonly handlers = new Set<Promise<void>>();
  private closing: Promise<void> | undefined;
  private readonly server = createServer((request, response) => {
    const handler = this.handle(request, response);
    this.handlers.add(handler);
    void handler.then(() => this.handlers.delete(handler));
  });
  constructor(private readonly responses: readonly ScriptedResponse[]) {
    this.server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });
  }
  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    const address = this.server.address();
    if (!address || typeof address === 'string')
      throw new Error('Scripted provider did not start');
    this.providerValue = new NativeProvider({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: 'scripted-test-key',
      supportsWebsockets: false,
    });
  }
  get provider(): NativeProvider {
    if (!this.providerValue)
      throw new Error('Scripted provider scope has ended');
    return this.providerValue;
  }
  get requests(): readonly Readonly<JsonObject>[] {
    return Object.freeze(structuredClone(this.bodies));
  }
  toolOutput(callId: string): string | undefined {
    for (let r = this.bodies.length - 1; r >= 0; r--) {
      const input = this.bodies[r].input;
      if (!Array.isArray(input)) continue;
      for (let i = input.length - 1; i >= 0; i--) {
        const item = input[i];
        if (
          !item ||
          typeof item !== 'object' ||
          Array.isArray(item) ||
          (item.type !== 'function_call_output' &&
            item.type !== 'custom_tool_call_output') ||
          item.call_id !== callId
        )
          continue;
        if (typeof item.output === 'string') return item.output;
        if (Array.isArray(item.output))
          return item.output
            .flatMap((part) =>
              part &&
              typeof part === 'object' &&
              !Array.isArray(part) &&
              typeof part.text === 'string'
                ? [part.text]
                : [],
            )
            .join('');
      }
    }
    return undefined;
  }
  assertExhausted(): void {
    const remaining = this.responses.length - this.next;
    if (remaining || this.unexpected || this.failures)
      throw new AssertionError({
        message: `Scripted responses: ${remaining} remaining, ${this.unexpected} unexpected requests, ${this.failures} internal failures`,
      });
  }
  private reject(response: ServerResponse): void {
    response
      .writeHead(400, { 'content-type': 'application/json' })
      .end(JSON.stringify(errorBody));
  }
  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const read: BodyRead = { request, teardownAbort: false };
    this.reads.add(read);
    try {
      const chunks: Buffer[] = [];
      try {
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
      } catch (error) {
        // Only the incomplete read destroyed by this teardown is expected.
        if (
          read.teardownAbort &&
          !request.complete &&
          request.aborted &&
          error instanceof Error &&
          'code' in error &&
          error.code === 'ECONNRESET'
        )
          return;
        throw error;
      } finally {
        this.reads.delete(read);
      }
      if (request.method !== 'POST' || request.url !== '/v1/responses') {
        this.unexpected++;
        this.reject(response);
        return;
      }
      let body: JsonObject;
      try {
        body = jsonObject.parse(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        this.unexpected++;
        this.reject(response);
        return;
      }
      this.bodies.push(body);
      const selected = this.responses[this.next];
      if (selected === undefined) {
        this.unexpected++;
        this.reject(response);
        return;
      }
      this.next++;
      if ('kind' in selected) {
        const error = selected;
        response
          .writeHead(error.status, {
            ...error.headers,
            'content-type': 'application/json',
          })
          .end(JSON.stringify(error.body));
        return;
      }
      const id = randomUUID();
      const envelope: {
        items: readonly ScriptedItem[];
        usage?: JsonObject;
        headers?: Readonly<Record<string, string>>;
      } = 'items' in selected ? selected : { items: selected };
      response.writeHead(200, {
        ...envelope.headers,
        'content-type': 'text/event-stream',
      });
      const events = [
        { type: 'response.created', response: { id } },
        ...envelope.items.map((item, output_index) => ({
          type: 'response.output_item.done',
          output_index,
          item,
        })),
        {
          type: 'response.completed',
          response: {
            id,
            ...(envelope.usage === undefined ? {} : { usage: envelope.usage }),
          },
        },
      ];
      for (const event of events)
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      response.end();
    } catch {
      this.failures++;
      if (!response.headersSent && !response.destroyed)
        response.writeHead(500).end('Scripted provider failed');
      else response.destroy();
    } finally {
      this.reads.delete(read);
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    const provider = this.providerValue;
    this.providerValue = undefined;
    this.closing = (async () => {
      const errors: unknown[] = [];
      try {
        await provider?.close();
      } catch (error) {
        errors.push(error);
      }
      const closed = new Promise<void>((resolve, reject) => {
        if (!this.server.listening) {
          resolve();
          return;
        }
        this.server.close((error) => (error ? reject(error) : resolve()));
      });
      for (const read of this.reads) {
        if (
          !read.request.complete &&
          !read.request.destroyed &&
          !read.request.aborted
        )
          read.teardownAbort = true;
      }
      for (const socket of this.sockets) socket.destroy();
      try {
        await closed;
      } catch (error) {
        errors.push(error);
      }
      await Promise.all(this.handlers);
      if (errors.length === 1) throw errors[0];
      if (errors.length)
        throw new AggregateError(errors, 'Scripted provider cleanup failed', {
          cause: errors[0],
        });
    })();
    return this.closing;
  }
}
/**
 * Serve prescribed Responses events through the real native loop. Close borrowed
 * Sessions before returning. Keep direct/bypassed loopback proxy routing stable
 * throughout the scope; exhaustion detects unused scripts after effects occur.
 * This helper does not isolate network access or change process telemetry.
 */
export async function withScriptedResponses<T>(
  responses: readonly ScriptedResponse[],
  run: (peer: ScriptedResponses) => T | Promise<T>,
): Promise<T> {
  if (!Array.isArray(responses)) {
    throw new TypeError('Scripted responses must be an array');
  }
  const captured = Array.from(responses, (response, index) => {
    try {
      return responseSchema.parse(response);
    } catch {
      throw new TypeError(`Invalid scripted response at index ${index}`);
    }
  });
  const peer = new Peer(captured);
  let result: T;
  try {
    await peer.start();
    result = await run(peer);
  } catch (error) {
    try {
      await peer.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'Scripted scope and cleanup failed',
        { cause: error },
      );
    }
    throw error;
  }
  await peer.close();
  peer.assertExhausted();
  return result;
}

export { ScriptedRealtimeAdapter } from './realtime';
export type {
  RealtimeFrame,
  RealtimeStep,
  RealtimeConnectCall,
  RealtimeScenario,
} from './realtime';
