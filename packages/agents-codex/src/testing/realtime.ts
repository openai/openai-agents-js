import { isDeepStrictEqual } from 'node:util';
import type {
  NativeRealtimeAdapter,
  NativeRealtimeAdapterContext,
  NativeRealtimeConnection,
} from '../runtime/realtime-adapter';

export type RealtimeFrame = Record<string, unknown>;
export interface RealtimeStep {
  /** Match a frame type, exact JSON object, or predicate. */
  expect: string | RealtimeFrame | ((frame: RealtimeFrame) => boolean);
  /** Derive an ACK from the outgoing settings when needed. */
  emit?:
    | readonly RealtimeFrame[]
    | ((frame: RealtimeFrame) => readonly RealtimeFrame[]);
  error?: Error;
}
export interface RealtimeConnectCall {
  readonly model?: string;
  /** Absolute endpoint without userinfo, query, or fragment. */
  readonly url?: string;
  /** Case-insensitive Authorization header-name presence, without its value. */
  readonly apiKeyProvided?: boolean;
  readonly headersProvided: boolean;
}
export interface RealtimeScenario {
  expectSend(expected: RealtimeStep['expect']): Promise<RealtimeFrame>;
  emit(...frames: readonly RealtimeFrame[]): void;
  failNextSend(error: Error): void;
  disconnect(error?: Error): void;
}

function matchesFrame(
  expected: RealtimeStep['expect'],
  actual: RealtimeFrame,
): boolean {
  return typeof expected === 'function'
    ? expected(actual)
    : typeof expected === 'string'
      ? expected === actual.type
      : isDeepStrictEqual(actual, expected);
}

function connectionEndpoint(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol))
      return undefined;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

/**
 * Deterministic canonical-frame I/O; the native owner interprets all protocol.
 * Use synthetic data: sentEvents intentionally records complete test frames.
 * Connection snapshots have been retaining only redacted endpoints, models,
 * and header-presence flags, without header values or signals.
 * The incoming iterator stays open until close. Assert completion after closing
 * the native session so final outgoing sends have settled.
 */
