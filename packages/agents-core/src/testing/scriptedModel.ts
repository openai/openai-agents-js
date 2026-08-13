import {
  Model,
  ModelRequest,
  ModelResponse,
  ModelRetryAdvice,
  ModelRetryAdviceRequest,
} from '../model';
import type {
  AssistantMessageItem,
  FunctionCallItem,
  StreamEvent,
} from '../types/protocol';
import { Usage } from '../usage';
import { snapshotRawUsage } from '../utils/rawUsage';
import { snapshotTestingValue } from '../utils/testingSnapshot';

/**
 * A complete normalized response or an output-only shorthand.
 *
 * Output-only responses count as one model request and receive a deterministic
 * response ID. Automatic streaming also assigns a deterministic response ID
 * when a complete response omits one because the normalized terminal stream
 * event requires an ID.
 */
export type ScriptedModelResponse = ModelResponse | ModelResponse['output'];

export type RecordedModelCall = Readonly<{
  /** The zero-based position of this model call in `calls`. */
  index: number;

  /** Whether the runner requested a streamed response. */
  streamed: boolean;

  /**
   * A frozen request snapshot with detached mutable input collections and
   * model settings. Runtime object identities such as the abort signal remain
   * unchanged.
   */
  request: Readonly<ModelRequest>;
}>;

export type ScriptedModelRetryAdvice =
  | ModelRetryAdvice
  | ((
      request: ModelRetryAdviceRequest,
    ) => ModelRetryAdvice | undefined | Promise<ModelRetryAdvice | undefined>);

type ScriptedModelResponseStep = {
  type: 'response';
  response: ScriptedModelResponse;
};

type ScriptedModelErrorStep = {
  type: 'error';
  error: unknown;
  retryAdvice?: ScriptedModelRetryAdvice;
};

type ScriptedModelResponderStep = {
  type: 'responder';
  respond: (
    call: RecordedModelCall,
  ) => ScriptedModelResponse | Promise<ScriptedModelResponse>;
};

export type ScriptedModelStream =
  Iterable<StreamEvent> | AsyncIterable<StreamEvent>;

type ScriptedModelStreamStep = {
  type: 'stream';
  events: ScriptedModelStream;
};

type ScriptedModelStreamResponderStep = {
  type: 'stream_responder';
  respond: (
    call: RecordedModelCall,
  ) => ScriptedModelStream | Promise<ScriptedModelStream>;
};

type ScriptedModelStep =
  | ScriptedModelResponseStep
  | ScriptedModelErrorStep
  | ScriptedModelResponderStep
  | ScriptedModelStreamStep
  | ScriptedModelStreamResponderStep;

export type ScriptedModelInput = ScriptedModelStep | ScriptedModelResponse;

export type AssistantMessageOptions = {
  id?: string;
  phase?: AssistantMessageItem['phase'];
  providerData?: Record<string, unknown>;
};

export type FunctionCallOptions = {
  callId: string;
  id?: string;
  namespace?: string;
  providerData?: Record<string, unknown>;
};

export type InvalidScriptedModelStepReason =
  | 'invalid_input'
  | 'unknown_step_type'
  | 'missing_response'
  | 'invalid_response'
  | 'missing_error'
  | 'missing_responder'
  | 'invalid_stream'
  | 'incompatible_call';

export class UnexpectedModelCallError extends Error {
  /** The zero-based position of the call in `ScriptedModel.calls`. */
  readonly callIndex: number;
  readonly streamed: boolean;

  constructor(call: RecordedModelCall) {
    super(
      `ScriptedModel received unexpected ${call.streamed ? 'streaming' : 'non-streaming'} call #${displayIndex(call.index)}; no scripted steps remain.`,
    );
    this.name = 'UnexpectedModelCallError';
    this.callIndex = call.index;
    this.streamed = call.streamed;
  }
}

export class UnconsumedModelStepsError extends Error {
  readonly remainingSteps: number;

