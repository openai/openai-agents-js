import type {
  RealtimeClientMessage,
  RealtimeSessionConfig,
  RealtimeUserInput,
} from '../clientMessages';
import type {
  RealtimeItem,
  RealtimeMcpCallApprovalRequestItem,
} from '../items';
import type {
  RealtimeTransportLayer,
  RealtimeTransportLayerConnectOptions,
} from '../transportLayer';
import type {
  RealtimeTransportEventTypes,
  TransportError,
  TransportToolCallEvent,
} from '../transportLayerEvents';
import { snapshotTestingValue } from '@openai/agents-core/utils/internal';

type FunctionKeys<T> = {
  [TKey in keyof T]-?: NonNullable<T[TKey]> extends (...args: any[]) => any
    ? TKey
    : never;
}[keyof T];

export type RealtimeTransportMethod = Exclude<
  FunctionKeys<RealtimeTransportLayer>,
  'emit' | 'off' | 'on' | 'once'
>;

type DeclaredRealtimeTransportCallData = {
  connect: {
    options: Omit<RealtimeTransportLayerConnectOptions, 'apiKey'> & {
      apiKeyProvided: boolean;
    };
  };
  sendEvent: { event: RealtimeClientMessage };
  requestResponse: { response?: Record<string, any> };
  sendMessage: {
    message: RealtimeUserInput;
    otherEventData: Record<string, any>;
    options?: { triggerResponse?: boolean };
  };
  addImage: {
    image: string;
    options?: { triggerResponse?: boolean };
  };
  sendAudio: {
    audio: ArrayBuffer;
    options: { commit?: boolean };
  };
  updateSessionConfig: { config: Partial<RealtimeSessionConfig> };
  close: Record<never, never>;
  mute: { muted: boolean };
  sendFunctionCallOutput: {
    toolCall: TransportToolCallEvent;
    output: string;
    startResponse: boolean;
  };
  interrupt: Record<never, never>;
  resetHistory: {
    oldHistory: RealtimeItem[];
    newHistory: RealtimeItem[];
  };
  sendMcpResponse: {
    approvalRequest: RealtimeMcpCallApprovalRequestItem;
    approved: boolean;
    reason?: string;
  };
};

type ExactCallDataMap<TData> =
  TData extends Record<RealtimeTransportMethod, object>
    ? Exclude<keyof TData, RealtimeTransportMethod> extends never
      ? TData
      : never
    : never;

type RealtimeTransportCallData =
  ExactCallDataMap<DeclaredRealtimeTransportCallData>;

type RealtimeTransportCall = {
  [TMethod in RealtimeTransportMethod]: Readonly<
    { method: TMethod } & RealtimeTransportCallData[TMethod]
  >;
}[RealtimeTransportMethod];

type KnownRecordedRealtimeTransportCall = {
  [TMethod in RealtimeTransportMethod]: Readonly<
    { index: number; method: TMethod } & RealtimeTransportCallData[TMethod]
  >;
}[RealtimeTransportMethod];

/** A forward-compatible summary of an outbound transport call. */
export type RecordedRealtimeTransportCall = Readonly<{
  /** The zero-based position of this call in `calls`. */
  index: number;
  /** The invoked method. New SDK versions may add method names. */
  method: string;
}>;

export type RealtimeTransportCallFor<TMethod extends RealtimeTransportMethod> =
  Readonly<
    { index: number; method: TMethod } & RealtimeTransportCallData[TMethod]
  >;

export type RealtimeCallMatcher<TMethod extends RealtimeTransportMethod> = (
  call: RealtimeTransportCallFor<TMethod>,
) => boolean | void;

export type ScriptedRealtimeScenarioContext = {
  expectCall: <TMethod extends RealtimeTransportMethod>(
    method: TMethod,
    matcher?: RealtimeCallMatcher<TMethod>,
  ) => Promise<RealtimeTransportCallFor<TMethod>>;
  emit: <TEvent extends keyof RealtimeTransportEventTypes>(
    event: TEvent,
    ...args: RealtimeTransportEventTypes[TEvent]
  ) => boolean;
};

