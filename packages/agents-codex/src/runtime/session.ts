import {
  capturePreparedRequest,
  preparedRequestFromNative,
  type PreparedRequestData,
} from './prepared-request';
import {
  captureTracing,
  getCurrentSpan,
  withoutTracing,
  TraceCapture,
  type TraceSpan,
  withNativeCallbackContext,
} from './tracing-context';
import type { TraceOptions } from './telemetry';
import {
  captureTraceContext,
  nativeTraceContext,
  type TraceContext,
  type TraceContextHeaders,
} from './trace-context';
import { decodeRequestMetadata } from './request-metadata';
import { networkPolicyDigest } from './network-policy';
import { apiRateLimits, type ApiRateLimits } from './api-rate-limits';
import {
  parseEmbeddedCommand,
  nativeReviewOutput,
  type EmbeddedCommandResult,
  type NativeReviewOutput,
} from './commands';
import {
  assertAdmittedToolReference,
  checkpointDefaultTools,
  type CheckpointSelections,
} from './selection-state';
import { readCheckpointSelections } from './state';
import { nativeGoal, type NativeGoal } from './goals';
import { RunBudgetTracker, type RunBudget } from './run-budget';
import {
  NativeError,
  enrichNativeError,
  nativeError,
  markNativeErrorNotStarted,
} from './native-error';
import {
  createCapabilities,
  featureSupport,
  checkpointStatus,
  type Capabilities,
  type CheckpointStatus,
  type FeatureName,
} from './capabilities';
export { NativeError } from './native-error';
import {
  ChildCallbacks,
  type ChildCallbackOwner,
  type ChildObservationProducer,
} from './child-callbacks';
import {
  issueNativeQuestion,
  approvalQuestionReply,
  formQuestionReply,
  negativeQuestionReply,
  urlQuestionReply,
  urlQuestionPresentation,
  isNativeQuestionReply,
  nativeReplyRequest,
  parseNativeQuestion,
  type NativeQuestionGrant,
  type NativeQuestion,
  type NativeQuestionReply,
  type Interaction,
  type NativeQuestionPresentation,
} from './native-questions';
import { createUrlCompletion } from './url-elicitation';
import { prepareNativeForm, type PreparedNativeForm } from './native-forms';
import { z } from 'zod';
import type { WebSearch } from './web-search';
import { hostedToolSpecs, type HostedTool } from './hosted-tools';
import {
  OutputValidationError,
  prepareOutput,
  type OutputSpec,
  type PreparedOutput,
} from './output';

import { AsyncLocalStorage } from 'node:async_hooks';
import type { EnvironmentAcquisition } from './environment-source';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeInput, type UserInput, type FunctionCallOutput } from './input';
import {
  ObservationBuffer,
  type Observation,
  type ObservationOptions,
  type ObservationPhase,
  type TurnObservationScope,
} from './observation';
import { managedCallInfo } from './call-metadata';
import {
  nativeAgentsPolicyRules,
  applyNativeAgentsApproval,
  type NativeAgents,
} from './native-agents';
import type { ModelSettings, ProviderLease } from './provider';
import {
  prepareUserVerification,
  type PreparedUserVerification,
} from './verification';
import {
  hasExecutorPolicy,
  executorPolicyRules,
  applyExecutorPolicy,
} from './executor-policy';
import {
  HttpMCP,
  selectHttpLeaves,
  mcpConfig,
  mcpPolicies,
  mcpPrePolicyRules,
  hasMcpPrePolicy,
  applyMcpPrePolicy,
  mcpToolNames,
  checkMcpPublication,
  transformMcpResult,
  splitToolDeclarations,
  isHostedRegistration,
  type McpTool,
} from './mcp';
import {
  createManualRequest,
  isManualReply,
  manualResultSchema,
  supportsManualCheckpoint,
  type ManualTool,
  type ManualToolReply,
  type ManualToolRequest,
} from './manual';
import {
  decode,
  encode,
  encodeReceipt,
  jsonObject,
  jsonValue,
  losslessJsonObjectSchema,
  losslessJsonValueSchema,
  parseNative,
  type Engine,
  type JsonObject,
  type JsonValue,
  type NativeThread,
} from './binding';
import {
  parseEvent,
  parseEvents,
  requestTypes,
  type NativeEvent,
} from './events';
import {
  tokenUsageInfo,
  addRunUsage,
  runUsageToWire,
  type RunUsage,
  type TokenCount,
  type TokenUsageInfo,
} from './run-events';
import {
  projectHistory,
  projectExecutionItem,
  projectSearchItem,
  projectNativeHostedToolItem,
  threadHistorySchema,
  recordedTurnToWire,
  recordedTurnFromWire,
  repairItemFromWire,
  type RepairTurnWire,
  type RepairItemWire,
  type RecordedTurn,
} from './history';
import type { ThreadOptions } from './options';
import {
  parseSessionState,
  parseNativeCheckpoint,
  fromNativeCheckpoint,
  type NativeCheckpoint,
  isManualSessionState,
  isOutputAwareState,
  type ManualSessionState,
  readChecklist,
  type ChecklistState,
  type SessionState,
} from './state';
import { issueChildTurn, issueSubagent, subagentsSchema } from './subagents';
import { nativeMcpResultInfoSchema } from './native-mcp';
import { captureWritableRoots, Environment } from './environment';
import {
  captureTools,
  toolIdentity,
  toolNamespace,
  toolDeclarationIdentity,
  type ToolSelector,
  invokeFunctionTool,
  outputOf,
  type ToolResponse,
  type SessionTool,
  type Tool,
  type ToolCatalog,
} from './tools';
import type { NativeProviderRoutes, SelectedModelTerminal } from './http-model';

type ToolStatus = 'completed' | 'failed' | 'cancelled';
type ToolIdentity = {
  callId: string;
  toolName: string;
  namespace: string | null;
  family: 'function' | 'mcp';
};

const submissionSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('started'), turn_id: z.string() }),
  z.object({
    status: z.literal('steered'),
    turn_id: z.string(),
    input_id: z.string().min(1).optional(),
  }),
  z.object({ status: z.literal('not_submitted'), reason: jsonValue }),
]);
export type AcceptedSubmission = Exclude<
  z.infer<typeof submissionSchema>,
  { status: 'not_submitted' }
>;

export interface SessionOptions {
  /** @internal Captured opening scope; never stored in SessionState. */
  tracingCapture?: TraceCapture;
  parentTrace?: TraceContext;
  openCorrection?: (
    model: string,
    modelSettings: ModelSettings,
    retainOpening: (owner: {
      readonly failedOpeningCleanup: (() => Promise<void>) | undefined;
    }) => void,
    parentTrace?: TraceContext,
  ) => Promise<Session<string>>;
  selectedModel?: {
    readonly callerSignal?: AbortSignal;
    accepted(receipt: Promise<AcceptedSubmission>): void;
    toolResult?(callId: string, name: string, response: ToolResponse): void;
    terminal?(event: SelectedModelTerminal): void;
  };
  applicationAgent?: import('./public-agent').Agent<any, any>;
  context?: unknown;
  initialModelSettings?: ModelSettings;
  webSearch?: WebSearch;
  hostedTools?: readonly HostedTool[];
  mcpTools?: readonly McpTool[];
  nativeAgents?: NativeAgents;
  nativeGoals?: boolean;
  output?: PreparedOutput;
  /** @internal Captured original opening authority for scoped deferred work. */
  deferredReopen?: (
    state: SessionState,
    output: PreparedOutput,
    outputOverride: boolean,
    parentTrace?: TraceContext,
  ) => Promise<Session<any, any>>;
  /** @internal Active restored output can differ from the opening default. */
  restoredOutput?: { output: PreparedOutput; outputOverride: boolean };
  onClose?: () => Promise<void>;
  /** @internal Live application source, never persisted or inherited from state. */
  environmentOwner?: EnvironmentAcquisition;
  environment?: Environment;
  state?: SessionState;
  localStorage?: boolean;
  customStore?: (request: string) => Promise<string>;
  localResume?: boolean;
  checklist?: boolean;
  websocketsAllowed?: boolean;
}

/** @internal The existing seal owner supplies the exact live root batch. */
export interface ManualCheckpointEntry {
  readonly request: ManualToolRequest;
  readonly arguments: JsonValue;
}

/** Options used by an owned Agent.run Session to drive manual replies. */
export type OneShotOptions = {
  input: string | JsonValue[] | null;
  prepareRequest?: OperationOptions<any>['prepareRequest'];
  onNativeQuestion?: (
    request: NativeQuestion,
    signal: AbortSignal,
  ) => NativeQuestionReply | Promise<NativeQuestionReply>;
  onRequiredAction?: (
    action: ManualToolRequest,
    signal: AbortSignal,
  ) => ManualToolReply | Promise<ManualToolReply>;
};
/** Select a new root native tool plan across all admitted tool families. */
export interface OperationOptions<Context = unknown> {
  tracing?: TraceOptions;
  /**
   * Explicit parent for this new root; omission or null inherits the Session parent.
   * Combined SDK scoped tracing must identify the same native parent; an active
   * SDK scope can therefore conflict with an explicit external parent.
   */
  parentTrace?: TraceContext | TraceContextHeaders | null;
  /**
   * Maximum root model preparations for this submission. Zero blocks the first
   * preparation. Manual suspension retains the remaining budget. Provider
   * retries, output repairs, and child agents have separate lifecycles.
   */
  maxModelSteps?: number;
  /** Observed budget for a new direct native root. See {@link RunBudget}. */
  budget?: RunBudget;
  /**
   * Replace the current extra writable directories when a new root starts.
   * For a WSS macOS executor, choose the directories when opening the Session.
   * Change the grant after earlier executor work finishes.
   */
  writableRoots?: readonly string[];
  /** Omission uses Session defaults; an empty list selects no tools. */
  tools?: readonly ToolSelector<Context>[];
  /**
   * Edit detached native sampling data; original tools and history retain authority.
   * Requires a standard Responses (non-Lite) model, explicit HTTP, and eager root function/MCP tools.
   * Unselected deferred tools may remain in the opening catalog. beforeStep may narrow a mixed ceiling.
   * Undefined keeps the original.
   * Recovery may prepare again; avoid business effects in this callback. Active checkpoints refuse it.
   * Pre-turn or mid-turn automatic compaction fails the operation before any hidden request.
   * Shorten the input or start a new operation without this callback. Earlier tool effects remain.
   * Post-turn compaction is also refused, but the operation keeps its completed answer.
   */
  prepareRequest?: (
    context: PrepareRequestContext<Context>,
  ) =>
    PreparedRequestData | undefined | Promise<PreparedRequestData | undefined>;
  /**
   * Select a subset of the operation ceiling before each model preparation.
   * Returning undefined uses that ceiling. Indices start at zero.
   * An exhausted step limit or run budget blocks this callback.
   */
  beforeStep?: (
    context: BeforeStepContext<Context>,
  ) =>
    | readonly ToolSelector<Context>[]
    | undefined
    | Promise<readonly ToolSelector<Context>[] | undefined>;
}
export interface PrepareRequestContext<Context = unknown> extends Omit<
  BeforeStepContext<Context>,
  'stepIndex'
> {
  readonly request: PreparedRequestData;
  readonly preparationIndex: number;
  readonly recoveryAttempt: number;
}
export interface BeforeStepContext<Context = unknown> {
  readonly context: Context;
  readonly submission: Turn<unknown>;
  readonly stepIndex: number;
  readonly signal: AbortSignal;
}
/** Omitted busy behavior steers the active root; reject starts only when idle. */
export interface SubmitOptions<
  Context = unknown,
> extends OperationOptions<Context> {
  ifBusy?: 'steer' | 'reject';
}
/** @internal Validate before opening a provider or allocating a submission. */
export function validateMaxModelSteps(
  value: number | undefined,
): number | undefined {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
    throw new TypeError('maxModelSteps must be a nonnegative safe integer');
  return value;
}

interface OperationSelection {
  readonly names: readonly ReturnType<typeof toolIdentity>[] | undefined;
  readonly maxModelSteps?: number;
  readonly budget?: RunBudgetTracker;
  readonly beforeStep?: OperationOptions<any>['beforeStep'];
  readonly prepareRequest?: OperationOptions<any>['prepareRequest'];
  preparationIndex: number;
  generation?: bigint;
  stepIndex: number;
}

function manualCaptureRefusal(
  selection: OperationSelection | undefined,
): string | undefined {
  if (selection?.budget !== undefined)
    return 'Cannot capture an active run with a budget';
  if (
    selection?.beforeStep !== undefined ||
    selection?.prepareRequest !== undefined
  )
    return 'Cannot capture a callback-selected operation';
}

/** Scoped stop options. Defaults to scope 'root' and mode 'force'. */
export interface SessionInterruptOptions {
  scope?: 'root' | 'all';
  mode?: 'force' | 'graceful';
}

interface SessionStopOptions {
  scope: 'root' | 'thread_tree';
  mode: 'force' | 'graceful';
}

const sessionStopSchema = z
  .object({
    scope: z.enum(['root', 'thread_tree']),
    mode: z.enum(['force', 'graceful']),
  })
  .strict();

export interface Completed<OutputT = string> {
  readonly turn: Turn<OutputT>;
  readonly finalOutput: OutputT;
  readonly usage: TokenUsageInfo | null;
  readonly state?: SessionState;
  readonly repairAttempts: readonly RecordedTurn[];
}

/** Wait for the captured turn's completion or its current manual request batch. */
export interface RequestWaitOptions {
  until: 'request';
  /** Cancel only this wait, without cancelling the turn or its requests. */
  signal?: AbortSignal;
}

export interface InteractionWaitOptions {
  until: 'interaction';
  signal?: AbortSignal;
}
type AnyRequestWaitOptions = RequestWaitOptions | InteractionWaitOptions;

export interface PendingRequests<
  OutputT = string,
  NativeId extends string | null = string,
  RequestT extends Interaction = ManualToolRequest,
> {
  readonly turn: Turn<OutputT, NativeId>;
  readonly requests: readonly RequestT[];
}

/** Acceptance of one input by an exact native root turn. */
export interface SteeringReceipt {
  readonly sessionId: string;
  readonly submissionId: string;
  readonly turnId: string;
  readonly inputId: string;
}

/** A known terminal state that needs a supervisor's attention. */
export interface TurnNeedsAttention {
  readonly type: 'needs_attention';
  readonly reason:
    'interrupted' | 'connection_lost' | 'rate_limited' | 'quota_blocked';
  readonly error: NativeError;
  readonly rateLimits: ApiRateLimits;
}

const quotaCategories = new Set([
  'session_budget_exceeded',
  'usage_limit_exceeded',
  'credit_balance_exhausted',
  'project_spend_limit_exceeded',
  'organization_spend_limit_exceeded',
  'organization_usage_limit_exceeded',
  'billing_not_active',
]);

function attentionReason(
  error: NativeError,
): TurnNeedsAttention['reason'] | undefined {
  if (error instanceof TurnAborted) return 'interrupted';
  if (error.category === 'connection_failed') return 'connection_lost';
  if (error.category === 'rate_limit_exceeded') return 'rate_limited';
  if (error.category && quotaCategories.has(error.category))
    return 'quota_blocked';
}

/** @internal One settlement view for the issued handle's joined public result. */
export interface TurnCompletion<T> {
  readonly promise: Promise<Completed<T>>;
  outcome?:
    | { status: 'fulfilled'; value: Completed<T> }
    | { status: 'rejected'; reason: unknown };
}

/** @internal The Session supplies live requests; observations carry no authority. */
export interface TurnRequestWait<T, NativeId extends string | null = string> {
  rootResultReady?(): boolean;
  notify(): void;
  rateLimits(): ApiRateLimits;
  wait(
    turn: Turn<T, NativeId>,
    options: AnyRequestWaitOptions,
    completion: TurnCompletion<T>,
  ): Promise<Completed<T> | PendingRequests<T, NativeId, Interaction>>;
}

/** @internal The Session remains the sole lifecycle owner. */
export let issueTurn: <T, NativeId extends string | null = string>(
  sessionId: string,
  turnId: NativeId | (() => NativeId),
  submissionId: string,
  completion: () => Promise<Completed<T>>,
  events: (options: ObservationOptions) => AsyncIterableIterator<Observation>,
  steer: (input: UserInput) => Promise<void>,
  cancel: (mode: 'force' | 'graceful') => Promise<void>,
  identity?: { childId: string; instanceId: string },
  requests?: TurnRequestWait<T, NativeId>,
  steerExact?: (
    input: UserInput,
    expectedTurnId: string,
  ) => Promise<SteeringReceipt>,
) => Turn<T, NativeId>;

/**
 * An issued turn. For roots, turnId identifies the initial native step.
 * Controls and results follow its owned continuations.
 */
export class Turn<OutputT = string, NativeId extends string | null = string> {
  readonly childId: string | null;
  readonly instanceId: string | null;
  private readonly waitState: { current?: TurnCompletion<OutputT> } = {};
  private constructor(
    readonly sessionId: string,
    private readonly nativeIdentity: NativeId | (() => NativeId),
    readonly submissionId: string,
    private readonly completion: () => Promise<Completed<OutputT>>,
    private readonly observations: (
      options: ObservationOptions,
    ) => AsyncIterableIterator<Observation>,
    private readonly steerInput: (input: UserInput) => Promise<void>,
    private readonly cancelRoot: (mode: 'force' | 'graceful') => Promise<void>,
    identity?: { childId: string; instanceId: string },
    private readonly requests?: TurnRequestWait<OutputT, NativeId>,
    private readonly steerExactInput?: (
      input: UserInput,
      expectedTurnId: string,
    ) => Promise<SteeringReceipt>,
  ) {
    this.childId = identity?.childId ?? null;
    this.instanceId = identity?.instanceId ?? null;
    Object.freeze(this);
  }

  static {
    issueTurn = (
      sessionId,
      turnId,
      submissionId,
      completion,
      events,
      steer,
      cancel,
      identity,
      requests,
      steerExact,
    ) =>
      new Turn(
        sessionId,
        turnId,
        submissionId,
        completion,
        events,
        steer,
        cancel,
        identity,
        requests,
        steerExact,
      );
  }

  get turnId(): NativeId {
    return typeof this.nativeIdentity === 'function'
      ? this.nativeIdentity()
      : this.nativeIdentity;
  }

  /**
   * Observe this Turn's events. Closing the reader leaves execution unchanged.
   * Execution completions contain identity and status by default.
   */
  events(options: ObservationOptions = {}): AsyncIterableIterator<Observation> {
    return this.observations(options);
  }

  /** @internal Check owner settlement without creating a result waiter. */
  _rootResultReady(): boolean {
    return this.requests?.rootResultReady?.() ?? false;
  }

  wait(): Promise<Completed<OutputT>>;
  /**
   * Return all valid manual requests pending at the final native snapshot.
   * Later requests belong to a later wait; this batch reserves no reply grant.
   */
  wait(
    options: RequestWaitOptions,
  ): Promise<Completed<OutputT> | PendingRequests<OutputT, NativeId>>;
  wait(
    options: InteractionWaitOptions,
  ): Promise<
    Completed<OutputT> | PendingRequests<OutputT, NativeId, Interaction>
  >;
  wait(
    options: AnyRequestWaitOptions,
  ): Promise<
    Completed<OutputT> | PendingRequests<OutputT, NativeId, Interaction>
  >;
  wait(
    options?: AnyRequestWaitOptions,
  ): Promise<
    Completed<OutputT> | PendingRequests<OutputT, NativeId, Interaction>
  > {
    // The completion owner checks the callback guard on every call, even after
    // memoization. Track its public settlement only once, before publishing it.
    const promise = this.completion();
    let state = this.waitState.current;
    if (!state) {
      const current: TurnCompletion<OutputT> = {
        promise: promise.then(
          (value) => {
            current.outcome = { status: 'fulfilled', value };
            this.requests?.notify();
            return value;
          },
          (reason: unknown) => {
            current.outcome = { status: 'rejected', reason };
            this.requests?.notify();
            throw reason;
          },
        ),
      };
      current.promise.catch(() => {});
      this.waitState.current = state = current;
    }
    if (!options) return state.promise;
    if (!this.requests)
      return Promise.reject(new NativeError('Request wait is unavailable'));
    return this.requests.wait(this, options, state);
  }

  /** Wait for this turn's result, live requests or a known supervisory stop. Aborting only ends the wait. */
  async waitForAttention({ signal }: { signal?: AbortSignal } = {}): Promise<
    | Completed<OutputT>
    | PendingRequests<OutputT, NativeId, Interaction>
    | TurnNeedsAttention
  > {
    try {
      return await this.wait({ until: 'interaction', signal });
    } catch (error) {
      if (signal?.aborted && error === signal.reason) throw error;
      if (!(error instanceof NativeError)) throw error;
      const reason = attentionReason(error);
      if (!reason || !this.requests) throw error;
      return Object.freeze({
        type: 'needs_attention',
        reason,
        error,
        rateLimits: this.requests.rateLimits(),
      });
    }
  }

  /** Steer only this root and its owned continuation. */
  steer(input: UserInput): Promise<void> {
    if (arguments.length > 1)
      return Promise.reject(
        new TypeError('steer accepts input without operation options'),
      );
    return this.steerInput(input);
  }

  /** Target the native ID from a turn_started observation without following a continuation. */
  steerExact(
    input: UserInput,
    expectedTurnId: string,
  ): Promise<SteeringReceipt> {
    if (!this.steerExactInput)
      return Promise.reject(
        new NativeError('Turn.steerExact supports root Turns only'),
      );
    if (typeof expectedTurnId !== 'string' || expectedTurnId.length === 0)
      return Promise.reject(
        new TypeError('expectedTurnId must be a non-empty string'),
      );
    return this.steerExactInput(input, expectedTurnId);
  }

  /** Stop this root and join its cleanup. A settled root is a no-op. */
  cancel({
    mode = 'force',
  }: { mode?: 'force' | 'graceful' } = {}): Promise<void> {
    return this.cancelRoot(mode);
  }
}

export type SessionUpdate<Context> =
  | {
      model?: string;
      modelSettings?: ModelSettings;
      instructions?: never;
      tools?: never;
    }
  | {
      instructions: string;
      model?: never;
      modelSettings?: never;
      tools?: never;
    }
  | {
      tools: readonly Tool<Context>[];
      model?: never;
      modelSettings?: never;
      instructions?: never;
    };

interface SessionStartup {
  failure: ReturnType<typeof Promise.withResolvers<never>>;
  publication?: Promise<string>;
  boundary?: {
    id: string;
    observed: ReturnType<typeof Promise.withResolvers<void>>;
  };
  cause?: { value: unknown };
}

interface NativeRunResult {
  finalOutput: string;
  turnId: string;
  usage: JsonValue | null;
}

export class TurnAborted extends NativeError {}
export class StaleTurnError extends NativeError {}
export class TurnNotSubmitted extends NativeError {
  constructor(readonly reason: JsonValue) {
    super('Native turn was not submitted: ' + encode(reason));
  }
}
export class InteractionRequired extends NativeError {
  constructor(readonly state?: SessionState) {
    super('The turn requires an application response');
  }
}

const toolInvocation = new AsyncLocalStorage<{
  session: Session<unknown>;
  run?: NativeTurn;
  child?: ChildCallbackOwner;
  active: boolean;
}>();

function cleanupFailure(run: NativeTurn, primary?: unknown): unknown {
  if (!run.toolCleanupErrors.length) return primary;
  return new AggregateError(
    [...(primary === undefined ? [] : [primary]), ...run.toolCleanupErrors],
    'Native tool callback cleanup failed',
    primary === undefined ? undefined : { cause: primary },
  );
}

interface OutputRepair {
  completion: Promise<void>;
  finished: boolean;
  stop?: 'force' | 'graceful';
  session?: Session<string>;
  run?: NativeTurn;
  cleanup?: Promise<void>;
  opening?: Pick<ProviderLease, 'failedOpeningCleanup'>;
}

// One edge can only be created by settlement of its predecessor. Following a
// Session result must never attach to a later, unrelated application submit.
const submissions = new WeakMap<
  NativeTurn,
  {
    readonly output: PreparedOutput;
    readonly outputOverride: boolean;
    callerSignal?: AbortSignal;
    observation: ObservationPhase;
    next?: NativeTurn;
    previous?: NativeTurn;
    cancelled?: boolean;
    blankFinal?: boolean;
    compaction?: boolean;
    review?: boolean;
    retirement?: Promise<never>;
    tracingAdmissionFailed?: boolean;
    repair?: OutputRepair;
  }
>();

// Public observers join automatic retirement; internal receipts stay available
// to release native readers and callback owners during that same cleanup.
function afterSubmissionRetirement<T>(
  run: NativeTurn,
  result: Promise<T>,
): Promise<T> {
  return result.catch((error: unknown) => {
    const retirement = submissions.get(run)?.retirement;
    if (retirement) return retirement;
    throw error;
  });
}

function continuationWasSuperseded(error: unknown): boolean {
  if (!(error instanceof TurnNotSubmitted)) return false;
  const reason = error.reason;
  return (
    reason !== null &&
    typeof reason === 'object' &&
    !Array.isArray(reason) &&
    (reason.type === 'superseded' || reason.type === 'pending_trigger_turn')
  );
}

class NativeTurn {
  parentTrace?: TraceContext;
  readonly accepted = Promise.withResolvers<AcceptedSubmission>();
  readonly completion = Promise.withResolvers<NativeRunResult>();
  readonly controller = new AbortController();
  mcpPublication?: Promise<void>;
  readonly pending: NativeEvent[] = [];
  readonly manualReplies = new Set<Promise<void>>();
  readonly callbacks = new Set<Promise<void>>();
  readonly toolInvocations = new Set<Promise<void>>();
  readonly toolCallIds = new Set<string>();
  readonly toolCleanupErrors: unknown[] = [];
  readonly executing = new Set<string>();
  tracing?: TraceCapture;
  // Keep workflow ownership when a retained successor takes completion tracing.
  issuedTracing?: TraceCapture;
  selection?: OperationSelection;
  writableRoots?: readonly string[];
  preparation?: AbortController;
  id: string | null = null;
  usage: JsonValue | null = null;
  tokenUsage: RunUsage | null = null;
  addUsage(raw: JsonObject): void {
    this.tokenUsage = addRunUsage(this.tokenUsage, raw);
  }
  failure: unknown;
  nativeFailure?: NativeError;
  constructor(private readonly beforeWait: () => void) {
    this.accepted.promise.catch(() => {});
    this.completion.promise.catch(() => {});
  }
  wait(): Promise<NativeRunResult> {
    this.beforeWait();
    return afterSubmissionRetirement(this, this.completion.promise);
  }
}

type Lifecycle =
  | { kind: 'idle' }
  | { kind: 'turn'; run: NativeTurn }
  | { kind: 'mutation'; completion: Promise<unknown> }
  | {
      kind: 'retired';
      cause: unknown;
      phase: ClosePhase;
      run?: NativeTurn;
      mutation?: Promise<unknown>;
      completedCloseFailure?: NativeError;
    }
  | { kind: 'closing'; completion: Promise<void> }
  | { kind: 'closed'; completion: Promise<void> };
type ClosePhase = 'revoke' | 'native' | 'engine' | 'carrier' | 'provider';

/** A view of the active model context issued by an idle Session. */
export interface ModelContextSnapshot {
  /** Detached Responses-shaped JSON items in native context order. */
  readonly items: readonly JsonObject[];
}

/** Replace idle model context without making a summarizing model request. */
export interface SuppliedCompactionOptions {
  readonly summary: string;
  readonly signal?: AbortSignal;
  /** A current snapshot from this Session. Supply it together with retain. */
  readonly snapshot?: ModelContextSnapshot;
  /** Zero-based item indices. Supply both indices for any retained tool pair. */
  readonly retain?: readonly number[];
}

type ContextChange = Awaited<ReturnType<NativeThread['_begin_context_change']>>;
type ContextReplacement = {
  readonly source: NativeThread;
  readonly sourceEngine: Engine;
  readonly sourceReaders: readonly Promise<void>[];
  change?: ContextChange;
  creation?: Promise<Engine>;
  candidate?: Engine;
  thread?: NativeThread;
  publication?: Promise<string>;
  witness?: Promise<void>;
  cleanup?: Promise<void>;
  released: boolean;
  fenced: boolean;
  retiring: boolean;
  sourceReleased: boolean;
  published: boolean;
  completedFailure?: NativeError;
};

export class Session<OutputT = string, Context = unknown> {
  private apiRateLimitState: { snapshot: ApiRateLimits } = {
    snapshot: Object.freeze({}),
  };

  /** Latest usable API-key limits observed in this live session. */
  rateLimits(): ApiRateLimits {
    return this.apiRateLimitState.snapshot;
  }

  private readonly turnHandles = new WeakMap<
    NativeTurn,
    Turn<unknown, string | null>
  >();
  private readonly pendingRoots: { run: NativeTurn; parts: JsonValue[] }[] = [];
  private readonly decodedOutputs = new WeakMap<NativeTurn, unknown>();
  private readonly repairTurns: RepairTurnWire[];
  private readonly repairItems: RepairItemWire[];
  private repairReceiptsIncomplete = false;
  private readonly completedResults = new WeakMap<
    NativeRunResult,
    Completed<unknown>
  >();
  private readonly issuedRuns = new Map<string, NativeTurn>();
  private readonly submissionIds = new WeakMap<NativeTurn, string>();
  private readonly requestObservationRoutes = new Map<string, NativeTurn>();
  private readonly allowedTools: Set<string>;
  private defaultTools: readonly SessionTool[];
  private readonly admittedDeclarations = new Map<string, WeakSet<object>>();
  private readonly observations: ObservationBuffer;
  private readonly nativeQuestions = new Map<
    NativeQuestion,
    {
      run: NativeTurn | ChildCallbackOwner;
      native: NativeThread;
      questionId?: string;
      grant: NativeQuestionGrant;
      decline: string | null;
      form: boolean;
      mcpCallId?: string;
      key: string;
      url?: {
        serverName: string;
        completion: ReturnType<typeof createUrlCompletion>;
      };
    }
  >();
  private readonly urlCompletions = new Map<
    NativeQuestion,
    {
      run: NativeTurn | ChildCallbackOwner;
      native: NativeThread;
      serverName: string;
      requestIdToken: string;
      questionId: string;
      producer: ChildObservationProducer;
      completion: ReturnType<typeof createUrlCompletion>;
      stop: () => Promise<void>;
    }
  >();
  private readonly nativeQuestionSources = new WeakMap<
    NativeEvent,
    ReturnType<typeof parseNativeQuestion>
  >();
  private readonly nativeFormRegistrations = new WeakMap<
    NativeTurn | ChildCallbackOwner,
    Set<string>
  >();
  private readonly nativeFormPreparations = new Map<
    string,
    {
      run: NativeTurn | ChildCallbackOwner;
      native: NativeThread;
      questionId: string;
      decline: string;
      active: boolean;
    }
  >();
  private readonly nativeQuestionKeys = new WeakMap<
    NativeTurn | ChildCallbackOwner,
    Set<string>
  >();
  private readonly nativeQuestionRetirement = new WeakSet<
    NativeTurn | ChildCallbackOwner
  >();
  private readonly nativeMcpCalls = new WeakMap<
    NativeTurn | ChildCallbackOwner,
    Map<string, { server: string; tool: string }>
  >();
  private starting?: SessionStartup;
  private readonly defaultOutput: PreparedOutput;
  private readonly openingCatalog: ToolCatalog;
  private readonly capabilityView: Capabilities;
  private sealedStateJson?: string;
  private mcpTools: readonly McpTool[];
  private readonly openingMcpTools: readonly McpTool[];
  private mcpBindings: readonly McpTool[];
  private defaultMcpTools: readonly McpTool[];
  private readonly allowedMcpTools: Set<string>;
  private mcpGeneration = 0n;
  private mcpReaderStarted = false;
  private readonly publicChildTurns = new Map<
    string,
    {
      turn: Turn<string>;
      native: import('../../native/index.js')._NativeChildTurn;
    }
  >();
  private readonly observedChildTurns = new WeakSet<ChildCallbackOwner>();
  private forkCopy: NativeThread | undefined;
  private readonly childContinuations = new Set<Promise<void>>();
  private readonly manualCalls = new Map<
    string,
    {
      run: NativeTurn | ChildCallbackOwner;
      event: NativeEvent;
      tool: ManualTool;
      grant: ReturnType<typeof createManualRequest>;
      tracing?: TraceSpan;
      ready: boolean;
      identity: ToolIdentity;
    }
  >();
  private readonly manualAdmissions = new Map<string, Promise<void>>();
  private nativeManualCheckpoint = false;
  private manualSealing = false;
  private manualSeal?: Promise<SessionState>;
  private manualRestoring = false;
  private manualSealed = false;
  private manualCheckpointRun?: NativeTurn;
  private manualProgress = 0;
  // manualSeal owns at most one readiness wait, including its native token.
  private manualWake?: () => void;
  private lifecycle: Lifecycle = { kind: 'idle' };
  // A stop gate is independent of the run lifecycle: native and its reader
  // still finish that exact run, while new starts/mutations are excluded.
  private readonly graphStops = new Set<{
    options: SessionStopOptions;
    run?: NativeTurn;
    completion: Promise<void>;
    questionReplies: Map<NativeTurn | ChildCallbackOwner, Promise<void>[]>;
  }>();
  private selectedEnvironmentRetirementAttempted = false;
  private readers: Promise<void>[] = [];
  private readonly interceptionCleanups = new Set<() => Promise<void>>();
  private readonly interceptionStops = new Set<
    (run?: NativeTurn, mode?: 'force' | 'graceful') => Promise<void>
  >();
  private childObservationProducer: ChildObservationProducer = {
    ended: false,
    eventReaderEnded: false,
  };
  private changedExecutorRoots = false;
  private lastRun: NativeTurn | null = null;
  private readonly childCallbacks = new ChildCallbacks();
  private readonly childSelections = new WeakMap<
    ChildCallbackOwner,
    OperationSelection
  >();
  // Only one-shot manual handlers report child cleanup to the owning run.
  private readonly oneShotChildCleanupErrors: unknown[] = [];
  #native: NativeThread;
  #engine: Engine;
  private environmentDisposalFinished = false;
  private environmentCloseFailure?: Promise<void>;
  readonly #modelApiKey?: string;
  private contextReplacement?: ContextReplacement;
  private replacingNative?: NativeThread;
  readonly #modelContextSnapshots = new WeakMap<
    ModelContextSnapshot,
    { source: NativeThread; payload: string; length: number }
  >();

