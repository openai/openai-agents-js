import type { ResponsesWS } from 'openai/resources/responses/ws';
import {
  copyJsonValue,
  losslessJsonObjectSchema,
  type JsonObject,
} from './binding';
import {
  capturePromptCacheKey,
  captureRequestOptionsSource,
  clientRequestOptions,
  hasRawProviderEvents,
  isRawModelPart,
  markRawModelPart,
  markResponsesWebSocketStream,
  projectResponsesResponse,
  type ModelAdapterOptions,
  type ModelRequest,
  type ModelResponse,
  type ModelRunOwner,
  type NativeModel,
} from './models';
import type { ModelRetryAdviceRequest, ModelRetryAdvice } from './model-retry';

/** One connection supplied by the caller's transport factory and owned by a run. */
export type ResponsesSocket = Pick<
  ResponsesWS,
  'send' | 'close' | 'socket' | typeof Symbol.asyncIterator
>;
export type ResponsesSocketOptions = Awaited<
  ReturnType<typeof clientRequestOptions>
>;
export type ResponsesSocketFactory = (
  request: ModelRequest,
  options: ResponsesSocketOptions,
) => ResponsesSocket | Promise<ResponsesSocket>;
type SocketEnvelope =
  ReturnType<
    ResponsesSocket[typeof Symbol.asyncIterator]
  > extends AsyncIterableIterator<infer Envelope>
    ? Envelope
    : never;
const socketFrameKinds = new WeakMap<object, 'raw' | 'projected'>();

/** @internal Hosted transport distinguishes provider frames from local projection. */
export function markResponsesSocketFrame(
  envelope: SocketEnvelope,
  kind: 'raw' | 'projected',
): SocketEnvelope {
  socketFrameKinds.set(envelope, kind);
  return envelope;
}

type Connection = {
  socket: ResponsesSocket;
  iterator: ReturnType<ResponsesSocket[typeof Symbol.asyncIterator]>;
  key: string;
  closing?: Promise<void>;
};
type Owner = {
  busy: boolean;
  retired: boolean;
  connection?: Connection;
  opening?: Promise<Connection>;
  cleanup?: Promise<void>;
};

/** Borrow a socket factory; native Core owns calls, history, usage and retries. */
export class ResponsesWebSocketModel implements NativeModel {
  readonly #owners = new WeakMap<ModelRunOwner, Owner>();
  readonly #requestOptions;
  readonly #promptCacheKey;
  readonly #unsafe = new WeakSet<object>();

  constructor(
    readonly connect: ResponsesSocketFactory,
    readonly model?: string,
    options: ModelAdapterOptions = {},
  ) {
    if (typeof connect !== 'function')
      throw new TypeError('Responses socket factory must be callable');
    this.#requestOptions = captureRequestOptionsSource(options);
    this.#promptCacheKey = capturePromptCacheKey(options);
  }