/** The callbacks and cancellation signal owned by `runScenario()`. */
export type ScriptedRealtimeScenarioOptions<TResult = void> = {
  scenario: (context: ScriptedRealtimeScenarioContext) => void | Promise<void>;
  exercise: () => TResult | Promise<TResult>;
  signal?: AbortSignal;
};

export type PendingRealtimeExpectation = Readonly<{
  order: number;
  method: RealtimeTransportMethod;
}>;

export type PendingRealtimeFailure = Readonly<{
  method: RealtimeTransportMethod;
  count: number;
}>;

type PendingExpectation = {
  order: number;
  method: RealtimeTransportMethod;
  matcher?: (call: KnownRecordedRealtimeTransportCall) => boolean | void;
  resolve: (call: KnownRecordedRealtimeTransportCall) => void;
  reject: (error: unknown) => void;
};

type CapturedFailure = { present: false } | { present: true; error: unknown };

type RealtimeTransportListener = (...args: any[]) => void;

type RealtimeTransportListenerRegistration = {
  listener: RealtimeTransportListener;
  once: boolean;
};

export class UnexpectedRealtimeCallError extends Error {
  /** The zero-based position of the call in `ScriptedRealtimeTransport.calls`. */
  readonly callIndex: number;
  readonly expectedMethod: RealtimeTransportMethod;
  readonly actualMethod: string;

  constructor(
    expectedMethod: RealtimeTransportMethod,
    actualCall: RecordedRealtimeTransportCall,
  ) {
    super(
      `ScriptedRealtimeTransport expected ${expectedMethod} but received ${actualCall.method} call #${displayIndex(actualCall.index)}.`,
    );
    this.name = 'UnexpectedRealtimeCallError';
    this.callIndex = actualCall.index;
    this.expectedMethod = expectedMethod;
    this.actualMethod = actualCall.method;
  }
}

export class RealtimeCallMatcherError extends Error {
  /** The zero-based position of the call in `ScriptedRealtimeTransport.calls`. */
  readonly callIndex: number;
  readonly actualMethod: string;

  constructor(call: RecordedRealtimeTransportCall) {
    super(
      `ScriptedRealtimeTransport matcher rejected ${call.method} call #${displayIndex(call.index)}.`,
    );
    this.name = 'RealtimeCallMatcherError';
    this.callIndex = call.index;
    this.actualMethod = call.method;
  }
}

export class IncompleteRealtimeScenarioError extends Error {
  readonly unconsumedCalls: readonly RecordedRealtimeTransportCall[];
  readonly pendingExpectations: readonly PendingRealtimeExpectation[];
  readonly pendingFailures: readonly PendingRealtimeFailure[];

  constructor(
    unconsumedCalls: readonly RecordedRealtimeTransportCall[],
    pendingExpectations: readonly PendingRealtimeExpectation[],
    pendingFailures: readonly PendingRealtimeFailure[],
  ) {
    const pendingOrder = pendingExpectations
      .map((expectation) => `#${expectation.order} ${expectation.method}`)
      .join(', ');
    const pendingFailureCount = pendingFailures.reduce(
      (total, failure) => total + failure.count,
      0,
    );
    super(
      `ScriptedRealtimeTransport scenario is incomplete: ${unconsumedCalls.length} unconsumed call${unconsumedCalls.length === 1 ? '' : 's'}, ${pendingExpectations.length} pending expectation${pendingExpectations.length === 1 ? '' : 's'}${pendingOrder ? ` (${pendingOrder})` : ''}, and ${pendingFailureCount} pending failure${pendingFailureCount === 1 ? '' : 's'}.`,
    );
    this.name = 'IncompleteRealtimeScenarioError';
    this.unconsumedCalls = Object.freeze([...unconsumedCalls]);
    this.pendingExpectations = Object.freeze([...pendingExpectations]);
    this.pendingFailures = Object.freeze([...pendingFailures]);
  }
}

export class ScriptedRealtimeScenarioCancelledError extends Error {
  readonly pendingExpectations: readonly PendingRealtimeExpectation[];

  constructor(pendingExpectations: readonly PendingRealtimeExpectation[]) {
    const pendingOrder = pendingExpectations
      .map((expectation) => `#${expectation.order} ${expectation.method}`)
      .join(', ');
    super(
      `ScriptedRealtimeTransport scenario was cancelled${pendingOrder ? ` with pending expectations: ${pendingOrder}` : ''}.`,
    );
    this.name = 'AbortError';
    this.pendingExpectations = Object.freeze([...pendingExpectations]);
  }
}