export class ScriptedRealtimeAdapter
  implements NativeRealtimeAdapter, NativeRealtimeConnection
{
  private readonly steps: RealtimeStep[];
  private index = 0;
  private readonly sent: RealtimeFrame[] = [];
  private readonly calls: RealtimeConnectCall[] = [];
  private readonly queued: string[] = [];
  private wake?: () => void;
  private closed = false;
  private failure?: { error: unknown };
  private closeError?: Error;
  private incomingError?: Error;
  private scenarioStarted = false;
  private scenarioSend?: () => void;

  constructor(
    steps: readonly RealtimeStep[] = [],
    private readonly options: {
      connectEvents?: readonly RealtimeFrame[];
      connectError?: Error;
      closeError?: Error;
      strict?: boolean;
    } = {},
  ) {
    this.steps = steps.map((step) => ({
      ...step,
      expect:
        typeof step.expect === 'object'
          ? structuredClone(step.expect)
          : step.expect,
      emit:
        typeof step.emit === 'function'
          ? step.emit
          : structuredClone(step.emit),
    }));
    this.options = {
      ...options,
      connectEvents: structuredClone(options.connectEvents),
    };
    this.closeError = options.closeError;
  }

  get sentEvents(): readonly RealtimeFrame[] {
    return structuredClone(this.sent);
  }
  get connectCalls(): readonly RealtimeConnectCall[] {
    return structuredClone(this.calls);
  }
  get remainingSteps(): number {
    return this.steps.length - this.index;
  }

  async runScenario<T>(options: {
    scenario: (scenario: RealtimeScenario) => unknown | Promise<unknown>;
    exercise: () => T | Promise<T>;
    signal?: AbortSignal;
  }): Promise<T> {
    if (this.steps.length)
      throw new Error('Realtime scenarios cannot include static steps');
    if (this.scenarioStarted)
      throw new Error('Scripted realtime adapter supports one scenario');
    if (this.failure) throw this.failure.error;
    options.signal?.throwIfAborted();
    this.scenarioStarted = true;

    let active = true;
    let exerciseComplete = false;
    let cursor = 0;
    let terminal: { error: unknown } | undefined;
    const failures: Error[] = [];
    const pending: {
      expected: RealtimeStep['expect'];
      resolve: (frame: RealtimeFrame) => void;
      reject: (error: unknown) => void;
    }[] = [];
    let rejectFailure!: (error: unknown) => void;
    const failed = new Promise<never>((_, reject) => {
      rejectFailure = reject;
    });
    const fail = (error: unknown) => {
      if (terminal) return;
      terminal = { error };
      this.failure ??= terminal;
      for (const waiter of pending.splice(0)) waiter.reject(error);
      rejectFailure(error);
    };
    const assertActive = () => {
      if (terminal) throw terminal.error;
      if (!active) throw new Error('Realtime scenario has ended');
    };
    const consume = () => {
      while (pending.length && cursor < this.sent.length) {
        const waiter = pending.shift()!;
        const frame = structuredClone(this.sent[cursor++]);
        try {
          if (!matchesFrame(waiter.expected, structuredClone(frame)))
            throw new Error(`Unexpected realtime send at step ${cursor - 1}`);
          waiter.resolve(frame);
        } catch (error) {
          waiter.reject(error);
          fail(error);
          return;
        }
      }
      if (exerciseComplete && pending.length)
        fail(
          new Error(
            'Realtime exercise completed with unsatisfied expectations',
          ),
        );
    };
    this.scenarioSend = () => {
      assertActive();
      consume();
      assertActive();
      const failure = failures.shift();
      if (failure) throw failure;
    };
    const context: RealtimeScenario = {
      expectSend: (expected) => {
        const snapshot =
          typeof expected === 'object' ? structuredClone(expected) : expected;
        const promise = new Promise<RealtimeFrame>((resolve, reject) => {
          try {
            assertActive();
            pending.push({ expected: snapshot, resolve, reject });
            consume();
          } catch (error) {
            reject(error);
            fail(error);
          }
        });
        // An ignored expectation still participates in scenario completeness.
        void promise.catch(() => {});
        return promise;
      },
      emit: (...frames) => {
        assertActive();
        this.emit(...frames);
      },
      failNextSend: (error) => {
        assertActive();
        failures.push(error);
      },
      disconnect: (error) => {
        assertActive();
        this.disconnect(error);
      },
    };
    const abort = () => fail(options.signal!.reason);
    options.signal?.addEventListener('abort', abort, { once: true });
    const runCallback = async <Result>(
      callback: () => Result | Promise<Result>,
    ) => {
      try {
        return await callback();
      } catch (error) {
        fail(error);
        throw error;
      }
    };
    const joined = Promise.all([
      Promise.resolve().then(() =>
        runCallback(() => options.scenario(context)),
      ),
      Promise.resolve()
        .then(() => runCallback(options.exercise))
        .then((result) => {
          exerciseComplete = true;
          consume();
          assertActive();
          return result;
        }),
    ]).then(([, result]) => {
      if (cursor !== this.sent.length || pending.length || failures.length)
        throw new Error('Realtime scenario has unconsumed sends or failures');
      return result;
    });
    try {
      return await Promise.race([joined, failed]);
    } catch (error) {
      fail(error);
      throw error;
    } finally {
      active = false;
      this.scenarioSend = undefined;
      options.signal?.removeEventListener('abort', abort);
    }
  }

  async connect(
    context: NativeRealtimeAdapterContext,
  ): Promise<NativeRealtimeConnection> {
    context.signal.throwIfAborted();
    if (this.calls.length || this.closed)
      throw new Error('Scripted realtime adapter supports one connection');
    const endpoint = connectionEndpoint(context.url);
    this.calls.push({
      model: context.model,
      ...(endpoint === undefined ? {} : { url: endpoint }),
      apiKeyProvided: Object.keys(context.headers).some(
        (name) => name.toLowerCase() === 'authorization',
      ),
      headersProvided: Object.keys(context.headers).length > 0,
    });
    if (this.options.connectError) throw this.options.connectError;
    this.emit(...(this.options.connectEvents ?? []));
    return this;
  }

  get incoming(): AsyncIterable<string> {
    return this.read();
  }

  private async *read(): AsyncGenerator<string> {
    for (;;) {
      if (this.queued.length) yield this.queued.shift()!;
      else if (this.closed) {
        if (this.incomingError) throw this.incomingError;
        return;
      } else
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
    }
  }

  emit(...frames: readonly RealtimeFrame[]): void {
    if (this.closed) throw new Error('Scripted realtime adapter is closed');
    const encoded = frames.map((frame) => JSON.stringify(frame));
    this.queued.push(...encoded);
    this.wake?.();
    this.wake = undefined;
  }

  async send(frame: string): Promise<void> {
    if (this.closed || !this.calls.length)
      throw new Error('Scripted realtime adapter is not connected');
    const actual: RealtimeFrame = JSON.parse(frame);
    this.sent.push(structuredClone(actual));
    if (this.scenarioSend) {
      this.scenarioSend();
      return;
    }
    if (this.scenarioStarted) {
      this.failure ??= { error: new Error('Realtime scenario has ended') };
      throw this.failure.error;
    }
    const step = this.steps[this.index];
    const matches = step && matchesFrame(step.expect, actual);
    if (!matches) {
      if (this.options.strict === false) return;
      this.failure = {
        error: new Error(`Unexpected realtime send at step ${this.index}`),
      };
      throw this.failure.error;
    }
    this.index++;
    this.emit(
      ...(typeof step.emit === 'function'
        ? step.emit(structuredClone(actual))
        : (step.emit ?? [])),
    );
    if (step.error) throw step.error;
  }

  async close(): Promise<void> {
    if (this.closeError) {
      const error = this.closeError;
      this.closeError = undefined;
      throw error;
    }
    this.disconnect();
  }

  disconnect(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.incomingError = error;
    this.wake?.();
    this.wake = undefined;
  }

  assertComplete(): void {
    if (this.failure) throw this.failure.error;
    if (this.scenarioSend)
      throw new Error('Realtime scenario is still running');
    if (this.remainingSteps)
      throw new Error(`${this.remainingSteps} unconsumed realtime steps`);
  }

  assertClosed(): void {
    if (!this.closed)
      throw new Error('Scripted realtime adapter is not closed');
  }
}
