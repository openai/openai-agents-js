import { summarizeResponseFactRecord } from './response-facts';
import { ToolOutput } from './tools';
import type { ExecutionItem, ModelOutputItem, SearchItem } from './history';
import type { JsonObject } from './binding';
import type { HostedToolItem } from './hosted-tools';
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

export type ExecutionItemSummary = Readonly<
  Pick<
    ExecutionItem,
    'type' | 'id' | 'threadId' | 'turnId' | 'callId' | 'status'
  >
>;

export type HostedToolItemSummary = Readonly<
  Pick<HostedToolItem, 'type' | 'id' | 'turn_id' | 'turnId' | 'status'>
>;

export type ObservationOptions = {
  after?: number;
  /** Include tool payloads, response-fact content and opted-in raw provider events. */
  includeExecutionDetails?: boolean;
};

type ExecutionObservation = SubmissionEvent &
  Readonly<{ type: 'execution_item_completed' }>;
type HostedToolItemObservation = SubmissionEvent &
  Readonly<{ type: 'hosted_tool_item_completed' }>;

export type ApiRateLimitsUpdated = SubmissionEvent &
  Readonly<{ type: 'api_rate_limits_updated'; snapshot: ApiRateLimits }>;

/** SDK-resolved root sampling fields immediately before client invocation.
 * Encoding and socket writes may not occur. Null means omitted, not a server default.
 * Internal transport retries share requestId; later client invocations get new IDs.
 * Separate correction roots retain their own thread/submission IDs and existing
 * parentSubmissionId. Native children, warmup, compaction and background/reviewer
 * requests are outside coverage. Restored manual roots emit fresh events for
 * resumed work; previously observed request/link events are not replayed.
 */
export type ModelRequestDispatching = SubmissionEvent &
  Readonly<{
    type: 'model_request_dispatching';
    requestId: string;
    threadId: string;
    model: string;
    reasoningEffort: string | number | bigint | null;
    reasoningSummary: string | null;
    serviceTier: string | null;
    wire: 'responses' | 'responses_lite';
    transport: 'http_sse' | 'http_json' | 'websocket';
  }>;

/** Best-effort link to a retained terminal occurrence. Retirement can drop a
 * link after history retention; absence does not establish absence of a terminal.
 */
export type ModelResponseLinked = SubmissionEvent &
  Readonly<{
    type: 'model_response_linked';
    requestId: string;
    threadId: string;
    responseObservationId: string;
  }>;

/** Provider event type by default; includeExecutionDetails exposes the full event.
 * Passive retention can report a gap for large payloads.
 */
export type HostedToolProgress = SubmissionEvent &
  Readonly<{
    type: 'hosted_tool_call_progress';
    threadId: string;
    itemId: string | null;
    event: JsonObject;
  }>;

/** A committed captured-Agent identity change. Initial/restored bindings and
 * same-profile refreshes are silent. Idle changes have null operation identity.
 * Both names come from captured declarations. The previous profile identifies
 * the committed source, including unnamed Agents. Older events can omit it.
 */
export type AgentProfileChanged = Event &
  Readonly<{
    type: 'agent_profile_changed';
    profileId: string;
    profileEpoch: string;
    agentName: string | null;
    previousProfileId?: string;
    previousAgentName?: string | null;
    submissionId: string | null;
    turnId: string | null;
    parentSubmissionId?: string;
  }>;

export type ModelOutputItemCompleted = SubmissionEvent &
  Readonly<{ type: 'model_output_item_completed'; item: ModelOutputItem }>;