  constructor(remainingSteps: number) {
    super(
      `ScriptedModel has ${remainingSteps} unconsumed scripted step${remainingSteps === 1 ? '' : 's'}.`,
    );
    this.name = 'UnconsumedModelStepsError';
    this.remainingSteps = remainingSteps;
  }
}

export class InvalidScriptedModelStepError extends Error {
  readonly reason: InvalidScriptedModelStepReason;
  /** The zero-based position of an invalid constructor or `enqueue()` input. */
  readonly inputIndex?: number;
  /** The zero-based position of a call in `ScriptedModel.calls`. */
  readonly callIndex?: number;
  readonly stepType?: string;

  constructor(options: {
    reason: InvalidScriptedModelStepReason;
    message: string;
    inputIndex?: number;
    callIndex?: number;
    stepType?: string;
  }) {
    super(options.message);
    this.name = 'InvalidScriptedModelStepError';
    this.reason = options.reason;
    this.inputIndex = options.inputIndex;
    this.callIndex = options.callIndex;
    this.stepType = options.stepType;
  }
}

export class ScriptedModelRequestAbortedError extends Error {
  /** The zero-based position of a call in `ScriptedModel.calls`. */
  readonly callIndex?: number;

  constructor(callIndex?: number) {
    super('Scripted model request was aborted.');
    this.name = 'AbortError';
    this.callIndex = callIndex;
  }
}

/** Creates a scripted normalized model response step. */
export function modelResponse(
  response: ScriptedModelResponse,
): ScriptedModelResponseStep {
  return { type: 'response', response };
}

/** Creates a scripted model failure step. */
export function modelError(
  error: unknown,
  retryAdvice?: ScriptedModelRetryAdvice,
): ScriptedModelErrorStep {
  return { type: 'error', error, retryAdvice };
}

/** Creates a response step that derives its output from the recorded call. */
export function modelResponder(
  respond: ScriptedModelResponderStep['respond'],
): ScriptedModelResponderStep {
  return { type: 'responder', respond };
}

/** Creates a raw normalized stream step. */
export function modelStream(
  events: ScriptedModelStreamStep['events'],
): ScriptedModelStreamStep {
  return { type: 'stream', events };
}

/** Creates a raw normalized stream derived from the recorded call. */
export function modelStreamResponder(
  respond: ScriptedModelStreamResponderStep['respond'],
): ScriptedModelStreamResponderStep {
  return { type: 'stream_responder', respond };
}

/** Creates a normalized assistant text message. */
export function assistantMessage(
  text: string,
  options: AssistantMessageOptions = {},
): AssistantMessageItem {
  return {
    type: 'message',
    role: 'assistant',
    status: 'completed',
    ...(typeof options.id === 'undefined' ? {} : { id: options.id }),
    ...(typeof options.phase === 'undefined' ? {} : { phase: options.phase }),
    content: [
      {
        type: 'output_text',
        text,
      },
    ],
    ...(typeof options.providerData === 'undefined'
      ? {}
      : { providerData: options.providerData }),
  };
}

/** Creates a normalized function call item. */
export function functionCall(
  name: string,
  args: string | Record<string, unknown>,
  options: FunctionCallOptions,
): FunctionCallItem {
  return {
    type: 'function_call',
    name,
    callId: options.callId,
    id: options.id ?? options.callId,
    namespace: options.namespace,
    status: 'completed',
    arguments: typeof args === 'string' ? args : JSON.stringify(args),
    providerData: options.providerData,
  };
}

/**
 * A deterministic model test double that consumes one scripted step per call.
 */
export class ScriptedModel implements Model {
  readonly #steps: ScriptedModelStep[];
  readonly #calls: RecordedModelCall[] = [];
  readonly #retryAdvice = new Map<
    unknown,
    Array<{
      request: ModelRequest;
      streamed: boolean;
      advice: ScriptedModelRetryAdvice | undefined;
    }>
  >();