  constructor(
    engine: Engine,
    native: NativeThread,
    private catalog: ToolCatalog,
    private readonly options: SessionOptions,
    private readonly threadOptions: ThreadOptions,
    private readonly restored: SessionState | null = null,
    private readonly carrier?: NativeProviderRoutes,
    private readonly environment: Environment | null = null,
    private readonly oneShot?: OneShotOptions,
    modelApiKey?: string,
  ) {
    this.defaultOutput = options.output ?? prepareOutput(undefined);
    this.openingCatalog = catalog;
    const receipts = isOutputAwareState(restored) ? restored : undefined;
    this.repairTurns = structuredClone(receipts?.repair_turns ?? []).map(
      (turn) => ({ ...turn, parentSessionId: native.id }),
    );
    this.repairItems = structuredClone(receipts?.repair_items ?? []).map(
      (item) => ({ ...item, parentSessionId: native.id }),
    );

    this.defaultTools = checkpointDefaultTools(
      readCheckpointSelections(restored).default_tools,
      catalog,
    );
    for (const tool of catalog.tools)
      this.admittedDeclarations.set(
        JSON.stringify([toolIdentity(tool).namespace, tool.name]),
        new WeakSet([toolDeclarationIdentity(tool)]),
      );
    this.openingMcpTools = Object.freeze([...(options.mcpTools ?? [])]);
    this.mcpBindings = this.openingMcpTools;
    this.defaultMcpTools = this.openingMcpTools;
    this.mcpTools = this.openingMcpTools.filter(
      (server) =>
        !(server instanceof HttpMCP) || server.activation !== 'operation',
    );
    this.allowedMcpTools = new Set(
      mcpToolNames(this.openingMcpTools).map((tool) =>
        JSON.stringify([tool.namespace, tool.name]),
      ),
    );
    this.allowedTools = new Set(
      catalog.tools.map((tool) => {
        const identity = toolIdentity(tool);
        return JSON.stringify([identity.namespace, identity.name]);
      }),
    );
    this.observations = new ObservationBuffer(native.id, {
      validate: () => this.checkCallbackOperation('observe'),
      pendingManual: () =>
        [...this.manualCalls.values()].flatMap((call) => {
          const request = call.ready ? call.grant.request() : null;
          return request ? [request] : [];
        }),
    });
    this.#native = native;
    this.#engine = engine;
    this.#modelApiKey = modelApiKey;
    this.capabilityView = createCapabilities(
      () => this.checkCapabilitiesHealth(),
      (feature) => this.featureSupport(feature),
      options.websocketsAllowed ?? false,
    );
  }
  get id(): string {
    return this.#native.id;
  }
  private get isOpen(): boolean {
    return (
      this.lifecycle.kind === 'idle' ||
      this.lifecycle.kind === 'turn' ||
      this.lifecycle.kind === 'mutation'
    );
  }
  async _start(): Promise<void> {
    const startup: SessionStartup = { failure: Promise.withResolvers<never>() };
    this.starting = startup;
    startup.failure.promise.catch(() => {});
    try {
      if (
        this.hasOperationMcp &&
        (this.options.nativeAgents ||
          this.options.localStorage ||
          this.restored ||
          this.codeModeEnabled)
      )
        throw new TypeError(
          'Operation HTTP activation requires a fresh ordinary root/direct Session',
        );
      if (this.options.localResume) {
        // Passive reads only, before settings publication, callback readers or
        // anything that can execute application work. No current child grant
        // is needed to inspect the full recorded graph.
        const children = subagentsSchema.parse(
          parseNative(await this.#native.call('list_subagents', '{}')),
        );
        const recorded = new Map<string, ReturnType<typeof projectHistory>>();
        for (const id of [this.id, ...children.map((child) => child.id)]) {
          const history = await this.#readHistory(
            id === this.id ? undefined : id,
          );
          const projected = projectHistory(
            history,
            this.id,
            id === this.id ? undefined : id,
          );
          recorded.set(id, projected);
          if (
            projected.items.some(
              (item) =>
                item.type === 'function_call' &&
                (item.status === 'in_progress' || item.status === 'incomplete'),
            )
          ) {
            throw new NativeError(
              'Native local history has an unknown tool outcome; reconcile its external effect before reopening',
            );
          }
        }
        for (const child of children) {
          if (child.status === 'closed') continue;
          const parent = recorded.get(child.parentAgentId);
          const own = recorded.get(child.id);
          if (!parent || !own)
            throw new NativeError(
              'Native local history has incomplete descendant topology',
            );
          const inherited = new Set(parent.turns.map((turn) => turn.id));
          const turns = own.turns.filter((turn) => !inherited.has(turn.id));
          if (
            !turns.length ||
            turns.some((turn) => turn.status === 'in_progress')
          )
            throw new NativeError(
              'Native local history has an active descendant; its runtime cannot be restored',
            );
        }
      }
      if (
        this.options.webSearch?.route === 'hosted' ||
        this.options.hostedTools?.length
      )
        await this.#native._validate_hosted_search_model();
      if (this.options.initialModelSettings && !this.restored) {
        const settings = modelOverrides(
          undefined,
          this.options.initialModelSettings,
        );
        if (
          Object.keys(settings).length &&
          (await this.#native._update_model_settings(encode(settings))) !== true
        )
          throw new NativeError('Native model settings were not acknowledged');
      }
      this.configureNative(this.#native);
      if (
        this.restored &&
        (this.defaultTools.length !== this.catalog.tools.length ||
          this.defaultTools.some((tool, i) => tool !== this.catalog.tools[i]))
      ) {
        const defaults = this.defaultTools;
        await this.publishCatalog(
          async () =>
            captureTools(this.catalog.tools, this.catalog.generation + 1n),
          defaults,
        );
      }
      const executorPolicy =
        this.environment !== null && hasExecutorPolicy(this.environment);
      if (this.catalog.tools.some((tool) => tool.kind === 'manual'))
        await this.configureManualTools();
      this.ownReader(withoutTracing(() => this.readEvents()));
      if (this.options.mcpTools) {
        const boundary = {
          id: randomUUID(),
          observed: Promise.withResolvers<void>(),
        };
        startup.boundary = boundary;
        startup.publication = this.#native._replace_mcp_servers(
          encode(
            mcpConfig(
              this.mcpTools,
              this.environment ?? undefined,
              this.codeModeEnabled,
              this.mcpBindings,
            ),
          ),
          mcpPolicies(this.mcpTools, this.mcpGeneration),
          hasMcpPrePolicy(this.mcpTools)
            ? encode(this.interceptionRules(this.mcpTools, this.mcpGeneration))
            : undefined,
          undefined,
          undefined,
          boundary.id,
        );
        startup.publication.catch(() => {});
        const receipt = parseNative(
          await Promise.race([startup.publication, startup.failure.promise]),
        );
        checkMcpPublication(
          receipt,
          this.mcpTools,
          this.mcpGeneration,
          this.mcpBindings,
        );
        await Promise.race([
          boundary.observed.promise,
          startup.failure.promise,
        ]);
      }
      if (this.options.mcpTools) {
        this.mcpReaderStarted = true;
        this.ownReader(withoutTracing(() => this.readMcpResults()));
      }
      if (executorPolicy || this.options.nativeAgents || this.options.mcpTools)
        this.ownReader(withoutTracing(() => this.readInterceptions()));
      if (startup.cause) throw startup.cause.value;
      this.starting = undefined;
    } catch (error) {
      startup.cause ??= { value: error };
      throw startup.cause.value;
    } finally {
      this.watchChildObservationProducer();
    }
  }

  private failStartup(error: unknown): void {
    const startup = this.starting;
    if (!startup) return;
    startup.cause ??= { value: error };
    startup.failure.reject(error);
  }

  private ownReader(reader: Promise<void>): void {
    const native = this.#native;
    this.readers.push(reader);
    reader.catch((error) => {
      if (this.replacingNative === native) return;
      if (this.starting) this.failStartup(error);
      else this.readerFailed(error);
    });
  }

  private configureNative(native: NativeThread): void {
    if (this.options.mcpTools) native._enable_native_mcp_results(30);
    const executorPolicy =
      this.environment !== null && hasExecutorPolicy(this.environment);
    if (executorPolicy || this.options.nativeAgents || this.options.mcpTools) {
      native._enable_native_interception(
        30,
        this.options.nativeAgents || this.options.mcpTools
          ? 'thread_tree'
          : 'root',
      );
      const rules: JsonValue[] = executorPolicy
        ? JSON.parse(
            executorPolicyRules(this.environment!, !!this.options.nativeAgents),
          )
        : [];
      if (this.options.nativeAgents)
        rules.push(...nativeAgentsPolicyRules(this.options.nativeAgents));
      native._configure_native_interception(encode(rules));
    }
  }

  private startReaders(): void {
    const executorPolicy =
      this.environment !== null && hasExecutorPolicy(this.environment);
    this.readers = [];
    this.childObservationProducer = { ended: false, eventReaderEnded: false };
    this.ownReader(withoutTracing(() => this.readEvents()));
    this.mcpReaderStarted = !!this.options.mcpTools;
    if (this.mcpReaderStarted)
      this.ownReader(withoutTracing(() => this.readMcpResults()));
    if (executorPolicy || this.options.nativeAgents || this.options.mcpTools)
      this.ownReader(withoutTracing(() => this.readInterceptions()));
    this.watchChildObservationProducer();
  }

  private watchChildObservationProducer(): void {
    const producer = this.childObservationProducer;
    // Auxiliary readers can still publish child observations after the main
    // event reader ends. All readers have been registered before this snapshot.
    void Promise.allSettled(this.readers).then(() => {
      producer.ended = true;
      this.retireChildObservations(producer);
    });
  }

  private retireChildObservations(
    producer: ChildObservationProducer,
    matches?: (owner: ChildCallbackOwner) => boolean,
  ): void {
    if (producer.ended)
      for (const [request, record] of this.urlCompletions)
        if (record.run instanceof NativeTurn && record.producer === producer)
          this.settleNativeUrl(request, false);
    const questionOwners = new Set([
      ...[...this.nativeQuestions.values()].map((record) => record.run),
      ...[...this.nativeFormPreparations.values()].map((record) => record.run),
    ]);
    for (const owner of questionOwners)
      if (
        !(owner instanceof NativeTurn) &&
        owner.observationProducer === producer &&
        (!matches || matches(owner))
      )
        this.retireNativeQuestions(owner);
    const pending = this.childCallbacks.retireObservations(
      producer,
      () => this.observations.notify(),
      matches,
    );
    if (!pending) return;
    this.childContinuations.add(pending);
    void pending.finally(() => this.childContinuations.delete(pending));
  }

  /**
   * Observe this Session's events. Execution completions contain identity and status by default.
   * Use includeExecutionDetails only in trusted code.
   * Recover full retained execution records through items() after a gap.
   */
  events(options: ObservationOptions = {}) {
    return this.observations.events(options);
  }

  private pendingNativeQuestions(
    run: NativeTurn | ChildCallbackOwner,
    ownedOnly = false,
  ): NativeQuestion[] {
    return [...this.nativeQuestions.values()].flatMap((record) =>
      record.run === run &&
      record.grant.current() &&
      (!ownedOnly ||
        (record.grant.request.turnId !== null &&
          record.grant.request.submissionId !== null))
        ? [record.grant.request]
        : [],
    );
  }

  private async refreshNativeQuestions(
    owner?: NativeTurn | ChildCallbackOwner,
  ): Promise<void> {
    await Promise.all(
      [...this.nativeQuestions].map(async ([request, record]) => {
        if ((owner && record.run !== owner) || record.questionId === undefined)
          return;
        if (record.url) {
          await record.url.completion.refresh();
          return;
        }
        let pending = false;
        if (record.grant.current()) {
          try {
            pending = await record.native._native_question_pending(
              record.questionId,
            );
          } catch (error) {
            if (record.grant.current()) throw error;
          }
        }
        if (!pending && this.nativeQuestions.get(request) === record) {
          record.grant.deactivate();
          this.nativeQuestions.delete(request);
          this.observations.notify();
        }
      }),
    );
  }

  /** Current issued interactions; this snapshot reserves no response. */
  async pendingInteractions(): Promise<readonly Interaction[]> {
    this.checkCallbackOperation('read interactions');
    for (;;) {
      if (!this.isOpen) throw new NativeError('Session is closed');
      await this.refreshNativeQuestions();
      if (!this.isOpen) throw new NativeError('Session is closed');
      const owners: (NativeTurn | ChildCallbackOwner)[] =
        this.childCallbacks.entered();
      if (this.lifecycle.kind === 'turn') owners.unshift(this.lifecycle.run);
      const snapshots = owners
        .filter((owner) => this.canReturnRequests(owner))
        .map((owner) => ({ owner, events: this.pendingManual(owner) }));
      const admissions = snapshots.flatMap(({ owner, events }) =>
        events.flatMap((event) => {
          const pending = this.admitManualCall(owner, event);
          return pending ? [pending] : [];
        }),
      );
      if (admissions.length) {
        await Promise.allSettled(admissions);
        continue;
      }
      const requests: Interaction[] = [];
      for (const { owner, events } of snapshots) {
        if (!this.canReturnRequests(owner)) continue;
        for (const event of events) {
          const key = this.manualCallKey(event);
          const call =
            key === undefined ? undefined : this.manualCalls.get(key);
          if (!call || call.run !== owner || !this.manualCurrent(event))
            continue;
          this.publishManualRequest(owner, event);
          const request = call.grant.request();
          if (request) requests.push(request);
        }
      }
      for (const owner of owners)
        requests.push(...this.pendingNativeQuestions(owner));
      return Object.freeze(requests);
    }
  }

  /** Live wrappers once per reader, independent of observation retention. */
  interactions(): AsyncIterableIterator<Interaction> {
    this.checkCallbackOperation('read interactions');
    if (!this.isOpen) throw new NativeError('Session is closed');
    const seen = new WeakSet<object>();
    const ended = Promise.withResolvers<void>();
    let closed = false;
    return {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: async (): Promise<IteratorResult<Interaction>> => {
        for (;;) {
          if (closed || !this.isOpen) return { done: true, value: undefined };
          const changed = this.observations.waitForChange();
          const snapshot = this.pendingInteractions();
          snapshot.catch(() => {});
          let requests: readonly Interaction[] | undefined;
          try {
            requests = await Promise.race([
              snapshot,
              ended.promise.then(() => undefined),
            ]);
          } catch (error) {
            if (closed || !this.isOpen) return { done: true, value: undefined };
            throw error;
          }
          if (closed || !requests) return { done: true, value: undefined };
          const request = requests.find((value) => !seen.has(value));
          if (request) {
            seen.add(request);
            return { done: false, value: request };
          }
          await Promise.race([changed, ended.promise]);
        }
      },
      async return() {
        closed = true;
        ended.resolve();
        return { done: true, value: undefined };
      },
    };
  }

  private enqueueNativeQuestion(
    run: NativeTurn | ChildCallbackOwner,
    native: NativeThread,
    wire: string,
    questionId?: string,
    requireLive = false,
  ): Promise<void> {
    const expired = new TypeError(
      'Native request is expired or already answered',
    );
    let enqueue: Promise<void>;
    try {
      enqueue =
        questionId === undefined
          ? native._respond_native_question(wire)
          : native
              ._respond_owned_native_question(questionId, wire)
              .then((accepted) => {
                if (!accepted && requireLive) throw expired;
              });
    } catch (error) {
      enqueue = Promise.reject(error);
    }
    const operation = enqueue.catch((error) => {
      if (
        run instanceof NativeTurn &&
        error !== expired &&
        !this.current(run) &&
        error !== run.failure &&
        error !== run.controller.signal.reason
      )
        run.toolCleanupErrors.push(error);
      throw error;
    });
    const tracked = operation.catch((error) => {
      if (error !== expired) throw error;
    });
    if (run instanceof NativeTurn) this.track(run, tracked, run.manualReplies);
    else
      void this.trackOwnedCallback(run, async () => {
        try {
          await tracked;
        } catch (error) {
          if (this.current(run)) throw error;
        }
      }).catch(() => {});
    return operation;
  }

  private async submitNativeQuestion(
    reply: NativeQuestionReply,
    expected?: NativeQuestion,
  ): Promise<void> {
    const request = nativeReplyRequest(reply);
    const record =
      request === undefined ? undefined : this.nativeQuestions.get(request);
    if (
      !record ||
      (expected !== undefined && request !== expected) ||
      !record.grant.current()
    )
      throw new TypeError(
        'Native reply is foreign, expired, or already delivered',
      );
    const wire = record.grant.take(reply);
    this.nativeQuestions.delete(record.grant.request);
    this.observations.notify();
    await this.enqueueNativeQuestion(
      record.run,
      record.native,
      wire,
      record.questionId,
      true,
    );
    if (record.url && JSON.parse(wire).kind === 'decline_elicitation')
      this.settleNativeUrl(record.grant.request, false);
    else if (
      record.url &&
      !record.url.completion.pending() &&
      record.questionId !== undefined
    )
      await record.native._native_url_completion_status(record.questionId);
  }

  private settleNativeUrl(request: NativeQuestion, completed: boolean): void {
    const record = this.urlCompletions.get(request);
    if (!record || !record.completion.pending()) return;
    record.completion.settle(completed);
    this.urlCompletions.delete(request);
    this.interceptionCleanups.delete(record.stop);
    if (!completed) {
      this.nativeQuestions.get(request)?.grant.deactivate();
      this.nativeQuestions.delete(request);
    }
    this.observations.notify();
  }

  private async observeNativeUrlStatus(
    native: NativeThread,
    event: NativeEvent,
  ): Promise<void> {
    const msg = event.msg;
    for (const [request, record] of this.urlCompletions) {
      const owner = record.run;
      if (
        record.native !== native ||
        record.serverName !== msg.server_name ||
        record.requestIdToken !== JSON.stringify(msg.request_id) ||
        (owner instanceof NativeTurn
          ? event.subagent_id !== undefined ||
            event.subagent_incarnation !== undefined ||
            event.subagent_instance_id !== undefined
          : event.subagent_id !== owner.childId ||
            event.subagent_incarnation !== owner.incarnation ||
            event.subagent_instance_id !== owner.instanceId)
      )
        continue;
      if (typeof msg.completed !== 'boolean')
        throw new NativeError('Malformed URL completion status');
      this.settleNativeUrl(request, msg.completed);
      if (msg.completed)
        await native._native_url_completion_status(record.questionId);
    }
  }

  private retireNativeQuestions(
    run: NativeTurn | ChildCallbackOwner,
    formsOnly = false,
  ): Promise<void>[] {
    if (!formsOnly) this.nativeMcpCalls.delete(run);
    const replies: Promise<void>[] = [];
    for (const preparation of this.nativeFormPreparations.values()) {
      if (preparation.run !== run || !preparation.active) continue;
      preparation.active = false;
      const reply = this.enqueueNativeQuestion(
        run,
        preparation.native,
        preparation.decline,
        preparation.questionId,
      );
      replies.push(reply);
      void reply.catch(() => {});
    }
    for (const [request, record] of this.nativeQuestions) {
      if (record.run !== run || (formsOnly && !record.form)) continue;
      record.grant.deactivate();
      this.nativeQuestions.delete(request);
      // Accepted URL lifecycles live separately from their original turn.
      // An unconsumed root URL also keeps its completion observation; closing
      // the Session or its explicit deadline retires that exact native owner.
      if (record.decline !== null && !record.url) {
        const reply = this.enqueueNativeQuestion(
          run,
          record.native,
          record.decline,
          record.questionId,
        );
        replies.push(reply);
        void reply.catch(() => {});
      }
    }
    this.observations.notify();
    return replies;
  }

  private declineQuestionWire(event: NativeEvent): string {
    const server = event.msg.server_name;
    const id = this.nativeQuestionSources.get(event)?.id;
    if (typeof server !== 'string' || id === undefined)
      throw new NativeError(
        'Native elicitation has no exact response identity',
      );
    return JSON.stringify({
      kind: 'decline_elicitation',
      server_name: server,
      request_id: JSON.rawJSON(id),
    });
  }

  private trackNativeQuestion(
    run: NativeTurn | ChildCallbackOwner,
    event: NativeEvent,
  ): Promise<void> {
    const native = this.#native;
    const context =
      typeof event.msg.tracing_context === 'string'
        ? event.msg.tracing_context
        : undefined;
    const questionId =
      typeof event.msg._sdk_question_id === 'string'
        ? event.msg._sdk_question_id
        : undefined;
    const callback = async () => {
      if (context === undefined || questionId === undefined)
        return this.admitNativeQuestion(run, event);
      const pending = async () =>
        this.#native === native &&
        this.canAnswerNativeQuestions(run) &&
        (await native._native_question_pending(questionId));
      if (!(await pending())) return;
      let entered = false;
      try {
        await withNativeCallbackContext(
          context,
          () => {
            entered = true;
            return this.admitNativeQuestion(run, event);
          },
          run.controller.signal,
          (traceId, workflowSpanId) =>
            this.workflowForTrace(traceId, workflowSpanId),
        );
      } catch (error) {
        if (!entered && !(await pending())) return;
        throw error;
      }
    };
    if (
      run instanceof NativeTurn &&
      context !== undefined &&
      questionId !== undefined
    ) {
      const pending = Promise.resolve().then(callback);
      this.track(run, pending, run.toolInvocations);
      return pending;
    }
    return this.trackOwnedCallback(run, callback);
  }

  private trackQuestionCallback(
    run: NativeTurn | ChildCallbackOwner,
    callback: () => Promise<void>,
  ): Promise<void> {
    const span = getCurrentSpan();
    const context = span?.retain();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (context !== undefined) span!.releaseContext(context);
    };
    const pending = this.trackOwnedCallback(
      run,
      async () => {
        try {
          await callback();
        } finally {
          release();
        }
      },
      context,
    );
    return pending.finally(release);
  }

  private async admitNativeQuestion(
    run: NativeTurn | ChildCallbackOwner,
    event: NativeEvent,
  ): Promise<void> {
    const msg = event.msg;
    const native = this.#native;
    const turnId = run instanceof NativeTurn ? run.id : run.turnId;
    const questionId =
      typeof msg._sdk_question_id === 'string'
        ? msg._sdk_question_id
        : undefined;
    if (
      !(run instanceof NativeTurn) &&
      !this.options.nativeAgents?.interactions
    )
      return;
    if (typeof msg.turn_id === 'string' && msg.turn_id !== turnId) return;
    if (!this.canAnswerNativeQuestions(run)) return;
    // Only the native capture proves an original owner. Uncaptured URLs retain
    // the existing negative-only session interaction route.
    if (questionId === undefined) {
      if (!(run instanceof NativeTurn)) return;
      if (msg.type !== 'elicitation_request') return;
      const request = msg.request;
      if (
        !request ||
        typeof request !== 'object' ||
        Array.isArray(request) ||
        request.mode !== 'url'
      ) {
        await this.enqueueNativeQuestion(
          run,
          native,
          this.declineQuestionWire(event),
        );
        return;
      }
    } else {
      const request = msg.request;
      const isUrl =
        msg.type === 'elicitation_request' &&
        request !== null &&
        typeof request === 'object' &&
        !Array.isArray(request) &&
        request.mode === 'url';
      if (
        !isUrl &&
        (msg.turn_id !== turnId ||
          !(await native._native_question_pending(questionId)))
      )
        return;
      if (this.#native !== native || !this.canAnswerNativeQuestions(run))
        return;
    }
    if (!this.nativeQuestionRetirement.has(run)) {
      this.nativeQuestionRetirement.add(run);
      run.controller.signal.addEventListener(
        'abort',
        () => this.retireNativeQuestions(run),
        { once: true },
      );
    }
    let type: NativeQuestion['type'] = 'approval_request';
    let description = 'Native approval requested';
    let key: string;
    let sessionScoped = false;
    let decline: string | null = null;
    let mcpCallId: string | undefined;
    let form: PreparedNativeForm | undefined;
    let url:
      | {
          url: string;
          serverName: string;
          elicitationId: string;
          requestIdToken: string;
        }
      | undefined;
    const generation = this.mcpGeneration;
    const registrations =
      this.nativeFormRegistrations.get(run) ?? new Set<string>();
    this.nativeFormRegistrations.set(run, registrations);
    let encodeReply: (value: unknown) => string;
    if (
      msg.type === 'exec_approval_request' ||
      msg.type === 'apply_patch_approval_request'
    ) {
      const tools = this.environment?.tools ?? [];
      const selected =
        msg.type === 'exec_approval_request'
          ? tools.includes('exec_command') || tools.includes('write_stdin')
          : tools.includes('apply_patch') || tools.includes('exec_command');
      if (
        msg.turn_id !== turnId ||
        (run instanceof NativeTurn && !selected) ||
        msg.grant_root != null ||
        msg.network_approval_context != null ||
        msg.additional_permissions != null ||
        (msg.type === 'exec_approval_request' &&
          (msg.kind ?? 'command') !== 'command')
      )
        throw new InteractionRequired();
      const id = msg.approval_id ?? msg.call_id;
      if (typeof id !== 'string' || !id)
        throw new NativeError('Missing native approval identity');
      const kind =
        msg.type === 'exec_approval_request'
          ? 'exec_approval'
          : 'patch_approval';
      key = questionId!;
      description = `${typeof msg.reason === 'string' ? msg.reason : 'Native approval requested'}: ${JSON.stringify(msg.type === 'exec_approval_request' ? msg.command : msg.changes)}`;
      encodeReply = approvalQuestionReply({
        kind,
        id,
        ...(kind === 'exec_approval' ? { turn_id: turnId! } : {}),
      });
    } else if (msg.type === 'elicitation_request') {
      const server = msg.server_name;
      const request = msg.request;
      if (
        typeof server !== 'string' ||
        !request ||
        typeof request !== 'object' ||
        Array.isArray(request)
      )
        throw new InteractionRequired();
      const token = this.nativeQuestionSources.get(event)?.id;
      if (token === undefined)
        throw new NativeError('Missing exact native request ID');
      const id: unknown = JSON.parse(token);
      const meta = request._meta;
      const prefix = 'mcp_tool_call_approval_';
      const callId =
        typeof id === 'string' && id.startsWith(prefix)
          ? id.slice(prefix.length)
          : undefined;
      const call =
        callId === undefined
          ? undefined
          : this.nativeMcpCalls.get(run)?.get(callId);
      const approval =
        request.mode === 'form' &&
        msg.turn_id === turnId &&
        call?.server === server &&
        meta &&
        typeof meta === 'object' &&
        !Array.isArray(meta) &&
        meta.codex_approval_kind === 'mcp_tool_call';
      key = questionId ?? JSON.stringify(['elicitation', server, token]);
      description =
        typeof request.message === 'string'
          ? request.message
          : 'Native input requested';
      if (approval) {
        mcpCallId = callId;
        encodeReply = approvalQuestionReply({
          kind: 'mcp_approval',
          server_name: server,
          request_id: id as string,
        });
      } else if (
        (request.mode === 'form' ||
          request.mode === 'openai/form' ||
          request.mode === 'openaiForm') &&
        callId === undefined &&
        !(meta && typeof meta === 'object' && 'codex_approval_kind' in meta)
      ) {
        decline = this.declineQuestionWire(event);
        // Repeated delivery of a pending registration must not decline the
        // original request while its schema is still being prepared.
        if (this.nativeFormPreparations.get(key)?.run === run) return;
        if (
          registrations.has(key) &&
          [...this.nativeQuestions.values()].some(
            (record) =>
              record.run === run &&
              record.key === key &&
              record.grant.current(),
          )
        )
          return;
        if (
          questionId === undefined ||
          this.nativeFormStopped(run) ||
          registrations.has(key)
        ) {
          this.enqueueNativeQuestion(run, native, decline, questionId).catch(
            () => {},
          );
          return;
        }
        // The opaque registration, not the peer's reusable request ID, owns it.
        registrations.add(key);
        const preparation = { run, native, questionId, decline, active: true };
        this.nativeFormPreparations.set(key, preparation);
        try {
          form = await prepareNativeForm(
            request.mode,
            this.nativeQuestionSources.get(event)?.schema,
          );
          if (
            !preparation.active ||
            this.#native !== native ||
            this.mcpGeneration !== generation ||
            !this.canAnswerNativeQuestions(run) ||
            this.nativeFormStopped(run) ||
            !(await native._native_question_pending(questionId))
          )
            return;
          if (
            !preparation.active ||
            this.#native !== native ||
            !this.canAnswerNativeQuestions(run)
          )
            return;
        } catch {
          if (preparation.active)
            this.enqueueNativeQuestion(run, native, decline, questionId).catch(
              () => {},
            );
          return;
        } finally {
          this.nativeFormPreparations.delete(key);
        }
        type = 'elicitation_request';
        sessionScoped = false;
        encodeReply = formQuestionReply(server, token, form);
      } else if (request.mode === 'openai/userVerification') {
        const registration = this.options.mcpTools?.find(isHostedRegistration);
        decline = this.declineQuestionWire(event);
        if (questionId === undefined || !registration) {
          this.enqueueNativeQuestion(run, native, decline, questionId).catch(
            () => {},
          );
          return;
        }
        let prepared: PreparedUserVerification;
        try {
          prepared = prepareUserVerification(
            registration,
            server,
            token,
            request,
          );
        } catch {
          this.enqueueNativeQuestion(run, native, decline, questionId).catch(
            () => {},
          );
          return;
        }
        this.publishNativeQuestion(run, native, {
          type: 'user_verification_request',
          key,
          sessionScoped: false,
          description: prepared.description,
          questionId,
          decline,
          generation,
          encodeReply: prepared.encodeReply,
          present: prepared.decorate,
          current: () =>
            this.mcpGeneration === generation &&
            prepared.registrationMatches(
              this.options.mcpTools?.find(isHostedRegistration),
            ),
        });
        return;
      } else if (
        request.mode === 'url' &&
        this.mcpTools.some((tool) => tool.name === server)
      ) {
        type = 'elicitation_request';
        sessionScoped = msg.turn_id == null;
        decline = this.declineQuestionWire(event);
        if (
          typeof request.url !== 'string' ||
          typeof request.elicitation_id !== 'string'
        )
          throw new InteractionRequired();
        url = {
          url: request.url,
          elicitationId: request.elicitation_id,
          serverName: server,
          requestIdToken: token,
        };
        description += `\nURL: ${request.url}\nVerification ID: ${request.elicitation_id}`;
        encodeReply =
          questionId === undefined
            ? negativeQuestionReply(decline)
            : urlQuestionReply({ server_name: server }, token);
      } else {
        this.enqueueNativeQuestion(
          run,
          native,
          this.declineQuestionWire(event),
          questionId,
        ).catch(() => {});
        return;
      }
    } else throw new InteractionRequired();
    this.publishNativeQuestion(run, native, {
      type,
      key,
      sessionScoped,
      description,
      questionId,
      decline,
      mcpCallId,
      form,
      generation,
      encodeReply,
      url,
    });
  }

  private publishNativeQuestion(
    run: NativeTurn | ChildCallbackOwner,
    native: NativeThread,
    options: {
      type: NativeQuestion['type'];
      key: string;
      sessionScoped: boolean;
      description: string;
      questionId?: string;
      decline: string | null;
      mcpCallId?: string;
      form?: PreparedNativeForm;
      generation: bigint;
      encodeReply: (value: unknown) => string;
      present?: NativeQuestionPresentation;
      current?: () => boolean;
      url?: {
        url: string;
        serverName: string;
        elicitationId: string;
        requestIdToken: string;
      };
    },
  ): void {
    const {
      type,
      key,
      sessionScoped,
      description,
      questionId,
      decline,
      mcpCallId,
      form,
      generation,
      encodeReply,
      url,
    } = options;
    const turnId = run instanceof NativeTurn ? run.id : run.turnId;
    const issued = this.nativeQuestionKeys.get(run) ?? new Set<string>();
    this.nativeQuestionKeys.set(run, issued);
    if (issued.has(key)) {
      if (
        [...this.nativeQuestions.values()].some(
          (record) =>
            record.run === run && record.key === key && record.grant.current(),
        )
      )
        return;
      if (questionId !== undefined) return;
      throw new InteractionRequired();
    }
    issued.add(key);
    const completion =
      url && questionId !== undefined
        ? createUrlCompletion(
            async () => {
              grant.deactivate();
              this.nativeQuestions.delete(grant.request);
              this.urlCompletions.delete(grant.request);
              this.observations.notify();
              await native._cancel_native_url_completion(questionId);
              this.interceptionCleanups.delete(stopUrl);
            },
            async () => {
              const status =
                await native._native_url_completion_status(questionId);
              if (status !== null) this.settleNativeUrl(grant.request, status);
              return status;
            },
          )
        : undefined;
    const stopUrl = () => completion?.retire() ?? Promise.resolve();
    const present = url
      ? urlQuestionPresentation(
          url,
          completion?.wait ??
            (async () => {
              throw new TypeError(
                'This URL request has no live native completion route',
              );
            }),
        )
      : options.present;
    const grant: NativeQuestionGrant = issueNativeQuestion(
      {
        type,
        sessionId: this.id,
        subagentId: run instanceof NativeTurn ? null : run.childId,
        submissionId: sessionScoped
          ? null
          : run instanceof NativeTurn
            ? this.submissionIds.get(run)!
            : `child:${run.childId}:${run.incarnation}:${run.turnId}`,
        turnId: sessionScoped ? null : turnId!,
        description,
        call: null,
      },
      encodeReply,
      () =>
        this.#native === native &&
        this.canAnswerNativeQuestions(run) &&
        !completion?.expired() &&
        (options.current?.() ?? true) &&
        (!form ||
          (this.mcpGeneration === generation &&
            !this.nativeFormStopped(run))) &&
        this.nativeQuestions.get(grant.request)?.grant === grant,
      form,
      present,
    );
    if (url && completion) {
      this.urlCompletions.set(grant.request, {
        run,
        native,
        serverName: url.serverName,
        requestIdToken: url.requestIdToken,
        questionId: questionId!,
        producer: this.childObservationProducer,
        completion,
        stop: stopUrl,
      });
      this.interceptionCleanups.add(stopUrl);
      if (!(run instanceof NativeTurn)) {
        void this.trackQuestionCallback(run, async () => {
          let failure: unknown;
          try {
            while (completion.pending() && this.current(run)) {
              await completion.refresh();
              if (!completion.pending()) break;
              await delay(50, undefined, {
                signal: run.controller.signal,
              }).catch((error: unknown) => {
                if (
                  error instanceof Error &&
                  run.controller.signal.aborted &&
                  Object.is(error.cause, run.controller.signal.reason)
                )
                  return;
                throw error;
              });
            }
          } catch (error) {
            failure = error;
          }
          try {
            await completion.refresh();
            if (completion.pending()) await completion.retire();
          } catch (cleanup) {
            if (failure !== undefined)
              throw new AggregateError(
                [failure, cleanup],
                'URL completion cleanup failed',
                { cause: failure },
              );
            throw cleanup;
          }
          if (failure !== undefined) throw failure;
        }).catch(() => {});
      }
    }
    this.nativeQuestions.set(grant.request, {
      run,
      native,
      questionId,
      grant,
      decline,
      form: form !== undefined,
      mcpCallId,
      key,
      ...(url && completion
        ? {
            url: {
              serverName: url.serverName,
              completion,
            },
          }
        : {}),
    });
    this.observations.notify();
    if (this.oneShot) {
      const handler = this.oneShot.onNativeQuestion;
      if (!handler) {
        void this.trackQuestionCallback(run, async () => {
          throw new InteractionRequired();
        }).catch(() => {});
        return;
      }
      const response: { reply?: NativeQuestionReply } = {};
      void this.trackQuestionCallback(run, async () => {
        response.reply = await handler(grant.request, run.controller.signal);
        if (!grant.current()) return;
        if (!response.reply)
          throw new NativeError(
            'A native question handler must return its issued reply',
          );
        try {
          await this.submitNativeQuestion(response.reply, grant.request);
        } catch (error) {
          if (
            !this.current(run) &&
            error instanceof TypeError &&
            error.message === 'Native request is expired or already answered'
          )
            return;
          throw error;
        }
      }).catch(() => {});
    }
  }

  /** @internal Return the same handle after proving its initial admission. */
  #turnFor(step: NativeTurn): Turn<unknown> {
    if (!this.rootRun(step).id)
      throw new NativeError('Turn has not been admitted');
    return this.issuedTurn(step) as Turn<unknown>;
  }

