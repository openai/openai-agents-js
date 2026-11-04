import type { ManualToolRequest } from './manual';
import type { TokenUsageInfo } from './run-events';
import type { ApiRateLimits } from './api-rate-limits';

type Event = Readonly<{ sessionId: string; sequence: number }>;
type SubmissionEvent = Event &
  Readonly<{
    submissionId: string;
    turnId: string;
    parentSubmissionId?: string;
  }>;
type ToolIdentity = Readonly<{
  callId: string;
  name: string;
  namespace: string | null;
  family: 'function' | 'mcp';
}>;

export type ApiRateLimitsUpdated = SubmissionEvent &
  Readonly<{ type: 'api_rate_limits_updated'; snapshot: ApiRateLimits }>;

export type Observation =
  | (Event & Readonly<{ type: 'warning'; message: string }>)
  | (SubmissionEvent & Readonly<{ type: 'turn_started' }>)
  | (SubmissionEvent &
      Readonly<{
        type: 'turn_finished';
        status: 'completed' | 'failed' | 'cancelled';
        errorType?: string | null;
      }>)
  | (SubmissionEvent &
      Readonly<{ type: 'output_text_delta'; itemId: string; delta: string }>)
  | (SubmissionEvent &
      Readonly<{ type: 'usage_updated'; usage: TokenUsageInfo | null }>)
  | ApiRateLimitsUpdated
  | (SubmissionEvent & Readonly<{ type: 'context_compacted'; itemId: string }>)
  | (SubmissionEvent & ToolIdentity & Readonly<{ type: 'tool_started' }>)
  | (SubmissionEvent &
      ToolIdentity &
      Readonly<{
        type: 'tool_finished';
        status: 'completed' | 'failed' | 'cancelled';
      }>)
  | (Event &
      Readonly<{
        type: 'subagent_lifecycle';
        subagentId: string;
        parentAgentId: string;
        status: string;
        kind: 'created' | 'active' | 'closed' | 'snapshot';
      }>)
  | (Event & Readonly<{ type: 'session_ended'; reason: 'closed' | 'failed' }>)
  | (Event & Readonly<{ type: 'gap'; firstSequence: number }>);

type WithoutIdentity<T> = T extends Event ? Omit<T, keyof Event> : never;
export type ObservationInput = WithoutIdentity<
  Exclude<Observation, { type: 'gap' }>
>;
export type ObservedEvent = Observation | ManualToolRequest;

/** Publication belongs to the producer, independently of result consumption. */
export type ObservationPhase = 'open' | 'finishing' | 'ended';
export type TurnObservationScope = {
  includes: (event: Observation) => boolean;
  phase: () => ObservationPhase;
};

/** One passive bounded suffix, shared by independent readers. */
export class ObservationBuffer {
  private records: Array<{ event: Observation; size: number }> = [];
  private characters = 0;
  private sequence = 0;
  private closed = false;
  private changed = Promise.withResolvers<void>();
  private repairParent?: {
    buffer: ObservationBuffer;
    submissionId: string;
  };

  constructor(
    readonly sessionId: string,
    private readonly options: {
      validate?: () => void;
      pendingManual?: () => Iterable<ManualToolRequest>;
    } = {},
  ) {}

  /** Wake readers when requests or their producers change. */
  notify(): void {
    this.changed.resolve();
    this.changed = Promise.withResolvers<void>();
  }

  /** @internal Capture before inspecting live owners; this never consumes events. */
  waitForChange(): Promise<void> {
    return this.changed.promise;
  }

  /** @internal Link future repair submission events without replaying history. */
  linkRepairParent(
    parent: ObservationBuffer,
    parentSubmissionId: string,
  ): void {
    this.repairParent = { buffer: parent, submissionId: parentSubmissionId };
  }

  append(value: ObservationInput): Observation | null {
    const event = this.record(value, this.sessionId);
    if (event && this.repairParent && 'submissionId' in event) {
      const linked = {
        ...event,
        parentSubmissionId: this.repairParent.submissionId,
        ...(event.type === 'usage_updated' && event.usage !== null
          ? {
              usage: Object.freeze({
                ...event.usage,
                totalTokenUsage: Object.freeze({
                  ...event.usage.totalTokenUsage,
                }),
                lastTokenUsage: Object.freeze({
                  ...event.usage.lastTokenUsage,
                }),
              }),
            }
          : {}),
      };
      this.repairParent.buffer.record(linked, event.sessionId);
    }
    return event;
  }

  private record(
    value: ObservationInput,
    sessionId: string,
  ): Observation | null {
    if (this.closed) return null;
    const event = Object.freeze({
      ...value,
      sessionId,
      sequence: ++this.sequence,
    });
    const size = Object.values(event).reduce<number>(
      (total, field) => total + (typeof field === 'string' ? field.length : 0),
      0,
    );
    if (size > 65_536) {
      this.records = [];
      this.characters = 0;
    } else {
      this.records.push({ event, size });
      this.characters += size;
      while (this.records.length > 256 || this.characters > 65_536)
        this.characters -= this.records.shift()!.size;
    }
    this.notify();
    return event;
  }

  finish(reason: 'closed' | 'failed'): void {
    if (this.closed) return;
    this.append({ type: 'session_ended', reason });
    this.closed = true;
    this.notify();
  }

  events(options?: { after?: number }): AsyncIterableIterator<ObservedEvent>;
  events(
    options: { after?: number } | undefined,
    scope: TurnObservationScope,
  ): AsyncIterableIterator<Observation>;
  events(
    { after = 0 }: { after?: number } = {},
    scope?: TurnObservationScope,
  ): AsyncIterableIterator<ObservedEvent> {
    this.options.validate?.();
    if (!Number.isInteger(after) || after < 0 || after > this.sequence)
      throw new RangeError(
        'after must be a sequence between zero and the current event',
      );
    let closed = false;
    let reading = false;
    const seen = scope ? undefined : new Set<ManualToolRequest>();
    const close = () => {
      closed = true;
      this.notify();
    };
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: async () => {
        this.options.validate?.();
        if (reading) throw new Error('Event stream already has a pending read');
        reading = true;
        try {
          while (!closed) {
            const changed = this.changed.promise;
            if (seen) {
              for (const request of this.options.pendingManual?.() ?? []) {
                if (!seen.has(request)) {
                  seen.add(request);
                  return { done: false, value: request };
                }
              }
            }
            const oldest = this.records[0]?.event.sequence ?? this.sequence + 1;
            if (after < oldest - 1) {
              const firstSequence = after + 1;
              after = oldest - 1;
              return {
                done: false,
                value: Object.freeze({
                  type: 'gap',
                  sessionId: this.sessionId,
                  sequence: after,
                  firstSequence,
                }),
              };
            }
            for (const { event } of this.records) {
              if (event.sequence <= after) continue;
              after = event.sequence;
              if (!scope || scope.includes(event))
                return { done: false, value: event };
            }
            const phase = scope?.phase();
            if (phase === 'ended' || (this.closed && phase !== 'finishing'))
              break;
            await changed;
          }
          close();
          return { done: true, value: undefined };
        } finally {
          reading = false;
        }
      },
      return: async () => {
        close();
        return { done: true, value: undefined };
      },
    };
  }
}