  constructor(inputs: Iterable<ScriptedModelInput> = []) {
    this.#steps = Array.from(inputs, (input, index) =>
      normalizeInput(input, index),
    );
  }

  /** All calls recorded by this model in invocation order. */
  get calls(): readonly RecordedModelCall[] {
    return Object.freeze(this.#calls.map(snapshotRecordedModelCall));
  }

  /** The first recorded call, if one has occurred. */
  get firstCall(): RecordedModelCall | undefined {
    const call = this.#calls[0];
    return call ? snapshotRecordedModelCall(call) : undefined;
  }

  /** The most recent recorded call, if one has occurred. */
  get lastCall(): RecordedModelCall | undefined {
    const call = this.#calls.at(-1);
    return call ? snapshotRecordedModelCall(call) : undefined;
  }

  /** The number of scripted steps that have not been consumed. */
  get remainingSteps(): number {
    return this.#steps.length;
  }

  /** Adds steps to the end of the script. */
  enqueue(...inputs: ScriptedModelInput[]): void {
    const steps = inputs.map((input, index) => normalizeInput(input, index));
    this.#steps.push(...steps);
  }

  /** Throws when the script still contains unconsumed steps. */
  assertComplete(): void {
    if (this.#steps.length > 0) {
      throw new UnconsumedModelStepsError(this.#steps.length);
    }
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    throwIfAborted(request.signal);
    const { call, step } = this.#recordAndTakeStep(request, false);

    if (step.type === 'stream' || step.type === 'stream_responder') {
      throw new InvalidScriptedModelStepError({
        reason: 'incompatible_call',
        callIndex: call.index,
        stepType: step.type,
        message: `ScriptedModel cannot use raw stream step for non-streaming call #${displayIndex(call.index)}.`,
      });
    }

    if (step.type === 'error') {
      this.#rememberRetryAdvice(step, request, false);
      throw step.error;
    }

    const response =
      step.type === 'responder' ? await step.respond(call) : step.response;
    throwIfAborted(request.signal, call.index);
    return normalizeResponseForCall(response, call, false);
  }

  getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    throwIfAborted(request.signal);
    const { call, step } = this.#recordAndTakeStep(request, true);

    return this.#processStreamedStep(request, call, step);
  }

  async *#processStreamedStep(
    request: ModelRequest,
    call: RecordedModelCall,
    step: ScriptedModelStep,
  ): AsyncIterable<StreamEvent> {
    throwIfAborted(request.signal, call.index);
    if (step.type === 'error') {
      this.#rememberRetryAdvice(step, request, true);
      throw step.error;
    }

    if (step.type === 'stream' || step.type === 'stream_responder') {
      const events =
        step.type === 'stream' ? step.events : await step.respond(call);
      throwIfAborted(request.signal, call.index);
      if (step.type === 'stream_responder' && !isIterable(events)) {
        throw new InvalidScriptedModelStepError({
          reason: 'invalid_stream',
          callIndex: call.index,
          stepType: step.type,
          message: `ScriptedModel stream responder returned an invalid stream for call #${displayIndex(call.index)}.`,
        });
      }
      for await (const event of events) {
        throwIfAborted(request.signal, call.index);
        yield event;
      }
      throwIfAborted(request.signal, call.index);
      return;
    }

    const scriptedResponse =
      step.type === 'responder' ? await step.respond(call) : step.response;
    throwIfAborted(request.signal, call.index);
    const response = normalizeResponseForCall(scriptedResponse, call, true);
    yield* streamResponse(response, request.signal, call.index);
  }

  async getRetryAdvice(
    request: ModelRetryAdviceRequest,
  ): Promise<ModelRetryAdvice | undefined> {
    const records = this.#retryAdvice.get(request.error);
    if (!records) {
      return undefined;
    }

    let recordIndex = records.findIndex(
      (record) =>
        record.streamed === request.stream &&
        record.request === request.request,
    );
    if (recordIndex === -1) {
      recordIndex = records.findIndex(
        (record) =>
          record.streamed === request.stream &&
          requestsShareCallInputs(record.request, request.request),
      );
    }
    if (recordIndex === -1) {
      recordIndex = records.findIndex(
        (record) => record.streamed === request.stream,
      );
    }
    if (recordIndex === -1) {
      return undefined;
    }

    const [record] = records.splice(recordIndex, 1);
    if (records.length === 0) {
      this.#retryAdvice.delete(request.error);
    }
    const advice = record?.advice;
    if (typeof advice === 'function') {
      return await advice(request);
    }
    return advice;
  }

  #recordAndTakeStep(
    request: ModelRequest,
    streamed: boolean,
  ): { call: RecordedModelCall; step: ScriptedModelStep } {
    const recordedCall: RecordedModelCall = Object.freeze({
      index: this.#calls.length,
      streamed,
      request: snapshotRequest(request),
    });
    this.#calls.push(recordedCall);

    const step = this.#steps.shift();
    if (!step) {
      throw new UnexpectedModelCallError(recordedCall);
    }
    return { call: snapshotRecordedModelCall(recordedCall), step };
  }

  #rememberRetryAdvice(
    step: ScriptedModelErrorStep,
    request: ModelRequest,
    streamed: boolean,
  ): void {
    const records = this.#retryAdvice.get(step.error) ?? [];
    records.push({ request, streamed, advice: step.retryAdvice });
    this.#retryAdvice.set(step.error, records);
  }
}

