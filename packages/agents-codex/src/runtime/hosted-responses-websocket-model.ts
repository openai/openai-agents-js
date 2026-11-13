import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
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
  bindResponsesSocketReplacementCheck,
  markResponsesSocketFrame,
  responsesSocketFrameKind,
  responsesSocketScope,
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
  acknowledgedOutputs: Map<string, JsonObject>;
  acknowledgedUserItems: Map<
    string,
    { afterCallId?: string; item: JsonObject }
  >;
  template?: JsonObject;
  responseId?: string;
  pending: Set<string>;
  emitted: Set<string>;
  passive: Map<string, number>;
  passiveCount: number;
  admittedPrograms: Set<string>;
  queued: JsonObject[];
  injecting?: Set<string>;
  terminal?: JsonObject;
  bytes: number;
};
type SocketEnvelope =
  ReturnType<
    ResponsesSocket[typeof Symbol.asyncIterator]
  > extends AsyncIterableIterator<infer Envelope>
    ? Envelope
    : never;
type Run = {
  active?: ActiveResponse;
  request?: ModelRequest;
  replacementFailure?: Error;
  socketScope?: string;
  recovered?: { frames: SocketEnvelope[]; bytes: number };
};
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
const maxResponseItems = 4096;

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
        if (run.replacementFailure) throw run.replacementFailure;
        const scope = responsesSocketScope(transport);
        if (run.socketScope !== undefined && run.socketScope !== scope)
          throw new TypeError('Hosted run cannot change transport scope');
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
        run.socketScope = scope;
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
    const body = request.body;
    if (Object.hasOwn(body, 'multi_agent') || Object.hasOwn(body, 'betas'))
      throw new TypeError('Hosted Responses owns multi_agent and betas');
    if (body.max_tool_calls != null)
      throw new TypeError('Hosted Responses does not support max_tool_calls');
    if (object(body.reasoning)?.summary != null)
      throw new TypeError(
        'Hosted Responses does not support reasoning.summary',
      );
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
    try {
      await this.#transport.cleanupOnRunEnd(owner);
    } finally {
      this.#runs.delete(owner);
    }
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
function isProgramItem(item: JsonObject): boolean {
  return item.type === 'program' || item.type === 'program_output';
}
function programItemKey(item: JsonObject): string {
  const content = JSON.stringify(item, (_key, value: unknown) => {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      !JSON.isRawJSON(value)
    ) {
      const fields = value as JsonObject;
      return Object.fromEntries(
        Object.keys(fields)
          .sort()
          .map((key) => [key, fields[key]]),
      );
    }
    return value;
  });
  return createHash('sha256').update(content).digest('hex');
}
function recordProgramItem(active: ActiveResponse, item: JsonObject): void {
  const key = programItemKey(item);
  active.passive.set(key, (active.passive.get(key) ?? 0) + 1);
  active.passiveCount++;
  if (item.type === 'program' && typeof item.call_id === 'string')
    active.admittedPrograms.add(item.call_id);
}
function responseConfiguration(frame: JsonObject): object {
  const {
    input,
    previous_response_id: _previousResponse,
    stream: _httpStream,
    betas: _headerBetas,
    // Native client metadata describes the current request, not the Agent.
    client_metadata: _clientMetadata,
    ...configuration
  } = frame;
  // Core puts the active declaration instructions in developer input.
  const developer = Array.isArray(input)
    ? input.flatMap((value) => {
        const item = object(value);
        return item?.type === 'message' && item.role === 'developer'
          ? [item.content]
          : [];
      })
    : [];
  return { ...configuration, developer };
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
  let producer: AsyncIterableIterator<SocketEnvelope> | undefined;
  let ownedActive: ActiveResponse | undefined;
  let paused = false;
  let retiring = false;
  const recover = (envelope: SocketEnvelope) => {
    if (envelope.type !== 'message') return;
    const queue = (run.recovered ??= { frames: [], bytes: 0 });
    queue.bytes += Buffer.byteLength(JSON.stringify(envelope.message));
    if (
      queue.bytes > maxResponseBytes * 2 ||
      queue.frames.length >= maxResponseItems * 2
    )
      throw new RangeError('Hosted recovery exceeds the native retained limit');
    queue.frames.push(envelope);
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
    run.active = ownedActive = {
      create: frame,
      lineage,
      pending: new Set(),
      acknowledgedOutputs: new Map(),
      acknowledgedUserItems: new Map(),
      emitted,
      passive: new Map(),
      passiveCount: 0,
      admittedPrograms: new Set(),
      queued: [],
      bytes,
    };
    paused = false;
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
    input: JsonObject[],
  ) => {
    const completed = object(active.terminal?.response);
    if (!completed || typeof completed.id !== 'string')
      throw new TypeError(
        'Hosted continuation requires an exact terminal response',
      );
    const next: JsonObject = { ...frame, input };
    if (next.conversation != null) delete next.previous_response_id;
    else if (
      typeof completed.store === 'boolean'
        ? completed.store
        : active.create.store !== false
    )
      next.previous_response_id = completed.id;
    else {
      const replay = Array.isArray(active.create.input)
        ? [...active.create.input]
        : [];
      const acknowledged = new Map(active.acknowledgedOutputs);
      const anchoredUsers = new Map<string | undefined, JsonObject[]>();
      for (const {
        afterCallId,
        item,
      } of active.acknowledgedUserItems.values()) {
        const messages = anchoredUsers.get(afterCallId);
        if (messages) messages.push(item);
        else anchoredUsers.set(afterCallId, [item]);
      }
      const appendUsers = (afterCallId?: string) => {
        replay.push(...(anchoredUsers.get(afterCallId) ?? []));
        anchoredUsers.delete(afterCallId);
      };
      appendUsers();
      for (const item of Array.isArray(completed.output)
        ? completed.output
        : []) {
        replay.push(item);
        const call = object(item);
        if (
          call?.type === 'function_call' &&
          typeof call.call_id === 'string'
        ) {
          const result = acknowledged.get(call.call_id);
          if (result) {
            replay.push(result);
            appendUsers(call.call_id);
            acknowledged.delete(call.call_id);
          }
        }
      }
      for (const [callId, result] of acknowledged) {
        replay.push(result);
        appendUsers(callId);
      }
      for (const messages of anchoredUsers.values()) replay.push(...messages);
      next.input = [...replay, ...input];
      if (typeof active.create.previous_response_id === 'string')
        next.previous_response_id = active.create.previous_response_id;
      else delete next.previous_response_id;
    }
    create(next, active.emitted);
  };
  const checkedContinuation = (
    active: ActiveResponse,
    frame: JsonObject,
  ): JsonObject[] => {
    const input = Array.isArray(frame.input)
      ? frame.input
          .map(object)
          .filter((item): item is JsonObject => Boolean(item))
      : [];
    const originalUserIds = new Set(
      Array.isArray(active.create.input)
        ? active.create.input
            .map(object)
            .filter((item) => item?.role === 'user')
            .map((item) => item?.id)
        : [],
    );
    const continuationInput = input.filter((item) => {
      if (item.type === 'function_call_output')
        return (
          typeof item.call_id === 'string' && active.pending.has(item.call_id)
        );
      return (
        item.type === 'message' &&
        item.role === 'user' &&
        typeof item.id === 'string' &&
        !originalUserIds.has(item.id) &&
        !active.acknowledgedUserItems.has(item.id)
      );
    });
    const ids = new Set(
      continuationInput
        .filter((item) => item.type === 'function_call_output')
        .map((item) => item.call_id as string),
    );
    if (
      !active.responseId ||
      !ids.size ||
      [...active.pending].some((id) => !ids.has(id))
    )
      throw new TypeError(
        'Hosted response requires the matching local function outputs',
      );
    return continuationInput;
  };
  const transport: ResponsesSocket = {
    get socket() {
      return socket.socket;
    },
    close: async () => {
      const active = ownedActive;
      const physicallyRetiring =
        socket.socket.readyState === 2 || socket.socket.readyState === 3;
      const previousActive = run.active;
      const retaining = active !== undefined && previousActive === active;
      const reconcile =
        paused &&
        run.request &&
        !run.request.signal.aborted &&
        active &&
        !active.terminalReported;
      const closed =
        socket.socket.readyState === 3
          ? undefined
          : new Promise<void>((resolve) =>
              socket.socket.once('close', () => resolve()),
            );
      socket.close();
      await closed;
      if (!reconcile || !producer || !active || run.request?.signal.aborted)
        return;
      run.active = active;
      retiring = true;
      const admitted = new Set(active.admittedPrograms);
      const admittedCalls = new Set(active.emitted);
      const deadline = AbortSignal.any([
        request().signal,
        AbortSignal.timeout(1000),
      ]);
      let stop: () => void = () => {};
      const stopped = new Promise<never>((_, reject) => {
        stop = () => reject(new Error('Hosted closed response did not settle'));
        if (deadline.aborted) stop();
        else deadline.addEventListener('abort', stop, { once: true });
      });
      try {
        for (;;) {
          const next = await Promise.race([producer.next(), stopped]);
          if (next.done) break;
          const envelope = next.value;
          if (envelope.type !== 'message') continue;
          const kind = responsesSocketFrameKind(envelope);
          if (kind === 'raw') recover(envelope);
          else if (kind === 'projected') {
            const event = losslessJsonObjectSchema.parse(envelope.message);
            const item = object(event.item);
            if (
              item?.type === 'function_call' &&
              !admittedCalls.has(item.call_id as string)
            )
              throw new TypeError(
                'Closed hosted response contains an unadmitted function call',
              );
            if (
              item?.type === 'program_output' &&
              typeof item.call_id === 'string' &&
              admitted.has(item.call_id)
            ) {
              recover(envelope);
            }
            if (terminal.has(String(event.type)) && active.terminalReported)
              break;
          }
        }
      } catch (error) {
        run.replacementFailure ??=
          error instanceof Error
            ? error
            : new Error('Hosted response reconciliation failed', {
                cause: error,
              });
      } finally {
        deadline.removeEventListener('abort', stop);
        retiring = false;
        run.active = retaining ? active : previousActive;
      }
      if (
        (retaining || physicallyRetiring) &&
        !active.terminalReported &&
        !run.replacementFailure
      )
        run.replacementFailure = new TypeError(
          'Closed hosted response has no genuine terminal',
        );
    },
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
      const continuationInput = checkedContinuation(active, frame);
      const ids = new Set(
        continuationInput
          .filter((item) => item.type === 'function_call_output')
          .map((item) => item.call_id as string),
      );
      if (active.terminal) {
        fallback(active, frame, continuationInput);
        return;
      }
      request().signal?.throwIfAborted();
      active.bytes += Buffer.byteLength(JSON.stringify(continuationInput));
      if (active.bytes > maxResponseBytes)
        throw new RangeError(
          'Hosted response exceeds the native retained-byte limit',
        );
      paused = false;
      active.continuation = frame;
      active.injectionInput = continuationInput;
      active.injecting = ids;
      accountProviderRequest(request(), {
        operation: 'dispatch',
        lineage: active.lineage,
      });
      socket.send({
        type: 'response.inject',
        response_id: active.responseId,
        input: continuationInput,
      } as unknown as Parameters<ResponsesSocket['send']>[0]);
    },
    [Symbol.asyncIterator]() {
      return (producer ??= (async function* () {
        try {
          const recovered = run.recovered;
          run.recovered = undefined;
          if (recovered) yield* recovered.frames;
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
                item &&
                (isProgramItem(item) ||
                  (item.type === 'function_call' &&
                    typeof item.call_id === 'string' &&
                    !active.emitted.has(item.call_id) &&
                    !active.pending.has(item.call_id)))
              ) {
                if (
                  active.emitted.size +
                    active.passiveCount +
                    active.queued.length >=
                  maxResponseItems
                )
                  throw new RangeError(
                    'Hosted response exceeds the native output-item limit',
                  );
                if (item.type === 'function_call')
                  active.pending.add(item.call_id as string);
                active.queued.push(copyJsonValue(item) as JsonObject);
              }
            } else if (event.type === 'response.inject.created') {
              if (active.injecting) {
                let afterCallId: string | undefined;
                for (const item of active.injectionInput ?? []) {
                  if (
                    item.type === 'function_call_output' &&
                    typeof item.call_id === 'string'
                  ) {
                    afterCallId = item.call_id;
                    active.acknowledgedOutputs.set(afterCallId, item);
                  } else if (typeof item.id === 'string') {
                    active.acknowledgedUserItems.set(item.id, {
                      afterCallId,
                      item,
                    });
                  }
                }
                for (const id of active.injecting) active.pending.delete(id);
                active.injectionInput = undefined;
                active.injecting = undefined;
              }
            } else if (
              event.type === 'response.inject.failed' &&
              object(event.error)?.code === 'response_already_completed'
            ) {
              active.fallbackInput = active.injectionInput;
              for (const id of active.injecting ?? [])
                active.pending.delete(id);
              active.injecting = undefined;
            } else if (
              event.type === 'response.inject.failed' ||
              event.type === 'response.error' ||
              event.type === 'error'
            ) {
              throw new Error(
                'Hosted response rejected the provider operation',
                {
                  cause: event.error,
                },
              );
            } else if (terminal.has(String(event.type))) {
              if (active.terminalReported)
                throw new TypeError(
                  'Hosted response received more than one terminal',
                );
              if (
                Array.isArray(response?.output) &&
                response.output.length > maxResponseItems
              )
                throw new RangeError(
                  'Hosted response exceeds the native output-item limit',
                );
              const measured = projectResponsesUsage(response?.usage);
              accountProviderRequest(request(), {
                operation: 'terminal',
                lineage: active.lineage,
                ...(measured ? { usage: addRunUsage(null, measured) } : {}),
              });
              active.terminalReported = true;
              active.terminal = copyJsonValue(event) as JsonObject;
              // Terminal snapshots can settle a Program before a failed injection falls back.
              const prior = new Map(active.passive);
              for (const item of active.queued) {
                if (!isProgramItem(item)) continue;
                const key = programItemKey(item);
                prior.set(key, (prior.get(key) ?? 0) + 1);
              }
              for (const value of Array.isArray(response?.output)
                ? response.output
                : []) {
                const item = object(value);
                if (!item || !isProgramItem(item)) continue;
                const key = programItemKey(item);
                const observed = prior.get(key) ?? 0;
                if (observed > 0) {
                  prior.set(key, observed - 1);
                  continue;
                }
                if (
                  active.emitted.size +
                    active.passiveCount +
                    active.queued.length >=
                  maxResponseItems
                )
                  throw new RangeError(
                    'Hosted response exceeds the native output-item limit',
                  );
                active.queued.push(copyJsonValue(item) as JsonObject);
              }
            }
            if (
              active.terminal &&
              !retiring &&
              active.fallbackInput?.length &&
              !active.injecting
            ) {
              if (!active.continuation)
                throw new TypeError(
                  'Hosted fallback requires its original continuation',
                );
              // Preserve the existing fallback priority over queued function callbacks.
              for (const item of active.queued) {
                if (!isProgramItem(item)) continue;
                recordProgramItem(active, item);
                yield markResponsesSocketFrame(
                  {
                    type: 'message',
                    message: { type: 'response.output_item.done', item },
                  } as unknown as typeof envelope,
                  'projected',
                );
              }
              fallback(active, active.continuation, active.fallbackInput);
              continue;
            }
            if (active.queued.length && !active.injecting) {
              if (!active.template || !active.responseId)
                throw new TypeError(
                  'Hosted function call preceded response creation',
                );
              const items = active.queued.splice(0);
              const calls = items.filter(
                (item) => item.type === 'function_call',
              );
              for (const item of items) {
                if (isProgramItem(item)) recordProgramItem(active, item);
                else active.emitted.add(item.call_id as string);
              }
              for (const [output_index, item] of items.entries())
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
              if (calls.length) {
                paused = true;
                yield markResponsesSocketFrame(
                  {
                    type: 'message',
                    message: {
                      type: 'response.completed',
                      response: {
                        ...active.template,
                        id: active.responseId,
                        status: 'completed',
                        output: items,
                        usage: null,
                      },
                    },
                  } as unknown as typeof envelope,
                  'projected',
                );
                continue;
              }
            }
            if (active.terminal && !active.injecting) {
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
                    isProgramItem(item) &&
                    active.passive.has(programItemKey(item))
                  ) &&
                  !(
                    item.type === 'function_call' &&
                    typeof item.call_id === 'string' &&
                    active.emitted.has(item.call_id)
                  ),
              );
              paused = false;
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
      })());
    },
  };
  return bindResponsesSocketReplacementCheck(
    transport,
    (frame, scopeChanged) => {
      const active = run.active;
      if (active && scopeChanged) {
        run.replacementFailure = new TypeError(
          'Active hosted response cannot change transport scope',
        );
        return true;
      }
      if (
        !active ||
        active.terminal ||
        isDeepStrictEqual(
          responseConfiguration(active.create),
          responseConfiguration(frame),
        )
      )
        return false;
      checkedContinuation(active, frame);
      if (frame.previous_response_id === active.responseId) {
        if (typeof active.create.previous_response_id === 'string')
          frame.previous_response_id = active.create.previous_response_id;
        else delete frame.previous_response_id;
      }
      // A paused response accepts input injection only. Replay the new native
      // request on its own socket, without treating the old pause as a terminal.
      run.active = undefined;
      return true;
    },
  );
}