  getRetryAdvice({
    error,
  }: ModelRetryAdviceRequest): ModelRetryAdvice | undefined {
    if (error && typeof error === 'object' && this.#unsafe.has(error))
      return {
        suggested: false,
        replaySafety: 'unsafe',
        reason: 'Responses WebSocket frame may have reached the provider',
      };
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    for await (const event of this.stream(request)) {
      if (isRawModelPart(event)) continue;
      if (
        [
          'response.completed',
          'response.failed',
          'response.incomplete',
        ].includes(String(event.type))
      )
        return projectResponsesResponse(event.response);
    }
    throw new TypeError(
      'Responses WebSocket ended without a terminal response',
    );
  }

  stream(request: ModelRequest): AsyncIterable<JsonObject> {
    return markResponsesWebSocketStream(this.#streamResponse(request));
  }

  async *#streamResponse(request: ModelRequest): AsyncIterable<JsonObject> {
    request.signal.throwIfAborted();
    if (!request.runOwner)
      throw new TypeError(
        'ResponsesWebSocketModel requires a native run owner',
      );
    const known = this.#owners.get(request.runOwner);
    const owner: Owner = known ?? { busy: false, retired: false };
    if (!known) this.#owners.set(request.runOwner, owner);
    if (owner.busy || owner.retired)
      throw new TypeError('Responses socket owner is busy or retired');
    owner.busy = true;
    let connection: Connection | undefined;
    let sent = false;
    let terminal = false;
    try {
      const body = copyJsonValue(request.body) as JsonObject;
      const options = await clientRequestOptions(this.#requestOptions, request);
      const key = JSON.stringify({
        headers: options.headers,
        query: options.query,
      });
      const readyState = owner.connection?.socket.socket.readyState;
      if (
        owner.connection &&
        (owner.connection.key !== key || (readyState !== 0 && readyState !== 1))
      ) {
        await closeConnection(owner.connection);
        owner.connection = undefined;
      }
      if (!owner.connection) {
        const snapshot = Object.freeze({
          ...request,
          body: copyJsonValue(body) as JsonObject,
        });
        owner.opening = Promise.resolve().then(async () => {
          const socket = await this.connect(snapshot, options);
          const opened = {
            socket,
            iterator: socket[Symbol.asyncIterator](),
            key,
          };
          if (owner.retired || request.signal.aborted) {
            await closeConnection(opened);
            request.signal.throwIfAborted();
            throw new TypeError(
              'Responses socket owner retired during connection',
            );
          }
          return opened;
        });
        try {
          owner.connection = await owner.opening;
        } finally {
          owner.opening = undefined;
        }
      }
      connection = owner.connection;
      request.signal.throwIfAborted();
      if (owner.retired) throw new TypeError('Responses socket owner retired');
      sent = true;
      const { stream: _httpStream, ...frameBody } = body;
      connection.socket.send({
        ...frameBody,
        model: this.model ?? body.model,
        ...(this.#promptCacheKey === undefined
          ? {}
          : { prompt_cache_key: this.#promptCacheKey }),
        type: 'response.create',
      } as Parameters<ResponsesSocket['send']>[0]);
      const deadline =
        options.timeout === undefined
          ? undefined
          : Date.now() + options.timeout;
      let responseId: unknown;
      for (;;) {
        const next = await readNext(connection, request.signal, deadline);
        if (next.done)
          throw new Error(
            'Responses WebSocket closed before a terminal response',
          );
        const message = next.value;
        if (message.type === 'error')
          throw (
            message.error ?? new Error('Responses WebSocket transport error')
          );
        if (message.type === 'close')
          throw new Error(
            'Responses WebSocket closed before a terminal response',
          );
        if (message.type !== 'message') continue;
        const event = losslessJsonObjectSchema.parse(message.message);
        const kind = socketFrameKinds.get(message);
        if (kind !== 'projected' && hasRawProviderEvents(request))
          yield markRawModelPart(copyJsonValue(event) as JsonObject);
        if (kind === 'raw') continue;
        const response = event.response;
        if (
          response &&
          typeof response === 'object' &&
          !Array.isArray(response)
        ) {
          if (
            responseId !== undefined &&
            response.id !== undefined &&
            response.id !== responseId
          )
            throw new TypeError(
              'Responses WebSocket changed response identity',
            );
          if (response.id !== undefined) responseId = response.id;
        }
        terminal = [
          'response.completed',
          'response.failed',
          'response.incomplete',
        ].includes(String(event.type));
        yield event;
        if (terminal) return;
        if (event.type === 'error')
          throw new Error('Responses WebSocket provider error');
      }
    } catch (error) {
      let failure = sent ? requestError(error) : error;
      if (connection) {
        try {
          await this.#closeAfterRequest(connection, sent);
          if (owner.connection === connection) owner.connection = undefined;
        } catch (cleanupError) {
          failure = new AggregateError(
            [failure, cleanupError],
            'Responses WebSocket cleanup failed',
            { cause: failure },
          );
        }
      }
      if (sent && failure && typeof failure === 'object')
        this.#unsafe.add(failure);
      throw failure;
    } finally {
      owner.busy = false;
      if (!terminal && connection && !connection.closing) {
        await this.#closeAfterRequest(connection, sent);
        if (owner.connection === connection) owner.connection = undefined;
      }
    }
  }

  async #closeAfterRequest(
    connection: Connection,
    sent: boolean,
  ): Promise<void> {
    try {
      await closeConnection(connection);
    } catch (value) {
      const error = requestError(value);
      if (sent) this.#unsafe.add(error);
      throw error;
    }
  }

  cleanupOnRunEnd(ownerToken: ModelRunOwner): Promise<void> {
    const owner = this.#owners.get(ownerToken);
    if (!owner) return Promise.resolve();
    owner.retired = true;
    return (owner.cleanup ??= (async () => {
      await owner.opening?.catch(() => {});
      if (owner.connection)
        await this.#closeAfterRequest(owner.connection, false);
      owner.connection = undefined;
    })());
  }
}

function requestError(value: unknown): Error {
  return value instanceof Error
    ? value
    : new Error('Responses WebSocket request failed', { cause: value });
}

function closeConnection(connection: Connection): Promise<void> {
  return (connection.closing ??= (async () => {
    const socket = connection.socket.socket;
    const closed =
      socket.readyState === 3
        ? undefined
        : new Promise<void>((resolve) => socket.once('close', () => resolve()));
    await connection.socket.close();
    await closed;
    await connection.iterator.return?.();
  })());
}
async function readNext(
  connection: Connection,
  signal: AbortSignal,
  deadline?: number,
) {
  signal.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort!: () => void;
  const stopped = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (deadline !== undefined)
      timer = setTimeout(
        () => reject(new Error('Responses WebSocket request timed out')),
        Math.max(0, deadline - Date.now()),
      );
  });
  try {
    return await Promise.race([connection.iterator.next(), stopped]);
  } finally {
    signal.removeEventListener('abort', abort);
    if (timer !== undefined) clearTimeout(timer);
  }
}