function snapshotRequest(request: ModelRequest): Readonly<ModelRequest> {
  return Object.freeze(snapshotTestingValue(request));
}

function snapshotRecordedModelCall(call: RecordedModelCall): RecordedModelCall {
  return Object.freeze({
    index: call.index,
    streamed: call.streamed,
    request: snapshotRequest(call.request),
  });
}

function normalizeInput(
  input: ScriptedModelInput,
  inputIndex?: number,
): ScriptedModelStep {
  if (Array.isArray(input)) {
    return { type: 'response', response: snapshotScriptedResponse(input) };
  }
  if (typeof input !== 'object' || input === null) {
    throw invalidStep('invalid_input', inputIndex);
  }

  if ('type' in input) {
    const stepType = typeof input.type === 'string' ? input.type : undefined;
    switch (input.type) {
      case 'response':
        if (!('response' in input)) {
          throw invalidStep('missing_response', inputIndex, stepType);
        }
        validateResponse(input.response, inputIndex);
        return {
          type: 'response',
          response: snapshotScriptedResponse(input.response),
        };
      case 'error':
        if (!('error' in input)) {
          throw invalidStep('missing_error', inputIndex, stepType);
        }
        return {
          type: 'error',
          error: input.error,
          retryAdvice:
            typeof input.retryAdvice === 'function'
              ? input.retryAdvice
              : snapshotTestingValue(input.retryAdvice),
        };
      case 'responder':
        if (typeof input.respond !== 'function') {
          throw invalidStep('missing_responder', inputIndex, stepType);
        }
        return { type: 'responder', respond: input.respond };
      case 'stream_responder':
        if (typeof input.respond !== 'function') {
          throw invalidStep('missing_responder', inputIndex, stepType);
        }
        return { type: 'stream_responder', respond: input.respond };
      case 'stream':
        if (!isIterable(input.events)) {
          throw invalidStep('invalid_stream', inputIndex, stepType);
        }
        return {
          type: 'stream',
          events: snapshotScriptedStream(input.events),
        };
      default:
        throw invalidStep('unknown_step_type', inputIndex, stepType);
    }
  }

  if ('output' in input || 'usage' in input) {
    validateResponse(input, inputIndex);
    return { type: 'response', response: snapshotScriptedResponse(input) };
  }
  throw invalidStep('invalid_input', inputIndex);
}