export class RealtimeTransportNotClosedError extends Error {
  readonly status: ScriptedRealtimeTransport['status'];

  constructor(status: ScriptedRealtimeTransport['status']) {
    super(
      `ScriptedRealtimeTransport is not closed; current status is ${status}.`,
    );
    this.name = 'RealtimeTransportNotClosedError';
    this.status = status;
  }
}

export class ScriptedRealtimeConnectionSupersededError extends Error {
  readonly operation = 'connect' as const;

  constructor() {
    super(
      'ScriptedRealtimeTransport connection attempt was superseded by another lifecycle operation.',
    );
    this.name = 'ScriptedRealtimeConnectionSupersededError';
  }
}

/**
 * An in-memory Realtime transport for deterministic session tests.
 */
export class ScriptedRealtimeTransport implements RealtimeTransportLayer {
  status: 'connected' | 'disconnected' | 'connecting' | 'disconnecting' =
    'disconnected';
  muted: boolean | null = false;

  readonly #calls: KnownRecordedRealtimeTransportCall[] = [];
  readonly #unconsumedCalls: KnownRecordedRealtimeTransportCall[] = [];
  readonly #expectations: PendingExpectation[] = [];
  readonly #failures = new Map<RealtimeTransportMethod, unknown[]>();
  readonly #listeners = new Map<
    keyof RealtimeTransportEventTypes,
    RealtimeTransportListenerRegistration[]
  >();
  #lifecycleGeneration = 0;
  #provisionalConnectedGeneration: number | undefined;
  #nextExpectationOrder = 1;

  /** Registers a synchronous transport event listener. */
  on<TEvent extends keyof RealtimeTransportEventTypes>(
    event: TEvent,
    listener: (...args: RealtimeTransportEventTypes[TEvent]) => void,
  ): this {
    this.#addListener(event, listener, false);
    return this;
  }

  /** Removes the most recently registered matching listener. */
  off<TEvent extends keyof RealtimeTransportEventTypes>(
    event: TEvent,
    listener: (...args: RealtimeTransportEventTypes[TEvent]) => void,
  ): this {
    const registrations = this.#listeners.get(event);
    if (!registrations) {
      return this;
    }
    for (let index = registrations.length - 1; index >= 0; index -= 1) {
      if (registrations[index].listener === listener) {
        registrations.splice(index, 1);
        break;
      }
    }
    if (registrations.length === 0) {
      this.#listeners.delete(event);
    }
    return this;
  }

  /** Emits an event synchronously and propagates listener failures. */
  emit<TEvent extends keyof RealtimeTransportEventTypes>(
    event: TEvent,
    ...args: RealtimeTransportEventTypes[TEvent]
  ): boolean {
    const registrations = this.#listeners.get(event);
    if (!registrations || registrations.length === 0) {
      return false;
    }
    for (const registration of [...registrations]) {
      if (registration.once) {
        this.#removeListenerRegistration(event, registration);
      }
      registration.listener(...args);
    }
    return true;
  }

  /** Registers a synchronous one-time transport event listener. */
  once<TEvent extends keyof RealtimeTransportEventTypes>(
    event: TEvent,
    listener: (...args: RealtimeTransportEventTypes[TEvent]) => void,
  ): this {
    this.#addListener(event, listener, true);
    return this;
  }

