import {
  copyJsonValue,
  losslessJsonObjectSchema,
  type JsonObject,
  type JsonValue,
} from './binding';
import type {
  ModelAdapterOptions,
  ModelRequest,
  ModelResponse,
  ModelRunOwner,
  NativeModel,
} from './models';
import { accountProviderRequest } from './provider-request-accounting';
import { addRunUsage } from './run-events';
import { markResponsesWebSocketStream, projectResponsesUsage } from './models';
import type { ModelRetryAdviceRequest } from './model-retry';
import {
  ResponsesWebSocketModel,
  markResponsesSocketFrame,
  type ResponsesSocket,
  type ResponsesSocketFactory,
} from './responses-websocket-model';

export interface HostedResponsesWebSocketModelOptions extends ModelAdapterOptions {
  maxConcurrentSubagents?: number;
}
type ActiveResponse = {
  create: JsonObject;
  lineage: string;
  terminalReported?: boolean;
  continuation?: JsonObject;
  injectionInput?: JsonObject[];
  fallbackInput?: JsonObject[];
  template?: JsonObject;
  responseId?: string;
  pending: Set<string>;
  emitted: Set<string>;
  queued: JsonObject[];
  injecting?: Set<string>;
  terminal?: JsonObject;
  bytes: number;
};
type Run = { active?: ActiveResponse; request?: ModelRequest };
const collaboration = new Set([
  'agent_message',
  'multi_agent_call',
  'multi_agent_call_output',
]);
const terminal = new Set([
  'response.completed',
  'response.failed',
  'response.incomplete',
]);
const maxResponseBytes = 8 * 1024 * 1024;