function validateResponse(
  response: unknown,
  inputIndex?: number,
  callIndex?: number,
): asserts response is ScriptedModelResponse {
  if (Array.isArray(response)) {
    return;
  }
  if (
    typeof response !== 'object' ||
    response === null ||
    !Array.isArray((response as Partial<ModelResponse>).output) ||
    !((response as Partial<ModelResponse>).usage instanceof Usage)
  ) {
    throw new InvalidScriptedModelStepError({
      reason: 'invalid_response',
      inputIndex,
      callIndex,
      message:
        typeof callIndex === 'number'
          ? `ScriptedModel responder returned an invalid response for call #${displayIndex(callIndex)}.`
          : `ScriptedModel input #${displayIndex(inputIndex ?? 0)} has an invalid response envelope.`,
    });
  }
}

function invalidStep(
  reason: InvalidScriptedModelStepReason,
  inputIndex?: number,
  stepType?: string,
): InvalidScriptedModelStepError {
  const position = inputIndex ?? 0;
  const detail =
    reason === 'unknown_step_type' && stepType
      ? ` has unknown type "${stepType}"`
      : ` is invalid (${reason.replace(/_/g, ' ')})`;
  return new InvalidScriptedModelStepError({
    reason,
    inputIndex: position,
    stepType,
    message: `ScriptedModel input #${displayIndex(position)}${detail}.`,
  });
}

function snapshotScriptedResponse(
  response: ScriptedModelResponse,
): ScriptedModelResponse {
  if (Array.isArray(response)) {
    return snapshotTestingValue(response);
  }

  const snapshot: ModelResponse = {
    output: snapshotTestingValue(response.output),
    usage: snapshotUsage(response.usage),
    ...(typeof response.responseId === 'undefined'
      ? {}
      : { responseId: response.responseId }),
    ...(typeof response.requestId === 'undefined'
      ? {}
      : { requestId: response.requestId }),
    ...(typeof response.providerData === 'undefined'
      ? {}
      : { providerData: snapshotTestingValue(response.providerData) }),
  };
  const rawUsageDescriptor = Object.getOwnPropertyDescriptor(
    response,
    'rawUsage',
  );
  if (rawUsageDescriptor) {
    Object.defineProperty(snapshot, 'rawUsage', {
      ...rawUsageDescriptor,
      ...(Object.prototype.hasOwnProperty.call(rawUsageDescriptor, 'value')
        ? { value: snapshotTestingValue(rawUsageDescriptor.value) }
        : {}),
    });
  }
  return snapshot;
}

function snapshotUsage(usage: Usage): Usage {
  return new Usage({
    requests: usage.requests,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    inputTokensDetails: snapshotTestingValue(usage.inputTokensDetails),
    outputTokensDetails: snapshotTestingValue(usage.outputTokensDetails),
    requestUsageEntries: usage.requestUsageEntries?.map((entry) => ({
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      totalTokens: entry.totalTokens,
      inputTokensDetails: snapshotTestingValue(entry.inputTokensDetails),
      outputTokensDetails: snapshotTestingValue(entry.outputTokensDetails),
      endpoint: entry.endpoint,
    })),
  });
}

function snapshotScriptedStream(
  events: ScriptedModelStream,
): ScriptedModelStream {
  return Array.isArray(events) ? snapshotTestingValue(events) : events;
}

function displayIndex(index: number): number {
  return index + 1;
}

function isIterable(value: unknown): value is ScriptedModelStream {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<
    Iterable<StreamEvent> & AsyncIterable<StreamEvent>
  >;
  return (
    typeof candidate[Symbol.iterator] === 'function' ||
    typeof candidate[Symbol.asyncIterator] === 'function'
  );
}

function requestsShareCallInputs(
  recorded: ModelRequest,
  advised: ModelRequest,
): boolean {
  return (
    recorded.input === advised.input &&
    recorded.modelSettings === advised.modelSettings &&
    recorded.tools === advised.tools &&
    recorded.handoffs === advised.handoffs
  );
}