  /** All outbound calls recorded in invocation order. */
  get calls(): readonly RecordedRealtimeTransportCall[] {
    return Object.freeze(this.#calls.map(snapshotRecordedRealtimeCall));
  }

  /** Registers an ordered expectation for the next outbound call. */
  expectCall<TMethod extends RealtimeTransportMethod>(
    method: TMethod,
    matcher?: RealtimeCallMatcher<TMethod>,
  ): Promise<RealtimeTransportCallFor<TMethod>> {
    const order = this.#nextExpectationOrder++;
    const existingCall = this.#unconsumedCalls.shift();
    if (existingCall) {
      try {
        this.#validateExpectation(
          method,
          matcher as PendingExpectation['matcher'],
          snapshotRecordedRealtimeCall(existingCall),
        );
        return Promise.resolve(
          snapshotRecordedRealtimeCall(
            existingCall,
          ) as RealtimeTransportCallFor<TMethod>,
        );
      } catch (error) {
        return Promise.reject(error);
      }
    }

    return new Promise<RealtimeTransportCallFor<TMethod>>((resolve, reject) => {
      this.#expectations.push({
        order,
        method,
        matcher: matcher as PendingExpectation['matcher'],
        resolve: (call) => resolve(call as RealtimeTransportCallFor<TMethod>),
        reject,
      });
    });
  }

  /** Runs an exercised scenario without relying on a wall-clock timeout. */
  async runScenario<TResult>(
    options: ScriptedRealtimeScenarioOptions<TResult>,
  ): Promise<TResult> {
    let terminalError: unknown;
    let active = true;
    let exerciseCompleted = false;
    let resolveExpectationFailure!: (outcome: {
      source: 'expectation';
      error: unknown;
    }) => void;
    const expectationFailureOutcome = new Promise<{
      source: 'expectation';
      error: unknown;
    }>((resolve) => {
      resolveExpectationFailure = resolve;
    });
    const abortError = () =>
      new ScriptedRealtimeScenarioCancelledError(
        this.#pendingExpectationDetails(),
      );
    if (options.signal?.aborted) {
      throw abortError();
    }

    let removeAbortListener = () => {};
    const abortOutcome = new Promise<{
      source: 'abort';
      error: ScriptedRealtimeScenarioCancelledError;
    }>((resolve) => {
      if (!options.signal) {
        return;
      }
      const listener = () => resolve({ source: 'abort', error: abortError() });
      options.signal.addEventListener('abort', listener, { once: true });
      removeAbortListener = () =>
        options.signal?.removeEventListener('abort', listener);
    });
    const settleOwnedExpectationFailure = (error: unknown) => {
      if (!active) {
        return;
      }
      terminalError = error;
      active = false;
      this.#rejectPendingExpectations(error);
      resolveExpectationFailure({ source: 'expectation', error });
    };

    const context: ScriptedRealtimeScenarioContext = {
      expectCall: (method, matcher) => {
        if (!active) {
          return Promise.reject(terminalError);
        }
        const expectation = this.expectCall(method, matcher);
        void expectation.catch(settleOwnedExpectationFailure);
        if (exerciseCompleted && this.#expectations.length > 0) {
          settleOwnedExpectationFailure(this.#createIncompleteError());
        }
        return expectation;
      },
      emit: this.emit.bind(this),
    };
    const assertCompleteOrTerminate = () => {
      if (!active) {
        throw terminalError;
      }
      try {
        this.assertComplete();
      } catch (error) {
        terminalError = error;
        active = false;
        this.#rejectPendingExpectations(error);
        throw error;
      }
    };

    const scenarioOutcome = Promise.resolve()
      .then(() => options.scenario(context))
      .then(
        () => ({ source: 'scenario' as const, status: 'fulfilled' as const }),
        (error: unknown) => ({
          source: 'scenario' as const,
          status: 'rejected' as const,
          error,
        }),
      );
    const exerciseOutcome = Promise.resolve()
      .then(() => options.exercise())
      .then(
        (value) => {
          exerciseCompleted = true;
          return {
            source: 'exercise' as const,
            status: 'fulfilled' as const,
            value,
          };
        },
        (error: unknown) => ({
          source: 'exercise' as const,
          status: 'rejected' as const,
          error,
        }),
      );

    try {
      const first = await Promise.race([
        scenarioOutcome,
        exerciseOutcome,
        abortOutcome,
        expectationFailureOutcome,
      ]);
      if (first.source === 'abort') {
        terminalError = first.error;
        active = false;
        this.#rejectPendingExpectations(first.error);
        throw first.error;
      }
      if (first.source === 'expectation') {
        throw first.error;
      }
      if (first.status === 'rejected') {
        terminalError = first.error;
        active = false;
        this.#rejectPendingExpectations(first.error);
        throw first.error;
      }

      if (first.source === 'exercise') {
        const immediateScenarioResult = await Promise.race([
          scenarioOutcome,
          Promise.resolve({ source: 'pending' as const }),
        ]);
        if (immediateScenarioResult.source === 'scenario') {
          if (immediateScenarioResult.status === 'rejected') {
            terminalError = immediateScenarioResult.error;
            active = false;
            this.#rejectPendingExpectations(immediateScenarioResult.error);
            throw immediateScenarioResult.error;
          }
          assertCompleteOrTerminate();
          return first.value;
        }
        if (this.#expectations.length > 0) {
          const error = this.#createIncompleteError();
          terminalError = error;
          active = false;
          this.#rejectPendingExpectations(error);
          throw error;
        }
        const scenarioResult = await Promise.race([
          scenarioOutcome,
          abortOutcome,
          expectationFailureOutcome,
        ]);
        if (scenarioResult.source === 'abort') {
          terminalError = scenarioResult.error;
          active = false;
          this.#rejectPendingExpectations(scenarioResult.error);
          throw scenarioResult.error;
        }
        if (scenarioResult.source === 'expectation') {
          throw scenarioResult.error;
        }
        if (scenarioResult.status === 'rejected') {
          terminalError = scenarioResult.error;
          active = false;
          this.#rejectPendingExpectations(scenarioResult.error);
          throw scenarioResult.error;
        }
        assertCompleteOrTerminate();
        return first.value;
      }

      const exerciseResult = await Promise.race([
        exerciseOutcome,
        abortOutcome,
        expectationFailureOutcome,
      ]);
      if (exerciseResult.source === 'abort') {
        terminalError = exerciseResult.error;
        active = false;
        this.#rejectPendingExpectations(exerciseResult.error);
        throw exerciseResult.error;
      }
      if (exerciseResult.source === 'expectation') {
        throw exerciseResult.error;
      }
      if (exerciseResult.status === 'rejected') {
        terminalError = exerciseResult.error;
        active = false;
        this.#rejectPendingExpectations(exerciseResult.error);
        throw exerciseResult.error;
      }
      assertCompleteOrTerminate();
      return exerciseResult.value;
    } finally {
      active = false;
      removeAbortListener();
    }
  }

  /** Makes the next call to a transport method throw the supplied error. */
  failNextCall(method: RealtimeTransportMethod, error: unknown): void {
    const failures = this.#failures.get(method) ?? [];
    failures.push(error);
    this.#failures.set(method, failures);
  }

  /** Emits a controlled terminal disconnect and optional transport error. */
  disconnect(error?: unknown): void {
    this.#lifecycleGeneration += 1;
    let notificationFailure: CapturedFailure = { present: false };
    if (this.status !== 'disconnected') {
      this.status = 'disconnected';
      try {
        this.emit('connection_change', 'disconnected');
      } catch (caughtError) {
        notificationFailure = { present: true, error: caughtError };
      }
    }
    if (typeof error !== 'undefined') {
      const transportError: TransportError = { type: 'error', error };
      try {
        this.emit('error', transportError);
      } catch (caughtError) {
        if (!notificationFailure.present) {
          notificationFailure = { present: true, error: caughtError };
        }
      }
    }
    if (notificationFailure.present) {
      throw notificationFailure.error;
    }
  }

  /** Throws when calls or expectations remain unmatched. */
  assertComplete(): void {
    if (
      this.#unconsumedCalls.length > 0 ||
      this.#expectations.length > 0 ||
      this.#failures.size > 0
    ) {
      throw this.#createIncompleteError();
    }
  }

  /** Throws unless the transport is disconnected. */
  assertClosed(): void {
    if (this.status !== 'disconnected') {
      throw new RealtimeTransportNotClosedError(this.status);
    }
  }

  async connect(options: RealtimeTransportLayerConnectOptions): Promise<void> {
    const generation = ++this.#lifecycleGeneration;
    try {
      this.status = 'connecting';
      this.#recordAndThrowNextFailure({
        method: 'connect',
        options: {
          model: options.model,
          url: options.url,
          callId: options.callId,
          initialSessionConfig: options.initialSessionConfig,
          apiKeyProvided: typeof options.apiKey !== 'undefined',
        },
      });
      this.#assertCurrentConnectionAttempt(generation, 'connecting');
      const connectingNotificationFailure =
        this.#emitConnectionChange('connecting');
      if (connectingNotificationFailure.present) {
        throw connectingNotificationFailure.error;
      }
      this.#assertCurrentConnectionAttempt(generation, 'connecting');
      this.status = 'connected';
      this.#provisionalConnectedGeneration = generation;
      const connectedNotificationFailure =
        this.#emitConnectionChange('connected');
      if (connectedNotificationFailure.present) {
        throw connectedNotificationFailure.error;
      }
      this.#assertCurrentConnectionAttempt(generation, 'connected');
      this.#provisionalConnectedGeneration = undefined;
    } catch (error) {
      if (this.#lifecycleGeneration === generation) {
        this.#lifecycleGeneration += 1;
        this.status = 'disconnected';
        try {
          this.emit('connection_change', 'disconnected');
        } catch {
          // Preserve the primary connection failure.
        }
      }
      throw error;
    } finally {
      if (this.#provisionalConnectedGeneration === generation) {
        this.#provisionalConnectedGeneration = undefined;
      }
    }
  }

  sendEvent(event: RealtimeClientMessage): void {
    this.#recordAndThrowNextFailure({ method: 'sendEvent', event });
  }

  requestResponse(response?: Record<string, any>): void {
    this.#recordAndThrowNextFailure({ method: 'requestResponse', response });
  }

  sendMessage(
    message: RealtimeUserInput,
    otherEventData: Record<string, any>,
    options?: { triggerResponse?: boolean },
  ): void {
    this.#recordAndThrowNextFailure({
      method: 'sendMessage',
      message,
      otherEventData,
      options,
    });
  }

  addImage(image: string, options?: { triggerResponse?: boolean }): void {
    this.#recordAndThrowNextFailure({ method: 'addImage', image, options });
  }

  sendAudio(audio: ArrayBuffer, options: { commit?: boolean }): void {
    this.#recordAndThrowNextFailure({ method: 'sendAudio', audio, options });
  }

  updateSessionConfig(config: Partial<RealtimeSessionConfig>): void {
    this.#recordAndThrowNextFailure({ method: 'updateSessionConfig', config });
  }

  close(): void {
    if (this.status === 'disconnected') {
      return;
    }

    const generation = ++this.#lifecycleGeneration;
    const previousStatus = this.status;
    const previousConnectionWasEstablished =
      previousStatus === 'connected' &&
      typeof this.#provisionalConnectedGeneration === 'undefined';
    this.status = 'disconnecting';
    try {
      this.#recordAndThrowNextFailure({ method: 'close' });
      if (
        this.#lifecycleGeneration !== generation ||
        this.status !== 'disconnecting'
      ) {
        return;
      }
      this.status = 'disconnected';
      this.emit('connection_change', 'disconnected');
    } catch (error) {
      if (
        this.#lifecycleGeneration === generation &&
        this.status === 'disconnecting'
      ) {
        this.status = previousConnectionWasEstablished
          ? 'connected'
          : 'disconnected';
        if (this.status === 'disconnected') {
          try {
            this.emit('connection_change', 'disconnected');
          } catch {
            // Preserve the primary close failure.
          }
        }
      }
      throw error;
    }
  }

  mute(muted: boolean): void {
    this.#recordAndThrowNextFailure({ method: 'mute', muted });
    this.muted = muted;
  }

  sendFunctionCallOutput(
    toolCall: TransportToolCallEvent,
    output: string,
    startResponse: boolean,
  ): void {
    this.#recordAndThrowNextFailure({
      method: 'sendFunctionCallOutput',
      toolCall,
      output,
      startResponse,
    });
  }

  interrupt(): void {
    this.#recordAndThrowNextFailure({ method: 'interrupt' });
  }

  resetHistory(oldHistory: RealtimeItem[], newHistory: RealtimeItem[]): void {
    this.#recordAndThrowNextFailure({
      method: 'resetHistory',
      oldHistory,
      newHistory,
    });
  }

  sendMcpResponse(
    approvalRequest: RealtimeMcpCallApprovalRequestItem,
    approved: boolean,
    reason?: string,
  ): void {
    this.#recordAndThrowNextFailure({
      method: 'sendMcpResponse',
      approvalRequest,
      approved,
      reason,
    });
  }

  #record(call: RealtimeTransportCall): void {
    const callSnapshot = snapshotTestingValue(call);
    const recordedCall = Object.freeze({
      ...callSnapshot,
      index: this.#calls.length,
    }) as KnownRecordedRealtimeTransportCall;
    this.#calls.push(recordedCall);

    const expectation = this.#expectations.shift();
    if (!expectation) {
      this.#unconsumedCalls.push(recordedCall);
      return;
    }

    try {
      this.#validateExpectation(
        expectation.method,
        expectation.matcher,
        snapshotRecordedRealtimeCall(recordedCall),
      );
      expectation.resolve(snapshotRecordedRealtimeCall(recordedCall));
    } catch (error) {
      expectation.reject(error);
      throw error;
    }
  }

  #addListener<TEvent extends keyof RealtimeTransportEventTypes>(
    event: TEvent,
    listener: (...args: RealtimeTransportEventTypes[TEvent]) => void,
    once: boolean,
  ): void {
    const registrations = this.#listeners.get(event) ?? [];
    registrations.push({
      listener: listener as RealtimeTransportListener,
      once,
    });
    this.#listeners.set(event, registrations);
  }

  #removeListenerRegistration(
    event: keyof RealtimeTransportEventTypes,
    registration: RealtimeTransportListenerRegistration,
  ): void {
    const registrations = this.#listeners.get(event);
    if (!registrations) {
      return;
    }
    const index = registrations.indexOf(registration);
    if (index !== -1) {
      registrations.splice(index, 1);
    }
    if (registrations.length === 0) {
      this.#listeners.delete(event);
    }
  }

  #validateExpectation(
    method: RealtimeTransportMethod,
    matcher: PendingExpectation['matcher'],
    call: KnownRecordedRealtimeTransportCall,
  ): void {
    if (call.method !== method) {
      throw new UnexpectedRealtimeCallError(method, call);
    }
    if (matcher && matcher(call) === false) {
      throw new RealtimeCallMatcherError(call);
    }
  }

  #recordAndThrowNextFailure(call: RealtimeTransportCall): void {
    const failure = this.#takeNextFailure(call.method);
    this.#record(call);
    if (failure.present) {
      throw failure.error;
    }
  }

  #takeNextFailure(method: RealtimeTransportMethod): CapturedFailure {
    const failures = this.#failures.get(method);
    if (!failures || failures.length === 0) {
      return { present: false };
    }
    const error = failures.shift();
    if (failures.length === 0) {
      this.#failures.delete(method);
    }
    return { present: true, error };
  }

  #emitConnectionChange(status: 'connected' | 'connecting'): CapturedFailure {
    try {
      this.emit('connection_change', status);
      return { present: false };
    } catch (error) {
      return { present: true, error };
    }
  }

  #assertCurrentConnectionAttempt(
    generation: number,
    expectedStatus: 'connecting' | 'connected',
  ): void {
    if (
      this.#lifecycleGeneration !== generation ||
      this.status !== expectedStatus
    ) {
      throw new ScriptedRealtimeConnectionSupersededError();
    }
  }

  #pendingExpectationDetails(): PendingRealtimeExpectation[] {
    return this.#expectations.map(({ order, method }) => ({ order, method }));
  }

  #pendingFailureDetails(): PendingRealtimeFailure[] {
    return Array.from(this.#failures, ([method, failures]) => ({
      method,
      count: failures.length,
    }));
  }

  #createIncompleteError(): IncompleteRealtimeScenarioError {
    return new IncompleteRealtimeScenarioError(
      this.#unconsumedCalls.map(({ index, method }) => ({ index, method })),
      this.#pendingExpectationDetails(),
      this.#pendingFailureDetails(),
    );
  }

  #rejectPendingExpectations(error: unknown): void {
    const expectations = this.#expectations.splice(0);
    for (const expectation of expectations) {
      expectation.reject(error);
    }
  }
}

function snapshotRecordedRealtimeCall(
  call: KnownRecordedRealtimeTransportCall,
): KnownRecordedRealtimeTransportCall {
  return Object.freeze(
    snapshotTestingValue(call),
  ) as KnownRecordedRealtimeTransportCall;
}

function displayIndex(index: number): number {
  return index + 1;
}