  private issuedTurn(step: NativeTurn): Turn<unknown, string | null> {
    if (step.id) {
      step.issuedTracing ??= step.tracing;
      this.issuedRuns.set(step.id, step);
    }
    const run = this.rootRun(step);
    let turn = this.turnHandles.get(run);
    if (!turn) {
      let completion: Promise<Completed<unknown>> | undefined;
      const scope = this.rootObservationScope(run);
      turn = issueTurn(
        this.id,
        () => run.id,
        this.submissionIds.get(run)!,
        () => {
          this.assertCanWait(run);
          return (completion ??= this.#waitResult(run).then((value) =>
            this.#complete(value),
          ));
        },
        (options) => this.observations.events(options, scope),
        (input) => {
          this.checkCallbackOperation('steer');
          return this.steerRun(run, nativeInput(input));
        },
        (mode) => this.cancelTurn(run, mode),
        undefined,
        {
          rootResultReady: () => scope.phase() === 'ended',
          notify: () => this.observations.notify(),
          rateLimits: () => this.rateLimits(),
          wait: (turn, options, completion) =>
            this.waitRequests(
              turn,
              () => this.ownedStep(run),
              options,
              completion,
            ),
        },
        (input, expectedTurnId) => {
          this.checkCallbackOperation('steer');
          return this.steerRun(run, nativeInput(input), expectedTurnId);
        },
      );
      this.turnHandles.set(run, turn);
    }
    return turn;
  }

  /** @internal Decode each exact result once, independently of later turns. */
  #complete(result: NativeRunResult): Completed<unknown> {
    const saved = this.completedResults.get(result);
    if (saved) return saved;
    const run = this.issuedRuns.get(result.turnId);
    if (!run) throw new NativeError('Result has no issued turn');
    const completed = Object.freeze({
      turn: this.#turnFor(run),
      finalOutput: this.decodedOutputs.has(run)
        ? this.decodedOutputs.get(run)
        : result.finalOutput,
      usage: tokenUsageInfo(result.usage),
      repairAttempts: Object.freeze(
        this.repairTurns
          .filter((turn) => turn.parentTurnId === result.turnId)
          .map((turn) => recordedTurnFromWire(structuredClone(turn))),
      ),
    });
    this.completedResults.set(result, completed);
    return completed;
  }
  private idle(operation: string): void {
    if (this.graphStops.size)
      throw new NativeError(
        `${operation} is unavailable while Session is stopping`,
      );
    if (this.manualSealed)
      throw new NativeError(
        'This Session was sealed; open a fresh Session with the saved state',
      );
    if (this.lifecycle.kind === 'retired') {
      throw new NativeError(
        operation +
          ' is unavailable after failed persistence or cleanup; close the session',
        { cause: this.lifecycle.cause },
      );
    }
    if (
      this.pendingRoots.length > 0 ||
      this.lifecycle.kind !== 'idle' ||
      (this.lastRun &&
        (this.lastRun.callbacks.size > 0 ||
          this.lastRun.manualReplies.size > 0))
    ) {
      throw new NativeError(`${operation} requires a settled open session`);
    }
  }
  private current(run: NativeTurn | ChildCallbackOwner): boolean {
    if ('childId' in run) return this.isOpen && this.childCallbacks.active(run);
    return this.owns(run) && !run.controller.signal.aborted;
  }
  private owns(run: NativeTurn): boolean {
    return this.lifecycle.kind === 'turn' && this.lifecycle.run === run;
  }
  private rootRun(run: NativeTurn): NativeTurn {
    for (;;) {
      const previous = submissions.get(run)?.previous;
      if (!previous) return run;
      run = previous;
    }
  }

  private *rootSteps(run: NativeTurn): Generator<NativeTurn> {
    for (;;) {
      yield run;
      const next = submissions.get(run)?.next;
      if (!next) return;
      run = next;
    }
  }

  private rootObservationScope(root: NativeTurn): TurnObservationScope {
    return {
      includes: (event) => {
        if (!('submissionId' in event)) return false;
        for (const run of this.rootSteps(root))
          if (
            event.submissionId === this.submissionIds.get(run) ||
            event.parentSubmissionId === this.submissionIds.get(run)
          )
            return true;
        return false;
      },
      phase: () => {
        for (const run of this.rootSteps(root)) {
          const phase = submissions.get(run)!.observation;
          if (phase !== 'ended') return phase;
        }
        return 'ended';
      },
    };
  }

  private finishObservation(run: NativeTurn): void {
    submissions.get(run)!.observation = 'ended';
    this.observations.notify();
  }

  private retireObservation(run: NativeTurn): void {
    const submission = submissions.get(run)!;
    if (submission.observation === 'ended') return;
    submission.observation = 'finishing';
    // Publication can outlast raw result rejection. Join entered publishers
    // without making results or native cleanup depend on an event reader.
    const publishers = [
      ...run.callbacks,
      ...run.toolInvocations,
      ...run.manualReplies,
      ...(submission.repair ? [submission.repair.completion] : []),
    ];
    if (publishers.length)
      void Promise.allSettled(publishers).then(() =>
        this.finishObservation(run),
      );
    else this.finishObservation(run);
  }

  private ownedStep(run: NativeTurn): NativeTurn | undefined {
    if (this.lifecycle.kind !== 'turn') return;
    const current = this.lifecycle.run;
    return this.rootRun(current) === this.rootRun(run) ? current : undefined;
  }

  private assertCanWait(run: NativeTurn): void {
    const callback = toolInvocation.getStore()?.run;
    if (
      this.pendingRoots.some((entry) => entry.run === run) ||
      this.ownedStep(run) ||
      (callback && this.rootRun(callback) === this.rootRun(run))
    )
      this.checkCallbackOperation('wait on an active turn of');
  }

  private retire(cause: unknown): void {
    const state = this.lifecycle;
    if (
      state.kind === 'closing' ||
      state.kind === 'closed' ||
      state.kind === 'retired'
    )
      return;
    this.lifecycle = {
      kind: 'retired',
      cause,
      phase: 'revoke',
      ...(state.kind === 'mutation' ? { mutation: state.completion } : {}),
      ...(state.kind === 'turn' ? { run: state.run } : {}),
    };
    this.discardPending(cause);
    if (state.kind === 'turn') {
      const { run } = state;

      this.retireNativeQuestions(run);
      this.clearManualCalls(run);
      run.controller.abort(cause);
      const settle = () => {
        const error = cleanupFailure(run, cause);
        run.accepted.reject(error);
        run.completion.reject(error);
      };
      if (run.toolInvocations.size || run.manualReplies.size)
        void Promise.allSettled([
          ...run.toolInvocations,
          ...run.manualReplies,
        ]).then(settle);
      else settle();
      this.retireObservation(run);
    }
  }
  async _run(
    input: string | JsonValue[],
    callerSignal?: AbortSignal,
    maxModelSteps?: number,
    budget?: RunBudgetTracker,
  ): Promise<NativeRunResult> {
    this.startTurn(
      input,
      false,
      undefined,
      false,
      this.captureSelection(
        { maxModelSteps, prepareRequest: this.oneShot?.prepareRequest },
        this.defaultOutput,
        budget,
      ),
      callerSignal,
    );

    return this.#waitResult();
  }
  /** Start a new root with a captured output contract; reject while busy. */
  async submitWithOutput<Next>(
    input: UserInput,
    outputType: OutputSpec<Next>,
    options?: OperationOptions<Context>,
  ): Promise<Turn<Next>> {
    this.checkCallbackOperation('submit to');
    this.idle('submitWithOutput');
    if (!outputType)
      throw new TypeError('submitWithOutput requires an output contract');
    const parts = nativeInput(input);
    const output = prepareOutput(outputType);
    const selection = this.captureSelection(options, output);
    const parentTrace =
      captureTraceContext(options?.parentTrace) ?? this.options.parentTrace;
    const run = this.startTurn(
      parts,
      true,
      output,
      true,
      selection,
      undefined,
      options?.tracing,
      options?.writableRoots,
      parentTrace ?? this.options.parentTrace,
    );
    await afterSubmissionRetirement(run, run.accepted.promise);
    // This root's parser was prepared from the same OutputSpec<Next>.
    return this.#turnFor(run) as Turn<Next>;
  }

  /** Register FIFO new work and issue its exact handle before native admission. */
  enqueue(
    input: UserInput,
    outputType?: undefined,
    options?: OperationOptions<Context>,
  ): Promise<Turn<OutputT, string | null>>;
  enqueue<Next>(
    input: UserInput,
    outputType: OutputSpec<Next>,
    options?: OperationOptions<Context>,
  ): Promise<Turn<Next, string | null>>;
  enqueue<Next>(
    input: UserInput,
    outputType: OutputSpec<Next> | undefined,
    options?: OperationOptions<Context>,
  ): Promise<Turn<OutputT | Next, string | null>>;
  async enqueue<Next>(
    input: UserInput,
    outputType?: OutputSpec<Next>,
    options?: OperationOptions<Context>,
  ): Promise<Turn<OutputT | Next, string | null>> {
    this.checkCallbackOperation('enqueue on');
    if (
      !this.isOpen ||
      this.lifecycle.kind === 'mutation' ||
      this.graphStops.size ||
      this.manualSeal ||
      this.manualSealing ||
      this.manualSealed
    )
      throw new NativeError(
        'enqueue requires an open Session without a mutation, capture, or stop',
      );
    const parts = nativeInput(input);
    const output =
      outputType === undefined ? this.defaultOutput : prepareOutput(outputType);
    const selection = this.captureSelection(options, output);
    const parentTrace =
      captureTraceContext(options?.parentTrace) ?? this.options.parentTrace;
    const writableRoots =
      options?.writableRoots === undefined
        ? undefined
        : captureWritableRoots(options.writableRoots);
    const run = this.allocateRun(output, outputType !== undefined);
    run.parentTrace = parentTrace;
    run.selection = selection;
    run.writableRoots = writableRoots;
    run.tracing = this.captureRootTracing(options?.tracing);
    this.pendingRoots.push({ run, parts });
    // This output was captured from the same schema or opening default.
    const turn = this.issuedTurn(run) as Turn<OutputT | Next, string | null>;
    this.drainPending();
    return turn;
  }

  private discardPending(error: unknown): void {
    // Detach before abort listeners run; they cannot withdraw a different root.
    const pending = this.pendingRoots.splice(0);
    for (const { run } of pending) {
      run.controller.abort(error);
      run.accepted.reject(error);
      run.completion.reject(error);
      this.finishObservation(run);
    }
  }

  private drainPending(): void {
    if (
      this.lifecycle.kind !== 'idle' ||
      this.graphStops.size ||
      this.manualSeal ||
      this.manualSealing ||
      this.manualSealed
    )
      return;
    const entry = this.pendingRoots.shift();
    if (entry) this.dispatchStart(entry.run, entry.parts);
  }

  submit(
    input: UserInput,
    options?: SubmitOptions<Context>,
  ): Promise<Turn<OutputT>>;
  submit(
    input: ManualToolReply | FunctionCallOutput,
  ): Promise<Turn<OutputT> | Turn<string>>;
  submit(
    input: UserInput | ManualToolReply | FunctionCallOutput,
  ): Promise<Turn<OutputT> | Turn<string>>;
  async submit(
    input: UserInput | ManualToolReply | FunctionCallOutput,
    options?: SubmitOptions<Context>,
  ): Promise<Turn<unknown>> {
    this.checkCallbackOperation('submit to');
    if (options && 'outputType' in options)
      throw new TypeError('Use submitWithOutput to select an output contract');
    const parentTrace = captureTraceContext(options?.parentTrace);
    const ifBusy = options?.ifBusy ?? 'steer';
    if (ifBusy !== 'steer' && ifBusy !== 'reject')
      throw new TypeError('ifBusy must be steer or reject');
    if (
      isManualReply(input) ||
      (typeof input === 'object' &&
        input !== null &&
        'type' in input &&
        input.type === 'function_call_output')
    ) {
      if (options !== undefined)
        throw new TypeError('Submit options apply only to user input');
      return this.submitManualInput(input);
    }
    const parts = nativeInput(input as UserInput);
    if (ifBusy === 'steer' && this.lifecycle.kind === 'turn') {
      if (parentTrace)
        throw new TypeError(
          'Cannot reparent an active turn; submit a new root',
        );
      if (options?.writableRoots !== undefined)
        throw new TypeError('Writable roots require a new root turn');
      if (
        options?.tools !== undefined ||
        options?.beforeStep !== undefined ||
        options?.maxModelSteps !== undefined ||
        options?.budget !== undefined ||
        options?.prepareRequest !== undefined ||
        options?.tracing !== undefined
      )
        throw new TypeError('Operation selection applies only to new roots');
      const run = this.rootRun(this.lifecycle.run);
      this.requireDefaultOutput(run);
      await this.steerRun(run, parts);
      return this.#turnFor(run);
    }
    const selection = this.captureSelection(options);
    const run = this.startTurn(
      parts,
      true,
      this.defaultOutput,
      false,
      selection,
      undefined,
      options?.tracing,
      options?.writableRoots,
      parentTrace ?? this.options.parentTrace,
    );

    await afterSubmissionRetirement(run, run.accepted.promise);
    return this.#turnFor(run);
  }

  private selectionNames(
    selectors: readonly ToolSelector[],
  ): readonly ReturnType<typeof toolIdentity>[] {
    const seen = new Set<string>();
    const policy = this.threadOptions.tool_policy;
    const opening =
      policy && typeof policy === 'object' && !Array.isArray(policy)
        ? policy.allowed_tools
        : undefined;
    return Object.freeze(
      selectors.map((selector) => {
        const identity =
          selector.kind === 'tool_ref'
            ? {
                name: selector.name,
                namespace: selector.namespace || 'functions',
              }
            : toolIdentity(selector);
        const key = JSON.stringify([identity.namespace, identity.name]);
        // Preserve immediate rejection outside the captured opening authority.
        // Core derives tool_search from admitted leaves and still resolves every
        // reference against the actual model's candidates before sampling.
        if (selector.kind === 'tool_ref')
          assertAdmittedToolReference(identity, opening);
        if (this.hasOperationMcp && selector.kind === 'tool_ref') {
          const matches = (server: McpTool) =>
            mcpToolNames([server]).some(
              (name) =>
                name.namespace === identity.namespace &&
                name.name === identity.name,
            );
          if (
            this.openingMcpTools.some(matches) &&
            !this.mcpBindings.some(matches)
          )
            throw new TypeError(
              'MCP selector requires a current captured raw binding',
            );
        }
        if (
          selector.kind !== 'tool_ref' &&
          !this.admittedDeclarations
            .get(key)
            ?.has(toolDeclarationIdentity(selector))
        )
          throw new TypeError(
            `Tool ${selector.name} was not admitted by this Session`,
          );
        if (seen.has(key))
          throw new TypeError(`Duplicate tool selector ${selector.name}`);
        seen.add(key);
        return Object.freeze(identity);
      }),
    );
  }

  private captureSelection(
    options?: OperationOptions<Context>,
    output = this.defaultOutput,
    budget = RunBudgetTracker.capture(options?.budget),
  ): OperationSelection | undefined {
    if (
      options?.tools === undefined &&
      options?.beforeStep === undefined &&
      options?.maxModelSteps === undefined &&
      options?.prepareRequest === undefined &&
      budget === undefined
    )
      return;
    if (options?.prepareRequest !== undefined) {
      if (typeof options.prepareRequest !== 'function')
        throw new TypeError('prepareRequest must be callable');
      if (output.repair)
        throw new TypeError(
          'prepareRequest does not support output correction attempts; use native output or prompted maxRetries: 0',
        );
      if (this.options.websocketsAllowed !== false)
        throw new TypeError(
          'prepareRequest requires NativeProvider({ supportsWebsockets: false })',
        );
      if (
        this.options.nativeAgents ||
        this.codeModeEnabled ||
        this.environment ||
        this.options.webSearch ||
        !!this.options.hostedTools?.length ||
        this.options.nativeGoals ||
        this.options.checklist ||
        this.openingMcpTools.some(isHostedRegistration)
      )
        throw new TypeError(
          'prepareRequest supports only direct root eager function and ordinary MCP tools',
        );
    }
    return {
      prepareRequest: options?.prepareRequest,
      names:
        options?.tools === undefined
          ? undefined
          : this.selectionNames([...options.tools]),
      maxModelSteps: validateMaxModelSteps(options?.maxModelSteps),
      beforeStep: options?.beforeStep,
      budget,
      preparationIndex: 0,
      stepIndex: 0,
    };
  }

  private requireDefaultOutput(run: NativeTurn): void {
    if (submissions.get(this.rootRun(run))!.outputOverride)
      throw new TypeError(
        'Use the returned Turn for output overrides, or respond for manual replies',
      );
  }

  /** Deliver a manual reply without selecting a final-output type. */
  async respond(
    input: ManualToolReply | FunctionCallOutput | NativeQuestionReply,
  ): Promise<void> {
    this.checkCallbackOperation('respond to');
    if (arguments.length > 1)
      throw new TypeError(
        'respond accepts a manual reply without operation options',
      );
    if (isNativeQuestionReply(input)) {
      await this.submitNativeQuestion(input);
      return;
    }
    await this.submitManualInput(
      input as ManualToolReply | FunctionCallOutput,
      undefined,
      false,
    );
  }

  private steerRun(anchor: NativeTurn, input: JsonValue[]): Promise<void>;
  private steerRun(
    anchor: NativeTurn,
    input: JsonValue[],
    expectedTurnId: string,
  ): Promise<SteeringReceipt>;
  private async steerRun(
    anchor: NativeTurn,
    input: JsonValue[],
    expectedTurnId?: string,
  ): Promise<void | SteeringReceipt> {
    this.checkCallbackOperation('steer');
    for (;;) {
      const run = this.ownedStep(anchor);
      if (expectedTurnId !== undefined && run?.id !== expectedTurnId)
        throw markNativeErrorNotStarted(
          new StaleTurnError('Turn is no longer active'),
        );
      if (!run) throw new NativeError('Turn is no longer active');
      if (submissions.get(run)?.repair)
        throw new NativeError('Output repair cannot accept steering input');
      if (
        this.manualRestoring ||
        this.manualSealing ||
        run.controller.signal.aborted ||
        [...this.graphStops].some(
          (stop) =>
            stop.options.scope === 'thread_tree' ||
            stop.options.mode === 'force',
        )
      )
        throw new NativeError('Current turn cannot accept steering input');
      await run.accepted.promise;
      const tracingContext = await run.tracing?.context();
      if (this.ownedStep(anchor) !== run) {
        if (expectedTurnId !== undefined)
          throw markNativeErrorNotStarted(
            new StaleTurnError('Turn is no longer active'),
          );
        continue;
      }
      if (
        this.manualRestoring ||
        this.manualSealing ||
        run.controller.signal.aborted ||
        [...this.graphStops].some(
          (stop) =>
            stop.options.scope === 'thread_tree' ||
            stop.options.mode === 'force',
        )
      )
        throw new NativeError('Current turn cannot accept steering input');
      const receipt = decode(
        submissionSchema,
        await this.#native._submit(
          encode({
            mode: 'steer',
            expected_turn_id: run.id,
            input,
            ...(expectedTurnId !== undefined ? { exact_steering: true } : {}),
            ...(tracingContext ? { tracing_context: tracingContext } : {}),
          }),
        ),
      );
      if (receipt.status === 'not_submitted') {
        if (
          expectedTurnId !== undefined &&
          receipt.reason &&
          typeof receipt.reason === 'object' &&
          !Array.isArray(receipt.reason) &&
          ['no_active_turn', 'expected_turn_mismatch'].includes(
            String(receipt.reason.type),
          )
        )
          throw markNativeErrorNotStarted(
            new StaleTurnError('Turn is no longer active'),
          );
        throw markNativeErrorNotStarted(new TurnNotSubmitted(receipt.reason));
      }
      if (receipt.status !== 'steered' || receipt.turn_id !== run.id)
        throw new TurnNotSubmitted('Unexpected steering receipt');
      if (expectedTurnId === undefined) return;
      if (!receipt.input_id)
        throw new NativeError('Native steering input ID is unavailable');
      return Object.freeze({
        sessionId: this.id,
        submissionId: this.submissionIds.get(run)!,
        turnId: receipt.turn_id,
        inputId: receipt.input_id,
      });
    }
  }

  private submitManualInput(
    input: ManualToolReply | FunctionCallOutput,
    child?: { id: string; instanceId: string },
  ): Promise<Turn<unknown>>;
  private submitManualInput(
    input: ManualToolReply | FunctionCallOutput,
    child: undefined,
    returnHandle: false,
  ): Promise<void>;
  private async submitManualInput(
    input: ManualToolReply | FunctionCallOutput,
    child?: { id: string; instanceId: string },
    returnHandle = true,
  ): Promise<Turn<unknown> | void> {
    const matches = [...this.manualCalls.values()].filter((call) => {
      if (!call.ready || !call.grant.request()) return false;
      if (
        child &&
        (call.run instanceof NativeTurn || call.run.childId !== child.id)
      )
        return false;
      return isManualReply(input)
        ? call.grant.matchesReply(input)
        : call.grant.request()!.callId === input.call_id;
    });
    if (matches.length !== 1)
      throw new TypeError('Manual reply must identify one pending call');
    const call = matches[0];
    const request = call.grant.request()!;
    const run = call.run;
    if (returnHandle && run instanceof NativeTurn)
      this.requireDefaultOutput(run);
    const producer =
      run instanceof NativeTurn
        ? this.childObservationProducer
        : run.observationProducer;
    const native =
      run instanceof NativeTurn
        ? null
        : await this.childNativeTurn(
            run,
            () => new TypeError('Manual child reply is expired'),
          );
    if (
      !(run instanceof NativeTurn) &&
      (!native ||
        native.incarnation !== run.incarnation ||
        native.turn_id !== run.turnId ||
        (child && native.instance_id !== child.instanceId))
    )
      throw new TypeError('Manual child reply is expired');
    let reply: ManualToolReply;
    if (isManualReply(input)) reply = input;
    else {
      const value = z
        .object({
          type: z.literal('function_call_output'),
          call_id: z.string().min(1),
          output: z.string(),
        })
        .strict()
        .parse(input);
      const schema = manualResultSchema(call.tool);
      const text =
        schema &&
        typeof schema === 'object' &&
        !Array.isArray(schema) &&
        schema.type === 'string';
      reply = request.reply(text ? value.output : JSON.parse(value.output));
    }
    if (!(await this.#submitToolResult(reply)))
      throw new TypeError(
        'Manual reply is foreign, expired, or already delivered',
      );
    if (!returnHandle) return;
    return run instanceof NativeTurn
      ? this.#turnFor(run)
      : this.publicChildTurn(native!, producer);
  }

  wait(): Promise<Completed<OutputT>>;
  /** Capture the current logical root before waiting, including pending admission. */
  wait(
    options: RequestWaitOptions,
  ): Promise<Completed<OutputT> | PendingRequests<OutputT, string | null>>;
  wait(
    options: InteractionWaitOptions,
  ): Promise<
    Completed<OutputT> | PendingRequests<OutputT, string | null, Interaction>
  >;
  wait(
    options: AnyRequestWaitOptions,
  ): Promise<
    Completed<OutputT> | PendingRequests<OutputT, string | null, Interaction>
  >;
  async wait(
    options?: AnyRequestWaitOptions,
  ): Promise<
    Completed<OutputT> | PendingRequests<OutputT, string | null, Interaction>
  > {
    if (!this.lastRun) throw new NativeError('Submit input before waiting');
    const anchor = this.rootRun(this.lastRun);
    this.requireDefaultOutput(anchor);
    this.assertCanWait(anchor);
    if (options)
      return this.issuedTurn(anchor).wait(options) as Promise<
        | Completed<OutputT>
        | PendingRequests<OutputT, string | null, Interaction>
      >;
    await afterSubmissionRetirement(anchor, anchor.accepted.promise);
    return this.#turnFor(anchor).wait() as Promise<Completed<OutputT>>;
  }

  private canReturnRequests(owner: NativeTurn | ChildCallbackOwner): boolean {
    return (
      this.current(owner) &&
      (!(owner instanceof NativeTurn) || owner.id !== null) &&
      owner.failure === undefined &&
      !this.graphStops.size &&
      !this.manualSealing &&
      !this.manualSealed
    );
  }

  private canAnswerNativeQuestions(
    run: NativeTurn | ChildCallbackOwner,
  ): boolean {
    return (
      this.current(run) &&
      (run instanceof NativeTurn
        ? run.id !== null
        : run.observationProducer === this.childObservationProducer &&
          !run.observationProducer.ended) &&
      run.failure === undefined &&
      !this.manualSealing &&
      !this.manualSealed
    );
  }

  private nativeFormStopped(run: NativeTurn | ChildCallbackOwner): boolean {
    return [...this.graphStops].some(
      (stop) =>
        stop.run === run ||
        (!(run instanceof NativeTurn) && stop.options.scope === 'thread_tree'),
    );
  }

  private manualCurrent(event: NativeEvent): boolean {
    return this.#native._manual_tool_current(encodeReceipt(event.msg));
  }

  private pendingManual(owner: NativeTurn | ChildCallbackOwner): NativeEvent[] {
    return parseEvents(
      this.#native._pending_manual_tools(
        encodeReceipt({
          thread: owner instanceof NativeTurn ? this.id : owner.childId,
          instance: owner instanceof NativeTurn ? null : owner.incarnation,
          turnId: owner instanceof NativeTurn ? owner.id : owner.turnId,
        }),
      ),
    );
  }

  private async waitRequests<T, NativeId extends string | null>(
    turn: Turn<T, NativeId>,
    owner: () => NativeTurn | ChildCallbackOwner | undefined,
    { signal, until }: AnyRequestWaitOptions,
    completion: TurnCompletion<T>,
  ): Promise<Completed<T> | PendingRequests<T, NativeId, Interaction>> {
    const aborted = Promise.withResolvers<void>();
    const abort = () => aborted.resolve();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    try {
      for (;;) {
        const changed = this.observations.waitForChange();
        if (completion.outcome) return completion.promise;
        signal?.throwIfAborted();
        const current = owner();
        if (until === 'interaction' && current) {
          await this.refreshNativeQuestions(current);
          if (completion.outcome) return completion.promise;
          signal?.throwIfAborted();
        }
        if (
          until === 'interaction' &&
          current &&
          !this.canReturnRequests(current)
        ) {
          // A graceful sampling fence must not hide a decision needed by an
          // already entered tool. Force/failure/terminal still revoke grants.
          const requests = this.pendingNativeQuestions(current, true);
          if (requests.length)
            return Object.freeze({ turn, requests: Object.freeze(requests) });
        }
        if (current && this.canReturnRequests(current)) {
          let events: NativeEvent[];
          try {
            events = this.pendingManual(current);
          } catch (error) {
            if (this.canReturnRequests(current)) {
              current.failure ??= error;
              this.trackOwnedCallback(current, async () => {
                throw error;
              });
            }
            continue;
          }
          const admissions = events.flatMap((event) => {
            const pending = this.admitManualCall(current, event);
            return pending ? [pending] : [];
          });
          if (admissions.length) {
            await Promise.race([
              Promise.allSettled(admissions),
              aborted.promise,
            ]);
            // Admission awaited application code. Sample the whole native
            // batch again, reconciling expiry and validating any new siblings.
            continue;
          }
          if (owner() === current && this.canReturnRequests(current)) {
            const keys = new Set(
              events.map((event) => this.manualCallKey(event)),
            );
            let removed = false;
            for (const [key, call] of this.manualCalls) {
              if (call.run !== current) continue;
              if (keys.has(key) && this.manualCurrent(call.event)) continue;
              call.grant.deactivate();
              call.tracing = undefined;
              this.manualCalls.delete(key);
              removed = true;
            }
            if (removed) this.notifyManualProgress();
            const requests: Interaction[] = events.flatMap((event) => {
              const key = this.manualCallKey(event);
              const call =
                key === undefined ? undefined : this.manualCalls.get(key);
              if (!call || call.run !== current || !this.manualCurrent(event))
                return [];
              this.publishManualRequest(current, event);
              const request = call.grant.request();
              return request ? [request] : [];
            });
            if (until === 'interaction')
              requests.push(...this.pendingNativeQuestions(current, true));
            // No await separates the native snapshot, current grant checks,
            // ownership checks and public settlement check from publication.
            if (completion.outcome) return completion.promise;
            signal?.throwIfAborted();
            if (requests.length && this.canReturnRequests(current))
              return Object.freeze({ turn, requests: Object.freeze(requests) });
          }
        }
        await Promise.race([changed, aborted.promise]);
      }
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  async #waitResult(
    anchor: NativeTurn | null = this.lastRun,
  ): Promise<NativeRunResult> {
    if (!anchor) throw new NativeError('Submit input before waiting');
    let run = this.rootRun(anchor);
    for (;;) {
      this.assertCanWait(run);
      // Read the exact promise, never an Agent-owned wrapper that itself waits
      // for this Session. The edge exists before the predecessor settles.
      let result: NativeRunResult;
      try {
        result = await afterSubmissionRetirement(run, run.completion.promise);
      } catch (error) {
        const previous = submissions.get(run)?.previous;
        if (previous && continuationWasSuperseded(error))
          return afterSubmissionRetirement(
            previous,
            previous.completion.promise,
          );
        throw error;
      }
      const next: NativeTurn | undefined = submissions.get(run)?.next;
      if (!next) return result;
      try {
        await afterSubmissionRetirement(next, next.accepted.promise);
      } catch (error) {
        if (continuationWasSuperseded(error)) return result;
        throw error;
      }
      run = next;
    }
  }
  private get hasOperationMcp(): boolean {
    return this.openingMcpTools.some(
      (server) =>
        server instanceof HttpMCP && server.activation === 'operation',
    );
  }

  private async promoteMcp(run: NativeTurn): Promise<void> {
    if (!this.owns(run) || !this.isOpen || run.controller.signal.aborted)
      throw new TurnAborted('HTTP activation no longer owns this root');
    const names = run.selection?.names;
    const next = this.mcpBindings.flatMap((server) => {
      if (!(server instanceof HttpMCP) || server.activation !== 'operation')
        return this.defaultMcpTools.filter(
          (selected) => selected.name === server.name,
        );
      const tools =
        names === undefined
          ? (this.defaultMcpTools.find(
              (selected) => selected.name === server.name,
            )?.tools ?? [])
          : server.tools.filter((raw) => {
              const projected = mcpToolNames([
                { name: server.name, tools: [raw] },
              ])[0];
              return names.some(
                (name) =>
                  name.namespace === projected.namespace &&
                  name.name === projected.name,
              );
            });
      return tools.length ? [selectHttpLeaves(server, tools)] : [];
    });
    const config = encode(
      mcpConfig(
        next,
        this.environment ?? undefined,
        this.codeModeEnabled,
        this.mcpBindings,
      ),
    );
    if (
      config ===
      encode(
        mcpConfig(
          this.mcpTools,
          this.environment ?? undefined,
          this.codeModeEnabled,
          this.mcpBindings,
        ),
      )
    )
      return;
    const generation = this.mcpGeneration + 1n;
    const guarded = hasMcpPrePolicy(this.mcpTools) || hasMcpPrePolicy(next);
    const receipt = parseNative(
      await this.#native._replace_mcp_servers(
        config,
        mcpPolicies(next, generation),
        guarded ? encode(this.interceptionRules(next, generation)) : undefined,
      ),
    );
    checkMcpPublication(receipt, next, generation, this.mcpBindings);
    if (!this.owns(run) || !this.isOpen || run.controller.signal.aborted)
      throw new TurnAborted('HTTP activation no longer owns this root');
    this.mcpTools = next;
    this.mcpGeneration = generation;
  }

  private startTurn(
    input: string | JsonValue[],
    interactive = true,
    output = this.defaultOutput,
    outputOverride = false,
    selection?: OperationSelection,
    callerSignal?: AbortSignal,
    tracing?: TraceOptions,
    writableRoots?: readonly string[],
    parentTrace = this.options.parentTrace,
  ): NativeTurn {
    this.idle('submit');
    if (
      !interactive &&
      this.defaultTools.some((tool) => tool.kind === 'manual') &&
      !this.oneShot?.onRequiredAction &&
      !this.canCheckpointManual(output, selection)
    )
      throw new InteractionRequired();
    const roots =
      writableRoots === undefined
        ? undefined
        : captureWritableRoots(writableRoots);
    const run = this.allocateRun(output, outputOverride);
    run.parentTrace = parentTrace;
    run.writableRoots = roots;
    submissions.get(run)!.callerSignal =
      callerSignal ?? this.options.selectedModel?.callerSignal;
    run.selection = selection;
    run.tracing = this.captureRootTracing(tracing);
    this.dispatchStart(
      run,
      typeof input === 'string' ? [{ type: 'text', text: input }] : input,
    );
    return run;
  }

  private captureRootTracing(options?: TraceOptions): TraceCapture | undefined {
    return captureTracing(options, this.options.tracingCapture);
  }

  private async tracingContext(run: NativeTurn): Promise<string> {
    try {
      return await run.tracing!.context();
    } catch (error) {
      submissions.get(run)!.tracingAdmissionFailed = true;
      throw error;
    }
  }

  private dispatchStart(run: NativeTurn, parts: JsonValue[]): void {
    const { output } = submissions.get(run)!;
    const selection = run.selection;
    if (selection?.prepareRequest && output.repair)
      throw new TypeError(
        'prepareRequest does not support output correction attempts; use native output or prompted maxRetries: 0',
      );
    if (selection) selection.generation = this.catalog.generation;
    const wire = encode({
      ...(selection
        ? {
            selection: {
              generation: this.catalog.generation.toString(),
              names: selection.names ?? null,
              before_step:
                selection.beforeStep !== undefined ||
                selection.maxModelSteps !== undefined ||
                selection.budget !== undefined,
              prepare_request: selection.prepareRequest !== undefined,
            },
          }
        : {}),
      ...(run.parentTrace ? { trace: run.parentTrace.toHeaders() } : {}),
      mode: 'start_if_idle',
      ...(run.writableRoots === undefined
        ? {}
        : { writable_roots: run.writableRoots }),
      observation_submission_id: this.submissionIds.get(run)!,
      input: output.prompt
        ? [...parts, { type: 'text', text: output.prompt }]
        : parts,
      ...(output.schema === undefined
        ? {}
        : { start: { final_output_json_schema: output.schema } }),
    });
    // Active-only state never changes when another root merely registers.
    this.manualCheckpointRun = run;
    this.dispatchRun(
      run,
      () => {
        if (!run.tracing) return this.#native._submit(wire);
        return this.tracingContext(run).then((context) => {
          if (!this.owns(run) || !this.isOpen || run.controller.signal.aborted)
            throw new TurnAborted(
              'Tracing admission stopped before native submission',
            );
          return this.#native._submit(
            JSON.stringify({ ...JSON.parse(wire), tracing_context: context }),
          );
        });
      },
      this.hasOperationMcp,
    );
  }

  private allocateRun(
    output = this.defaultOutput,
    outputOverride = false,
  ): NativeTurn {
    if (this.options.localStorage && output.repair)
      throw new TypeError('Local storage does not support output repair');
    const run = new NativeTurn(() => this.assertCanWait(run));
    submissions.set(run, { output, outputOverride, observation: 'open' });
    void run.completion.promise.then(
      () => run.tracing?.finish(),
      (error: unknown) =>
        run.tracing?.finish(
          error ?? null,
          error instanceof TurnAborted,
          error instanceof OutputValidationError
            ? 'validation_error'
            : error instanceof NativeError
              ? 'provider_error'
              : 'operation_error',
        ),
    );
    this.submissionIds.set(run, randomUUID());
    this.registerRequestObservationRoute(run);
    return run;
  }

  private registerRequestObservationRoute(run: NativeTurn): void {
    const routeId = this.submissionIds.get(run)!;
    this.requestObservationRoutes.set(routeId, run);
    const retire = () => {
      this.requestObservationRoutes.delete(routeId);
    };
    run.completion.promise.then(retire, retire);
  }

  private begin(
    submit: (run: NativeTurn, tracingContext?: string) => Promise<string>,
    output = this.defaultOutput,
    outputOverride = false,
    selection?: OperationSelection,
    tracing?: TraceOptions,
    continuedFrom?: NativeTurn,
  ): NativeTurn {
    const run = this.allocateRun(output, outputOverride);
    run.selection = selection;
    // A retained continuation is the same admitted operation, not a new root.
    run.tracing = continuedFrom
      ? continuedFrom.tracing
      : this.captureRootTracing(tracing);
    if (continuedFrom) continuedFrom.tracing = undefined;
    this.dispatchRun(run, () => {
      if (!run.tracing) return submit(run);
      return this.tracingContext(run).then((context) => {
        if (!this.owns(run) || !this.isOpen || run.controller.signal.aborted)
          throw new TurnAborted(
            'Tracing admission stopped before native submission',
          );
        return submit(run, context);
      });
    });
    return run;
  }

  private dispatchRun(
    run: NativeTurn,
    submit: () => Promise<string>,
    activateMcp = false,
  ): void {
    this.lifecycle = { kind: 'turn', run };
    this.lastRun = run;
    this.options.selectedModel?.accepted(run.accepted.promise);
    // Own synchronous bridge errors through the same admission failure path.
    let submission: Promise<string>;
    try {
      if (activateMcp) {
        run.mcpPublication = this.promoteMcp(run);
        run.mcpPublication.catch(() => {});
        submission = run.mcpPublication.then(() => {
          if (
            !this.owns(run) ||
            !this.isOpen ||
            run.controller.signal.aborted ||
            this.graphStops.size
          )
            throw new TurnAborted(
              'HTTP activation stopped before native submission',
            );
          return submit();
        });
      } else submission = submit();
    } catch (error) {
      submission = Promise.reject(error);
    }
    let rejectedBeforeAdmission = false;
    submission
      .then(
        (wire) => {
          // Close can retire this exact dispatch before its receipt arrives.
          if (!this.owns(run) || !this.isOpen) return;
          const accepted = decode(submissionSchema, wire);
          if (accepted.status === 'not_submitted')
            throw markNativeErrorNotStarted(
              new TurnNotSubmitted(accepted.reason),
            );
          run.id = accepted.turn_id;
          this.changedExecutorRoots ||= run.writableRoots !== undefined;
          this.#turnFor(run);
          this.observations.append({
            type: 'turn_started',
            turnId: run.id,
            submissionId: this.submissionIds.get(run)!,
          });
          run.accepted.resolve(accepted);
          for (const event of run.pending.splice(0)) this.process(run, event);
        },
        (error: unknown) => {
          // _submit reserves InvalidArg for native guards before Core
          // dispatch. Receipt decoding failures require retiring the Session.
          rejectedBeforeAdmission =
            submissions.get(run)!.tracingAdmissionFailed === true ||
            (error instanceof Error &&
              'code' in error &&
              error.code === 'InvalidArg' &&
              !activateMcp);
          throw error;
        },
      )
      .catch((error: unknown) => {
        if (
          this.owns(run) &&
          run.id === null &&
          !rejectedBeforeAdmission &&
          !(error instanceof TurnNotSubmitted)
        ) {
          // Keep the exact run attached through native shutdown. finish()
          // would advertise idle and could checkpoint still-running work.
          run.failure = error;
          const retirement = this.close().then(
            () => {
              throw error;
            },
            (cleanupError: unknown) => {
              if (cleanupError === error) throw error;
              throw new AggregateError(
                [error, cleanupError],
                'Native submission failed and its owned cleanup failed',
                { cause: error },
              );
            },
          );
          submissions.get(run)!.retirement = retirement;
          retirement.catch(() => {});
        } else {
          this.finish(run, error);
        }
      });
  }

  private closeCorrection(repair: OutputRepair): Promise<void> {
    if (!repair.session) return Promise.resolve();
    if (repair.cleanup) return repair.cleanup;
    const session = repair.session;
    repair.cleanup = session
      .close()
      .then(() => {
        repair.session = undefined;
        repair.run = undefined;
      })
      .finally(() => {
        repair.cleanup = undefined;
      });
    return repair.cleanup;
  }

  private stopCorrection(
    repair: OutputRepair,
    mode: 'force' | 'graceful',
  ): void {
    if (repair.stop !== 'force') repair.stop = mode;
    if (mode === 'force' && repair.session && repair.run)
      // The correction Session's close owner joins this same stop and reports cleanup.
      void repair.session.cancelTurn(repair.run, 'force').catch(() => {});
  }

  private startOutputRepair(run: NativeTurn, output: string): void {
    const submission = submissions.get(run)!;
    const repair: OutputRepair = {
      completion: Promise.resolve(),
      finished: false,
    };
    submission.repair = repair;
    for (const stop of this.graphStops)
      if (stop.run === run) this.stopCorrection(repair, stop.options.mode);
    const abort = () => this.stopCorrection(repair, 'force');
    run.controller.signal.addEventListener('abort', abort, { once: true });
    repair.completion = Promise.resolve().then(async () => {
      let failure: unknown;
      try {
        this.decodedOutputs.set(
          run,
          await (run.tracing
            ? run.tracing.run('host.output_repair', 'validation', () =>
                this.repairOutput(run, repair, output),
              )
            : this.repairOutput(run, repair, output)),
        );
      } catch (error) {
        failure = run.failure ?? error;
      } finally {
        repair.finished = true;
        run.controller.signal.removeEventListener('abort', abort);
      }
      if (repair.session || repair.opening?.failedOpeningCleanup) {
        // A failed close retains its exact Session for the parent's next close.
        const error =
          failure ?? new NativeError('Output repair cleanup is incomplete');
        this.retire(error);
        throw error;
      }
      this.finish(run, run.failure ?? failure, output);
    });
    repair.completion.catch(() => {});
  }

  private async repairOutput(
    run: NativeTurn,
    repair: OutputRepair,
    text: string,
  ): Promise<unknown> {
    const prepared = submissions.get(run)!.output;
    const check = (opening = false) => {
      if (run.failure !== undefined) throw run.failure;
      if (
        !this.owns(run) ||
        run.controller.signal.aborted ||
        repair.stop === 'force' ||
        (opening && repair.stop === 'graceful')
      )
        throw new TurnAborted('Output repair stopped');
    };
    check(true);
    const history = await this.#readHistory();
    check(true);
    const settingsEvent = history
      .toReversed()
      .find(
        (row) =>
          row.type === 'event_msg' &&
          row.payload.type === 'thread_settings_applied' &&
          row.payload.thread_id === this.id,
      );
    const accepted = jsonObject.safeParse(
      settingsEvent?.payload.thread_settings,
    );
    if (
      !accepted.success ||
      typeof accepted.data.model !== 'string' ||
      !accepted.data.model
    )
      throw new NativeError(
        'Native history does not contain accepted model settings for repair',
      );
    const captured = accepted.data;
    const settings: ModelSettings = {};
    if (captured.reasoning_effort != null)
      settings.reasoningEffort =
        captured.reasoning_effort as ModelSettings['reasoningEffort'];
    if (captured.reasoning_summary != null)
      settings.reasoningSummary =
        captured.reasoning_summary as ModelSettings['reasoningSummary'];
    if (captured.service_tier !== undefined)
      settings.serviceTier =
        captured.service_tier as ModelSettings['serviceTier'];
    const open = this.options.openCorrection;
    if (!open)
      throw new NativeError('This Session does not support output repair');
    for (let index = 0; index < prepared.repair!.maxRetries; index++) {
      check(true);
      repair.session = await open(
        accepted.data.model,
        settings,
        (owner) => {
          repair.opening = owner;
        },
        run.parentTrace,
      );
      repair.opening = undefined;
      const correction = repair.session;
      // A correction uses the owning session's model provider and reports into
      // the same live snapshot in the order its response headers arrive.
      correction.apiRateLimitState = this.apiRateLimitState;
      correction.observations.linkRepairParent(
        this.observations,
        this.submissionIds.get(run)!,
      );
      let possiblyAdmitted = false;
      let result: NativeRunResult | undefined;
      let failure: unknown;
      try {
        check(true);
        // startTurn checks the live Session before invoking native admission.
        repair.run = correction.startTurn(
          JSON.stringify({
            schema: prepared.repair!.schema,
            invalid_output: text,
          }),
          true,
          correction.defaultOutput,
          false,
          correction.captureSelection(
            undefined,
            correction.defaultOutput,
            run.selection?.budget,
          ),
        );
        possiblyAdmitted = true;
        result = await repair.run.wait();
      } catch (error) {
        failure = error;
        if (
          repair.run?.id === null &&
          (error instanceof TurnNotSubmitted ||
            (error instanceof Error &&
              'code' in error &&
              error.code === 'InvalidArg'))
        )
          possiblyAdmitted = false;
      }
      if (possiblyAdmitted) {
        try {
          const recorded = projectHistory(
            await correction.#readHistory(),
            correction.id,
          );
          if (
            !recorded.turns.length ||
            recorded.turns.some(
              (turn) =>
                turn.status === 'in_progress' || turn.subagentId !== null,
            )
          )
            throw new NativeError('Output repair history is incomplete');
          for (const turn of recorded.turns)
            this.repairTurns.push({
              ...recordedTurnToWire(turn),
              subagentId: null,
              status: turn.status as RepairTurnWire['status'],
              parentSessionId: this.id,
              parentTurnId: run.id!,
            });
          for (const { data: _data, ...item } of recorded.items)
            this.repairItems.push({
              parentSessionId: this.id,
              parentTurnId: run.id!,
              sessionId: correction.id,
              item,
            });
        } catch (error) {
          this.repairReceiptsIncomplete = true;
          failure ??= error;
        }
      }
      try {
        await this.closeCorrection(repair);
      } catch (error) {
        throw failure === undefined
          ? error
          : new AggregateError(
              [failure, error],
              'Output repair failed and cleanup is incomplete',
              { cause: failure },
            );
      }
      check();
      if (failure !== undefined) throw failure;
      text = result!.finalOutput;
      try {
        return prepared.parse!(text);
      } catch (error) {
        if (!(error instanceof OutputValidationError)) throw error;
      }
    }
    throw new OutputValidationError(text);
  }

  private finish(
    run: NativeTurn,
    error?: unknown,
    output = '',
    unsampledSteering = false,
  ): void {
    if (this.lifecycle.kind !== 'turn' || this.lifecycle.run !== run) return;
    submissions.get(run)!.observation = 'finishing';
    this.retireNativeQuestions(run);
    if (run.manualReplies.size > 0) {
      void Promise.allSettled([...run.manualReplies]).then(() =>
        this.finish(run, run.failure ?? error, output, unsampledSteering),
      );
      return;
    }
    if (run.callbacks.size > 0) {
      if (error !== undefined) run.controller.abort(error);
      void Promise.allSettled([...run.callbacks]).then(() =>
        this.finish(run, run.failure ?? error, output, unsampledSteering),
      );
      return;
    }
    if (run.toolInvocations.size > 0) {
      run.controller.abort(error);
      void Promise.allSettled([
        ...run.toolInvocations,
        ...run.manualReplies,
      ]).then(() => this.finish(run, error, output, unsampledSteering));
      return;
    }
    error = cleanupFailure(run, error);
    if (run.toolCleanupErrors.length) {
      this.retire(error);
      void this.close().catch(() => {});
      return;
    }
    const submission = submissions.get(run);
    if (submission?.repair && !submission.repair.finished) {
      if (error !== undefined) {
        run.failure ??= error;
        run.controller.abort(error);
      }
      return;
    }
    if (
      error === undefined &&
      submission?.output.parse &&
      !submission?.compaction &&
      !this.decodedOutputs.has(run)
    ) {
      try {
        this.decodedOutputs.set(
          run,
          run.tracing
            ? run.tracing.validate(() => submission.output.parse!(output))
            : submission.output.parse(output),
        );
      } catch (cause) {
        if (
          cause instanceof OutputValidationError &&
          submission.output.repair &&
          !unsampledSteering
        ) {
          this.startOutputRepair(run, output);
          return;
        }
        error = cause;
      }
    }
    const retained =
      unsampledSteering &&
      this.threadOptions._managed_instructions === true &&
      run.id !== null &&
      submission !== undefined;
    if (error === undefined && retained) {
      // Abort listeners run synchronously and may cancel or close this Session.
      // Keep the original owner until they finish, then recheck admission.
      run.controller.abort();
      if (!this.owns(run)) return;
      if (submission?.cancelled) {
        error = new NativeError(
          'Accepted steering input remains in history after interruption',
        );
      }
    }
    const continueRetained = error === undefined && retained;
    run.failure = error;
    if (submission?.previous && continuationWasSuperseded(error))
      this.lastRun = submission.previous;

    this.clearManualCalls(run);
    run.controller.abort(error);
    if (!this.owns(run)) return;
    if (continueRetained && (submission?.cancelled || this.graphStops.size)) {
      error = new NativeError(
        'Accepted steering input remains in history after interruption',
      );
      run.failure = error;
    }
    try {
      this.lifecycle = { kind: 'idle' };
      if (error === undefined && continueRetained && submission) {
        // Reserve the next Session lifecycle before the first receipt resolves.
        // Native still decides admission from the exact managed Turn, never from
        // this event hint. Input is already in history and is not resubmitted.
        const next = this.begin(
          (nextRun, tracingContext) =>
            this.#native._submit(
              encode({
                ...(tracingContext ? { tracing_context: tracingContext } : {}),
                input: [],
                mode: 'continue_if_idle',
                ...(run.parentTrace
                  ? { trace: run.parentTrace.toHeaders() }
                  : {}),
                observation_submission_id: this.submissionIds.get(nextRun)!,
                expected_previous_turn_id: run.id,
                ...(submission.output.schema === undefined
                  ? {}
                  : {
                      start: {
                        final_output_json_schema: submission.output.schema,
                      },
                    }),
              }),
            ),
          submission.output,
          submission.outputOverride,
          run.selection,
          undefined,
          run,
        );
        next.parentTrace = run.parentTrace;
        submission.next = next;
        const successor = submissions.get(next)!;
        successor.previous = run;
        if (this.manualCheckpointRun === run) this.manualCheckpointRun = next;
      }
      if (run.id)
        this.observations.append({
          type: 'turn_finished',
          turnId: run.id,
          submissionId: this.submissionIds.get(run)!,
          status:
            error === undefined
              ? 'completed'
              : error instanceof TurnAborted
                ? 'cancelled'
                : 'failed',
          errorType: error instanceof Error ? error.name : null,
        });
      this.drainPending();
      if (error !== undefined) {
        run.accepted.reject(error);
        run.completion.reject(error);
      } else if (run.id !== null) {
        run.completion.resolve({
          finalOutput: output,
          turnId: run.id,
          usage: run.usage,
        });
      } else {
        const missing = new NativeError(
          'Native turn completed without an admitted turn ID',
        );
        run.accepted.reject(missing);
        run.completion.reject(missing);
      }
    } finally {
      this.finishObservation(run);
    }
  }
  private async readEvents(): Promise<void> {
    const native = this.#native;
    const producer = this.childObservationProducer;
    let batch: string[] = [];
    let batchIndex = 0;
    try {
      while (this.isOpen && this.#native === native) {
        let event: NativeEvent;
        try {
          if (batchIndex === batch.length) {
            batch = await native._next_session_events();
            batchIndex = 0;
            if (batch.length === 0)
              throw new NativeError('Native event batch was empty');
          }
          const raw = batch[batchIndex++]!;
          event = parseEvent(raw);
          if (event.msg.type === 'elicitation_request') {
            // The generic event schema drops prototype-named record keys.
            // Preserve raw form data; prepareNativeForm validates it separately.
            this.nativeQuestionSources.set(event, parseNativeQuestion(raw));
          }
        } catch (error) {
          // Suspension joins and retires Core. Its reader can close before the
          // shutdown event arrives; manual sealing owns the suspension outcome.
          if (this.manualSuspending || this.replacingNative === native) return;
          throw error;
        }
        if (!this.isOpen || this.#native !== native) return;
        const msg = event.msg;
        if (msg.type === 'token_count') {
          const snapshot = apiRateLimits(msg.api_rate_limits);
          if (snapshot) this.apiRateLimitState.snapshot = snapshot;
        }
        if (msg.type === '_sdk_request_metadata') {
          const route =
            typeof msg.submission_id === 'string'
              ? this.requestObservationRoutes.get(msg.submission_id)
              : undefined;
          if (route) {
            if (route.id === null) route.pending.push(event);
            else this.observeRequestMetadata(route, event);
          }
          continue;
        }
        const run = this.lifecycle.kind === 'turn' ? this.lifecycle.run : null;
        if (msg.type === 'elicitation_status') {
          await this.observeNativeUrlStatus(native, event);
          continue;
        }
        if (
          event.subagent_id === undefined &&
          event.subagent_incarnation === undefined &&
          event.subagent_instance_id === undefined &&
          msg.type === 'warning' &&
          typeof msg.message === 'string'
        ) {
          this.observations.append({ type: 'warning', message: msg.message });
          continue;
        }
        if (!event.subagent_id && msg.type === 'shutdown_complete') {
          // Core has stopped these controls before publishing ShutdownComplete.
          // Cancel their idle readers too, including after a manual suspension.
          if (
            this.options.nativeAgents ||
            this.options.mcpTools ||
            (this.environment !== null && hasExecutorPolicy(this.environment))
          )
            native._revoke_native_interception();
          if (this.mcpReaderStarted) native._revoke_native_mcp_results();
        }
        if (msg.type === 'sdk_mcp_publication_boundary') {
          const boundary = this.starting?.boundary;
          if (!boundary || event.id !== boundary.id)
            throw new NativeError('Unexpected native publication boundary');
          boundary.observed.resolve();
          continue;
        }
        const question = [
          'exec_approval_request',
          'apply_patch_approval_request',
          'elicitation_request',
          'request_user_input',
          'request_permissions',
        ].includes(msg.type);
        if (this.starting && (question || msg.type === 'shutdown_complete')) {
          this.failStartup(
            question
              ? new InteractionRequired()
              : new NativeError('Native session shut down while opening'),
          );
          return;
        }
        if (
          question &&
          (event.subagent_id !== undefined ||
            event.subagent_incarnation !== undefined ||
            event.subagent_instance_id !== undefined) &&
          !(event.subagent_id && event.subagent_incarnation)
        )
          throw new InteractionRequired();
        if (question && !run && !event.subagent_id) {
          if (msg.type !== 'elicitation_request')
            throw new InteractionRequired();
          await native._respond_native_question(
            this.declineQuestionWire(event),
          );
          continue;
        }
        if (msg.type === 'sdk_subagent_lifecycle') {
          const lifecycle = z
            .object({
              subagent_id: z.string(),
              parent_agent_id: z.string(),
              status: z.string(),
              kind: z.enum(['created', 'active', 'closed', 'snapshot']),
            })
            .parse(msg);
          this.observations.append({
            type: 'subagent_lifecycle',
            subagentId: lifecycle.subagent_id,
            parentAgentId: lifecycle.parent_agent_id,
            status: lifecycle.status,
            kind: lifecycle.kind,
          });
          continue;
        }
        if (!event.subagent_id && msg.type === 'shutdown_complete') {
          if (this.manualSuspending || this.replacingNative === native) return;
          // A raw native suspension can stop the thread without a turn terminal.
          // Retire rather than persist an idle checkpoint after native is gone.
          this.retire(new NativeError('Native session shut down'));
          void this.close().catch(() => {});
          return;
        }
        if (
          event.subagent_id &&
          (event.subagent_incarnation || msg.type === 'shutdown_complete')
        ) {
          this.processChild(event, native, producer);
          continue;
        }
        if (!run) {
          this.observeRootItem(event);
          continue;
        }
        if (this.manualSuspending) {
          // A manual seal can refuse while an automatic request is queued.
          // Keep those events until native confirms that it suspended the turn.
          if (this.manualSealing) {
            if (
              msg.type === 'raw_response_completed' ||
              msg.type === 'token_count'
            )
              this.process(run, event);
            else run.pending.push(event);
          }
          continue;
        }
        if (run.id === null) run.pending.push(event);
        else this.process(run, event);
      }
    } finally {
      // Release callbacks waiting for this reader before auxiliary readers
      // join their callback work during replacement, suspension, or close.
      producer.eventReaderEnded = true;
      this.observations.notify();
      // Retire receipts from this native owner, without closing the new one.
      native._finish_child_event_reader();
    }
  }

  private childOwner(
    id: string,
    incarnation: string,
    turnId: string,
    producer: ChildObservationProducer,
    instanceId?: string,
  ): ChildCallbackOwner {
    const owner = this.childCallbacks.owner(
      id,
      incarnation,
      turnId,
      producer,
      instanceId,
    );
    if (
      owner.observationPhase === 'open' &&
      !this.observedChildTurns.has(owner)
    ) {
      this.observedChildTurns.add(owner);
      this.observations.append({
        type: 'turn_started',
        turnId,
        submissionId: `child:${id}:${incarnation}:${turnId}`,
      });
    }
    return owner;
  }

  private workflowForTrace(
    traceId: string,
    workflowSpanId: string,
  ): TraceSpan | undefined {
    const current =
      this.lifecycle.kind === 'turn'
        ? this.lifecycle.run.tracing?.workflow
        : this.lastRun?.tracing?.workflow;
    if (
      current?.context.traceId === traceId &&
      current.context.spanId === workflowSpanId
    )
      return current;
    // Issued turns already retain exact result owners, including completed and
    // retained steps. A child may first reach JS after a later root starts.
    for (const run of this.issuedRuns.values()) {
      const workflow = (run.issuedTracing ?? run.tracing)?.workflow;
      if (
        workflow?.context.traceId === traceId &&
        workflow.context.spanId === workflowSpanId
      )
        return workflow;
    }
    const opening = this.options.tracingCapture?.workflow;
    return opening?.context.traceId === traceId &&
      opening.context.spanId === workflowSpanId
      ? opening
      : undefined;
  }

  private processChild(
    event: NativeEvent,
    native: NativeThread,
    producer: ChildObservationProducer,
  ): void {
    const id = event.subagent_id;
    const incarnation = event.subagent_incarnation;
    if (!id) return;
    const msg = event.msg;
    if (msg.type === 'shutdown_complete') {
      if (incarnation) {
        this.childCallbacks.end(id, incarnation);
        this.clearManualCalls();
      }
      this.retireChildObservations(
        producer,
        (owner) =>
          owner.childId === id &&
          (incarnation
            ? owner.incarnation === incarnation
            : event.subagent_instance_id !== undefined &&
              owner.instanceId === event.subagent_instance_id),
      );
      return;
    }
    if (!incarnation) return;
    const turnId =
      msg.turn_id ??
      msg.turnId ??
      ([
        'task_complete',
        'turn_complete',
        'turn_aborted',
        'token_count',
        'hosted_tool_call_progress',
      ].includes(msg.type)
        ? event.id
        : undefined);
    if (typeof turnId !== 'string') return;
    if (msg.type === 'hosted_tool_call_progress') {
      const owner = this.childCallbacks.find(id, incarnation, turnId);
      if (
        owner &&
        owner.observationPhase !== 'ended' &&
        (!owner.instanceId || owner.instanceId === event.subagent_instance_id)
      )
        this.observeHostedProgress(
          event,
          turnId,
          `child:${id}:${incarnation}:${turnId}`,
          id,
        );
    }
    if (msg.type === 'item_completed' && msg.thread_id === id) {
      const item = projectExecutionItem(msg.item, turnId, id);
      const searchItem = item
        ? undefined
        : projectSearchItem(msg.item, turnId, id);
      const hostedItem = projectNativeHostedToolItem(msg.item, turnId);
      if (item || searchItem || hostedItem) {
        const owner = this.childCallbacks.find(id, incarnation, turnId);
        if (
          owner &&
          owner.observationPhase !== 'ended' &&
          (!owner.instanceId || owner.instanceId === event.subagent_instance_id)
        ) {
          const submissionId = `child:${id}:${incarnation}:${turnId}`;
          if (hostedItem)
            this.observations.append({
              type: 'hosted_tool_item_completed',
              turnId,
              submissionId,
              item: hostedItem,
            });
          if (item)
            this.observations.append({
              type: 'execution_item_completed',
              turnId,
              submissionId,
              item,
            });
          else if (searchItem)
            this.observations.append({
              type: 'search_item_completed',
              turnId,
              submissionId,
              item: searchItem,
            });
        } else {
          this.observations.gap();
        }
        return;
      }
    }
    const startsTurn =
      msg.type === 'task_started' || msg.type === 'turn_started';
    if (startsTurn)
      this.retireChildObservations(
        producer,
        (owner) =>
          owner.childId === id &&
          owner.incarnation === incarnation &&
          owner.nativeStartObserved &&
          owner.turnId !== turnId,
      );
    const owner =
      msg.type === 'token_count'
        ? this.childCallbacks.find(id, incarnation, turnId)
        : this.childOwner(
            id,
            incarnation,
            turnId,
            producer,
            event.subagent_instance_id,
          );
    if (!owner) return;
    // An acknowledged future turn can exist before an older start is read.
    // Only starts from this ordered reader establish prior-turn ownership.
    if (startsTurn) {
      owner.nativeStartObserved = true;
      this.observations.notify();
    }
    owner.instanceId ??= event.subagent_instance_id;
    const submissionId = `child:${id}:${incarnation}:${turnId}`;
    if (msg.type === 'token_count')
      this.observeTokenCount(event, turnId, submissionId);
    if (
      msg.type === 'agent_message_content_delta' &&
      msg.thread_id === id &&
      typeof msg.item_id === 'string' &&
      typeof msg.delta === 'string'
    )
      this.observations.append({
        type: 'output_text_delta',
        turnId,
        submissionId,
        itemId: msg.item_id,
        delta: msg.delta,
      });
    if (
      msg.type === 'item_completed' &&
      msg.thread_id === id &&
      msg.item &&
      typeof msg.item === 'object' &&
      !Array.isArray(msg.item) &&
      msg.item.type === 'ContextCompaction' &&
      typeof msg.item.id === 'string'
    )
      this.observations.append({
        type: 'context_compacted',
        turnId,
        submissionId,
        itemId: msg.item.id,
      });
    if (
      msg.type === 'turn_complete' ||
      msg.type === 'task_complete' ||
      msg.type === 'turn_aborted'
    ) {
      if (owner.observationPhase !== 'open') return;
      owner.observationPhase = 'finishing';
      this.childCallbacks.end(id, incarnation, turnId);
      this.clearManualCalls();
      const continuation = (async () => {
        try {
          try {
            await this.childCallbacks.drain(id, incarnation, turnId);
          } catch (error) {
            this.observations.append({
              type: 'turn_finished',
              turnId,
              submissionId,
              status: 'failed',
              errorType: error instanceof Error ? error.name : null,
            });
            return;
          }
          this.observations.append({
            type: 'turn_finished',
            turnId,
            submissionId,
            status:
              msg.type === 'turn_aborted'
                ? 'cancelled'
                : event.subagent_turn_failed === false
                  ? 'completed'
                  : 'failed',
            ...(msg.type !== 'turn_aborted' &&
            event.subagent_turn_failed !== false
              ? { errorType: 'NativeError' }
              : {}),
          });
        } finally {
          owner.observationPhase = 'ended';
          this.observations.notify();
        }
        if (!this.isOpen || !this.options.nativeAgents) return;
        const current = await native._child_turn(id);
        if (
          !current ||
          current.incarnation !== incarnation ||
          current.turn_id !== turnId
        )
          return;
        const next = await current._continue();
        if (next) this.publicChildTurn(next, producer);
      })();
      this.childContinuations.add(continuation);
      void continuation
        .catch((error) => {
          if (this.isOpen) this.readerFailed(error);
        })
        .finally(() => this.childContinuations.delete(continuation));
      return;
    }
    if (
      [...this.graphStops].some(
        (stop) =>
          stop.options.scope === 'thread_tree' && stop.options.mode === 'force',
      )
    ) {
      this.childCallbacks.end(id, incarnation, turnId);
      return;
    }
    if (msg.type === '_sdk_select_step') {
      if (this.current(owner))
        void this.selectChildStep(owner, event, native).catch(() => {});
      return;
    }
    if (
      msg.type === 'mcp_tool_call_begin' ||
      msg.type === 'mcp_tool_call_end'
    ) {
      this.observeMcp(owner, event);
      return;
    }
    if (
      [
        'exec_approval_request',
        'apply_patch_approval_request',
        'elicitation_request',
      ].includes(msg.type)
    ) {
      if (owner.observationProducer !== producer || this.#native !== native)
        return;
      void this.trackNativeQuestion(owner, event).catch(() => {});
      return;
    }
    if (!requestTypes.has(msg.type)) return;
    if (!this.current(owner)) return;
    const callId = typeof msg.callId === 'string' ? msg.callId : event.id;
    const manualKey = this.manualCallKey(event);
    if (manualKey !== undefined) {
      const admission = this.admitManualCall(owner, event);
      if (admission)
        void admission.then(
          () => this.publishManualRequest(owner, event),
          () => {},
        );
      return;
    }
    const callKey = msg.type + ':' + callId;
    if (owner.calls.has(callKey)) return;
    owner.calls.add(callKey);
    this.childCallbacks.track(
      owner,
      async () => {
        const scope = { session: this, child: owner, active: true };
        try {
          await toolInvocation.run(scope, () =>
            this.handleChildRequest(owner, event),
          );
        } finally {
          scope.active = false;
        }
      },
      async () => {
        if (msg._sdk_python_tool)
          await native._cancel_child_callback(encodeReceipt(msg));
        else {
          const turn = await native._child_turn(id);
          if (turn?.incarnation === incarnation && turn.turn_id === turnId)
            await turn.cancel();
        }
      },
    );
  }
  private observeMcp(
    owner: NativeTurn | ChildCallbackOwner,
    event: NativeEvent,
  ): void {
    if (!this.current(owner)) return;
    const msg = event.msg;
    const invocation = msg.invocation;
    if (
      typeof msg.call_id !== 'string' ||
      !invocation ||
      typeof invocation !== 'object' ||
      Array.isArray(invocation) ||
      typeof invocation.server !== 'string' ||
      typeof invocation.tool !== 'string'
    )
      return;
    if (owner instanceof NativeTurn) {
      if (
        !msg.call_id ||
        msg.turn_id !== owner.id ||
        event.subagent_id !== undefined ||
        event.subagent_incarnation !== undefined ||
        event.subagent_instance_id !== undefined ||
        !this.mcpTools.some(
          (server) =>
            server.name === invocation.server &&
            server.tools.includes(invocation.tool as string),
        )
      )
        return;
    }
    if (!(owner instanceof NativeTurn)) {
      const key = msg.type + ':' + msg.call_id;
      if (owner.calls.has(key)) return;
      owner.calls.add(key);
      if (
        msg.turn_id !== owner.turnId ||
        event.subagent_id !== owner.childId ||
        event.subagent_incarnation !== owner.incarnation
      )
        return;
    }
    {
      const calls =
        this.nativeMcpCalls.get(owner) ??
        new Map<string, { server: string; tool: string }>();
      this.nativeMcpCalls.set(owner, calls);
      if (msg.type === 'mcp_tool_call_begin') {
        if (calls.has(msg.call_id)) {
          const error = new InteractionRequired();
          owner.failure ??= error;
          void this.trackOwnedCallback(owner, async () => {
            throw error;
          }).catch(() => {});
          return;
        }
        calls.set(msg.call_id, {
          server: invocation.server,
          tool: invocation.tool,
        });
      } else if (
        calls.get(msg.call_id)?.server === invocation.server &&
        calls.get(msg.call_id)?.tool === invocation.tool
      ) {
        calls.delete(msg.call_id);
        for (const [request, record] of this.nativeQuestions) {
          if (record.run === owner && record.mcpCallId === msg.call_id) {
            record.grant.deactivate();
            this.nativeQuestions.delete(request);
          }
        }
        this.observations.notify();
      }
    }
    const identity: ToolIdentity = {
      callId: msg.call_id,
      toolName: invocation.tool,
      namespace: invocation.server,
      family: 'mcp',
    };
    if (msg.type === 'mcp_tool_call_begin')
      this.observeToolStart(owner, identity);
    else {
      const result = msg.result;
      const ok =
        result && typeof result === 'object' && !Array.isArray(result)
          ? result.Ok
          : null;
      this.observeToolEnd(
        owner,
        identity,
        ok &&
          typeof ok === 'object' &&
          !Array.isArray(ok) &&
          ok.isError !== true
          ? 'completed'
          : 'failed',
      );
    }
  }
  private async handleChildRequest(
    owner: ChildCallbackOwner,
    event: NativeEvent,
  ): Promise<void> {
    await this.handleRequest(owner, event);
  }

  private observeTokenCount(
    event: NativeEvent,
    turnId: string,
    submissionId: string,
  ): boolean {
    const { msg } = event;
    if (msg.api_rate_limits !== undefined) {
      const snapshot = apiRateLimits(msg.api_rate_limits);
      if (snapshot && event.id === turnId)
        this.observations.append({
          type: 'api_rate_limits_updated',
          turnId,
          submissionId,
          snapshot,
        });
      // A header-only notification carries neither usage nor managed limits.
      if (msg.info == null && msg.rate_limits == null) return false;
    }
    this.observations.append({
      type: 'usage_updated',
      turnId,
      submissionId,
      usage: tokenUsageInfo(msg.info),
    });
    return true;
  }

  private observeHostedProgress(
    event: NativeEvent,
    turnId: string,
    submissionId: string,
    threadId: string,
  ): void {
    const raw = event.msg.event;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return;
    this.observations.append({
      type: 'hosted_tool_call_progress',
      turnId,
      submissionId,
      threadId,
      itemId: typeof raw.item_id === 'string' ? raw.item_id : null,
      event: structuredClone(raw),
    });
  }

  private observeRootItem(event: NativeEvent): void {
    const msg = event.msg;
    if (
      msg.type !== 'item_completed' ||
      msg.thread_id !== this.id ||
      typeof msg.turn_id !== 'string' ||
      event.subagent_id !== undefined ||
      event.subagent_incarnation !== undefined ||
      event.subagent_instance_id !== undefined
    )
      return;
    const item = projectExecutionItem(msg.item, msg.turn_id, this.id);
    const searchItem = item
      ? undefined
      : projectSearchItem(msg.item, msg.turn_id, this.id);
    const hostedItem = projectNativeHostedToolItem(msg.item, msg.turn_id);
    if (!item && !searchItem && !hostedItem) return;
    const owner = this.lastRun;
    if (
      owner?.id === msg.turn_id &&
      submissions.get(owner)!.observation !== 'ended'
    ) {
      const submissionId = this.submissionIds.get(owner)!;
      if (hostedItem)
        this.observations.append({
          type: 'hosted_tool_item_completed',
          turnId: msg.turn_id,
          submissionId,
          item: hostedItem,
        });
      if (item)
        this.observations.append({
          type: 'execution_item_completed',
          turnId: msg.turn_id,
          submissionId,
          item,
        });
      else if (searchItem)
        this.observations.append({
          type: 'search_item_completed',
          turnId: msg.turn_id,
          submissionId,
          item: searchItem,
        });
    } else this.observations.gap();
  }

  private observeRequestMetadata(run: NativeTurn, event: NativeEvent): void {
    const msg = event.msg;
    if (
      run.controller.signal.aborted ||
      typeof msg.submission_id !== 'string' ||
      this.requestObservationRoutes.get(msg.submission_id) !== run
    )
      return;
    const observation = decodeRequestMetadata(
      msg.observation,
      msg.submission_id,
    );
    if (
      observation &&
      'threadId' in observation &&
      observation.threadId === this.id &&
      observation.turnId === event.id &&
      run.id === observation.turnId
    )
      this.observations.append(observation);
  }

  private process(run: NativeTurn, event: NativeEvent): void {
    if (event.msg.type === '_sdk_request_metadata') {
      this.observeRequestMetadata(run, event);
      return;
    }
    if (this.lifecycle.kind !== 'turn' || this.lifecycle.run !== run) return;
    const msg = event.msg;
    const kind = msg.type;
    this.observeRootItem(event);
    if (
      [
        'exec_approval_request',
        'apply_patch_approval_request',
        'elicitation_request',
      ].includes(kind)
    ) {
      void this.trackNativeQuestion(run, event).catch(() => {});
      return;
    }
    if (kind === '_sdk_prepare_request') {
      if (msg.turn_id !== run.id) return;
      this.track(run, this.prepareRequest(run, event));
      return;
    }
    if (kind === '_sdk_select_step') {
      if (msg.turn_id !== run.id) return;
      this.track(run, this.selectStep(run, event));
      return;
    }
    const manualKey = this.manualCallKey(event);
    const repeatedFunction =
      kind === 'dynamic_tool_call_request' &&
      manualKey === undefined &&
      run.toolCallIds.has(
        JSON.stringify([
          event.subagent_id,
          event.subagent_instance_id,
          msg.callId,
        ]),
      );
    if (event.subagent_id) {
      if (requestTypes.has(kind) && this.current(run)) {
        const key =
          event.subagent_id +
          ':' +
          (typeof msg.callId === 'string' ? msg.callId : event.id);
        if (run.executing.has(key) && !repeatedFunction) return;
        run.executing.add(key);
        this.track(
          run,
          this.handleRequest(run, event).finally(() =>
            run.executing.delete(key),
          ),
        );
      }
      return;
    }
    const eventTurn =
      msg.turn_id ??
      msg.turnId ??
      (kind === 'task_complete' ||
      kind === 'turn_complete' ||
      kind === 'turn_aborted'
        ? event.id
        : null);
    if (eventTurn !== null && eventTurn !== undefined && eventTurn !== run.id)
      return;
    if (
      (kind === 'mcp_tool_call_begin' || kind === 'mcp_tool_call_end') &&
      msg.turn_id === run.id
    )
      this.observeMcp(run, event);
    if (
      kind === 'raw_response_item' &&
      event.id === run.id &&
      this.threadOptions._managed_instructions
    ) {
      const item = msg.item;
      const submission = submissions.get(run);
      if (
        submission &&
        item !== null &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        item.type === 'message' &&
        item.role === 'assistant' &&
        Array.isArray(item.content)
      ) {
        const texts = item.content.flatMap((part) =>
          part !== null &&
          typeof part === 'object' &&
          !Array.isArray(part) &&
          (part.type === 'input_text' || part.type === 'output_text') &&
          typeof part.text === 'string'
            ? [part.text]
            : [],
        );
        // Rust char::is_whitespace uses Unicode White_Space, unlike JS trim
        // (which also strips BOM and omits U+0085).
        const blank =
          texts.length > 0 &&
          texts.every((text) => /^\p{White_Space}*$/u.test(text));
        if (!blank || item.phase === 'final_answer')
          submission.blankFinal = blank;
      }
    }
    if (
      kind === 'item_completed' &&
      msg.item &&
      typeof msg.item === 'object' &&
      !Array.isArray(msg.item) &&
      msg.item.type === 'ContextCompaction'
    )
      this.observations.append({
        type: 'context_compacted',
        turnId: run.id!,
        submissionId: this.submissionIds.get(run)!,
        itemId: String(msg.item.id ?? ''),
      });
    if (
      kind === 'token_count' &&
      this.observeTokenCount(event, run.id!, this.submissionIds.get(run)!)
    )
      run.usage = msg.info ?? null;
    if (
      kind === 'agent_message_content_delta' &&
      eventTurn === run.id &&
      msg.thread_id === this.id &&
      typeof msg.item_id === 'string' &&
      typeof msg.delta === 'string' &&
      msg.delta
    ) {
      this.observations.append({
        type: 'output_text_delta',
        turnId: run.id!,
        submissionId: this.submissionIds.get(run)!,
        itemId: String(msg.item_id ?? ''),
        delta: msg.delta,
      });
    }
    if (kind === 'hosted_tool_call_progress' && event.id === run.id)
      this.observeHostedProgress(
        event,
        run.id!,
        this.submissionIds.get(run)!,
        this.id,
      );
    if (kind === 'raw_response_completed' && event.id === run.id) {
      const raw = msg.token_usage;
      const usage =
        raw !== null && typeof raw === 'object' && !Array.isArray(raw)
          ? raw
          : undefined;
      if (usage) run.addUsage(usage);
      run.selection?.budget?.observe(usage);
      this.notifyManualProgress();
      this.maybeSealManual(run);
    }
    if (event.id === run.id && submissions.get(run)?.review) {
      const item = msg.item;
      const review =
        kind === 'exited_review_mode'
          ? msg.review_output
          : kind === 'item_completed' &&
              item !== null &&
              typeof item === 'object' &&
              !Array.isArray(item) &&
              item.type === 'ExitedReviewMode'
            ? item.review_output
            : undefined;
      if (review !== undefined)
        this.decodedOutputs.set(run, nativeReviewOutput.parse(review));
    }
    if (
      kind === 'task_complete' ||
      kind === 'turn_complete' ||
      kind === 'turn_aborted'
    ) {
      this.notifyManualProgress();
      let error = run.failure;
      if (
        kind !== 'turn_aborted' &&
        this.mcpReaderStarted &&
        run.id &&
        this.#native._take_native_mcp_result_failure(run.id)
      )
        error ??= new NativeError('Native MCP result policy failed');
      if (
        kind !== 'turn_aborted' &&
        submissions.get(run)?.review &&
        !this.decodedOutputs.has(run)
      )
        error ??= new NativeError(
          'Native review completed without a review result',
        );
      if (kind === 'turn_aborted')
        error ??= new TurnAborted('Turn interrupted');
      else {
        if (
          run.nativeFailure &&
          error === run.nativeFailure &&
          run.failure === run.nativeFailure
        )
          enrichNativeError(run.nativeFailure, msg.error);
        if (msg.error) error ??= nativeError(msg.error);
      }
      this.options.selectedModel?.terminal?.({
        turnId: run.id!,
        kind,
        reason: msg.reason,
        nativeError: msg.error,
        priorFailure: run.failure,
        nativeFailure: run.nativeFailure,
        error,
        usage: tokenUsageInfo(run.usage),
      });
      this.finish(
        run,
        error,
        submissions.get(run)?.blankFinal
          ? ''
          : typeof msg.last_agent_message === 'string'
            ? msg.last_agent_message
            : '',
        kind !== 'turn_aborted' && event.sdk_unsampled_steering === true,
      );
    } else if (
      kind === 'error' &&
      event.id === run.id &&
      event.error_affects_turn_status !== false
    ) {
      if (run.failure == null) {
        run.nativeFailure = nativeError(
          msg,
          typeof msg.message === 'string' ? msg.message : 'Native turn failed',
        );
        run.failure = run.nativeFailure;
      }
      this.notifyManualProgress();
      // Error notices may precede the terminal receipt; the session stays owned until it arrives.
    } else if (requestTypes.has(kind) && this.current(run)) {
      if (manualKey !== undefined) {
        const admission = this.admitManualCall(run, event);
        if (admission)
          void admission.then(
            () => this.publishManualRequest(run, event),
            () => {},
          );
        return;
      }
      const key =
        manualKey ?? (typeof msg.callId === 'string' ? msg.callId : event.id);
      if (run.executing.has(key) && !repeatedFunction) return;
      run.executing.add(key);
      this.track(
        run,
        this.handleRequest(run, event).finally(() => run.executing.delete(key)),
        undefined,
        () => this.publishManualRequest(run, event),
      );
    }
  }
  private prepareRequest(run: NativeTurn, event: NativeEvent): Promise<void> {
    const msg = event.msg;
    const selection = run.selection;
    const preparation = new AbortController();
    const signal = AbortSignal.any([run.controller.signal, preparation.signal]);
    run.preparation = preparation;
    return this.invokeCallback(
      run,
      async () => {
        let replied = false;
        const reply = (data: string | undefined, failed: boolean) => {
          if (replied) return;
          replied = true;
          // The replacement was captured before this boundary; never stringify an application object here.
          const receipt = `{"thread":${JSON.stringify(this.id)},"turn_id":${JSON.stringify(msg.turn_id)},"generation":${JSON.stringify(msg.generation)},"request_id":${JSON.stringify(msg.request_id)},"failed":${failed},"data":${data ?? 'null'}}`;
          if (failed) {
            try {
              this.#native._reply_prepared_request(receipt);
            } catch {
              /* Already revoked. */
            }
          } else this.#native._reply_prepared_request(receipt);
        };
        const abort = () => reply(undefined, true);
        signal.addEventListener('abort', abort, { once: true });
        try {
          if (
            !selection?.prepareRequest ||
            !this.current(run) ||
            msg.turn_id !== run.id ||
            msg.generation !== this.catalog.generation.toString() ||
            selection.generation !== this.catalog.generation
          )
            throw new NativeError('Expired prepared request owner');
          signal.throwIfAborted();
          if (this.graphStops.size)
            throw new TurnAborted('Request preparation stopped');
          const returned = selection.prepareRequest({
            context: this.options.context as Context,
            submission: this.#turnFor(this.rootRun(run)),
            preparationIndex: selection.preparationIndex++,
            recoveryAttempt: msg.recovery_attempt as number,
            signal,
            request: preparedRequestFromNative(msg.data),
          });
          const replacement =
            returned &&
            typeof (returned as Promise<PreparedRequestData>).then ===
              'function'
              ? await returned
              : returned;
          // Capture immediately after settlement, before cancellation/owner checks or another await.
          const captured =
            replacement === undefined
              ? undefined
              : capturePreparedRequest(replacement);
          signal.throwIfAborted();
          if (
            !this.current(run) ||
            selection.generation !== this.catalog.generation
          )
            throw new NativeError('Prepared request is no longer active');
          reply(captured, false);
        } catch (error) {
          reply(undefined, true);
          throw error;
        } finally {
          signal.removeEventListener('abort', abort);
          if (run.preparation === preparation) run.preparation = undefined;
        }
      },
      signal,
    );
  }

  private selectStep(run: NativeTurn, event: NativeEvent): Promise<void> {
    const msg = event.msg;
    const selection = run.selection;
    const preparation = new AbortController();
    const signal = AbortSignal.any([run.controller.signal, preparation.signal]);
    run.preparation = preparation;
    // Keep the effective preparation signal through callback settlement.
    return this.invokeCallback(
      run,
      async () => {
        const receipt = {
          thread: this.id,
          turn_id: msg.turn_id,
          generation: msg.generation,
          request_id: msg.request_id,
        };
        let replied = false;
        const reply = (
          names: readonly ReturnType<typeof toolIdentity>[] | null,
        ) => {
          if (replied) return;
          replied = true;
          const response = encode({ ...receipt, names });
          if (names === null) {
            // Native retirement may already have dropped this exact sender.
            try {
              this.#native._reply_step(response);
            } catch {
              /* Already revoked. */
            }
          } else this.#native._reply_step(response);
        };
        const abort = () => reply(null);
        signal.addEventListener('abort', abort, { once: true });
        try {
          if (
            !selection ||
            !this.current(run) ||
            msg.turn_id !== run.id ||
            msg.generation !== this.catalog.generation.toString() ||
            selection.generation !== this.catalog.generation
          )
            throw new NativeError('Expired step selection');
          signal.throwIfAborted();
          if (this.graphStops.size)
            throw new TurnAborted('Step preparation stopped');
          if (
            selection.maxModelSteps !== undefined &&
            selection.stepIndex >= selection.maxModelSteps
          )
            throw new NativeError('Root model step limit reached', {
              code: 'max_model_steps_exceeded',
              retryable: false,
            });
          const nonce = encode(receipt);
          const assertActive = () => {
            signal.throwIfAborted();
            if (
              !this.current(run) ||
              selection.generation !== this.catalog.generation ||
              !this.#native._check_step(nonce)
            )
              throw new NativeError('Step selection is no longer active');
          };
          assertActive();
          selection.budget?.check(assertActive);
          const stepIndex = selection.stepIndex++;
          const selected = await selection.beforeStep?.({
            context: this.options.context as Context,
            submission: this.#turnFor(this.rootRun(run)),
            stepIndex,
            signal,
          });
          assertActive();
          const names = this.selectedStepNames(
            event,
            selected,
            selection.names,
          );
          signal.throwIfAborted();
          reply(names);
          selection.budget?.charge();
        } catch (error) {
          reply(null);
          throw error;
        } finally {
          signal.removeEventListener('abort', abort);
          if (run.preparation === preparation) run.preparation = undefined;
        }
      },
      signal,
      typeof msg.tracing_context === 'string' ? msg.tracing_context : undefined,
    );
  }

  private selectChildStep(
    owner: ChildCallbackOwner,
    event: NativeEvent,
    native: NativeThread,
  ): Promise<void> {
    const beforeStep = this.options.nativeAgents?.beforeStep;
    if (!beforeStep)
      return Promise.reject(
        new NativeError('Child step selection is disabled'),
      );
    let selection = this.childSelections.get(owner);
    if (!selection) {
      selection = {
        names: undefined,
        generation: this.catalog.generation,
        preparationIndex: 0,
        stepIndex: 0,
      };
      this.childSelections.set(owner, selection);
    }
    const capturedSelection = selection;
    return this.trackOwnedCallback(owner, async () => {
      const signal = owner.controller.signal;
      const receipt = {
        thread: owner.childId,
        instance: owner.incarnation,
        turn_id: event.msg.turn_id,
        generation: event.msg.generation,
        request_id: event.msg.request_id,
      };
      let replied = false;
      const reply = (
        names: readonly ReturnType<typeof toolIdentity>[] | null,
      ) => {
        if (replied) return;
        replied = true;
        const response = encode({ ...receipt, names });
        if (names === null) {
          try {
            native._reply_child_step(response);
          } catch {
            /* This original preparation may already have retired. */
          }
        } else native._reply_child_step(response);
      };
      const abort = () => reply(null);
      signal.addEventListener('abort', abort, { once: true });
      try {
        signal.throwIfAborted();
        const original = await native._child_turn(owner.childId);
        if (
          !this.current(owner) ||
          native !== this.#native ||
          [...this.graphStops].some(
            (stop) => stop.options.scope === 'thread_tree',
          ) ||
          !original ||
          original.incarnation !== owner.incarnation ||
          original.turn_id !== owner.turnId ||
          event.msg.turn_id !== owner.turnId ||
          event.msg.thread !== owner.childId ||
          event.msg.generation !== this.catalog.generation.toString() ||
          capturedSelection.generation !== this.catalog.generation
        ) {
          reply(null);
          return;
        }
        const submission = this.publicChildTurn(
          original,
          owner.observationProducer,
        );
        const context = Object.freeze({
          context: this.options.context as Context,
          submission,
          child: Object.freeze({
            sessionId: this.id,
            childId: owner.childId,
            instanceId: original.instance_id,
            turnId: owner.turnId,
            submissionId: `child:${owner.childId}:${owner.incarnation}:${owner.turnId}`,
          }),
          stepIndex: capturedSelection.stepIndex,
          signal,
        });
        // Read-only admission must be adjacent to entry, after every await.
        if (!native._check_step(encode(receipt))) return;
        signal.throwIfAborted();
        capturedSelection.stepIndex++;
        const selected = await withNativeCallbackContext(
          typeof event.msg.tracing_context === 'string'
            ? event.msg.tracing_context
            : undefined,
          () => beforeStep(context),
          signal,
          (traceId, workflowSpanId) =>
            this.workflowForTrace(traceId, workflowSpanId),
        );
        signal.throwIfAborted();
        if (
          !this.current(owner) ||
          native !== this.#native ||
          capturedSelection.generation !== this.catalog.generation
        ) {
          reply(null);
          return;
        }
        if (!native._check_step(encode(receipt))) return;
        reply(this.selectedStepNames(event, selected));
      } catch (error) {
        reply(null);
        throw error;
      } finally {
        signal.removeEventListener('abort', abort);
      }
    });
  }

  private selectedStepNames(
    event: NativeEvent,
    selected: Awaited<
      ReturnType<NonNullable<OperationOptions<Context>['beforeStep']>>
    >,
    defaults?: readonly ReturnType<typeof toolIdentity>[],
  ): readonly ReturnType<typeof toolIdentity>[] {
    const candidates = z
      .array(z.object({ name: z.string(), namespace: z.string().nullish() }))
      .parse(event.msg.candidates)
      .map((tool) => ({
        name: tool.name,
        namespace: tool.namespace || 'functions',
      }));
    const names =
      selected === undefined
        ? (defaults ?? candidates)
        : this.selectionNames([...selected]);
    const allowed = new Set(
      candidates.map((tool) => JSON.stringify([tool.namespace, tool.name])),
    );
    if (
      names.some(
        (tool) => !allowed.has(JSON.stringify([tool.namespace, tool.name])),
      )
    )
      throw new TypeError('beforeStep may only narrow the operation tools');
    return names;
  }

  private track(
    run: NativeTurn,
    callback: Promise<void>,
    owners = run.callbacks,
    onComplete?: () => void,
  ): void {
    owners.add(callback);
    callback
      .then(
        () => {
          owners.delete(callback);
          onComplete?.();
          this.notifyManualProgress();
          this.maybeSealManual(run);
        },
        async (error) => {
          if (this.current(run)) run.failure = error;
          owners.delete(callback);
          this.notifyManualProgress();
          if (this.current(run)) await this.#cancel(run);
        },
      )
      .catch((error) => this.readerFailed(error));
  }
  private readerFailed(error: unknown): void {
    if (!this.isOpen) return;
    this.retire(error);
    void this.close().catch(() => {});
  }
  private manualSuspending = false;

  private invokeTool(
    run: NativeTurn,
    callId: string,
    callback: () => Promise<void>,
    tracingContext?: string,
  ): Promise<void> {
    if (run.toolCallIds.has(callId))
      return Promise.reject(new NativeError('Native tool call ID was reused'));
    run.toolCallIds.add(callId);
    return this.invokeCallback(
      run,
      callback,
      run.controller.signal,
      tracingContext,
    );
  }

  private invokeCallback(
    run: NativeTurn,
    callback: () => Promise<void>,
    signal: AbortSignal = run.controller.signal,
    tracingContext?: string,
  ): Promise<void> {
    const scope = { session: this, run, active: true };
    const tracing = run.tracing ?? run.issuedTracing;
    // Register before application code runs; remove before track handles errors.
    const invocation = Promise.resolve()
      .then(() =>
        toolInvocation.run(scope, () =>
          tracingContext !== undefined
            ? withNativeCallbackContext(
                tracingContext,
                callback,
                signal,
                (traceId, workflowSpanId) =>
                  this.workflowForTrace(traceId, workflowSpanId),
              )
            : tracing
              ? tracing.run('host.callback', 'callback', callback)
              : callback(),
        ),
      )
      .catch((error) => {
        const callerSignal = submissions.get(this.rootRun(run))?.callerSignal;
        if (
          signal.aborted &&
          error !== run.failure &&
          error !== run.controller.signal.reason &&
          !(signal.aborted && error === signal.reason) &&
          !(callerSignal?.aborted && Object.is(error, callerSignal.reason))
        )
          run.toolCleanupErrors.push(error);
        throw error;
      })
      .finally(() => {
        scope.active = false;
        run.toolInvocations.delete(invocation);
      });
    run.toolInvocations.add(invocation);
    return invocation;
  }

  private checkCallbackOperation(operation: string): void {
    const scope = toolInvocation.getStore();
    if (scope?.active && scope.session === this)
      throw new NativeError(
        `A tool callback cannot ${operation} its own session`,
      );
  }
  private observeToolStart(
    owner: NativeTurn | ChildCallbackOwner,
    identity: ToolIdentity,
  ): void {
    this.observeTool(owner, identity, 'tool_started');
  }
  private observeToolEnd(
    owner: NativeTurn | ChildCallbackOwner,
    identity: ToolIdentity,
    status: ToolStatus,
  ): void {
    this.observeTool(owner, identity, 'tool_finished', status);
  }

  private observeTool(
    run: NativeTurn | ChildCallbackOwner,
    identity: ToolIdentity,
    type: 'tool_started' | 'tool_finished',
    status: 'completed' | 'failed' | 'cancelled' = 'completed',
  ): void {
    const event = {
      turnId: run instanceof NativeTurn ? run.id! : run.turnId,
      submissionId:
        run instanceof NativeTurn
          ? this.submissionIds.get(run)!
          : `child:${run.childId}:${run.incarnation}:${run.turnId}`,
      callId: identity.callId,
      name: identity.toolName,
      namespace: identity.namespace,
      family: identity.family,
    };
    if (type === 'tool_finished')
      this.observations.append({ ...event, type, status });
    else this.observations.append({ ...event, type });
  }

  private clearManualCalls(run?: NativeTurn | ChildCallbackOwner): void {
    let removed = false;
    for (const [key, call] of this.manualCalls) {
      if (run ? call.run !== run : this.current(call.run)) continue;
      call.grant.deactivate();
      call.tracing = undefined;
      this.manualCalls.delete(key);
      removed = true;
    }
    if (removed) this.notifyManualProgress();
  }

  private notifyManualProgress(): void {
    this.observations.notify();
    this.manualProgress++;
    this.manualWake?.();
  }

  private manualCallKey(event: NativeEvent): string | undefined {
    const msg = event.msg;
    const marker = msg._sdk_python_tool;
    if (
      msg.type !== 'dynamic_tool_call_request' ||
      !marker ||
      this.catalog.tools[marker.slot]?.kind !== 'manual'
    )
      return undefined;
    // Only admission's native check grants authority. This key keeps distinct
    // private requests from colliding on their public wire call ID.
    return JSON.stringify([
      'manual',
      marker.thread,
      msg.turnId,
      msg.callId,
      marker.generation,
      marker.slot,
      marker.instance,
      marker.manual_grant,
    ]);
  }

  private admitManualCall(
    run: NativeTurn | ChildCallbackOwner,
    event: NativeEvent,
  ): Promise<void> | undefined {
    const msg = event.msg;
    const key = this.manualCallKey(event);
    if (
      key === undefined ||
      typeof msg.callId !== 'string' ||
      typeof msg.turnId !== 'string'
    )
      return;
    const pending = this.manualAdmissions.get(key);
    if (pending) return pending;
    const calls = run instanceof NativeTurn ? run.toolCallIds : run.calls;
    if (calls.has(key)) return;
    // Reserve the full native grant key before deferred callback admission.
    // The inbox and every external waiter join this same operation.
    const reservation = Promise.withResolvers<void>();
    this.manualAdmissions.set(key, reservation.promise);
    reservation.promise.catch(() => {});
    const callId = msg.callId;
    const turnId = msg.turnId;
    const prepare = async () => {
      if (
        !this.current(run) ||
        run.failure !== undefined ||
        this.manualSealing ||
        !this.manualCurrent(event)
      )
        return;
      const marker = msg._sdk_python_tool!;
      const root = run instanceof NativeTurn;
      if (
        marker.thread !== (root ? this.id : run.childId) ||
        (!root && marker.instance !== run.incarnation) ||
        BigInt(marker.generation) !== this.catalog.generation
      )
        throw new NativeError('Expired managed tool generation');
      const tool = this.catalog.tools[marker.slot];
      if (
        !tool ||
        tool.kind !== 'manual' ||
        msg.tool !== tool.name ||
        msg.namespace != null
      )
        throw new NativeError('Invalid managed tool identity');
      const identity = {
        callId,
        toolName: tool.name,
        namespace: null,
        family: 'function' as const,
      };
      this.observeToolStart(run, identity);
      try {
        if (!this.current(run) || !this.manualCurrent(event)) return;
        const args =
          typeof msg.arguments === 'string'
            ? decode(jsonValue, msg.arguments)
            : jsonValue.parse(msg.arguments);
        const grant = createManualRequest(
          tool,
          {
            sessionId: this.id,
            submissionId:
              run instanceof NativeTurn
                ? this.submissionIds.get(run)!
                : `child:${run.childId}:${run.incarnation}:${run.turnId}`,
            subagentId: run instanceof NativeTurn ? null : run.childId,
            turnId,
            callId,
            call: managedCallInfo(
              {
                sessionId: this.id,
                childId: run instanceof NativeTurn ? null : run.childId,
                childIncarnation:
                  run instanceof NativeTurn ? null : run.incarnation,
              },
              msg,
            ),
          },
          args,
          () => {
            if (!this.current(run) || this.manualSealing) return false;
            try {
              return this.manualCurrent(event);
            } catch {
              return false;
            }
          },
        );
        this.manualCalls.set(key, {
          run,
          event,
          tool,
          grant,
          tracing: getCurrentSpan(),
          identity,
          ready: false,
        });
        calls.add(key);
      } catch (error) {
        if (!this.current(run) || !this.manualCurrent(event)) {
          this.observeToolEnd(run, identity, 'cancelled');
          return;
        }
        this.observeToolEnd(run, identity, 'failed');
        run.failure ??= error;
        throw error;
      }
    };
    const invoke = async () => {
      try {
        await prepare();
      } catch (error) {
        if (this.current(run)) run.failure ??= error;
        throw error;
      }
    };
    const admission = this.trackOwnedCallback(
      run,
      invoke,
      typeof msg.tracing_context === 'string' ? msg.tracing_context : undefined,
    );
    void admission.then(reservation.resolve, reservation.reject).finally(() => {
      if (this.manualAdmissions.get(key) === reservation.promise)
        this.manualAdmissions.delete(key);
      this.observations.notify();
    });
    return reservation.promise;
  }

  private publishManualRequest(
    run: NativeTurn | ChildCallbackOwner,
    event: NativeEvent,
  ): void {
    const key = this.manualCallKey(event);
    if (key === undefined) return;
    const call = this.manualCalls.get(key);
    if (!call || call.run !== run || call.ready) return;
    call.ready = true;
    this.observations.notify();
    const action = call.grant.request();
    if (!action) return;
    const handler = this.oneShot?.onRequiredAction;
    if (handler) {
      const root =
        run instanceof NativeTurn
          ? run
          : this.lifecycle.kind === 'turn'
            ? this.lifecycle.run
            : undefined;
      // One-shot ownership ends with the root. An explicit Session can still
      // receive child manual requests after its root completes.
      if (!root) return;
      const answer = async () => {
        if (!this.current(root) || !this.current(run) || !call.grant.request())
          return;
        const reply = await handler(action, run.controller.signal);
        if (!this.current(root) || !this.current(run)) return;
        if (!(await this.submitManualResult(reply, key)))
          throw new TypeError(
            'onRequiredAction must return a reply to the manual request it received',
          );
      };
      if (run instanceof NativeTurn) {
        const invocation = this.invokeTool(
          run,
          JSON.stringify(['one-shot-manual', key]),
          answer,
          typeof event.msg.tracing_context === 'string'
            ? event.msg.tracing_context
            : undefined,
        );
        // Do not hold Core's model-completion callbacks; termination aborts
        // entered handlers before joining them.
        this.track(run, invocation, run.toolInvocations);
      } else {
        this.trackOwnedCallback(
          run,
          async () => {
            try {
              await answer();
            } catch (error) {
              if (
                !run.controller.signal.aborted ||
                error !== run.controller.signal.reason
              ) {
                if (this.current(root) && root.failure === undefined) {
                  root.failure = error;
                  // Child cleanup is joined by close, never from the callback
                  // that close itself must drain.
                  toolInvocation.exit(() => {
                    void this.#cancel(root).catch((cause) =>
                      this.readerFailed(cause),
                    );
                  });
                } else if (error !== root.failure) {
                  this.oneShotChildCleanupErrors.push(error);
                }
              }
              throw error;
            }
          },
          typeof event.msg.tracing_context === 'string'
            ? event.msg.tracing_context
            : undefined,
        );
      }
      return;
    }
  }

  /** Supply one validated result for a current manual request. Copies and expired replies are rejected. */
  async #submitToolResult(reply: ManualToolReply): Promise<boolean> {
    this.checkCallbackOperation('submit a manual result to');
    return this.submitManualResult(reply);
  }

  private async submitManualResult(
    reply: unknown,
    expectedKey?: string,
    beforeConsume?: (output: ToolResponse) => void,
  ): Promise<boolean> {
    for (const [key, call] of this.manualCalls) {
      if (expectedKey !== undefined && key !== expectedKey) continue;
      if (!call.grant.matchesReply(reply)) continue;
      const validate = () => call.grant.takeReply(reply, beforeConsume);
      const output = call.tracing
        ? call.tracing.validate(validate)
        : withoutTracing(validate);
      if (!output) continue;
      // A taken grant is unavailable before its native reply and end hook
      // settle. An explicit save may keep waiting on other grants in this run.
      this.notifyManualProgress();
      const run = call.run;
      const operation = (async () => {
        let accepted = false;
        if (this.manualRestoring) {
          await this.#native._respond_manual_continuation(
            encodeReceipt({
              request: call.event.msg,
              response: output,
            }),
          );
          accepted = true;
        } else {
          accepted = await this.#native._respond_python_tool(
            encodeReceipt({ request: call.event.msg, response: output }),
          );
        }
        call.tracing = undefined;
        this.manualCalls.delete(key);
        this.notifyManualProgress();
        this.observeToolEnd(
          run,
          call.identity,
          accepted ? 'completed' : 'cancelled',
        );
        return accepted;
      })();
      const settled = operation.then(() => {});
      if (run instanceof NativeTurn)
        this.track(run, settled, run.manualReplies);
      else this.trackOwnedCallback(run, () => settled);
      const accepted = await operation;
      await settled;
      if (
        this.manualRestoring &&
        run instanceof NativeTurn &&
        !this.manualCalls.size &&
        !run.manualReplies.size &&
        this.current(run) &&
        run.failure === undefined
      ) {
        // Claim recovery before awaiting native so concurrent accepted replies
        // cannot start the original turn twice. Every end hook has joined.
        this.manualRestoring = false;
        try {
          const schema = submissions.get(run)!.output.schema;
          const tracingContext = run.tracing
            ? await run.tracing.context()
            : undefined;
          if (
            tracingContext &&
            (!this.current(run) || run.controller.signal.aborted)
          )
            throw new TurnAborted(
              'Manual continuation stopped before native admission',
            );
          const wire = await this.#native._complete_manual_continuation(
            schema == null ? undefined : encodeReceipt(schema),
            run.selection
              ? encode({
                  generation: this.catalog.generation.toString(),
                  names: run.selection.names ?? null,
                  before_step: run.selection.maxModelSteps !== undefined,
                })
              : undefined,
            this.options.parentTrace
              ? encode(this.options.parentTrace.toHeaders())
              : undefined,
            tracingContext,
            this.submissionIds.get(run)!,
          );
          const submission = decode(submissionSchema, wire);
          if (submission.status !== 'started' || submission.turn_id !== run.id)
            throw new NativeError(
              'Manual continuation changed the original turn',
            );
        } catch (error) {
          if (
            [...this.graphStops].some(
              (stop) => stop.run === run && stop.options.mode === 'force',
            )
          ) {
            this.finish(run, new TurnAborted('Manual continuation stopped'));
            return false;
          }
          this.retire(error);
          // An owned handler must leave before Agent.run can join and close it.
          if (expectedKey === undefined) await this.close();
          throw error;
        }
      }
      return accepted;
    }
    return false;
  }

  private maybeSealManual(run: NativeTurn): void {
    if (
      !this.oneShot ||
      this.oneShot?.onRequiredAction ||
      this.pendingNativeQuestions(run).length ||
      this.manualSeal ||
      this.manualSealing ||
      this.graphStops.size ||
      !this.current(run) ||
      run.failure !== undefined ||
      !this.manualCalls.size ||
      run.callbacks.size ||
      run.toolInvocations.size ||
      run.manualReplies.size
    )
      return;
    const action = this.manualCalls.values().next().value?.grant.request();
    void this.sealManualTurn(run)
      .catch(async (error) => {
        if (!this.current(run)) return;
        const failure = action ? new InteractionRequired() : error;
        if (failure instanceof InteractionRequired) failure.cause = error;
        run.failure ??= failure;
        await this.#cancel(run);
      })
      .catch((error) => this.readerFailed(error));
  }

  private canCheckpointManual(
    output = this.defaultOutput,
    selection?: OperationSelection,
  ): boolean {
    return (
      selection?.prepareRequest === undefined &&
      !output.prompt &&
      this.nativeManualCheckpoint &&
      supportsManualCheckpoint(this.threadOptions, !!this.environment)
    );
  }

  private sealManualTurn(
    run: NativeTurn,
    beforeSeal?: (entries: readonly ManualCheckpointEntry[]) => void,
    signal?: AbortSignal,
  ): Promise<SessionState> {
    const refusal = manualCaptureRefusal(run.selection);
    if (refusal) return Promise.reject(new NativeError(refusal));
    this.requireCompleteRepairReceipts();

    if (this.pendingRoots.length)
      return Promise.reject(
        new NativeError('Cannot capture while roots are queued'),
      );
    if (this.manualSeal)
      return Promise.reject(
        new NativeError('Manual checkpoint is already being saved'),
      );
    // Claim the single writer/waiter before inspecting any native grant.
    const pending = Promise.resolve().then(() =>
      this.captureManualTurn(run, beforeSeal, signal),
    );
    this.manualSeal = pending;
    return pending
      .finally(() => {
        if (this.manualSeal === pending) this.manualSeal = undefined;
        this.observations.notify();
      })
      .catch(async (error) => {
        // close joins manualSeal. Clear that raw capture promise first, so
        // cleanup can never await itself. A concurrent close joins the same
        // capture and remains the owner of its existing close promise.
        if (this.manualSealed) {
          try {
            await this.close();
          } catch (closeError) {
            throw new AggregateError(
              [error, closeError],
              'Manual checkpoint failed and its cleanup is incomplete',
              { cause: error },
            );
          }
        }
        throw error;
      });
  }

  private async captureManualTurn(
    run: NativeTurn,
    beforeSeal?: (entries: readonly ManualCheckpointEntry[]) => void,
    signal?: AbortSignal,
  ): Promise<SessionState> {
    for (;;) {
      signal?.throwIfAborted();
      if (
        this.pendingRoots.length ||
        this.manualSealing ||
        !this.current(run) ||
        this.manualCheckpointRun !== run ||
        run.failure !== undefined
      )
        throw (
          run.failure ??
          run.controller.signal.reason ??
          new NativeError('Original manual checkpoint turn is no longer active')
        );

      // Taken replies may still be settling. Only send current root grants;
      // never absorb an unrelated child or a later turn into this save.
      const requests = [...this.manualCalls.values()]
        .filter((call) => call.run === run)
        .map((call) => ({ call, action: call.grant.request() }))
        .filter(
          (
            request,
          ): request is typeof request & { action: ManualToolRequest } =>
            request.action !== undefined,
        );
      if (!requests.length)
        throw new NativeError('Original manual checkpoint requests expired');
      const keys =
        '[' +
        requests.map(({ call }) => encodeReceipt(call.event.msg)).join(',') +
        ']';
      const progress = this.manualProgress;
      const changed = Promise.withResolvers<void>();
      const wake = () => changed.resolve();
      this.manualWake = wake;
      run.controller.signal.addEventListener('abort', wake, { once: true });
      signal?.addEventListener('abort', wake, { once: true });
      let token: string | undefined;
      let nativeProgress: Promise<void> | undefined;
      try {
        // A restored frame has a checked ledger, but no running native Turn.
        if (!this.manualRestoring) {
          token = this.#native._begin_manual_checkpoint_wait(keys);
          nativeProgress = this.#native._wait_manual_checkpoint_progress(token);
          // Readiness can itself reject before Promise.race has been reached.
          // The original promise is still joined on every path below.
          void nativeProgress.catch(() => {});
        }
        // Check malformed history now, even with an unrelated JS callback held.
        let ready: boolean;
        try {
          ready = await this.#native._manual_checkpoint_ready(keys);
        } catch (error) {
          // A usable grant can be answered while native checks the snapshot.
          // Retry only for a grant that actually expired in this same run.
          // Malformed history never waits behind unrelated callback progress.
          if (
            this.current(run) &&
            this.manualCheckpointRun === run &&
            run.failure === undefined &&
            this.manualProgress !== progress &&
            requests.some(({ call }) => !call.grant.request())
          )
            continue;
          throw error;
        }
        if (
          !this.current(run) ||
          this.manualCheckpointRun !== run ||
          run.failure !== undefined
        )
          throw (
            run.failure ??
            run.controller.signal.reason ??
            new NativeError(
              'Original manual checkpoint turn is no longer active',
            )
          );
        signal?.throwIfAborted();
        const settling =
          run.callbacks.size ||
          run.toolInvocations.size ||
          run.manualReplies.size;
        if (!ready || settling) {
          // Both JS and native notifications were registered before ready().
          // Testing the epoch after registration covers a change during check.
          if (this.manualProgress === progress) {
            await (nativeProgress
              ? Promise.race([changed.promise, nativeProgress])
              : changed.promise);
          }
          continue;
        }
      } finally {
        if (this.manualWake === wake) this.manualWake = undefined;
        run.controller.signal.removeEventListener('abort', wake);
        signal?.removeEventListener('abort', wake);
        // Release the losing JS/native wait before retry, error, or capture.
        wake();
        if (token !== undefined) {
          try {
            this.#native._end_manual_checkpoint_wait(token);
          } finally {
            await nativeProgress;
          }
        }
      }

      if (
        this.manualProgress !== progress ||
        !this.current(run) ||
        this.manualCheckpointRun !== run ||
        run.failure !== undefined
      )
        continue;
      if (this.pendingRoots.length)
        throw new NativeError('Cannot capture while roots are queued');
      beforeSeal?.(
        requests.map(({ call, action }) => ({
          request: action,
          arguments:
            typeof call.event.msg.arguments === 'string'
              ? decode(jsonValue, call.event.msg.arguments)
              : jsonValue.parse(call.event.msg.arguments),
        })),
      );
      signal?.throwIfAborted();
      if (
        this.manualProgress !== progress ||
        !this.current(run) ||
        this.manualCheckpointRun !== run ||
        run.failure !== undefined ||
        requests.some(({ call, action }) => call.grant.request() !== action)
      )
        continue;
      // Until this point ordinary replies remain usable. Starting the native
      // seal claims commit and joins the native outcome. Run cancellation
      // and Session.close retain their own fences.
      this.manualSealing = true;
      this.manualSuspending = true;
      this.observations.notify();
      let sealed = false;
      try {
        const wire = await this.#native._seal_manual_checkpoint(keys);
        // A successful native return may already have retired its writer.
        // Only an explicit valid not_ready response proves no commit occurred.
        sealed = true;
        this.manualSealed = true;
        const result = z
          .union([
            z.object({ status: z.literal('not_ready') }).strict(),
            z.object({
              status: z.literal('failed'),
              committed: z.literal(true),
              message: z.string(),
            }),
            z.object({
              checkpoint: z.unknown(),
              manual_continuation: jsonObject,
            }),
          ])
          .parse(parseNative(wire));
        if ('status' in result) {
          if (result.status === 'not_ready') {
            sealed = false;
            this.manualSealed = false;
            this.manualSuspending = false;
            continue;
          }
          throw new NativeError(result.message);
        }
        // Usage can still be queued behind the native shutdown. Restored holds
        // have no running Core reader until all restored grants are answered.
        if (!this.manualRestoring) await this.readers[0];
        if (!this.current(run))
          throw new TurnAborted('Manual checkpoint cancelled');
        const state = fromNativeCheckpoint(
          this.checkpointCatalog(
            parseNativeCheckpoint(result.checkpoint),
            this.checkpointSelections(run),
          ),
          submissions.get(run)!.output.identity,
          this.restored,
          { turns: this.repairTurns, items: this.repairItems },
          {
            manual_continuation: result.manual_continuation,
            manual_context: {
              ...(run.selection?.maxModelSteps === undefined
                ? {}
                : {
                    remaining_model_steps:
                      run.selection.maxModelSteps - run.selection.stepIndex,
                  }),
              instructions: this.threadOptions._managed_instructions
                ? this.#native._application_instructions()
                : (this.threadOptions.instructions ?? null),
              result_schemas: this.catalog.tools
                .filter((tool) => tool.kind === 'manual')
                .map((tool) => ({
                  name: tool.name,
                  schema: manualResultSchema(tool),
                })),
              usage:
                run.tokenUsage === null ? null : runUsageToWire(run.tokenUsage),
            },
          },
          this.checkpointSelections(run),
          networkPolicyDigest(this.environment?.network),
        );

        if (!this.current(run))
          throw new TurnAborted('Manual checkpoint cancelled');
        // Publish only after one validated serialized receipt is retained.
        this.sealedStateJson = encodeReceipt(state);
        this.finish(
          run,
          new InteractionRequired(parseSessionState(this.sealedStateJson)),
        );
        return parseSessionState(this.sealedStateJson);
      } catch (error) {
        this.manualSuspending = false;
        if (sealed && this.owns(run)) this.retire(error);
        throw error;
      } finally {
        this.manualSealing = false;
        this.observations.notify();
        if (!sealed && this.current(run)) {
          for (const event of run.pending.splice(0)) this.process(run, event);
        }
      }
    }
  }

  /** @internal Restore original pending calls with new native and JavaScript reply authority. */
  async _restoreManualContinuation(state: ManualSessionState): Promise<void> {
    this.idle('restore manual continuation');
    const tracing = this.captureRootTracing();
    let requests: JsonObject[];
    try {
      const context = tracing ? await tracing.context() : undefined;
      requests = decode(
        z.array(jsonObject),
        await this.#native._restore_manual_continuation(
          encodeReceipt(state.manual_continuation),
          context,
        ),
      );
    } catch (error) {
      tracing?.finish(error ?? null);
      throw error;
    }
    const restoredOutput = this.options.restoredOutput ?? {
      output: this.defaultOutput,
      outputOverride: false,
    };
    const run = this.allocateRun(
      restoredOutput.output,
      restoredOutput.outputOverride,
    );
    run.tracing = tracing;

    run.parentTrace = this.options.parentTrace;
    run.id = state.manual_continuation.turn_id;
    const operation = readCheckpointSelections(state).operation_tools;
    const remaining = state.manual_context.remaining_model_steps;
    if (operation !== undefined || remaining !== undefined)
      run.selection = {
        names:
          operation === undefined
            ? undefined
            : this.selectionNames(
                operation.map((reference) => ({
                  kind: 'tool_ref',
                  ...reference,
                })),
              ),
        maxModelSteps: remaining,
        generation: this.catalog.generation,
        preparationIndex: 0,
        stepIndex: 0,
      };
    this.#turnFor(run);
    run.accepted.resolve({ status: 'started', turn_id: run.id });
    const usage = state.manual_context.usage;
    if (usage)
      run.addUsage({
        input_tokens: usage.inputTokens,
        cached_input_tokens: usage.cachedInputTokens,
        cache_write_input_tokens: usage.cacheWriteInputTokens,
        output_tokens: usage.outputTokens,
        reasoning_output_tokens: usage.reasoningOutputTokens,
        total_tokens: usage.totalTokens,
      });
    this.lifecycle = { kind: 'turn', run };
    this.lastRun = run;
    this.manualCheckpointRun = run;
    this.manualRestoring = true;

    const events = requests.map((request) =>
      parseEvent(encodeReceipt(request)),
    );
    for (const event of events) await this.handleRequest(run, event);
    // Register all saved requests before a handler can resolve the last grant
    // and restart the original turn.
    for (const event of events) {
      this.publishManualRequest(run, event);
    }
  }
  private async handleRequest(
    owner: NativeTurn | ChildCallbackOwner,
    event: NativeEvent,
  ): Promise<void> {
    const msg = event.msg;
    const marker = msg._sdk_python_tool;
    if (msg.type !== 'dynamic_tool_call_request' || !marker)
      throw new InteractionRequired();
    if (this.manualCallKey(event) !== undefined) {
      await this.admitManualCall(owner, event);
      return;
    }
    const root = owner instanceof NativeTurn;
    if (
      marker.thread !== (root ? this.id : owner.childId) ||
      (!root && marker.instance !== owner.incarnation) ||
      BigInt(marker.generation) !== this.catalog.generation
    )
      throw new NativeError('Expired managed tool generation');
    const tool = this.catalog.tools[marker.slot];
    if (
      !tool ||
      msg.tool !== tool.name ||
      (msg.namespace ?? null) !== toolNamespace(tool)
    )
      throw new NativeError('Invalid managed tool identity');
    if (tool.kind === 'manual') return;
    if (typeof msg.callId !== 'string')
      throw new NativeError('Native tool invocation has no call identity');
    const execute = async () => {
      if (!this.current(owner)) return;
      this.#native._check_python_tool(encodeReceipt(msg));
      const submission = root
        ? this.#turnFor(owner)
        : await this.childSubmission(owner);
      if (!submission) return;
      if (!root) {
        if (!this.current(owner)) return;
        this.#native._check_python_tool(encodeReceipt(msg));
      }
      const context = {
        traceContext: nativeTraceContext(
          msg._sdk_trace_context as TraceContextHeaders | null | undefined,
        ),
        context: this.options.context,
        submission,
        call: managedCallInfo(
          {
            sessionId: this.id,
            childId: root ? null : owner.childId,
            childIncarnation: root ? null : owner.incarnation,
          },
          msg,
        ),
        threadId: root ? this.id : owner.childId,
        turnId: root ? owner.id! : owner.turnId,
        callId: msg.callId as string,
        signal: owner.controller.signal,
      };
      const identity: ToolIdentity = {
        callId: context.callId,
        toolName: tool.name,
        namespace: toolNamespace(tool),
        family: 'function',
      };
      this.observeToolStart(owner, identity);
      let status: ToolStatus | undefined;
      try {
        const args =
          typeof msg.arguments === 'string'
            ? decode(jsonValue, msg.arguments)
            : jsonValue.parse(msg.arguments);
        const response = await invokeFunctionTool(
          tool,
          args,
          context,
          (error) => {
            owner.failure ??= error;
            if (root)
              toolInvocation.exit(() => {
                void this.#cancel(owner).catch((cause) =>
                  this.readerFailed(cause),
                );
              });
            else {
              owner.controller.abort(error);
              void this.#native
                ._cancel_child_callback(encodeReceipt(msg))
                .catch((cause) => this.readerFailed(cause));
            }
          },
          () => {
            if (!this.current(owner))
              throw new NativeError('Tool invocation is no longer active');
            this.#native._check_python_tool(encodeReceipt(msg));
          },
        );
        if (!this.current(owner)) {
          status = 'cancelled';
          return;
        }
        this.#native._check_python_tool(encodeReceipt(msg));
        const accepted = await this.#native._respond_python_tool(
          encodeReceipt({
            request: msg,
            response,
          }),
        );
        if (accepted && root)
          this.options.selectedModel?.toolResult?.(
            context.callId,
            tool.name,
            response,
          );
        status = accepted
          ? response.success
            ? 'completed'
            : 'failed'
          : 'cancelled';
      } finally {
        const finalStatus = owner.controller.signal.aborted
          ? 'cancelled'
          : status;
        if (finalStatus !== undefined)
          getCurrentSpan()?.end({
            status:
              finalStatus === 'cancelled'
                ? 'cancelled'
                : finalStatus === 'failed'
                  ? 'error'
                  : 'ok',
            category:
              finalStatus === 'cancelled'
                ? 'cancelled'
                : finalStatus === 'failed'
                  ? 'tool_error'
                  : undefined,
          });
        this.observeToolEnd(owner, identity, finalStatus ?? 'failed');
      }
    };
    if (root)
      await this.invokeTool(
        owner,
        JSON.stringify([
          event.subagent_id,
          event.subagent_instance_id,
          msg.callId,
        ]),
        execute,
        typeof msg.tracing_context === 'string'
          ? msg.tracing_context
          : undefined,
      );
    else
      await withNativeCallbackContext(
        typeof msg.tracing_context === 'string'
          ? msg.tracing_context
          : undefined,
        execute,
        owner.controller.signal,
        (traceId, workflowSpanId) =>
          this.workflowForTrace(traceId, workflowSpanId),
      );
  }

  private async childNativeTurn(
    owner: ChildCallbackOwner,
    expiredError: () => Error = () =>
      new NativeError('Native child callback belongs to an expired turn'),
  ): Promise<import('../../native/index.js')._NativeChildTurn | null> {
    const thread = this.#native;
    const producer = owner.observationProducer;
    const current = () =>
      this.#native === thread &&
      this.childObservationProducer === producer &&
      this.current(owner);
    // These stops own pending native senders. A tentative manual seal can
    // resume, so it owns retirement only after sealing or reader EOF.
    const retired = () =>
      !current() ||
      this.replacingNative === thread ||
      this.manualSealed ||
      (producer.eventReaderEnded && this.manualSuspending);
    const matches = (
      turn: import('../../native/index.js')._NativeChildTurn | null,
    ): turn is import('../../native/index.js')._NativeChildTurn =>
      turn?.incarnation === owner.incarnation && turn.turn_id === owner.turnId;
    if (!current()) return null;
    try {
      // Existing handles remain usable before JS observes a start, including
      // restored manual turns. Only a missing publication needs the reader.
      const startObserved = owner.nativeStartObserved;
      let native = await thread._child_turn(owner.childId);
      if (!current()) return null;
      if (!matches(native) && retired()) return null;
      if (!matches(native) && !startObserved) {
        const aborted = Promise.withResolvers<void>();
        const signal = owner.controller.signal;
        const abort = () => aborted.resolve();
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        try {
          for (;;) {
            const changed = this.observations.waitForChange();
            if (!current()) return null;
            if (owner.nativeStartObserved) break;
            if (retired()) return null;
            if (producer.eventReaderEnded) throw expiredError();
            await Promise.race([changed, aborted.promise]);
          }
        } finally {
          signal.removeEventListener('abort', abort);
        }
        native = await thread._child_turn(owner.childId);
        if (!current()) return null;
      }
      if (!matches(native)) throw expiredError();
      return native;
    } catch (error) {
      if (retired()) return null;
      throw error;
    }
  }

  private async childSubmission(
    owner: ChildCallbackOwner,
  ): Promise<Turn<string> | null> {
    const native = await this.childNativeTurn(owner);
    return native
      ? this.publicChildTurn(native, owner.observationProducer)
      : null;
  }

  /** Request a stop and return once it is accepted. Cleanup remains owned by
   * this Session: close() joins it and reports failures. A run's wait() only
   * waits for that run, not background cells or descendant cleanup.
   * If close fails before native teardown, retry close to finish cleanup.
   * New work stays fenced until cleanup finishes. Graceful stops allow current
   * tool replies to finish; force stops revoke them. Both modes stop remaining
   * background Code Mode cells in the selected scope.
   */
  async interrupt(options: SessionInterruptOptions = {}): Promise<void> {
    this.checkCallbackOperation('cancel');
    void this.stopGraph(
      sessionStopSchema.parse({
        scope:
          options.scope === 'all' ? 'thread_tree' : (options.scope ?? 'root'),
        mode: options.mode ?? 'force',
      }),
    );
    this.discardPending(
      new TurnAborted('Queued work stopped by Session interruption'),
    );
    if (
      this.lifecycle.kind === 'turn' &&
      this.lifecycle.run.id === null &&
      (options.mode ?? 'force') === 'force'
    )
      void this.close().catch(() => {});
  }

  private cancelTurn(
    anchor: NativeTurn,
    mode: 'force' | 'graceful',
  ): Promise<void> {
    if (mode !== 'force' && mode !== 'graceful')
      return Promise.reject(new TypeError('mode must be force or graceful'));
    const queued = this.pendingRoots.findIndex((entry) => entry.run === anchor);
    if (queued >= 0) {
      this.checkCallbackOperation('cancel');
      this.pendingRoots.splice(queued, 1);
      const error = new TurnAborted('Queued work cancelled before admission');
      anchor.controller.abort(error);
      anchor.accepted.reject(error);
      anchor.completion.reject(error);
      this.finishObservation(anchor);
      return Promise.resolve();
    }
    if (
      this.lifecycle.kind === 'closing' &&
      this.lastRun &&
      this.rootRun(this.lastRun) === anchor
    ) {
      this.checkCallbackOperation('cancel');
      return this.lifecycle.completion;
    }
    const pending = [...this.graphStops].find(
      (stop) =>
        stop.run &&
        this.rootRun(stop.run) === anchor &&
        (stop.options.mode === 'force' || mode === 'graceful'),
    );
    if (!pending && !this.ownedStep(anchor)) return Promise.resolve();
    this.checkCallbackOperation('cancel');
    if (pending) return pending.completion;
    const unknown = this.ownedStep(anchor)?.id === null;
    const stopped = this.stopGraph({ scope: 'root', mode });
    if (unknown && mode === 'force') return this.close();
    return stopped;
  }

  async #cancel(expected?: NativeTurn): Promise<void> {
    if (expected && expected !== this.lastRun) return;
    this.checkCallbackOperation('cancel');
    if (this.lifecycle.kind === 'closing') return this.lifecycle.completion;
    if (this.lifecycle.kind !== 'turn') return;
    const run = this.lifecycle.run;
    if (expected && run !== expected) return;
    if (this.manualSeal) {
      run.controller.abort(new TurnAborted('Manual checkpoint cancelled'));
      await this.manualSeal.catch(() => {});
      if (this.manualSealed) return this.close();
    }
    let cancelError: unknown;
    let failed = false;
    try {
      await this.interruptRun(run);
    } catch (error) {
      failed = true;
      cancelError = error;
    }
    await Promise.allSettled([...run.toolInvocations, ...run.manualReplies]);
    if (run.toolCleanupErrors.length) throw cleanupFailure(run, cancelError);
    if (failed) throw cancelError;
  }

  private stopGraph(options: SessionStopOptions): Promise<void> {
    this.checkCallbackOperation('cancel');
    if (this.lifecycle.kind === 'closing') {
      this.idle('interrupt');
    }
    if (!this.isOpen || this.manualSealed || this.lifecycle.kind === 'mutation')
      this.idle('cancel');
    const run = this.lifecycle.kind === 'turn' ? this.lifecycle.run : undefined;
    // Reserve the native fence before any await or callback abort. If native
    // rejects before reservation, the existing Session and grants stay usable.
    const native = this.#native._request_graph_stop(
      options.scope,
      options.mode,
    );
    const done = Promise.withResolvers<void>();
    const stop = {
      options,
      run,
      completion: done.promise,
      questionReplies: new Map<
        NativeTurn | ChildCallbackOwner,
        Promise<void>[]
      >(),
    };
    this.graphStops.add(stop);
    const stopInterceptions = (mode: 'force' | 'graceful') =>
      Promise.allSettled(
        [...this.interceptionStops].map((stop) => {
          try {
            return stop(undefined, mode);
          } catch (error) {
            return Promise.reject(error);
          }
        }),
      );
    const interceptionStop = stopInterceptions(options.mode);
    let settledInterceptionStop:
      ReturnType<typeof stopInterceptions> | undefined;
    if (run)
      stop.questionReplies.set(run, this.retireNativeQuestions(run, true));
    if (options.scope === 'thread_tree')
      for (const child of this.childCallbacks.entered())
        stop.questionReplies.set(
          child,
          this.retireNativeQuestions(child, true),
        );
    // Preparation has no entered tool effect to drain during a graceful stop.
    run?.preparation?.abort(new TurnAborted('Step preparation stopped'));
    this.observations.notify();
    done.promise.catch(() => {});
    const enteredChildren =
      options.scope === 'thread_tree' ? this.childCallbacks.entered() : [];
    const wasRestoring = this.manualRestoring;
    if (run) {
      const submission = submissions.get(run);
      if (submission?.repair)
        this.stopCorrection(submission.repair, options.mode);
      if (
        submission &&
        (options.scope === 'thread_tree' || options.mode === 'force')
      )
        submission.cancelled = true;
      if (options.mode === 'force') {
        run.failure ??= new TurnAborted('Turn interrupted');
        run.controller.abort(new TurnAborted('Session work stopped'));

        this.clearManualCalls(run);
        if (wasRestoring) {
          // There is no native task to emit a terminal for an unrecovered
          // ledger. Native retired it synchronously; finish only this JS hold.
          this.manualRestoring = false;
          this.finish(run, new TurnAborted('Manual continuation stopped'));
        }
      }
    }
    if (options.scope === 'thread_tree' && options.mode === 'force') {
      this.childCallbacks.stop(new TurnAborted('Session work stopped'));
      this.clearManualCalls();
    }
    void (async () => {
      let failure: unknown;
      try {
        try {
          // Keep the reservation until an earlier N-API submit is acknowledged.
          // Own settlement setup too, so a synchronous bridge failure cannot
          // leave an accepted stop with a completion that never settles.
          if (run && run.id === null)
            await run.accepted.promise.catch(() => {});
          // Escalation/repeated interruption must also join declines owned by
          // earlier stops. Never join their full compiler/cleanup completion here.
          const questionReplies: Promise<void>[] = [];
          for (const pending of this.graphStops)
            for (const [owner, replies] of pending.questionReplies)
              if (
                options.scope === 'thread_tree' ||
                owner instanceof NativeTurn
              )
                questionReplies.push(...replies);
          await Promise.allSettled(questionReplies);
          await native.settle();
          // Graceful settlement may admit retained callbacks after the first
          // snapshot. Revoke their leases before joining the complete set.
          if (options.mode === 'graceful')
            settledInterceptionStop = stopInterceptions('force');
          await this.manualSeal?.catch(() => {});
          if (run) {
            await run.completion.promise.catch((error) => {
              if (
                !(error instanceof TurnAborted) &&
                !(error instanceof TurnNotSubmitted) &&
                error !== run.failure
              )
                throw error;
            });
          }
        } catch (error) {
          // Revoke before joining: a failed graceful native stop cannot wait
          // for callbacks whose input is no longer accepted.
          failure = error;
          this.retire(error);
          if (options.mode === 'graceful')
            settledInterceptionStop = stopInterceptions('force');
          if (options.scope === 'thread_tree')
            this.childCallbacks.stop(new TurnAborted('Session work stopped'));
        }
        if (run) {
          await Promise.allSettled([
            ...run.toolInvocations,
            ...run.manualReplies,
          ]);
          failure = cleanupFailure(run, failure);
        }
        if (failure !== undefined) {
          // A root cleanup failure must also revoke entered tree work before
          // the tree join. Repeated stop/retire only touches the same owners.
          this.retire(failure);
          if (options.scope === 'thread_tree')
            this.childCallbacks.stop(new TurnAborted('Session work stopped'));
        }
        if (options.scope === 'thread_tree') {
          try {
            await this.childCallbacks.drainEntered(enteredChildren);
          } catch (error) {
            failure =
              failure === undefined
                ? error
                : new AggregateError(
                    [failure, error],
                    'Session work stop failed',
                    { cause: failure },
                  );
          }
        }
      } catch (error) {
        failure =
          failure === undefined
            ? error
            : new AggregateError([failure, error], 'Session work stop failed', {
                cause: failure,
              });
      } finally {
        const results = [
          ...(await interceptionStop),
          ...(settledInterceptionStop ? await settledInterceptionStop : []),
        ];
        for (const result of results) {
          if (result.status === 'rejected')
            failure =
              failure === undefined
                ? result.reason
                : new AggregateError(
                    [failure, result.reason],
                    'Session work stop failed',
                    { cause: failure },
                  );
        }
        try {
          // Keep native admission fenced until entered SDK callbacks finish.
          native.release(failure === undefined);
        } catch (error) {
          failure =
            failure === undefined
              ? error
              : new AggregateError(
                  [failure, error],
                  'Session work stop failed',
                  {
                    cause: failure,
                  },
                );
        }
      }
      if (failure === undefined) {
        this.graphStops.delete(stop);
        this.observations.notify();
        done.resolve();
        this.drainPending();
      } else {
        // close remains the owner of terminal ACK and engine cleanup.
        this.retire(failure);
        done.reject(failure);
      }
    })();
    return done.promise;
  }

  private async interruptRun(run: NativeTurn): Promise<void> {
    const interceptionStop = Promise.allSettled(
      [...this.interceptionStops].map((stop) => {
        try {
          return stop(run, 'force');
        } catch (error) {
          return Promise.reject(error);
        }
      }),
    );
    let failure: unknown;
    let failed = false;
    try {
      await (async () => {
        const submission = submissions.get(run);
        if (submission) submission.cancelled = true;
        run.controller.abort();
        if (this.manualRestoring) {
          this.retire(
            run.failure ?? new TurnAborted('Manual continuation cancelled'),
          );
          await this.close();
          return;
        }
        // A receipt must settle before the interrupt can target its real native owner.
        try {
          await run.accepted.promise;
        } catch {
          return;
        }
        if (!this.owns(run)) return;
        try {
          await this.#native._interrupt_session();
          if (!this.owns(run)) return;
          await run.completion.promise.catch((error) => {
            if (!(error instanceof TurnAborted) && error !== run.failure)
              throw error;
          });
        } catch (error) {
          if (!this.owns(run)) return;
          this.retire(run.failure ?? error);
          try {
            await this.close();
          } catch (closeError) {
            throw new AggregateError(
              [error, closeError],
              'Native cancellation and cleanup failed',
              { cause: error },
            );
          }
          throw error;
        }
      })();
    } catch (error) {
      failed = true;
      failure = error;
    }
    const results = await interceptionStop;
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (errors.length)
      throw new AggregateError(
        [...(failed ? [failure] : []), ...errors],
        'Native cancellation and callback cleanup failed',
        failed ? { cause: failure } : undefined,
      );
    if (failed) throw failure;
  }

  private interceptionRules(
    servers: readonly McpTool[],
    generation: bigint,
  ): JsonValue[] {
    const rules: JsonValue[] =
      this.environment instanceof Environment &&
      hasExecutorPolicy(this.environment)
        ? JSON.parse(
            executorPolicyRules(this.environment, !!this.options.nativeAgents),
          )
        : [];
    if (this.options.nativeAgents)
      rules.push(...nativeAgentsPolicyRules(this.options.nativeAgents));
    rules.push(...mcpPrePolicyRules(servers, generation));
    return rules;
  }

  private async mutate<T>(action: () => Promise<T>): Promise<T> {
    this.idle('Mutation');
    const pending = Promise.resolve().then(action);
    this.lifecycle = { kind: 'mutation', completion: pending };
    try {
      return await pending;
    } finally {
      if (
        this.lifecycle.kind === 'mutation' &&
        this.lifecycle.completion === pending
      )
        this.lifecycle = { kind: 'idle' };
    }
  }
  async update(options: SessionUpdate<Context> = {}): Promise<void> {
    this.checkCallbackOperation('update');
    this.idle('update');
    const settings = modelOverrides(options.model, options.modelSettings);
    if (
      this.options.nativeAgents &&
      (options.instructions !== undefined || Object.keys(settings).length)
    )
      throw new TypeError(
        'NativeAgents settings and instructions cannot change after the Session opens',
      );
    const categories =
      Number(options.tools !== undefined) +
      Number(options.instructions !== undefined) +
      Number(Object.keys(settings).length > 0);
    if (categories > 1)
      throw new TypeError(
        'Update tools, instructions, and model settings separately',
      );
    if (options.tools !== undefined) {
      const next = splitToolDeclarations(options.tools);
      const registration = this.options.mcpTools?.find(isHostedRegistration);
      if (
        next.mcp.some(
          (server) => server.name === 'codex_apps' && server !== registration,
        )
      )
        throw new TypeError(
          'Apps registration is fixed; open a new Session to replace it',
        );
      if (
        encode(hostedToolSpecs(next.hostedTools)) !==
        encode(hostedToolSpecs(this.options.hostedTools ?? []))
      )
        throw new TypeError(
          'Tool updates must retain the captured hosted tool declarations',
        );
      const capturedSearch = this.options.webSearch;
      if (encode(next.webSearch ?? null) !== encode(capturedSearch ?? null))
        throw new TypeError(
          'Tool updates must retain the captured WebSearch declaration',
        );
      if (next.nativeGoals)
        throw new TypeError(
          'NativeGoals cannot change after the Session opens',
        );
      if (next.checklist)
        throw new TypeError('Checklist cannot change after the Session opens');
      if (next.nativeAgents)
        throw new TypeError(
          'NativeAgents cannot change after the Session opens',
        );
      const discoveryGranted =
        this.openingCatalog.tools.some((tool) => tool.deferLoading) ||
        this.options.mcpTools?.some((server) => server.deferLoading);
      if (!discoveryGranted && next.tools.some((tool) => tool.deferLoading))
        throw new TypeError(
          'Schema discovery must have been granted when the Session opened',
        );
      for (const server of next.mcp) {
        const opening = this.options.mcpTools?.find(
          (declared) => declared.name === server.name,
        );
        if (!opening || server.deferLoading !== opening.deferLoading)
          throw new TypeError(
            'MCP schema discovery mode must match the Session opening',
          );
      }
      for (const tool of next.tools)
        if (
          !this.allowedTools.has(
            JSON.stringify([toolIdentity(tool).namespace, tool.name]),
          )
        )
          throw new TypeError(
            'Updated tools must have been declared when the Session opened',
          );
      for (const tool of mcpToolNames(next.mcp))
        if (
          !this.allowedMcpTools.has(JSON.stringify([tool.namespace, tool.name]))
        )
          throw new TypeError(
            'Updated MCP tools must have been declared when the Session opened',
          );
      if (!this.options.mcpTools) {
        await this.#replaceTools(next.tools);
        return;
      }
      for (const server of next.mcp) {
        if (
          !this.hasOperationMcp &&
          !(server instanceof HttpMCP && server.activation === 'operation')
        )
          continue;
        const opening = this.openingMcpTools.find(
          (original) => original.name === server.name,
        );
        if (
          !opening ||
          server.tools.some((raw) => !opening.tools.includes(raw)) ||
          (opening instanceof HttpMCP &&
            opening.activation === 'operation' &&
            !(server instanceof HttpMCP)) ||
          (server instanceof HttpMCP &&
            (!(opening instanceof HttpMCP) ||
              server.activation !== opening.activation))
        )
          throw new TypeError(
            'Updated MCP raw identities and activation must match Session opening',
          );
      }
      const bindings = !this.hasOperationMcp
        ? next.mcp
        : this.mcpBindings.map(
            (bound) =>
              next.mcp.find((server) => server.name === bound.name) ?? bound,
          );
      const active = next.mcp.filter(
        (server) =>
          !(server instanceof HttpMCP) || server.activation !== 'operation',
      );
      const guarded = hasMcpPrePolicy(this.mcpTools) || hasMcpPrePolicy(active);
      const candidate = captureTools(next.tools, this.catalog.generation + 1n);
      const generation = this.mcpGeneration + 1n;
      await this.mutate(async () => {
        let published = false;
        try {
          let receipt: unknown;
          if (guarded) {
            receipt = parseNative(
              await this.#native._replace_mcp_servers(
                encode(
                  mcpConfig(
                    active,
                    this.environment ?? undefined,
                    this.codeModeEnabled,
                    bindings,
                  ),
                ),
                mcpPolicies(active, generation),
                encode(this.interceptionRules(active, generation)),
                candidate.generation.toString(),
                candidate.specsJson,
              ),
            );
            // The combined ingress owns function and MCP publication. Any
            // uncertain failure is retired below, rather than retried as old state.
            published = true;
            if (
              jsonObject.parse(jsonObject.parse(receipt).result)
                .tools_generation !== candidate.generation.toString()
            )
              throw new NativeError(
                'Native tool publication was not confirmed',
              );
          } else {
            const accepted = await this.#native._replace_tools(
              candidate.generation.toString(),
              candidate.specsJson,
            );
            if (accepted !== candidate.generation.toString())
              throw new NativeError(
                'Native tool publication was not confirmed',
              );
            published = true;
            receipt = parseNative(
              await this.#native._replace_mcp_servers(
                encode(
                  mcpConfig(
                    active,
                    this.environment instanceof Environment
                      ? this.environment
                      : undefined,
                    this.codeModeEnabled,
                    bindings,
                  ),
                ),
                mcpPolicies(active, generation),
              ),
            );
          }
          checkMcpPublication(receipt, active, generation, bindings);
          this.catalog = candidate;
          this.defaultTools = candidate.tools;
          this.mcpTools = active;
          this.defaultMcpTools = Object.freeze([...next.mcp]);
          this.mcpBindings = Object.freeze(bindings);
          this.mcpGeneration = generation;
          await this.configureManualTools();
        } catch (error) {
          if (
            published ||
            !(
              error instanceof Error &&
              'code' in error &&
              error.code === 'InvalidArg'
            )
          )
            this.retire(error);
          throw error;
        }
      });
    } else if (options.instructions !== undefined) {
      await this.updateInstructions(options.instructions);
    } else if (Object.keys(settings).length) {
      await this.mutate(async () => {
        try {
          if (
            (await this.#native._update_model_settings(encode(settings))) !==
            true
          )
            throw new NativeError('Native model update was not acknowledged');
        } catch (error) {
          if (!(
            error instanceof Error &&
            'code' in error &&
            error.code === 'InvalidArg'
          ))
            this.retire(error);
          throw error;
        }
      });
    }
  }

  async #replaceTools(tools: readonly SessionTool[]): Promise<void> {
    const replacements = captureTools(tools);
    const byName = new Map(
      replacements.tools.map((tool) => [
        JSON.stringify(toolIdentity(tool)),
        tool,
      ]),
    );
    const candidate = captureTools(
      this.catalog.tools.map(
        (tool) => byName.get(JSON.stringify(toolIdentity(tool))) ?? tool,
      ),
      this.catalog.generation + 1n,
    );
    await this.publishCatalog(async () => candidate, replacements.tools);
  }
  private async publishCatalog(
    create: () => Promise<ToolCatalog>,
    defaults: readonly SessionTool[],
  ): Promise<void> {
    let confirmed = false;
    await this.mutate(async () => {
      const candidate = await create();
      const slots = defaults.map((tool) => {
        const identity = toolIdentity(tool);
        return candidate.tools.findIndex((binding) => {
          const current = toolIdentity(binding);
          return (
            current.name === identity.name &&
            current.namespace === identity.namespace
          );
        });
      });
      const accepted = await this.#native._replace_tools(
        candidate.generation.toString(),
        candidate.specsJson,
        encode(slots),
      );
      confirmed = accepted === candidate.generation.toString();
      if (confirmed) {
        this.catalog = candidate;
        this.defaultTools = Object.freeze(
          slots.map((slot) => candidate.tools[slot]),
        );
        for (const tool of defaults) {
          const identity = toolIdentity(tool);
          const key = JSON.stringify([identity.namespace, identity.name]);
          let admitted = this.admittedDeclarations.get(key);
          if (!admitted)
            this.admittedDeclarations.set(key, (admitted = new WeakSet()));
          admitted.add(toolDeclarationIdentity(tool));
        }
        await this.configureManualTools();
      }
    });
    if (!confirmed) {
      await this.close();
      throw new NativeError(
        'Unconfirmed native tool publication; session retired',
      );
    }
  }
  private async configureManualTools(): Promise<void> {
    this.#native._configure_manual_tools(
      encode(
        this.catalog.tools
          .filter((tool) => tool.kind === 'manual')
          .map((tool) => ({
            name: tool.name,
          })),
      ),
    );
    this.nativeManualCheckpoint = this.catalog.tools.some(
      (tool) => tool.kind === 'manual',
    )
      ? await this.#native._manual_checkpoint_config_supported()
      : false;
  }
  private async updateInstructions(instructions: string): Promise<void> {
    await this.mutate(async () => {
      try {
        await this.#native.call('set_instructions', encode({ instructions }));
      } catch (error) {
        try {
          this.#native._application_instructions();
        } catch {
          this.retire(error);
        }
        throw error;
      }
    });
  }
  /** Read current native goal state without starting model work. */
  async goal(): Promise<Readonly<NativeGoal> | null> {
    if (!this.isOpen) throw new NativeError('Session is closed');
    if (!this.options.localStorage || !this.options.nativeGoals)
      throw new NativeError(
        'goal requires local storage and current NativeGoals',
      );
    return nativeGoal(parseNative(await this.#native._read_goal()));
  }
  /**
   * Set the native goal on an idle, open root Session using LocalStorage and
   * current NativeGoals. This does not start model work.
   *
   * Omitting `tokenBudget` keeps an existing budget or uses Core's default for
   * a new goal. Supply a `bigint` for budgets above the safe integer range.
   * The result preserves native accounting and can retain `budgetLimited`
   * status.
   *
   * If the goal database write fails after Core records the instruction, the
   * previous goal remains and the recorded instruction can remain in history.
   */
  async setPausedGoal(
    objective: string,
    { tokenBudget }: { readonly tokenBudget?: TokenCount } = {},
  ): Promise<Readonly<NativeGoal>> {
    this.checkCallbackOperation('set a paused goal on');
    this.idle('setPausedGoal');
    if (!this.options.localStorage || !this.options.nativeGoals)
      throw new NativeError(
        'setPausedGoal requires LocalStorage and current NativeGoals',
      );
    if (
      tokenBudget !== undefined &&
      typeof tokenBudget !== 'bigint' &&
      !Number.isSafeInteger(tokenBudget)
    )
      throw new TypeError('tokenBudget must be a safe integer or bigint');
    return this.mutate(async () => {
      const value = await this.#native._set_paused_goal(
        objective,
        tokenBudget?.toString(),
      );
      return nativeGoal(parseNative(value))!;
    });
  }
  /** Read accepted root or owned-child data, including without a destination grant. */
  async checklist(
    options: { readonly subagentId?: string } = {},
  ): Promise<ChecklistState | null> {
    if (!this.isOpen)
      throw new NativeError('Checklist requires an open Session');
    const value = await this.#native.read_checklist(options.subagentId ?? null);
    // Native completion can be delivered after local close has won the JS queue.
    if (this.options.localStorage && !this.isOpen)
      throw new NativeError('Checklist requires an open Session');
    return readChecklist(value);
  }
  async *items(options: { subagentId?: string } = {}) {
    const repairs =
      options.subagentId === undefined ? structuredClone(this.repairItems) : [];
    const history = await this.#readHistory(options.subagentId);
    const projected = projectHistory(history, this.id, options.subagentId);
    const parents = new Set(projected.turns.map((turn) => turn.id));
    const lastItems = new Map(
      projected.items.map((item, index) => [item.turnId, index]),
    );
    for (const [index, { data: _data, ...item }] of projected.items.entries()) {
      yield item;
      if (lastItems.get(item.turnId) === index && parents.has(item.turnId)) {
        for (const receipt of repairs.filter(
          (entry) => entry.parentTurnId === item.turnId,
        )) {
          const recorded = repairItemFromWire(receipt.item);
          if (recorded) yield recorded;
        }
      }
    }
    for (const receipt of repairs) {
      if (
        !parents.has(receipt.parentTurnId) ||
        lastItems.has(receipt.parentTurnId)
      )
        continue;
      const recorded = repairItemFromWire(receipt.item);
      if (recorded) yield recorded;
    }
  }
  async *turns(options: { subagentId?: string } = {}) {
    const repairs =
      options.subagentId === undefined ? structuredClone(this.repairTurns) : [];
    const history = await this.#readHistory(options.subagentId);
    for (const turn of projectHistory(history, this.id, options.subagentId)
      .turns) {
      yield turn;
      for (const receipt of repairs.filter(
        (entry) => entry.parentTurnId === turn.id,
      ))
        yield recordedTurnFromWire(receipt);
    }
  }
  async *subagents() {
    const thread = this.#native;
    const producer = this.childObservationProducer;
    const records = subagentsSchema
      .parse(parseNative(await thread.call('list_subagents', '{}')))
      .sort((a, b) => a.openedAt - b.openedAt || a.id.localeCompare(b.id));
    for (const record of records) {
      const [instance, native] = (await thread._child_instance(record.id)) ?? [
        null,
        null,
      ];
      const isLive = record.status === 'active' && instance !== null;
      yield issueSubagent(
        { ...record, isLive },
        native ? this.publicChildTurn(native, producer) : null,
        (input) => this.submitChild(record.id, instance, input),
        (turn) =>
          this.tryCancelChild(record.id, isLive ? instance : null, turn),
      );
    }
  }

  private publicChildTurn(
    native: import('../../native/index.js')._NativeChildTurn,
    producer: ChildObservationProducer,
  ): Turn<string> {
    const key = `child:${native.child_id}:${native.incarnation}:${native.turn_id}`;
    let captured = this.publicChildTurns.get(key);
    if (!captured) {
      const owner = this.childCallbacks.owner(
        native.child_id,
        native.incarnation,
        native.turn_id,
        producer,
        native.instance_id,
      );
      if (producer.ended)
        this.retireChildObservations(
          producer,
          (candidate) => candidate === owner,
        );
      const turn = issueChildTurn(native, {
        beforeWait: () => this.checkCallbackOperation('wait on a child of'),
        observations: (options) =>
          this.observations.events(options, {
            includes: (event) =>
              'submissionId' in event && event.submissionId === key,
            phase: () => owner.observationPhase,
          }),
        drain: () =>
          this.childCallbacks.drain(
            native.child_id,
            native.incarnation,
            native.turn_id,
          ),
        requests: {
          notify: () => this.observations.notify(),
          rateLimits: () => this.rateLimits(),
          wait: (turn, options, completion) =>
            this.waitRequests(turn, () => owner, options, completion),
        },
      });
      captured = { turn, native };
      this.publicChildTurns.set(key, captured);
    }
    return captured.turn;
  }

  private async tryCancelChild(
    id: string,
    instance: string | null,
    turn: Turn<string>,
  ): Promise<boolean> {
    this.checkCallbackOperation('cancel a child of');
    if (!this.isOpen || instance === null)
      throw new NativeError('Child is not live');
    const captured = this.publicChildTurns.get(turn.submissionId);
    if (
      !captured ||
      captured.turn !== turn ||
      captured.native.child_id !== id ||
      captured.native.instance_id !== instance
    ) {
      throw new NativeError(
        'Turn does not belong to this captured child instance',
      );
    }
    // A passive caller may stop awaiting this Promise. The continuation still
    // owns this exact receipt and joins its cleanup before resolving.
    const native = captured.native;
    const confirmed = await native.cancel();
    if (confirmed === false) return false;
    let cleanupFailed = confirmed !== true;
    const lifecycle = this.lifecycle;
    if (lifecycle.kind === 'closing' || lifecycle.kind === 'closed') {
      // Close may already have swept the callback owners. Join its original
      // completion rather than creating an owner after that sweep.
      try {
        await lifecycle.completion;
      } catch {
        cleanupFailed = true;
      }
    } else if (lifecycle.kind === 'retired') {
      cleanupFailed = true;
    }
    this.childCallbacks.end(
      native.child_id,
      native.incarnation,
      native.turn_id,
    );
    try {
      await this.childCallbacks.drain(
        native.child_id,
        native.incarnation,
        native.turn_id,
      );
    } catch {
      cleanupFailed = true;
    }
    // Native null means interruption was confirmed but its cleanup failed.
    // Neither native nor application cleanup errors are public child results.
    if (cleanupFailed)
      throw new NativeError('Child cancellation cleanup failed');
    return true;
  }

  private async submitChild(
    id: string,
    instance: string | null,
    input: UserInput | ManualToolReply | FunctionCallOutput,
  ): Promise<Turn<string>> {
    this.checkCallbackOperation('submit to a child of');
    if (!this.isOpen || instance === null)
      throw new NativeError('Child is not live');
    if (
      isManualReply(input) ||
      (typeof input === 'object' &&
        input !== null &&
        'type' in input &&
        input.type === 'function_call_output')
    ) {
      return this.submitManualInput(input, {
        id,
        instanceId: instance,
      }) as Promise<Turn<string>>;
    }
    if (
      [...this.graphStops].some((stop) => stop.options.scope === 'thread_tree')
    )
      throw new NativeError('Session graph is stopping');
    const thread = this.#native;
    const producer = this.childObservationProducer;
    const native = await thread._child_submit(
      id,
      instance,
      encode({ input: nativeInput(input as UserInput) }),
    );
    return this.publicChildTurn(native, producer);
  }

  async #readHistory(subagentId?: string) {
    return decode(
      threadHistorySchema,
      await this.#native.read_thread_history(subagentId ?? null),
    );
  }
  /** @internal Read the root rollout, including records omitted from Model input. */
  _rootHistory() {
    return this.#readHistory();
  }

  /** Read the settled root model context for use with supplied compaction. */
  async modelContext(): Promise<ModelContextSnapshot> {
    this.checkCallbackOperation('read model context from');
    this.idle('modelContext');
    return this.mutate(async () => {
      const source = this.#native;
      const payload = await source._read_model_context();
      if (this.lifecycle.kind !== 'mutation')
        throw new NativeError('Session closed during model context capture');
      const { items }: ModelContextSnapshot = JSON.parse(payload);
      const snapshot = { items };
      this.#modelContextSnapshots.set(snapshot, {
        source,
        payload,
        length: items.length,
      });
      return snapshot;
    });
  }

  async compact(options?: SuppliedCompactionOptions): Promise<void> {
    if (options !== undefined) this.requireCompleteRepairReceipts();
    if (this.options.localStorage && options !== undefined)
      throw new TypeError(
        'Local storage does not support compact; retain Session.id and reopen its profile',
      );
    this.checkCallbackOperation('compact');
    this.idle('compact');
    if (options !== undefined) {
      const { summary, signal, snapshot, retain } = options;
      if (typeof summary !== 'string' || !summary.trim())
        throw new TypeError('Compaction summary must be nonempty text');
      signal?.throwIfAborted();
      if (this.forkCopy)
        throw new NativeError(
          'Supplied compaction requires completed fork cleanup; retry fork() or close()',
        );
      if (this.threadOptions.runtime?.native_goal_store != null)
        throw new TypeError(
          'Supplied compaction does not support a goal store',
        );
      if (this.childCallbacks.entered().length || this.childContinuations.size)
        throw new NativeError(
          'Supplied compaction requires settled child callbacks',
        );
      if ((snapshot === undefined) !== (retain === undefined))
        throw new TypeError('Supply snapshot and retain together');
      const captured =
        snapshot === undefined
          ? undefined
          : this.#modelContextSnapshots.get(snapshot);
      if (snapshot !== undefined && !captured)
        throw new TypeError(
          'Snapshot must come from this Session.modelContext()',
        );
      if (captured && captured.source !== this.#native)
        throw new NativeError('Model context snapshot is stale');
      const indices: number[] = [];
      if (captured) {
        if (!Array.isArray(retain))
          throw new TypeError('retain must be an array of item indices');
        for (const index of retain) {
          if (!Number.isInteger(index) || index < 0 || index >= captured.length)
            throw new RangeError('Retained index is outside the model context');
          indices.push(index);
        }
      }
      await this.mutate(() =>
        this.replaceContext(summary, signal, indices, captured?.payload),
      );
      return;
    }
    await this.beginCompaction().wait();
  }

  private beginCompaction(tracing?: TraceOptions): NativeTurn {
    const previous = this.lastRun;
    const parentTrace = this.options.parentTrace;
    const run = this.begin(
      (_run, context) =>
        this.#native._compact(
          parentTrace ? encode(parentTrace.toHeaders()) : null,
          context,
        ),
      undefined,
      false,
      undefined,
      tracing,
    );
    run.parentTrace = parentTrace;
    this.lastRun = previous;
    submissions.get(run)!.compaction = true;
    return run;
  }
  /** Execute a canonical embedded command using its native operation. */
  async executeCommand(
    input: string,
    options?: Pick<OperationOptions<Context>, 'tracing'>,
  ): Promise<EmbeddedCommandResult> {
    this.checkCallbackOperation('execute a command on');
    const command = parseEmbeddedCommand(input);
    if (!this.isOpen || this.manualSealing || this.manualSealed)
      throw new NativeError('Commands require a healthy open Session');
    if (command.name === 'compact') {
      this.idle('compact');
      const run = this.beginCompaction(options?.tracing);
      await afterSubmissionRetirement(run, run.accepted.promise);
      return Object.freeze({
        command: 'compact',
        turn: this.#turnFor(run) as Turn<string>,
      });
    }
    const native = this.#native;
    if (command.name === 'review') {
      this.idle('review');
      if (this.options.selectedModel)
        throw new TypeError(
          'Native review is unavailable for a selected Model; use a NativeProvider-backed Session',
        );
      const parentTrace = this.options.parentTrace;
      const run = this.begin(
        (_run, context) =>
          native._execute_command(
            'review',
            command.arguments,
            parentTrace ? encode(parentTrace.toHeaders()) : null,
            context,
          ),
        prepareOutput(undefined),
        true,
        undefined,
        options?.tracing,
      );
      run.parentTrace = parentTrace;
      submissions.get(run)!.review = true;
      await afterSubmissionRetirement(run, run.accepted.promise);
      return Object.freeze({
        command: 'review',
        turn: this.#turnFor(run) as Turn<NativeReviewOutput | null>,
      });
    }
    const receipt = await native._execute_command(
      command.name,
      command.arguments,
    );
    if (command.name === 'stop') {
      const accepted = decode(
        z.object({ session_id: z.string(), operation_id: z.string() }),
        receipt,
      );
      return Object.freeze({
        command: 'stop',
        sessionId: accepted.session_id,
        operationId: accepted.operation_id,
      });
    }
    const renamed = decode(
      z.object({ session_id: z.string(), name: z.string() }),
      receipt,
    );
    return Object.freeze({
      command: 'rename',
      sessionId: renamed.session_id,
      name: renamed.name,
    });
  }
  get capabilities(): Capabilities {
    this.checkCapabilitiesHealth();
    return this.capabilityView;
  }
  private checkCapabilitiesHealth(): void {
    if (!this.isOpen || this.manualSealing || this.manualSealed)
      throw new NativeError('Capabilities require a healthy open Session');
  }
  private get codeModeEnabled(): boolean {
    const codeMode = this.threadOptions.config?.['features.code_mode'];
    return (
      codeMode === true ||
      (typeof codeMode === 'object' &&
        codeMode !== null &&
        !Array.isArray(codeMode) &&
        codeMode.enabled === true)
    );
  }
  private featureSupport(feature: FeatureName) {
    return featureSupport(feature, {
      manual:
        this.defaultTools.some((tool) => tool.kind === 'manual') &&
        this.nativeManualCheckpoint &&
        supportsManualCheckpoint(this.threadOptions, !!this.environment),
      manualRestore:
        this.catalog.tools.some((tool) => tool.kind === 'manual') &&
        this.nativeManualCheckpoint,
      functionCallback: this.defaultTools.some(
        (tool) => tool.kind !== 'manual',
      ),
      mcp: mcpToolNames(this.mcpTools).length > 0,
      executor: !!this.environment?.tools.length,
      codeMode: this.codeModeEnabled,
      nativeAgents: !!this.options.nativeAgents,
      local: !!this.options.localStorage,
      remoteSkills: !!this.environment?.capabilityDirectories?.length,
      checklist: !!this.options.checklist,
    });
  }
  private checkpointRefusal(): string | undefined {
    if (this.repairReceiptsIncomplete)
      return 'Output repair receipts are incomplete';
    if (
      !this.isOpen ||
      this.manualSealing ||
      this.manualSealed ||
      this.manualSeal
    )
      return 'Session is not available for checkpoint inspection';
    if (this.options.localStorage)
      return 'Local storage cannot export SessionState';
    if (this.pendingRoots.length) return 'Session has queued root work';
    if (this.graphStops.size) return 'Session graph is stopping';
    if (this.childCallbacks.entered().length)
      return 'Native child work or callbacks remain active';
    if (this.lifecycle.kind === 'mutation')
      return 'Session is changing or saving its state';
  }
  async checkpointStatus(options: {
    kind: 'idle' | 'manualWait';
  }): Promise<CheckpointStatus> {
    this.checkCallbackOperation('inspect checkpoints of');
    if (options?.kind !== 'idle' && options?.kind !== 'manualWait')
      throw new TypeError('kind must be idle or manualWait');
    const refusal = this.checkpointRefusal();
    if (refusal) return checkpointStatus('notReady', refusal);
    if (options.kind === 'idle') {
      const idleRefusal = () =>
        this.checkpointRefusal() ??
        (this.lifecycle.kind !== 'idle' ||
        this.lastRun?.callbacks.size ||
        this.lastRun?.toolInvocations.size ||
        this.lastRun?.manualReplies.size
          ? 'Idle inspection requires a settled idle Session'
          : undefined);
      if (idleRefusal())
        return checkpointStatus(
          'notReady',
          'Idle inspection requires a settled idle Session',
        );
      try {
        let result: CheckpointStatus | undefined;
        await this.mutate(async () => {
          const wire: unknown = JSON.parse(
            await this.#native._export_checkpoint(null, false, true),
          );
          const envelope = z
            .discriminatedUnion('kind', [
              z
                .object({
                  kind: z.literal('notReady'),
                  reason: z.enum(['nativeBusy', 'nativeChanged']),
                })
                .strict(),
              z
                .object({ kind: z.literal('snapshot'), snapshot: z.string() })
                .strict(),
            ])
            .parse(wire);
          if (envelope.kind === 'notReady') {
            result = checkpointStatus(
              'notReady',
              envelope.reason === 'nativeBusy'
                ? 'Native checkpoint boundary is not settled'
                : 'Native checkpoint boundary changed',
            );
          } else {
            parseNativeCheckpoint(envelope.snapshot);
            result = checkpointStatus('ready');
          }
        });
        const after = idleRefusal();
        return after ? checkpointStatus('notReady', after) : result!;
      } catch {
        const after = idleRefusal();
        return after
          ? checkpointStatus('notReady', after)
          : checkpointStatus(
              'unknown',
              'Native checkpoint readiness could not be verified',
            );
      }
    }
    if (this.lifecycle.kind !== 'turn')
      return checkpointStatus('notReady', 'No settled pending manual boundary');
    const run = this.lifecycle.run;
    const captureRefusal = manualCaptureRefusal(run.selection);
    if (captureRefusal) return checkpointStatus('notReady', captureRefusal);
    const output = submissions.get(run)?.output;
    const valid = () =>
      this.current(run) &&
      this.manualCheckpointRun === run &&
      run.failure === undefined &&
      !run.controller.signal.aborted &&
      this.nativeManualCheckpoint &&
      supportsManualCheckpoint(this.threadOptions, !!this.environment) &&
      output !== undefined &&
      submissions.get(run)?.output === output &&
      !run.callbacks.size &&
      !run.toolInvocations.size &&
      !run.manualReplies.size;
    if (!valid())
      return checkpointStatus('notReady', 'No settled pending manual boundary');
    const calls = [...this.manualCalls.values()].filter(
      (call) => call.run === run,
    );
    const grants = calls.map((call) => call.grant.request());
    if (
      !calls.length ||
      calls.some((call) => !call.ready) ||
      grants.some((grant) => !grant)
    )
      return checkpointStatus('notReady', 'No settled pending manual boundary');
    const progress = this.manualProgress;
    const thread = this.#native;
    const unchanged = () =>
      !this.checkpointRefusal() &&
      this.#native === thread &&
      valid() &&
      this.manualProgress === progress &&
      calls.every(
        (call, i) => call.ready && call.grant.request() === grants[i],
      );
    const keys =
      '[' + calls.map((call) => encodeReceipt(call.event.msg)).join(',') + ']';
    try {
      const ready = await thread._manual_checkpoint_ready(keys);
      return unchanged() && ready
        ? checkpointStatus('ready')
        : checkpointStatus('notReady', 'No settled pending manual boundary');
    } catch {
      return unchanged()
        ? checkpointStatus(
            'unknown',
            'Native checkpoint readiness could not be verified',
          )
        : checkpointStatus('notReady', 'No settled pending manual boundary');
    }
  }

  /** Copy settled root history into an independently owned portable state. */
  async fork(): Promise<SessionState> {
    this.requireCompleteRepairReceipts();
    if (this.options.localStorage)
      throw new TypeError('Local storage does not support fork');
    this.checkCallbackOperation('fork');
    if (this.graphStops.size || this.childContinuations.size)
      throw new NativeError('fork requires a settled Session');
    return this.mutate(async () => {
      // Native ownership retains the copy even if delivery of this handle fails.
      await this.discardForkCopy();
      const copy = await this.#native._fork_settled();
      this.forkCopy = copy;
      let state: SessionState;
      try {
        state = this.decorateState(
          parseNativeCheckpoint(await copy._export_checkpoint(null, false)),
        );
      } catch (error) {
        try {
          await this.discardForkCopy();
        } catch (cleanup) {
          throw new AggregateError(
            [error, cleanup],
            'Fork export and cleanup failed',
            { cause: error },
          );
        }
        throw error;
      }
      await this.discardForkCopy();
      if (!this.isOpen) throw new NativeError('Session closed during fork');
      return state;
    });
  }

  private async discardForkCopy(): Promise<void> {
    const copy = this.forkCopy;
    if (!copy) return;
    const diagnostic = await copy._discard_fork();
    this.forkCopy = undefined;
    if (diagnostic) throw new NativeError(diagnostic);
  }

  private async replaceContext(
    summary: string,
    signal: AbortSignal | undefined,
    retainedIndices: number[],
    capturedContext: string | undefined,
  ): Promise<void> {
    const owner: ContextReplacement = {
      source: this.#native,
      sourceEngine: this.#engine,
      sourceReaders: this.readers,
      released: false,
      fenced: false,
      retiring: false,
      sourceReleased: false,
      published: false,
    };
    // This owner remains reachable even when construction rejects without an Engine.
    this.contextReplacement = owner;
    const beforeRetirement = () => {
      signal?.throwIfAborted();
      if (this.lifecycle.kind !== 'mutation')
        throw new NativeError('Session closed during supplied compaction');
    };
    try {
      beforeRetirement();
      owner.change = await owner.source._begin_context_change();
      beforeRetirement();
      if (capturedContext !== undefined) {
        const current = await owner.change.context();
        beforeRetirement();
        if (current !== capturedContext)
          throw new NativeError('Model context snapshot is stale');
      }
      const checkpoint = await owner.change.prepare(summary, retainedIndices);
      const current = decode(
        z.object({
          instructions: z.string(),
          instruction_files: z.array(jsonObject),
        }),
        await owner.change.options(),
      );
      const servers = mcpConfig(
        this.mcpTools,
        this.environment ?? undefined,
        this.codeModeEnabled,
        this.mcpBindings,
      );
      // The candidate owns the effective Environment, including changes
      // accepted since the original opening declaration.
      const { environment: _openingEnvironment, ...runtime } =
        this.threadOptions.runtime ?? {};
      const options: ThreadOptions = {
        ...this.threadOptions,
        instructions: current.instructions,
        _sdk_instruction_files: current.instruction_files,
        config: { ...this.threadOptions.config, mcp_servers: servers },
        runtime,
      };
      beforeRetirement();
      owner.creation = owner.change.createCandidateEngine(
        this.#modelApiKey ?? null,
        encode(servers),
      );
      owner.candidate = await owner.creation;
      beforeRetirement();
      this.carrier?.bindEngine(owner.candidate);
      owner.thread = await owner.candidate.restore_checkpoint(
        checkpoint,
        encode(options),
        this.catalog.specsJson,
        false,
      );
      beforeRetirement();
      this.configureNative(owner.thread);
      owner.thread._configure_manual_tools(
        encode(
          this.catalog.tools
            .filter((tool) => tool.kind === 'manual')
            .map((tool) => ({ name: tool.name })),
        ),
      );
      const manualCheckpoint = this.catalog.tools.some(
        (tool) => tool.kind === 'manual',
      )
        ? await owner.thread._manual_checkpoint_config_supported()
        : false;
      await this.publishContextStartup(owner, signal);
      beforeRetirement();
      await owner.change.validateCandidate(owner.thread);
      beforeRetirement();
      owner.retiring = true;
      this.replacingNative = owner.source;
      const report = await owner.change.retire();
      owner.fenced = true;
      if (report) owner.completedFailure = new NativeError(report);
      await this.releaseContextSource(owner);
      if (owner.completedFailure) throw owner.completedFailure;
      // Retirement is irreversible: finish publication even if close or abort arrived.
      this.#native = owner.thread;
      this.#engine = owner.candidate;
      this.nativeManualCheckpoint = manualCheckpoint;
      owner.published = true;
      this.startReaders();
      this.contextReplacement = undefined;
      this.replacingNative = undefined;
    } catch (error) {
      const failures: unknown[] = [error];
      try {
        await this.cleanupContextReplacement(owner);
        if (owner.completedFailure && owner.completedFailure !== error)
          failures.push(owner.completedFailure);
      } catch (cleanupError) {
        failures.push(cleanupError);
        // A missing candidate handle is not proof of cleanup. Native retains it.
        this.retire(error);
        try {
          if (owner.change && !owner.fenced) {
            await owner.change.fence();
            owner.fenced = true;
          }
          await this.releaseContextChange(owner);
        } catch (fenceError) {
          failures.push(fenceError);
        }
      }
      if (owner.retiring) this.retire(error);
      if (!this.contextReplacement) this.replacingNative = undefined;
      if (failures.length > 1)
        throw new AggregateError(
          failures,
          'Compaction failed and cleanup reported errors',
          { cause: error },
        );
      throw error;
    }
    // Promise cancellation belongs to this joined mutation, never a later Turn.
    signal?.throwIfAborted();
  }

  private async publishContextStartup(
    owner: ContextReplacement,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!this.options.mcpTools) return;
    const change = owner.change!;
    const thread = owner.thread!;
    owner.witness = (async () => {
      while (true) {
        const raw = await change.nextCandidateEvent(thread);
        if (raw === null) return;
        const event = parseEvent(raw);
        if (
          requestTypes.has(event.msg.type) ||
          event.msg.type === 'shutdown_complete'
        )
          throw new NativeError(
            'Compaction candidate requires interaction or ended during startup',
          );
      }
    })();
    owner.witness.catch(() => {});
    owner.publication = change.publishCandidateMcpServers(
      thread,
      encode(
        mcpConfig(
          this.mcpTools,
          this.environment ?? undefined,
          this.codeModeEnabled,
          this.mcpBindings,
        ),
      ),
      mcpPolicies(this.mcpTools, this.mcpGeneration),
      hasMcpPrePolicy(this.mcpTools)
        ? encode(this.interceptionRules(this.mcpTools, this.mcpGeneration))
        : undefined,
    );
    owner.publication.catch(() => {});
    let abort: (() => void) | undefined;
    const interrupted = signal
      ? new Promise<never>((_resolve, reject) => {
          abort = () => reject(signal.reason);
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        })
      : undefined;
    try {
      const receipt = await Promise.race([
        owner.publication,
        owner.witness.then(() => {
          throw new NativeError('Compaction startup reader ended');
        }),
        ...(interrupted ? [interrupted] : []),
      ]);
      await change.stopCandidateEvents();
      await owner.witness;
      checkMcpPublication(
        parseNative(receipt),
        this.mcpTools,
        this.mcpGeneration,
        this.mcpBindings,
      );
    } finally {
      if (abort) signal!.removeEventListener('abort', abort);
    }
  }

  private async releaseContextChange(owner: ContextReplacement): Promise<void> {
    if (owner.change && !owner.released) {
      await owner.change.release();
      owner.released = true;
    }
  }

  private async releaseContextSource(owner: ContextReplacement): Promise<void> {
    if (owner.sourceReleased) return;
    // Never retain a mutation guard while native close acquires its own guard.
    await this.releaseContextChange(owner);
    const threadReport = await owner.source._close_report();
    if (threadReport) owner.completedFailure ??= new NativeError(threadReport);
    await Promise.allSettled(owner.sourceReaders);
    const engineReport = await owner.sourceEngine._close_report();
    if (engineReport) owner.completedFailure ??= new NativeError(engineReport);
    this.carrier?.unbindEngine(owner.sourceEngine);
    owner.sourceReleased = true;
  }

  private cleanupContextReplacement(owner: ContextReplacement): Promise<void> {
    if (owner.cleanup) return owner.cleanup;
    const pending = (async () => {
      if (!owner.published && owner.change) {
        // Cancel the exact native publication before close can wait behind its prompt.
        const report = await owner.change.cleanupCandidate();
        if (report) owner.completedFailure ??= new NativeError(report);
        await Promise.allSettled(
          [owner.publication, owner.witness].filter((p) => p !== undefined),
        );
        if (owner.candidate) this.carrier?.unbindEngine(owner.candidate);
      }
      if (owner.retiring) {
        if (owner.change && !owner.fenced) {
          await owner.change.fence();
          owner.fenced = true;
        }
        await this.releaseContextSource(owner);
      } else {
        await this.releaseContextChange(owner);
      }
      if (this.contextReplacement === owner)
        this.contextReplacement = undefined;
    })();
    owner.cleanup = pending;
    void pending
      .finally(() => {
        if (owner.cleanup === pending) owner.cleanup = undefined;
      })
      .catch(() => {});
    return pending;
  }
  async saveState(): Promise<SessionState> {
    this.requireCompleteRepairReceipts();
    if (this.options.localStorage)
      throw new TypeError(
        'Local storage does not support saveState; retain Session.id and reopen its profile',
      );
    this.checkCallbackOperation('save');
    if (this.graphStops.size)
      throw new NativeError(
        'saveState is unavailable while Session is stopping',
      );

    this.idle('saveState');
    let snapshot: SessionState | null = null;
    await this.mutate(async () => {
      const state = this.decorateState(
        parseNativeCheckpoint(
          await this.#native._export_checkpoint(null, false),
        ),
      );

      snapshot = state;
    });
    if (!snapshot) throw new NativeError('Native checkpoint was not captured');
    return snapshot;
  }
  async suspend(): Promise<SessionState> {
    if (this.nativeQuestions.size)
      throw new TypeError('Native questions cannot be suspended or serialized');
    if (this.options.localStorage)
      throw new TypeError(
        'Local storage does not support suspend; retain Session.id and reopen its profile',
      );
    if (this.sealedStateJson !== undefined)
      return parseSessionState(this.sealedStateJson);
    this.checkCallbackOperation('suspend');
    if (this.pendingRoots.length)
      throw new NativeError('Cannot suspend while roots are queued');
    if (
      this.graphStops.size ||
      this.lifecycle.kind !== 'turn' ||
      !this.manualCalls.size
    )
      throw new NativeError('suspend requires a pending manual-tool boundary');
    return this.sealManualTurn(this.lifecycle.run);
  }

  /** @internal Capture the original opening authority before a deferred seal. */
  _captureDeferredReopen(request: ManualToolRequest): {
    check(): void;
    open(state: SessionState): Promise<Session<any, any>>;
  } {
    this.checkCallbackOperation('start deferred work on');
    const run = this.lifecycle.kind === 'turn' ? this.lifecycle.run : undefined;
    const reopen = this.options.deferredReopen;
    const active = run && submissions.get(run);
    if (
      !run ||
      !active ||
      !reopen ||
      !this.current(run) ||
      ![...this.manualCalls.values()].some(
        (call) => call.run === run && call.grant.request() === request,
      )
    )
      throw new TypeError('Deferred start requires an original root request');
    const check = () => {
      if (
        this.changedExecutorRoots ||
        this.catalog !== this.openingCatalog ||
        this.#native._application_instructions() !==
          this.threadOptions.instructions
      )
        throw new TypeError(
          'Changed session tools, instructions or writable roots require explicit preparation and restore',
        );
    };
    check();
    return {
      check,
      open: (state) =>
        reopen(state, active.output, active.outputOverride, run.parentTrace),
    };
  }

  /** @internal Read the original restored checkpoint and one current root grant. */
  _deferredCheckpoint(request: ManualToolRequest): {
    serialized: string;
    sourceSessionId: string;
    arguments: JsonValue;
  } {
    this.checkCallbackOperation('advance a deferred request on');
    const run = this.lifecycle.kind === 'turn' ? this.lifecycle.run : undefined;
    const call = [...this.manualCalls.values()].find(
      (entry) =>
        entry.run === run && entry.ready && entry.grant.request() === request,
    );
    if (
      !run ||
      !this.current(run) ||
      run.failure !== undefined ||
      !this.manualRestoring ||
      this.manualSealed ||
      this.manualSealing ||
      this.graphStops.size ||
      !this.restored ||
      !isManualSessionState(this.restored) ||
      request.subagentId !== null ||
      !call
    )
      throw new TypeError(
        'Deferred work requires a current restored root request',
      );
    return {
      serialized: encodeReceipt(this.restored),
      sourceSessionId: this.restored.source_session_id,
      arguments:
        typeof call.event.msg.arguments === 'string'
          ? decode(jsonValue, call.event.msg.arguments)
          : jsonValue.parse(call.event.msg.arguments),
    };
  }

  /** @internal Check model-key privacy without disclosing the key to the coordinator. */
  _validateDeferredResult(
    raw: string,
    privateValues: readonly string[],
  ): unknown {
    // Native authentication trims the Unicode White_Space property from keys.
    const nativeApiKey = this.#modelApiKey?.replace(
      /^\p{White_Space}+|\p{White_Space}+$/gu,
      '',
    );
    const secrets = [...privateValues, this.#modelApiKey, nativeApiKey].filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    );
    const containsSecret = (text: string) =>
      secrets.some((secret) => text.includes(secret));
    if (containsSecret(raw))
      throw new TypeError('Deferred result contains private data');
    const value: unknown = JSON.parse(raw);
    const pending: unknown[] = [value];
    while (pending.length) {
      const item = pending.pop();
      if (typeof item === 'string' && containsSecret(item))
        throw new TypeError('Deferred result contains private data');
      if (Array.isArray(item)) {
        for (const child of item) pending.push(child);
      } else if (item !== null && typeof item === 'object')
        for (const [key, child] of Object.entries(item))
          pending.push(key, child);
    }
    return value;
  }

  /** @internal Deliver through the existing grant owner and retain the original Turn. */
  async _deliverDeferredResult(
    request: ManualToolRequest,
    value: unknown,
    expectedJson: string,
    assertActive: () => void,
  ): Promise<Turn<unknown>> {
    this._deferredCheckpoint(request);
    const run = this.lifecycle.kind === 'turn' ? this.lifecycle.run : undefined;
    if (!run) throw new TypeError('Deferred request is no longer active');
    const expected = encode(outputOf(JSON.parse(expectedJson)));
    const accepted = await this.submitManualResult(
      request.reply(value),
      undefined,
      (output) => {
        assertActive();
        this._deferredCheckpoint(request);
        if (encode(output) !== expected)
          throw new TypeError('Deferred result changed before delivery');
        assertActive();
      },
    );
    if (!accepted) throw new TypeError('Deferred request is no longer active');
    return this.#turnFor(run);
  }

  /** @internal Prepare through the existing seal owner, without granting new reply authority. */
  async _prepareDeferredCheckpoint(
    request: ManualToolRequest,
    validate: (entries: readonly ManualCheckpointEntry[]) => void,
    signal: AbortSignal,
  ): Promise<{ state: SessionState; serialized: string }> {
    this.checkCallbackOperation('prepare');
    signal.throwIfAborted();
    const run = this.lifecycle.kind === 'turn' ? this.lifecycle.run : undefined;
    if (
      !run ||
      !this.current(run) ||
      run.failure !== undefined ||
      this.manualRestoring ||
      this.manualSealed ||
      this.manualSealing ||
      this.graphStops.size ||
      this.options.localStorage ||
      this.environment ||
      this.options.nativeAgents ||
      !this.nativeManualCheckpoint ||
      this.nativeQuestions.size ||
      request.subagentId !== null ||
      submissions.get(run)?.output.schema != null ||
      ![...this.manualCalls.values()].some(
        (call) => call.run === run && call.grant.request() === request,
      )
    )
      throw new TypeError(
        'Deferred preparation requires a current portable root request',
      );
    const state = await this.sealManualTurn(
      run,
      (entries) => {
        if (!entries.some((entry) => entry.request === request))
          throw new TypeError(
            'Deferred preparation requires its current root request',
          );
        validate(entries);
      },
      signal,
    );
    if (this.sealedStateJson === undefined)
      throw new NativeError(
        'Deferred preparation did not retain its checkpoint',
      );
    return { state, serialized: this.sealedStateJson };
  }
  private requireCompleteRepairReceipts(): void {
    if (this.repairReceiptsIncomplete)
      throw new NativeError(
        'Output repair receipts are incomplete; portable capture is unavailable',
      );
  }

  private checkpointSelections(run?: NativeTurn): CheckpointSelections {
    const changedDefaults =
      this.defaultTools.length !== this.catalog.tools.length ||
      this.defaultTools.some((tool, i) => tool !== this.catalog.tools[i]);
    return {
      ...(changedDefaults
        ? { default_tools: this.defaultTools.map(toolIdentity) }
        : {}),
      ...(run?.selection?.names !== undefined
        ? { operation_tools: run.selection.names }
        : {}),
    };
  }

  private checkpointCatalog(
    state: NativeCheckpoint,
    selection: CheckpointSelections,
  ): NativeCheckpoint {
    // Defaults are persisted separately. Keep current admitted declarations so
    // selected manual tools outside those defaults can be checked on restore.
    return selection.default_tools !== undefined ||
      selection.operation_tools !== undefined
      ? {
          ...state,
          managed_tool_specs: decode(jsonValue, this.catalog.specsJson),
        }
      : state;
  }

  private decorateState(state: NativeCheckpoint): SessionState {
    this.requireCompleteRepairReceipts();
    state = this.checkpointCatalog(state, this.checkpointSelections());
    if (!this.restored || isManualSessionState(this.restored))
      return fromNativeCheckpoint(
        state,
        this.defaultOutput.identity,
        this.restored,
        { turns: this.repairTurns, items: this.repairItems },
        undefined,
        this.checkpointSelections(),
        networkPolicyDigest(this.environment?.network),
      );
    const prior = this.restored.recovery;
    const decorated: NativeCheckpoint = {
      ...state,
      recovery: {
        interrupted_thread_ids: [
          ...new Set([
            ...(prior?.interrupted_thread_ids ?? []),
            ...this.restored.interrupted_thread_ids,
          ]),
        ],
        expired_actions: [
          ...(prior?.expired_actions ?? []),
          ...this.restored.pending_actions,
        ],
      },
      root_tool_origins: {
        ...this.restored.root_tool_origins,
        ...state.root_tool_origins,
      },
    };
    return fromNativeCheckpoint(
      decorated,
      this.defaultOutput.identity,
      this.restored,
      { turns: this.repairTurns, items: this.repairItems },
      undefined,
      this.checkpointSelections(),
      networkPolicyDigest(this.environment?.network),
    );
  }

  private async readMcpResults(): Promise<void> {
    const native = this.#native;
    const producer = this.childObservationProducer;
    while (this.isOpen && this.#native === native) {
      const raw = parseNative(await native._next_native_mcp_result());
      if (!this.isOpen || this.#native !== native || raw === null) return;
      const { incarnation, tracing_context, ...notice } =
        nativeMcpResultInfoSchema
          .extend({
            incarnation: z.string().nullable().optional(),
            generation: z.string().optional(),
            tracing_context: z.string().optional(),
          })
          .parse(raw);
      const owner = this.callbackOwner(
        notice.thread_id,
        incarnation,
        notice.turn_id,
        producer,
      );
      if (!owner || !native._handoff_native_mcp_result(notice.nonce)) {
        native._fail_native_mcp_result(
          notice.nonce,
          notice.turn_id,
          notice.call_id,
        );
        native._release_native_mcp_result(notice.nonce);
        continue;
      }
      const callback = async () => {
        try {
          if (owner instanceof NativeTurn) await owner.accepted.promise;
          if (
            !this.current(owner) ||
            (owner instanceof NativeTurn && owner.id !== notice.turn_id) ||
            !native._check_native_mcp_result(
              notice.nonce,
              notice.turn_id,
              notice.call_id,
            )
          )
            return;
          let requestExpired = false;
          const transform = async () => {
            const submission =
              owner instanceof NativeTurn
                ? this.#turnFor(owner)
                : await this.childSubmission(owner);
            if (
              !submission ||
              (!(owner instanceof NativeTurn) &&
                (!this.current(owner) ||
                  !native._check_native_mcp_result(
                    notice.nonce,
                    notice.turn_id,
                    notice.call_id,
                  )))
            ) {
              requestExpired = true;
              return;
            }
            return transformMcpResult(
              this.mcpTools,
              this.mcpGeneration,
              this.options.context,
              submission,
              { ...notice, generation: notice.generation ?? '' },
            );
          };
          let response: unknown;
          if (owner instanceof NativeTurn && tracing_context !== undefined) {
            await this.invokeCallback(
              owner,
              async () => {
                try {
                  response = await transform();
                } catch {
                  throw new NativeError('Native MCP result policy failed');
                }
              },
              owner.controller.signal,
              tracing_context,
            );
          } else {
            response = await withNativeCallbackContext(
              tracing_context,
              transform,
              owner.controller.signal,
              (traceId, workflowSpanId) =>
                this.workflowForTrace(traceId, workflowSpanId),
            );
          }
          if (!requestExpired && this.current(owner)) {
            native._resolve_native_mcp_result(
              notice.nonce,
              notice.turn_id,
              notice.call_id,
              JSON.stringify(losslessJsonValueSchema.parse(response)),
            );
          }
        } catch {
          throw new NativeError('Native MCP result policy failed');
        } finally {
          try {
            // Close owns sender revocation. Otherwise, settle even a retired
            // session's sender before releasing its payload.
            if (
              this.lifecycle.kind !== 'closing' &&
              this.lifecycle.kind !== 'closed'
            ) {
              native._fail_native_mcp_result(
                notice.nonce,
                notice.turn_id,
                notice.call_id,
              );
            }
          } finally {
            native._release_native_mcp_result(notice.nonce);
          }
        }
      };
      if (owner instanceof NativeTurn && tracing_context !== undefined) {
        const pending = Promise.resolve().then(callback);
        this.track(owner, pending, owner.toolInvocations);
      } else {
        this.trackOwnedCallback(owner, callback);
      }
    }
  }
  private callbackOwner(
    threadId: JsonValue | undefined,
    incarnation: JsonValue | undefined,
    turnId: JsonValue | undefined,
    producer: ChildObservationProducer,
  ): NativeTurn | ChildCallbackOwner | null {
    if (threadId === this.id) {
      const run = this.lifecycle.kind === 'turn' ? this.lifecycle.run : null;
      return run && (run.id === null || run.id === turnId) ? run : null;
    }
    if (
      typeof threadId !== 'string' ||
      typeof incarnation !== 'string' ||
      typeof turnId !== 'string' ||
      !this.isOpen
    )
      return null;
    const owner = this.childOwner(threadId, incarnation, turnId, producer);
    if (
      [...this.graphStops].some(
        (stop) =>
          stop.options.scope === 'thread_tree' && stop.options.mode === 'force',
      )
    )
      this.childCallbacks.end(threadId, incarnation, turnId);
    return owner;
  }
  private trackOwnedCallback(
    owner: NativeTurn | ChildCallbackOwner,
    callback: () => Promise<void>,
    tracingContext?: string,
  ): Promise<void> {
    if (owner instanceof NativeTurn) {
      const pending = this.invokeCallback(
        owner,
        callback,
        owner.controller.signal,
        tracingContext,
      );
      this.track(owner, pending);
      return pending;
    } else {
      const pending = Promise.withResolvers<void>();
      pending.promise.catch(() => {});
      this.childCallbacks.track(
        owner,
        async () => {
          const scope = { session: this, child: owner, active: true };
          try {
            await toolInvocation.run(scope, () =>
              withNativeCallbackContext(
                tracingContext,
                callback,
                owner.controller.signal,
                (traceId, workflowSpanId) =>
                  this.workflowForTrace(traceId, workflowSpanId),
              ),
            );
            pending.resolve();
          } catch (error) {
            pending.reject(error);
            throw error;
          } finally {
            scope.active = false;
          }
        },
        async () => {
          const turn = await this.#native._child_turn(owner.childId);
          if (
            turn?.incarnation === owner.incarnation &&
            turn.turn_id === owner.turnId
          )
            await turn.cancel();
        },
      );
      return pending.promise;
    }
  }
  private async readInterceptions(): Promise<void> {
    const native = this.#native;
    const producer = this.childObservationProducer;
    const pending = new Map<
      string,
      {
        owner: NativeTurn | ChildCallbackOwner;
        cancelled: boolean;
        cancel(): void;
      }
    >();
    const identitySchema = z.object({
      owner_id: z.string().regex(/^[1-9][0-9]*$/),
      thread_id: z.string(),
      incarnation: z.string(),
      turn_id: z.string(),
      outer_call_id: z.string(),
      cell_id: z.string(),
    });
    const cellIdentitySchema = identitySchema.omit({ owner_id: true });
    type CellIdentity = z.infer<typeof identitySchema>;
    type CellLease = {
      identity: CellIdentity;
      run: NativeTurn | ChildCallbackOwner;
      controller: AbortController;
      bound: boolean;
      removeAbort?: () => void;
    };
    // Native leases are the only authority for a settled root's callbacks.
    const leases = new Map<string, CellLease>();
    const callbacks = new Map<Promise<void>, NativeTurn | ChildCallbackOwner>();
    const failures: {
      owner: NativeTurn | ChildCallbackOwner;
      error: unknown;
    }[] = [];
    let stopping = false;
    let cleanup: Promise<void> | undefined;
    const matches = (
      lease: CellLease,
      identity: Omit<CellIdentity, 'owner_id'>,
    ) =>
      lease.identity.thread_id === identity.thread_id &&
      lease.identity.incarnation === identity.incarnation &&
      lease.identity.turn_id === identity.turn_id &&
      lease.identity.outer_call_id === identity.outer_call_id &&
      lease.identity.cell_id === identity.cell_id;
    const capture = (identity: CellIdentity): CellLease | undefined => {
      const known = leases.get(identity.owner_id);
      if (known) return matches(known, identity) ? known : undefined;
      if (
        stopping ||
        this.graphStops.size > 0 ||
        !this.isOpen ||
        this.#native !== native
      )
        return;
      const run = this.callbackOwner(
        identity.thread_id,
        identity.incarnation,
        identity.turn_id,
        producer,
      );
      if (!run || !this.current(run)) return;
      const lease: CellLease = {
        identity: Object.freeze(identity),
        run,
        controller: new AbortController(),
        bound: !(run instanceof NativeTurn),
      };
      leases.set(identity.owner_id, lease);
      if (!(run instanceof NativeTurn)) {
        // A child lease belongs to this incarnation and turn, not its parent.
        const abort = () =>
          retire(identity.owner_id, run.controller.signal.reason);
        run.controller.signal.addEventListener('abort', abort, { once: true });
        lease.removeAbort = () =>
          run.controller.signal.removeEventListener('abort', abort);
        if (run.controller.signal.aborted) abort();
      }
      return lease;
    };
    const retire = (
      id: string,
      reason: unknown = new NativeError('Native cell policy owner retired'),
    ) => {
      const lease = leases.get(id);
      if (!lease) return;
      leases.delete(id);
      lease.removeAbort?.();
      lease.controller.abort(reason);
    };
    const stopCallbacks = (
      run?: NativeTurn,
      mode: 'force' | 'graceful' = 'force',
    ): Promise<void> => {
      const matchesOwner = (owner: NativeTurn | ChildCallbackOwner) =>
        owner instanceof NativeTurn && (run === undefined || owner === run);
      // Capture entered work and original leases before abort listeners run.
      // Force revokes only these roots; graceful keeps their replies usable.
      const selected = [...callbacks].filter(([, owner]) =>
        matchesOwner(owner),
      );
      const selectedLeases = [...leases.values()].filter((lease) =>
        matchesOwner(lease.run),
      );
      const reservations = [...pending.values()].filter((reservation) =>
        matchesOwner(reservation.owner),
      );
      if (mode === 'force') {
        for (const lease of selectedLeases) {
          try {
            retire(lease.identity.owner_id);
          } catch (error) {
            failures.push({ owner: lease.run, error });
          }
        }
        for (const reservation of reservations) {
          try {
            reservation.cancel();
          } catch (error) {
            failures.push({ owner: reservation.owner, error });
          }
        }
      }
      return Promise.allSettled(selected.map(([task]) => task)).then(() => {
        const errors = failures
          .filter(({ owner }) => matchesOwner(owner))
          .map(({ error }) => error);
        if (errors.length)
          throw new AggregateError(
            [...new Set(errors)],
            'Native policy callback stop failed',
          );
      });
    };
    this.interceptionStops.add(stopCallbacks);
    const stop = (): Promise<void> => {
      if (cleanup) return cleanup;
      stopping = true;
      this.interceptionStops.delete(stopCallbacks);
      for (const lease of leases.values()) {
        try {
          retire(lease.identity.owner_id);
        } catch (error) {
          failures.push({ owner: lease.run, error });
        }
      }
      for (const reservation of pending.values()) {
        try {
          reservation.cancel();
        } catch (error) {
          failures.push({ owner: reservation.owner, error });
        }
      }
      cleanup = (async () => {
        // Include callbacks whose lease retired before close, and callbacks
        // that ignore cancellation until their actual application work returns.
        while (callbacks.size) await Promise.allSettled([...callbacks.keys()]);
        if (failures.length) {
          throw new AggregateError(
            [...new Set(failures.map(({ error }) => error))],
            'Native policy callback cleanup failed',
          );
        }
      })();
      cleanup.then(
        () => this.interceptionCleanups.delete(stop),
        () => {},
      );
      return cleanup;
    };
    this.interceptionCleanups.add(stop);
    try {
      while (!stopping && this.isOpen && this.#native === native) {
        const raw = parseNative(await native._next_native_interception());
        if (!this.isOpen || this.#native !== native || raw === null) return;
        const notice = z
          .union([
            z.object({ cancel: z.string() }),
            z.object({ cell_owner_retired: z.string() }),
            z.object({ nonce: z.string(), cell_owner: identitySchema }),
            z.object({
              nonce: z.string(),
              generation: z.string().optional(),
              request: losslessJsonObjectSchema,
            }),
          ])
          .parse(raw);
        if ('cancel' in notice) {
          const reservation = pending.get(notice.cancel);
          if (reservation) reservation.cancel();
          else native._release_native_interception(notice.cancel);
          continue;
        }
        if ('cell_owner_retired' in notice) {
          retire(notice.cell_owner_retired);
          continue;
        }
        const binding = 'cell_owner' in notice;
        const request = binding ? undefined : notice.request;
        let lease: CellLease | undefined;
        let needsLease = binding;
        if (binding) {
          lease = capture(notice.cell_owner);
        } else if (
          notice.generation === undefined &&
          request!.thread_id === this.id &&
          request!.route === 'code_mode'
        ) {
          const name = request!.tool_name;
          const builtin =
            name &&
            typeof name === 'object' &&
            !Array.isArray(name) &&
            (name.namespace === null ||
              name.namespace === '' ||
              name.namespace === 'functions') &&
            (name.name === 'exec_command' ||
              name.name === 'write_stdin' ||
              name.name === 'apply_patch');
          const before =
            request!.phase === 'before' && request!.boundary === 'pre_dispatch';
          const after =
            request!.phase === 'after' &&
            request!.boundary === 'executor_return';
          needsLease = after || request!.cell_owner_id !== undefined;
          if (
            builtin &&
            (before || after) &&
            typeof request!.runtime_tool_call_id === 'string'
          ) {
            const identity = {
              thread_id: request!.thread_id,
              incarnation: request!.incarnation,
              turn_id: request!.turn_id,
              outer_call_id: request!.outer_call_id,
              cell_id: request!.cell_id,
            };
            if (before && request!.cell_owner_id !== undefined) {
              const parsed = identitySchema.safeParse({
                ...identity,
                owner_id: request!.cell_owner_id,
              });
              if (parsed.success) lease = capture(parsed.data);
            } else if (after && request!.cell_owner_id === undefined) {
              const parsed = cellIdentitySchema.safeParse(identity);
              if (parsed.success) {
                const matching = [...leases.values()].filter(
                  (candidate) =>
                    candidate.bound && matches(candidate, parsed.data),
                );
                if (matching.length === 1) lease = matching[0];
              }
            }
          }
        }
        const owner =
          lease?.run ??
          (needsLease
            ? null
            : this.callbackOwner(
                request!.thread_id,
                request!.incarnation,
                request!.turn_id,
                producer,
              ));
        if (!owner || !native._handoff_native_interception(notice.nonce)) {
          native._resolve_native_interception(
            notice.nonce,
            '{"action":"deny"}',
          );
          native._release_native_interception(notice.nonce);
          continue;
        }
        const controller = new AbortController();
        const reservation = {
          owner,
          cancelled: false,
          cancel: () => {
            if (reservation.cancelled) return;
            reservation.cancelled = true;
            controller.abort(
              new NativeError('Native policy reservation ended'),
            );
            native._resolve_native_interception(
              notice.nonce,
              '{"action":"deny"}',
            );
          },
        };
        const ownerSignal = lease?.controller.signal ?? owner.controller.signal;
        const signal = AbortSignal.any([ownerSignal, controller.signal]);
        const expectedCancellation = (error: unknown) =>
          signal.aborted &&
          (Object.is(error, signal.reason) ||
            (!lease &&
              owner.controller.signal.aborted &&
              Object.is(error, owner.controller.signal.reason)));
        const abort = () => reservation.cancel();
        ownerSignal.addEventListener('abort', abort, { once: true });
        if (ownerSignal.aborted) abort();
        pending.set(notice.nonce, reservation);
        const active = () =>
          !stopping &&
          this.isOpen &&
          this.#native === native &&
          (lease
            ? leases.get(lease.identity.owner_id) === lease &&
              !lease.controller.signal.aborted
            : this.current(owner));
        const failOwner = () => {
          const error = new NativeError('Executor policy failed');
          owner.failure ??= error;
          if (owner instanceof NativeTurn && this.current(owner)) {
            toolInvocation.exit(() => {
              void this.#cancel(owner).catch((cause) =>
                this.readerFailed(cause),
              );
            });
          } else owner.controller.abort(error);
        };
        const requestStop = (
          message:
            'Turn stopped by MCP policy' | 'Turn stopped by executor policy',
        ): boolean => {
          if (!active() || reservation.cancelled) return false;
          // Atomically claim the original nonce and capture its owner;
          // neither this callback nor its reason crosses the bridge.
          const stopped = native._hold_native_interception_for_stop(
            notice.nonce,
          );
          if (!stopped) return false;
          reservation.cancelled = true;
          const error = new NativeError(message);
          owner.failure ??= error;
          owner.controller.abort(error);
          // Retirement must run after this entered callback returns.
          // Joining it here would wait on ourselves.
          const retirement = task.then(() =>
            toolInvocation.exit(() => stopped.finish()),
          );
          void this.trackOwnedCallback(owner, () => retirement).catch(
            (cause: unknown) => {
              failures.push({ owner, error: cause });
            },
          );
          return true;
        };
        const callback = async () => {
          try {
            if (owner instanceof NativeTurn) await owner.accepted.promise;
            if (
              !active() ||
              reservation.cancelled ||
              !native._check_native_interception(notice.nonce)
            )
              return;
            if (lease && !lease.bound) {
              // A provisional owner can wait for submit acceptance, but cannot
              // bind to a successor while this channel keeps reading.
              if (
                !(lease.run instanceof NativeTurn) ||
                !this.current(lease.run) ||
                lease.run.id !== lease.identity.turn_id
              )
                return;
              lease.bound = true;
            }
            if (
              !active() ||
              (owner instanceof NativeTurn &&
                owner.id !== (lease?.identity.turn_id ?? request!.turn_id)) ||
              reservation.cancelled
            )
              return;
            if (binding) {
              native._resolve_native_interception(
                notice.nonce,
                '{"action":"continue"}',
              );
              return;
            }
            let reply: string;
            try {
              const submission =
                owner instanceof NativeTurn
                  ? this.#turnFor(owner)
                  : await this.childSubmission(owner);
              if (!submission) return;
              if (
                !(owner instanceof NativeTurn) &&
                (!active() ||
                  reservation.cancelled ||
                  !native._check_native_interception(notice.nonce))
              )
                return;
              const toolName = request!.tool_name;
              const collaboration =
                toolName &&
                typeof toolName === 'object' &&
                !Array.isArray(toolName) &&
                toolName.namespace === 'collaboration';
              const response =
                notice.generation !== undefined
                  ? await applyMcpPrePolicy(
                      this.mcpTools,
                      this.mcpGeneration,
                      this.options.context,
                      submission,
                      { ...request!, _mcp_generation: notice.generation },
                      signal,
                      () => {
                        if (
                          !this.current(owner) ||
                          reservation.cancelled ||
                          notice.generation !== this.mcpGeneration.toString() ||
                          !native._check_native_interception(notice.nonce)
                        )
                          throw new NativeError(
                            'Native MCP policy is no longer active',
                          );
                      },
                      () => reservation.cancel(),
                      () => {
                        requestStop('Turn stopped by MCP policy');
                      },
                    )
                  : this.options.nativeAgents && collaboration
                    ? await applyNativeAgentsApproval(
                        this.options.nativeAgents,
                        this.options.context,
                        submission,
                        request!,
                        signal,
                      )
                    : this.environment instanceof Environment &&
                        hasExecutorPolicy(this.environment)
                      ? await applyExecutorPolicy(
                          this.environment,
                          this,
                          this.options.applicationAgent!,
                          this.options.context,
                          submission,
                          request!,
                          signal,
                          failOwner,
                          () => requestStop('Turn stopped by executor policy'),
                        )
                      : null;
              reply =
                response == null
                  ? '{"action":"deny"}'
                  : JSON.stringify(losslessJsonValueSchema.parse(response));
            } catch (cause) {
              // An abort-ignoring callback can return normally, after which
              // the SDK throws its supplied signal reason. That is a stop,
              // not an application failure or a reason to cancel a successor.
              getCurrentSpan()?.end({
                status: signal.aborted ? 'cancelled' : 'error',
                category: signal.aborted ? 'cancelled' : 'callback_error',
              });
              if (expectedCancellation(cause)) return;
              const cleanupFailure =
                signal.aborted || (lease !== undefined && !this.current(owner));
              if (
                notice.generation === undefined &&
                this.environment instanceof Environment &&
                hasExecutorPolicy(this.environment)
              )
                failOwner();
              // Retained failures belong to the original callback's cleanup,
              // even when that run's public result has already settled.
              if (cleanupFailure) throw cause;
              reply = '{"action":"deny"}';
            }
            if (
              active() &&
              !reservation.cancelled &&
              native._check_native_interception(notice.nonce)
            )
              native._resolve_native_interception(notice.nonce, reply);
          } finally {
            ownerSignal.removeEventListener('abort', abort);
            pending.delete(notice.nonce);
            try {
              if (!reservation.cancelled)
                native._resolve_native_interception(
                  notice.nonce,
                  '{"action":"deny"}',
                );
            } finally {
              native._release_native_interception(notice.nonce);
            }
          }
        };
        const tracingContext =
          typeof request?.tracing_context === 'string'
            ? request.tracing_context
            : undefined;
        const task: Promise<void> =
          lease && lease.run instanceof NativeTurn
            ? this.invokeCallback(lease.run, callback, signal, tracingContext)
            : this.trackOwnedCallback(owner, callback, tracingContext);
        if (lease && lease.run instanceof NativeTurn) {
          // A native cell outlives normal root completion. Its reader owns
          // cleanup; the ordinary run result must not wait for this callback.
          lease.run.toolInvocations.delete(task);
        }
        callbacks.set(task, owner);
        task.then(
          () => callbacks.delete(task),
          (error: unknown) => {
            callbacks.delete(task);
            // Abort-aware callbacks may reject with their supplied signal.
            // Keep actual application/cleanup failures, not expected stops.
            if (!expectedCancellation(error)) failures.push({ owner, error });
          },
        );
      }
    } finally {
      try {
        await stop();
      } finally {
        native._finish_native_interception_reader();
      }
    }
  }

  private async closeNative(): Promise<NativeError | undefined> {
    if (
      this.environment instanceof Environment &&
      !this.selectedEnvironmentRetirementAttempted
    ) {
      // A genuinely incomplete native shutdown may be retried, but its
      // explicit remote termination attempt must not be started again.
      this.selectedEnvironmentRetirementAttempted = true;
      const message = await this.#native._close_selected_environment();
      if (message) return new NativeError(message);
    } else {
      const message = await this.#native._close_report();
      if (message) return new NativeError(message);
    }
    return undefined;
  }

  /**
   * Closes the session and releases its resources.
   *
   * The call that closes the session can reject if command termination is
   * unconfirmed. A later call on an already closed session returns without
   * rechecking command termination.
   */
  close(): Promise<void> {
    return this.closeOwned();
  }

  /** @internal Only the owned run wrapper can request its exact cancellation receipt. */
  _closeOwnedRun(accepted: (rejection: unknown) => void): Promise<void> {
    return this.closeOwned(accepted);
  }

  private closeOwned(
    acceptedCancellation?: (rejection: unknown) => void,
  ): Promise<void> {
    this.checkCallbackOperation('close');
    const state = this.lifecycle;
    if (state.kind === 'closed') {
      if (this.environmentCloseFailure) return this.environmentCloseFailure;
      // Completed persistent cleanup retains the engine's durability report.
      // Release-only diagnostics have already been consumed by native close.
      return this.options.localStorage
        ? this.#engine._close_report().then((message) => {
            if (message) throw new NativeError(message);
          })
        : Promise.resolve();
    }
    if (state.kind === 'closing') return state.completion;
    const interceptionFailures: unknown[] = [];
    // Resolving or declining a callback can wake the model loop. Fence new
    // requests before revoking callbacks, and let native close own teardown.
    try {
      this.#native._stop_sampling_for_close();
    } catch (error) {
      interceptionFailures.push(error);
    }
    if (this.starting)
      this.failStartup(new TurnAborted('Session closed while opening'));
    const done = Promise.withResolvers<void>();
    const tracingCapture = this.options.tracingCapture;
    void done.promise
      .then(
        () => tracingCapture?.finish(),
        (error: unknown) => tracingCapture?.finish(error ?? null),
      )
      .catch(() => {});
    const run =
      state.kind === 'turn' || state.kind === 'retired' ? state.run : undefined;
    if (run && submissions.get(run)!.observation !== 'ended')
      submissions.get(run)!.observation = 'finishing';
    const repair = run && submissions.get(run)?.repair;
    const repairWasFinished = repair?.finished;
    if (repair) this.stopCorrection(repair, 'force');
    let phase: ClosePhase = state.kind === 'retired' ? state.phase : 'revoke';
    let acknowledgmentFailure =
      state.kind === 'retired' ? state.completedCloseFailure : undefined;
    const graphStopFailures: unknown[] = [];
    const joinGraphStops = async () => {
      const stops = [...this.graphStops];
      const results = await Promise.allSettled(
        stops.map((stop) => stop.completion),
      );
      results.forEach((result) => {
        if (result.status === 'rejected') graphStopFailures.push(result.reason);
      });
      for (const stop of stops) this.graphStops.delete(stop);
    };
    const settleClose = (primary?: unknown) => {
      const failures = [
        ...(primary === undefined ? [] : [primary]),
        ...this.oneShotChildCleanupErrors,
        ...interceptionFailures,
        ...(acknowledgmentFailure ? [acknowledgmentFailure] : []),
      ];
      if (graphStopFailures.length) {
        // A background stop can observe the same run/child failure as close.
        // Keep the original close errors and add only distinct stop failures.
        const seen = new Set<unknown>();
        const collect = (error: unknown, append: boolean): void => {
          if (seen.has(error)) return;
          seen.add(error);
          if (error instanceof AggregateError && error.errors.length)
            for (const nested of error.errors) collect(nested, append);
          else if (append) failures.push(error);
        };
        for (const error of failures) collect(error, false);
        for (const error of graphStopFailures) collect(error, true);
      }
      if (failures.length > 1) {
        done.reject(
          new AggregateError(failures, 'Session cleanup failed', {
            cause: failures[0],
          }),
        );
      } else if (failures.length) {
        done.reject(failures[0]);
      } else {
        done.resolve();
      }
    };
    this.lifecycle = { kind: 'closing', completion: done.promise };
    // Revoke every reader's leases now, including callbacks from settled runs.
    // Join after native shutdown, and retain failures on both close paths.
    const interceptionCleanup = Promise.allSettled(
      [...this.interceptionCleanups].map((stop) => {
        try {
          return stop();
        } catch (error) {
          return Promise.reject(error);
        }
      }),
    ).then((results) => {
      for (const result of results)
        if (result.status === 'rejected')
          interceptionFailures.push(result.reason);
    });

    this.discardPending(
      new TurnAborted('Session closed before queued admission'),
    );
    this.childCallbacks.stop();
    this.clearManualCalls();
    done.promise.catch(() => {});
    void (async () => {
      if (repair) {
        const failure = await repair.completion.then(
          () => undefined,
          (error: unknown) => error,
        );
        if (repair.session || repair.opening?.failedOpeningCleanup) {
          if (!repairWasFinished && failure !== undefined) throw failure;
          await this.closeCorrection(repair);
          await repair.opening?.failedOpeningCleanup?.();
          repair.opening = undefined;
        }
      }
      // A manual capture owns the native thread and checkpoint writer until it
      // settles. Closing revokes publication immediately, but joins its writes.
      await this.manualSeal?.catch(() => {});
      if (state.kind === 'mutation') await state.completion.catch(() => {});
      if (state.kind === 'retired') await state.mutation?.catch(() => {});
      const replacement = this.contextReplacement;
      if (replacement) {
        await this.cleanupContextReplacement(replacement);
        acknowledgmentFailure ??= replacement.completedFailure;
        if (!replacement.published && replacement.sourceReleased)
          phase = 'carrier';
        else if (
          !replacement.published &&
          replacement.fenced &&
          phase === 'revoke'
        )
          phase = 'native';
      }

      if (run && (phase === 'revoke' || phase === 'native')) {
        const closed =
          state.kind === 'retired'
            ? state.cause
            : new TurnAborted('Session closed');

        this.retireNativeQuestions(run);
        this.clearManualCalls(run);
        run.controller.abort(closed);
        try {
          // Stop native sampling before joining callbacks whose results may
          // already have been accepted. Keep the engine until cleanup finishes.
          acknowledgmentFailure =
            (await this.closeNative()) ?? acknowledgmentFailure;
        } finally {
          await run.mcpPublication?.catch(() => {});
          await Promise.allSettled([
            ...run.toolInvocations,
            ...run.manualReplies,
          ]);
          const error = cleanupFailure(run, run.failure ?? closed);
          if (
            state.kind === 'turn' &&
            run.failure === undefined &&
            error === closed
          )
            acceptedCancellation?.(error);
          run.accepted.reject(error);
          run.completion.reject(error);
        }
      }
      if (phase === 'revoke') {
        if (
          this.options.nativeAgents ||
          this.options.mcpTools ||
          (this.environment instanceof Environment &&
            hasExecutorPolicy(this.environment))
        )
          this.#native._revoke_native_interception();
        if (this.mcpReaderStarted) this.#native._revoke_native_mcp_results();
        phase = 'native';
      }
      if (phase === 'native' && this.starting) {
        const message = await this.#engine._close_report();
        if (message) acknowledgmentFailure ??= new NativeError(message);
        // The post-Thread engine shutdown must finish before joining a held publication.
        const startup = this.starting;
        const settled = await Promise.allSettled([
          ...(startup.publication ? [startup.publication] : []),
          ...this.readers,
        ]);
        const errors = settled.flatMap((result) =>
          result.status === 'rejected' && result.reason !== startup.cause?.value
            ? [result.reason]
            : [],
        );
        if (errors.length)
          acknowledgmentFailure = new NativeError(
            'Native startup cleanup failed',
            {
              cause: new AggregateError([
                ...(acknowledgmentFailure ? [acknowledgmentFailure] : []),
                ...errors,
              ]),
            },
          );
        this.starting = undefined;
        phase = 'carrier';
      }
      if (phase === 'native') {
        try {
          await this.discardForkCopy();
        } catch (error) {
          if (this.forkCopy) throw error;
          acknowledgmentFailure ??= error as NativeError;
        }
        acknowledgmentFailure =
          (await this.closeNative()) ?? acknowledgmentFailure;
        await Promise.allSettled(this.readers);
        phase = 'engine';
      }
      await interceptionCleanup;
      await this.childCallbacks.close();
      // Native close escalates any graceful stop. Join its callback/native
      // owners before releasing the engine, without waiting before closeNative.
      await joinGraphStops();
      await Promise.allSettled([...this.childContinuations]);
      if (phase === 'engine') {
        const message = await this.#engine._close_report();
        if (message) acknowledgmentFailure ??= new NativeError(message);
        phase = 'carrier';
      }
      if (phase === 'carrier') {
        await this.carrier?.close();
        phase = 'provider';
      }
      if (phase === 'provider') {
        try {
          if (!this.environmentDisposalFinished) {
            try {
              await this.options.environmentOwner?.dispose(async (dispose) => {
                const scope = { session: this, active: true };
                try {
                  await toolInvocation.run(scope, dispose);
                } finally {
                  scope.active = false;
                }
              });
            } catch (error) {
              // Automatic source retirement may have no current waiter. Keep its
              // failed close joinable after all remaining owners have retired.
              this.environmentCloseFailure ??= done.promise;
              acknowledgmentFailure = new NativeError(
                'Environment lease cleanup failed',
                {
                  cause: acknowledgmentFailure
                    ? new AggregateError(
                        [acknowledgmentFailure, error],
                        'Session and environment cleanup failed',
                      )
                    : error,
                },
              );
            } finally {
              this.environmentDisposalFinished = true;
            }
          }
          await this.options.onClose?.();
        } finally {
          // Native, readers and child callbacks have joined; late discovery is now impossible.
          this.options.tracingCapture = undefined;
          for (const owned of [
            run,
            this.lastRun,
            ...this.issuedRuns.values(),
          ]) {
            if (owned) {
              owned.tracing = undefined;
              owned.issuedTracing = undefined;
            }
          }
        }
      }
      this.observations.finish('closed');
      if (run) this.finishObservation(run);
      this.lifecycle = { kind: 'closed', completion: done.promise };

      settleClose(run ? cleanupFailure(run) : undefined);
    })().catch(async (error) => {
      await interceptionCleanup;
      // Entered SDK child handlers must finish even when native teardown fails.
      // Keep concurrent close calls on this promise until their cleanup joins.
      await this.childCallbacks.close();
      // An early failure may precede native shutdown. Retain graph stops for
      // the close retry; a graceful stop can still need native close to settle.
      this.observations.finish('failed');
      if (run) this.finishObservation(run);
      this.lifecycle = {
        kind: 'retired',
        phase,
        cause: error,
        run,
        completedCloseFailure: acknowledgmentFailure,
      };
      settleClose(run ? cleanupFailure(run, error) : error);
    });
    return done.promise;
  }
  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}

function modelOverrides(model?: string, settings?: ModelSettings): JsonObject {
  const overrides: JsonObject = {};
  if (model !== undefined) overrides.model = model;
  if (settings?.reasoningEffort !== undefined)
    overrides.effort = settings.reasoningEffort;
  if (settings?.reasoningSummary !== undefined)
    overrides.summary = settings.reasoningSummary;
  if (settings?.serviceTier !== undefined)
    overrides.service_tier = settings.serviceTier;
  if (settings?.toolChoice !== undefined)
    overrides.tool_choice = settings.toolChoice;
  return overrides;
}