/** Provider beta transport; native Core retains local function execution. */
export class HostedResponsesWebSocketModel implements NativeModel {
  readonly #transport: ResponsesWebSocketModel;
  readonly #runs = new WeakMap<ModelRunOwner, Run>();
  constructor(
    connect: ResponsesSocketFactory,
    model?: string,
    options: HostedResponsesWebSocketModelOptions = {},
  ) {
    const count = options.maxConcurrentSubagents;
    if (count !== undefined && (!Number.isSafeInteger(count) || count <= 0))
      throw new TypeError(
        'maxConcurrentSubagents requires a positive exact integer',
      );
    const config: JsonObject = {
      enabled: true,
      ...(count === undefined ? {} : { max_concurrent_subagents: count }),
    };
    this.#transport = new ResponsesWebSocketModel(
      async (request, transport) => {
        if (!request.runOwner)
          throw new TypeError('Hosted Responses requires a native run owner');
        let run = this.#runs.get(request.runOwner);
        if (!run) {
          run = {};
          this.#runs.set(request.runOwner, run);
        }
        const headers = { ...transport.headers };
        const betas: string[] = [];
        for (const key of Object.keys(headers))
          if (key.toLowerCase() === 'openai-beta') {
            if (typeof headers[key] === 'string')
              betas.push(
                ...headers[key]!.split(',')
                  .map((value) => value.trim())
                  .filter(Boolean),
              );
            delete headers[key];
          }
        headers['OpenAI-Beta'] = [
          ...new Set([...betas, 'responses_multi_agent=v1']),
        ].join(',');
        const socket = await connect(request, { ...transport, headers });
        return hostedSocket(socket, run, config);
      },
      model,
      options,
    );
  }
  #begin(request: ModelRequest): Run {
    if (!request.runOwner)
      throw new TypeError('Hosted Responses requires a native run owner');
    let run = this.#runs.get(request.runOwner);
    if (!run) {
      run = {};
      this.#runs.set(request.runOwner, run);
    }
    if (run.request)
      throw new TypeError('Hosted Responses already has an active request');
    accountProviderRequest(request, { operation: 'manage' });
    run.request = request;
    return run;
  }
  async complete(request: ModelRequest): Promise<ModelResponse> {
    const run = this.#begin(request);
    try {
      return await this.#transport.complete(request);
    } finally {
      if (run.request === request) run.request = undefined;
    }
  }
  stream(request: ModelRequest): AsyncIterable<JsonObject> {
    return markResponsesWebSocketStream(this.#streamResponse(request));
  }
  async *#streamResponse(request: ModelRequest): AsyncIterable<JsonObject> {
    const run = this.#begin(request);
    try {
      yield* this.#transport.stream(request);
    } finally {
      if (run.request === request) run.request = undefined;
    }
  }
  getRetryAdvice(request: ModelRetryAdviceRequest) {
    return this.#transport.getRetryAdvice(request);
  }
  async cleanupOnRunEnd(owner: ModelRunOwner): Promise<void> {
    await this.#transport.cleanupOnRunEnd(owner);
    this.#runs.delete(owner);
  }
}
function object(value: JsonValue | undefined): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : undefined;
}
function stable(item: JsonObject): boolean {
  return (
    !collaboration.has(String(item.type)) &&
    (item.type !== 'message' ||
      (object(item.agent)?.agent_name === '/root' &&
        item.phase === 'final_answer'))
  );
}
function hostedSocket(
  socket: ResponsesSocket,
  run: Run,
  config: JsonObject,
): ResponsesSocket {
  const iterator = socket[Symbol.asyncIterator]();
  const request = () => {
    if (!run.request)
      throw new TypeError('Hosted transport requires an active native request');
    return run.request;
  };
  const create = (frame: JsonObject, emitted = new Set<string>()) => {
    request().signal?.throwIfAborted();
    const bytes = Buffer.byteLength(JSON.stringify(frame));
    if (bytes > maxResponseBytes)
      throw new RangeError(
        'Hosted request exceeds the native retained-byte limit',
      );
    const lineage = accountProviderRequest(request(), { operation: 'create' });
    if (!lineage)
      throw new TypeError('Hosted create requires a native request lineage');
    run.active = {
      create: frame,
      lineage,
      pending: new Set(),
      emitted,
      queued: [],
      bytes,
    };
    accountProviderRequest(request(), { operation: 'dispatch', lineage });
    socket.send({
      ...frame,
      type: 'response.create',
      multi_agent: config,
    } as unknown as Parameters<ResponsesSocket['send']>[0]);
  };
  const fallback = (
    active: ActiveResponse,
    frame: JsonObject,
    outputs: JsonObject[],
  ) => {
    const completed = object(active.terminal?.response);
    if (!completed || typeof completed.id !== 'string')
      throw new TypeError(
        'Hosted continuation requires an exact terminal response',
      );
    const next: JsonObject = { ...frame, input: outputs };
    if (next.conversation != null) delete next.previous_response_id;
    else if (
      typeof completed.store === 'boolean'
        ? completed.store
        : active.create.store !== false
    )
      next.previous_response_id = completed.id;
    else {
      next.input = [
        ...(Array.isArray(active.create.input) ? active.create.input : []),
        ...(Array.isArray(completed.output) ? completed.output : []),
        ...outputs,
      ];
      if (typeof active.create.previous_response_id === 'string')
        next.previous_response_id = active.create.previous_response_id;
      else delete next.previous_response_id;
    }
    create(next, active.emitted);
  };
  return {
    get socket() {
      return socket.socket;
    },
    close: () => socket.close(),
    send(value) {
      const {
        stream: _httpStream,
        betas: _headerBetas,
        ...frame
      } = losslessJsonObjectSchema.parse(value);
      const active = run.active;
      if (!active) {
        create(frame);
        return;
      }
      const input = Array.isArray(frame.input)
        ? frame.input
            .map(object)
            .filter((item): item is JsonObject => Boolean(item))
        : [];
      const outputs = input.filter(
        (item) =>
          item.type === 'function_call_output' &&
          typeof item.call_id === 'string' &&
          active.pending.has(item.call_id),
      );
      const ids = new Set(outputs.map((item) => item.call_id as string));
      if (
        !active.responseId ||
        !ids.size ||
        [...active.pending].some((id) => !ids.has(id))
      )
        throw new TypeError(
          'Hosted response requires the matching local function outputs',
        );
      if (active.terminal) {
        fallback(active, frame, outputs);
        return;
      }
      request().signal?.throwIfAborted();
      active.continuation = frame;
      active.injectionInput = outputs;
      active.injecting = ids;
      accountProviderRequest(request(), {
        operation: 'dispatch',
        lineage: active.lineage,
      });
      socket.send({
        type: 'response.inject',
        response_id: active.responseId,
        input: outputs,
      } as unknown as Parameters<ResponsesSocket['send']>[0]);
    },
    async *[Symbol.asyncIterator]() {
      try {
        for (;;) {
          const next = await iterator.next();
          if (next.done) return;
          const envelope = next.value;
          if (envelope.type !== 'message') {
            yield envelope;
            continue;
          }
          const event = losslessJsonObjectSchema.parse(envelope.message);
          const active = run.active;
          if (!active) throw new Error('Hosted response has no active owner');
          active.bytes += Buffer.byteLength(JSON.stringify(event));
          if (active.bytes > maxResponseBytes)
            throw new RangeError(
              'Hosted response exceeds the native retained-byte limit',
            );
          yield markResponsesSocketFrame(envelope, 'raw');
          const response = object(event.response);
          if (event.type === 'response.created') {
            if (!response || typeof response.id !== 'string' || !response.id)
              throw new TypeError('Hosted response requires a response ID');
            active.template = copyJsonValue(response) as JsonObject;
            active.responseId = response.id;
            yield markResponsesSocketFrame({ ...envelope }, 'projected');
          } else if (event.type === 'response.output_item.done') {
            const item = object(event.item);
            if (
              item?.type === 'function_call' &&
              typeof item.call_id === 'string' &&
              !active.emitted.has(item.call_id) &&
              !active.queued.some((known) => known.call_id === item.call_id)
            ) {
              active.pending.add(item.call_id);
              active.queued.push(copyJsonValue(item) as JsonObject);
            }
          } else if (event.type === 'response.inject.created') {
            for (const id of active.injecting ?? []) active.pending.delete(id);
            active.injecting = undefined;
          } else if (
            event.type === 'response.inject.failed' &&
            object(event.error)?.code === 'response_already_completed'
          ) {
            active.fallbackInput = active.injectionInput;
            for (const id of active.injecting ?? []) active.pending.delete(id);
            active.injecting = undefined;
          } else if (
            event.type === 'response.inject.failed' ||
            event.type === 'response.error' ||
            event.type === 'error'
          ) {
            throw new Error('Hosted response rejected the provider operation', {
              cause: event.error,
            });
          } else if (terminal.has(String(event.type))) {
            if (active.terminalReported)
              throw new TypeError(
                'Hosted response received more than one terminal',
              );
            const measured = projectResponsesUsage(response?.usage);
            accountProviderRequest(request(), {
              operation: 'terminal',
              lineage: active.lineage,
              ...(measured ? { usage: addRunUsage(null, measured) } : {}),
            });
            active.terminalReported = true;
            active.terminal = copyJsonValue(event) as JsonObject;
          }
          if (
            active.terminal &&
            active.fallbackInput?.length &&
            !active.injecting
          ) {
            if (!active.continuation)
              throw new TypeError(
                'Hosted fallback requires its original continuation',
              );
            fallback(active, active.continuation, active.fallbackInput);
            continue;
          }
          if (active.queued.length && !active.injecting) {
            if (!active.template || !active.responseId)
              throw new TypeError(
                'Hosted function call preceded response creation',
              );
            const calls = active.queued.splice(0);
            for (const item of calls)
              active.emitted.add(item.call_id as string);
            for (const [output_index, item] of calls.entries())
              yield markResponsesSocketFrame(
                {
                  type: 'message',
                  message: {
                    type: 'response.output_item.done',
                    output_index,
                    item,
                  },
                } as unknown as typeof envelope,
                'projected',
              );
            yield markResponsesSocketFrame(
              {
                type: 'message',
                message: {
                  type: 'response.completed',
                  response: {
                    ...active.template,
                    id: active.responseId,
                    status: 'completed',
                    output: calls,
                    usage: null,
                  },
                },
              } as unknown as typeof envelope,
              'projected',
            );
          } else if (active.terminal && !active.injecting) {
            const saved = active.terminal;
            const completed = object(saved.response);
            if (!completed)
              throw new TypeError('Hosted terminal requires a response');
            const output = Array.isArray(completed.output)
              ? completed.output
                  .map(object)
                  .filter((item): item is JsonObject => Boolean(item))
              : [];
            const supported = output.filter(
              (item) =>
                stable(item) &&
                !(
                  item.type === 'function_call' &&
                  typeof item.call_id === 'string' &&
                  active.emitted.has(item.call_id)
                ),
            );
            run.active = undefined;
            for (const [output_index, item] of supported.entries())
              yield markResponsesSocketFrame(
                {
                  type: 'message',
                  message: {
                    type: 'response.output_item.done',
                    output_index,
                    item,
                  },
                } as unknown as typeof envelope,
                'projected',
              );
            yield markResponsesSocketFrame(
              {
                type: 'message',
                message: {
                  ...saved,
                  response: {
                    ...completed,
                    output: supported,
                  },
                },
              } as unknown as typeof envelope,
              'projected',
            );
          }
        }
      } finally {
        await iterator.return?.();
      }
    },
  };
}