export type Observation =
  | ModelOutputItemCompleted
  | AgentProfileChanged
  | HostedToolProgress
  | (HostedToolItemObservation &
      Readonly<{ item: HostedToolItemSummary | HostedToolItem }>)
  | ModelRequestDispatching
  | ModelResponseLinked
  | ResponseFactReceived
  | RawProviderEvent
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
      Readonly<{ type: 'search_item_completed'; item: SearchItem }>)
  | (SubmissionEvent &
      Readonly<{ type: 'usage_updated'; usage: TokenUsageInfo | null }>)
  | ApiRateLimitsUpdated
  | (SubmissionEvent & Readonly<{ type: 'context_compacted'; itemId: string }>)
  | (ExecutionObservation &
      Readonly<{ item: ExecutionItemSummary | ExecutionItem }>)
  | (SubmissionEvent & ToolIdentity & Readonly<{ type: 'tool_started' }>)
  | (SubmissionEvent &
      Readonly<{
        type: 'function_approval_requested';
        /** Display identifiers. Reply authority remains with the live request. */
        approvalId: string;
        callId: string;
        name: string;
      }>)
  | (SubmissionEvent &
      ToolIdentity &
      Readonly<{
        type: 'tool_finished';
        status: 'completed' | 'failed' | 'cancelled';
        /** Acknowledged post-hook function response, only with includeExecutionDetails.
         * Null for cancellation and other completions; retained history owns model input.
         */
        output?: ToolOutput | null;
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
export type ResponseFactReceived = SubmissionEvent &
  Readonly<{
    type: 'response_fact';
    record:
      | import('./response-facts').RecordedResponseFact
      | import('./response-facts').RecordedResponseFactSummary;
  }>;

/** Responses provider JSON captured before native event decoding. */
export type RawProviderEvent = SubmissionEvent &
  Readonly<{
    type: 'raw_provider_event';
    source: 'responses';
    transport: 'sse' | 'websocket' | 'json';
    payload: JsonObject;
  }>;

type RetainedObservation =
  | Exclude<Observation, ExecutionObservation | HostedToolItemObservation>
  | (ExecutionObservation & Readonly<{ item: ExecutionItem }>)
  | (HostedToolItemObservation & Readonly<{ item: HostedToolItem }>);
export type ObservationInput = WithoutIdentity<
  Exclude<RetainedObservation, { type: 'gap' }>
>;
export type ObservedEvent = Observation | ManualToolRequest;

/** Publication belongs to the producer, independently of result consumption. */
export type ObservationPhase = 'open' | 'finishing' | 'ended';
export type TurnObservationScope = {
  /** Negative until a queued root dispatches; readers consult the live value. */
  after?: number;
  includes: (event: Observation) => boolean;
  phase: () => ObservationPhase;
};

function withoutSearchResults(item: SearchItem): SearchItem {
  const summary = { ...item };
  if (summary.type === 'web_search_call') delete summary.results;
  return summary;
}

function projectObservation(
  event: RetainedObservation,
  includeExecutionDetails: boolean,
): Observation {
  if (event.type === 'tool_finished')
    return Object.freeze({
      ...event,
      output:
        includeExecutionDetails && event.output
          ? new ToolOutput(
              structuredClone(event.output.contentItems),
              event.output.success,
            )
          : null,
    });
  if (event.type === 'raw_provider_event')
    return Object.freeze({ ...event, payload: structuredClone(event.payload) });
  if (event.type === 'response_fact')
    return Object.freeze({
      ...event,
      record: includeExecutionDetails
        ? structuredClone(event.record)
        : summarizeResponseFactRecord(event.record),
    });
  if (event.type === 'model_output_item_completed')
    return Object.freeze({ ...event, item: structuredClone(event.item) });
  if (event.type === 'search_item_completed') {
    const item = includeExecutionDetails
      ? event.item
      : withoutSearchResults(event.item);
    return Object.freeze({ ...event, item: structuredClone(item) });
  }
  if (event.type === 'hosted_tool_item_completed') {
    if (includeExecutionDetails)
      return Object.freeze({ ...event, item: structuredClone(event.item) });
    const { type, id, turn_id, turnId, status } = event.item;
    return Object.freeze({
      ...event,
      item: Object.freeze({ type, id, turn_id, turnId, status }),
    });
  }
  if (event.type === 'hosted_tool_call_progress')
    return Object.freeze({
      ...event,
      event: includeExecutionDetails
        ? structuredClone(event.event)
        : Object.freeze({ type: event.event.type }),
    });
  if (event.type !== 'execution_item_completed') return event;
  if (includeExecutionDetails)
    return Object.freeze({ ...event, item: structuredClone(event.item) });
  const { type, id, threadId, turnId, callId, status } = event.item;
  return Object.freeze({
    ...event,
    item: Object.freeze({ type, id, threadId, turnId, callId, status }),
  });
}

/** One passive event log, bounded by default, shared by independent readers. */
export class ObservationBuffer {
  private records: Array<{
    event: RetainedObservation;
    size: number;
    payloadSize: number;
    detailsMissing?: boolean;
  }> = [];
  private characters = 0;
  private payloadCharacters = 0;
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
      retention?: 'bounded' | 'all';
      validate?: () => void;
      pendingManual?: () => Iterable<ManualToolRequest>;
    } = {},
  ) {}

  /** @internal Sequence captured by existing turn owners at admission. */
  get currentSequence(): number {
    return this.sequence;
  }

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

  append(value: ObservationInput): RetainedObservation | null {
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

  /** A native completion survived in history but its live owner has retired. */
  gap(): void {
    if (this.closed) return;
    this.sequence++;
    this.repairParent?.buffer.gap();
    if (this.options.retention === 'all') {
      this.records.push({
        event: Object.freeze({
          type: 'gap',
          sessionId: this.sessionId,
          sequence: this.sequence,
          firstSequence: this.sequence,
        }),
        size: 0,
        payloadSize: 0,
      });
      this.notify();
      return;
    }
    this.records = [];
    this.characters = 0;
    this.payloadCharacters = 0;
    this.notify();
  }

  private record(
    value: ObservationInput,
    sessionId: string,
  ): RetainedObservation | null {
    if (this.closed) return null;
    const event = Object.freeze({
      ...value,
      sessionId,
      sequence: ++this.sequence,
    });
    // Image bytes and raw search results share a separate detail budget.
    // Search metadata remains useful when the raw results cannot be retained.
    const partial =
      event.type === 'hosted_tool_call_progress' &&
      event.event.type === 'response.image_generation_call.partial_image' &&
      typeof event.event.partial_image_b64 === 'string'
        ? event.event.partial_image_b64
        : undefined;
    const searchResults =
      event.type === 'search_item_completed' &&
      event.item.type === 'web_search_call'
        ? event.item.results
        : undefined;
    const searchSummary =
      searchResults !== undefined && event.type === 'search_item_completed'
        ? Object.freeze({
            ...event,
            item: withoutSearchResults(event.item),
          })
        : undefined;
    let payloadSize =
      event.type === 'raw_provider_event'
        ? JSON.stringify(event.payload).length
        : (partial?.length ??
          (searchResults === undefined
            ? 0
            : JSON.stringify(searchResults).length));
    const size = Object.values(event).reduce<number>(
      (total, field) => total + (typeof field === 'string' ? field.length : 0),
      event.type === 'tool_finished' && event.output
        ? JSON.stringify(event.output).length
        : event.type === 'response_fact'
          ? JSON.stringify(event.record).length
          : event.type === 'execution_item_completed' ||
              event.type === 'search_item_completed' ||
              event.type === 'model_output_item_completed' ||
              event.type === 'hosted_tool_item_completed'
            ? JSON.stringify(searchSummary?.item ?? event.item).length
            : event.type === 'hosted_tool_call_progress'
              ? JSON.stringify(
                  partial === undefined
                    ? event.event
                    : { ...event.event, partial_image_b64: '' },
                ).length
              : 0,
    );
    let retainedEvent: RetainedObservation = event;
    let detailsMissing = false;
    if (
      this.options.retention !== 'all' &&
      searchSummary &&
      payloadSize > 16 * 1024 * 1024
    ) {
      retainedEvent = searchSummary;
      payloadSize = 0;
      detailsMissing = true;
    }
    if (
      this.options.retention !== 'all' &&
      (size > 65_536 || payloadSize > 16 * 1024 * 1024)
    ) {
      this.records = [];
      this.characters = 0;
      this.payloadCharacters = 0;
    } else {
      this.records.push({
        event: retainedEvent,
        size,
        payloadSize,
        detailsMissing,
      });
      this.characters += size;
      this.payloadCharacters += payloadSize;
      while (
        this.options.retention !== 'all' &&
        (this.records.length > 256 ||
          this.characters > 65_536 ||
          this.payloadCharacters > 32 * 1024 * 1024)
      ) {
        if (this.records.length <= 256 && this.characters <= 65_536) {
          const detailedSearch = this.records.find(
            (record) =>
              record.payloadSize > 0 &&
              record.event.type === 'search_item_completed' &&
              record.event.item.type === 'web_search_call',
          );
          if (detailedSearch?.event.type === 'search_item_completed') {
            detailedSearch.event = Object.freeze({
              ...detailedSearch.event,
              item: withoutSearchResults(detailedSearch.event.item),
            });
            this.payloadCharacters -= detailedSearch.payloadSize;
            detailedSearch.payloadSize = 0;
            detailedSearch.detailsMissing = true;
            continue;
          }
        }
        const removed = this.records.shift()!;
        this.characters -= removed.size;
        this.payloadCharacters -= removed.payloadSize;
      }
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

  events(options?: ObservationOptions): AsyncIterableIterator<ObservedEvent>;
  events(
    options: ObservationOptions | undefined,
    scope: TurnObservationScope,
  ): AsyncIterableIterator<Observation>;
  events(
    options: ObservationOptions = {},
    scope?: TurnObservationScope,
  ): AsyncIterableIterator<ObservedEvent> {
    this.options.validate?.();
    let { after = 0 } = options;
    const includeExecutionDetails =
      Object.hasOwn(options, 'includeExecutionDetails') &&
      options.includeExecutionDetails === true;
    if (!Number.isInteger(after) || after < 0 || after > this.sequence)
      throw new RangeError(
        'after must be a sequence between zero and the current event',
      );
    let index = this.options.retention === 'all' ? after : 0;
    let closed = false;
    let reading = false;
    const seen = scope ? undefined : new WeakSet<ManualToolRequest>();
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
            if (this.options.retention === 'all' && scope) {
              const floor = scope.after ?? 0;
              if (floor < 0) {
                if (scope.phase() === 'ended' || this.closed) break;
                await changed;
                continue;
              }
              after = Math.max(after, floor);
              index = Math.max(index, after);
            }
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
            if (this.options.retention !== 'all') index = 0;
            while (index < this.records.length) {
              const { event, detailsMissing } = this.records[index++];
              if (event.sequence <= after) continue;
              after = event.sequence;
              if (
                event.type === 'raw_provider_event' &&
                !includeExecutionDetails
              )
                continue;
              if (event.type === 'gap' || !scope || scope.includes(event))
                return {
                  done: false,
                  value:
                    includeExecutionDetails && detailsMissing
                      ? Object.freeze({
                          type: 'gap',
                          sessionId: event.sessionId,
                          sequence: event.sequence,
                          firstSequence: event.sequence,
                        })
                      : projectObservation(event, includeExecutionDetails),
                };
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