function normalizeResponse(
  response: ScriptedModelResponse,
  request: ModelRequest,
  callIndex: number,
  requireResponseId: boolean,
): ModelResponse {
  validateResponse(response, undefined, callIndex);
  if (Array.isArray(response)) {
    return {
      output: response,
      usage: new Usage({ requests: 1 }),
      responseId: `scripted-response-${displayIndex(callIndex)}`,
    };
  }

  let rawUsage: Record<string, unknown> | undefined;
  const preserveRawUsage = request.modelSettings.preserveRawUsage === true;
  if (preserveRawUsage) {
    try {
      rawUsage = snapshotRawUsage(response.rawUsage);
    } catch {
      rawUsage = undefined;
    }
  }
  const responseId =
    requireResponseId && typeof response.responseId === 'undefined'
      ? `scripted-response-${displayIndex(callIndex)}`
      : response.responseId;
  const hasRawUsage = 'rawUsage' in response;
  if (responseId === response.responseId && !hasRawUsage) {
    return response;
  }

  const responseWithoutRawUsage = {} as Omit<ModelResponse, 'rawUsage'>;
  for (const key of Object.keys(response) as Array<keyof ModelResponse>) {
    if (key !== 'rawUsage') {
      Object.assign(responseWithoutRawUsage, { [key]: response[key] });
    }
  }
  return {
    ...responseWithoutRawUsage,
    ...(typeof responseId === 'undefined' ? {} : { responseId }),
    ...(typeof rawUsage === 'undefined' ? {} : { rawUsage }),
  };
}

function normalizeResponseForCall(
  response: ScriptedModelResponse,
  call: RecordedModelCall,
  requireResponseId: boolean,
): ModelResponse {
  const normalized = normalizeResponse(
    response,
    call.request,
    call.index,
    requireResponseId,
  );
  throwIfAborted(call.request.signal, call.index);
  return normalized;
}

async function* streamResponse(
  response: ModelResponse,
  signal?: AbortSignal,
  callIndex?: number,
): AsyncIterable<StreamEvent> {
  throwIfAborted(signal, callIndex);
  yield { type: 'response_started' };

  for (const item of response.output) {
    if (
      item.type !== 'message' ||
      item.role !== 'assistant' ||
      !Array.isArray(item.content)
    ) {
      continue;
    }
    for (const part of item.content) {
      if (part.type === 'output_text') {
        throwIfAborted(signal, callIndex);
        yield snapshotTestingValue<StreamEvent>({
          type: 'output_text_delta',
          itemId: item.id,
          delta: part.text,
          ...(typeof part.providerData === 'undefined'
            ? {}
            : { providerData: part.providerData }),
        });
      }
    }
  }

  throwIfAborted(signal, callIndex);
  yield snapshotTestingValue<StreamEvent>({
    type: 'response_done',
    response: {
      id: response.responseId!,
      requestId: response.requestId,
      usage: {
        requests: response.usage.requests,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        totalTokens: response.usage.totalTokens,
        inputTokensDetails:
          response.usage.inputTokensDetails.length > 0
            ? response.usage.inputTokensDetails
            : undefined,
        outputTokensDetails:
          response.usage.outputTokensDetails.length > 0
            ? response.usage.outputTokensDetails
            : undefined,
        requestUsageEntries: response.usage.requestUsageEntries?.map(
          (entry) => ({
            inputTokens: entry.inputTokens,
            outputTokens: entry.outputTokens,
            totalTokens: entry.totalTokens,
            inputTokensDetails: entry.inputTokensDetails,
            outputTokensDetails: entry.outputTokensDetails,
            endpoint: entry.endpoint,
          }),
        ),
      },
      rawUsage: response.rawUsage,
      providerData: response.providerData,
      output: response.output,
    },
  } as StreamEvent);
}

function throwIfAborted(signal?: AbortSignal, callIndex?: number): void {
  if (!signal?.aborted) {
    return;
  }
  throw new ScriptedModelRequestAbortedError(callIndex);
}
