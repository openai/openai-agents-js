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
  readonly headersProvided: boolean;
}

/**
 * Deterministic canonical-frame I/O; the native owner interprets all protocol.
 * Use synthetic data: sentEvents intentionally records complete test frames.
 * Connection snapshots never retain URLs, headers, signals, or credentials.
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
  private failure?: Error;
  private closeError?: Error;

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

  async connect(
    context: NativeRealtimeAdapterContext,
  ): Promise<NativeRealtimeConnection> {
    context.signal.throwIfAborted();
    if (this.calls.length || this.closed)
      throw new Error('Scripted realtime adapter supports one connection');
    this.calls.push({
      model: context.model,
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
      else if (this.closed) return;
      else
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
    const step = this.steps[this.index];
    const matches =
      step &&
      (typeof step.expect === 'function'
        ? step.expect(actual)
        : typeof step.expect === 'string'
          ? step.expect === actual.type
          : isDeepStrictEqual(actual, step.expect));
    if (!matches) {
      if (this.options.strict === false) return;
      this.failure = new Error(
        `Unexpected realtime send at step ${this.index}`,
      );
      throw this.failure;
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
    this.closed = true;
    this.wake?.();
    this.wake = undefined;
  }

  assertComplete(): void {
    if (this.failure) throw this.failure;
    if (this.remainingSteps)
      throw new Error(`${this.remainingSteps} unconsumed realtime steps`);
  }
}
