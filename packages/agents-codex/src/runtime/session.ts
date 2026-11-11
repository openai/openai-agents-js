import { audioInputByteLimit } from './media';
import {
  ManagedWorkspaceCheckpoint,
  captureRetiredWorkspace,
  managedWorkspaceRestore,
  type ManagedWorkspaceBinding,
} from './managed-workspace';
import {
  hasRealtimeAgentConfiguration,
  resolveRealtimeAgentConfiguration,
} from './realtime-agent-config';
import { resolveRealtimePolicy } from './realtime-policy';
import type { ChildBeforeStepContext } from './native-agents';
import {
  GuardrailTripwire,
  captureGuardrailResult,
  type GuardrailRecord,
  type InputGuardrail,
  type OutputGuardrail,
} from './guardrails';
import { closeComputerResources } from './computer';
import {
  captureModelResponse,
  type NativeModel,
  type ModelProvider,
} from './models';
import {
  bindDecide,
  decisionBinding,
  type BoundDecide,
  type DecisionProvider,
} from './decisions';
import {
  captureCompletionDecision,
  type BeforeComplete,
  type CompletionContext,
  type CompletionDecision,
  type BeforeCompact,
  type ContextTransform,
} from './model-callbacks';
import { isDeepStrictEqual } from 'node:util';
import {
  managedCallInfo,
  terminalCallInfo,
  toolCompletionSchema,
  type ToolCallInfo,
} from './call-metadata';
import { isBackgroundToolResponse } from './background-result';
import {
  allocatedProfileCatalogs,
  checkProfileReceipt,
  parseProfileReceipt,
  profileInteger,
  profileRoster,
  encodeProfileReceipt,
  type AgentProfileReceipt,
  type AgentProfileRuntime,
  type CapturedAgentGraph,
} from './agent-profiles';
import {
  createNativeRealtimeOwner,
  realtimePrepareParams,
  type NativeRealtimeSipConfigOptions,
  type NativeRealtimeSession,
  type NativeRealtimeOptions,
} from './realtime';
import { serializeRealtimeSettings } from './realtime-settings';
import { privateRuntime } from './private-engine-reuse';
import {
  capturePreparedRequest,
  preparedRequestFromNative,
  type PreparedRequestData,
} from './prepared-request';
import {
  captureTracing,
  captureTraceValidation,
  getCurrentSpan,
  workflowForTrace,
  withoutTracing,
  TraceCapture,
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
import { projectResponseFactRecord } from './response-facts';
import { networkPolicyDigest } from './network-policy';
import { apiRateLimits, type ApiRateLimits } from './api-rate-limits';
import { parsePlanUsage, type CodexPlanUsage } from './plan-usage';
import {
  parseEmbeddedCommand,
  nativeReviewOutput,
  type EmbeddedCommandResult,
  type NativeReviewOutput,
} from './commands';
import {
  assertAdmittedToolReference,
  checkpointDefaultTools,
  checkpointResourceServers,
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
  type InteractionHandler,
  type Interaction,
  type NativeQuestionPresentation,
} from './native-questions';
import { createUrlCompletion } from './url-elicitation';
import { prepareNativeForm, type PreparedNativeForm } from './native-forms';
import { z } from 'zod';
import type { WebSearch } from './web-search';
import { hostedToolSpecs, type HostedTool } from './hosted-tools';
import {
  assertOutputRepairSupported,
  OutputValidationError,
  prepareOutput,
  parseToolCompletion,
  type OutputSpec,
  type PreparedOutput,
} from './output';

import { AsyncLocalStorage } from 'node:async_hooks';
import { addAbortListener } from 'node:events';
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
import { FunctionAdmission } from './function-admission';
import {
  nativeAgentsPolicyRules,
  applyNativeAgentsApproval,
  type NativeAgents,
} from './native-agents';
import {
  modelOverrides,
  type ModelSettings,
  type ProviderLease,
} from './provider';
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
  StdioMCP,
  selectHttpLeaves,
  resourceMcpBinding,
  mcpConfig,
  mcpPolicies,
  mcpPrePolicyRules,
  hasMcpPrePolicy,
  applyMcpPrePolicy,
  mcpToolNames,
  mcpRefIdentity,
  checkMcpPublication,
  transformMcpResult,
  splitToolDeclarations,
  isHostedRegistration,
  type McpTool,
  type MCPListResourcesResult,
  type MCPListResourceTemplatesResult,
  type MCPReadResourceResult,
  type MCPPrompt,
  type MCPGetPromptResult,
} from './mcp';
import {
  createManualRequest,
  isFunctionApprovalRequest,
  type ApprovalDecision,
  isManualReply,
  manualResultSchema,
  supportsManualCheckpoint,
  type ManualTool,
  type ManualToolReply,
  type ManualToolRequest,
} from './manual';
import {
  binding,
  decode,
  encode,
  encodeReceipt,
  encodeOperationSelection,
  jsonObject,
  losslessJsonObjectSchema,
  losslessJsonValueSchema,
  parseNative,
  type Engine,
  type JsonObject,
  type JsonValue,
  type NativeThread,
} from './binding';
import {
  nativeMarker,
  parseEvent,
  parseEvents,
  requestTypes,
  type NativeEvent,
} from './events';
import {
  tokenUsageInfo,
  addRunUsage,
  addTokenCounts,
  parseTokenCount,
  captureUsageReport,
  usageReportBinding,
  runUsageSnapshot,
  mergeRunUsage,
  type TokenUsage,
  type UsageReporter,
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
  type CanonicalHistorySnapshot,
} from './history';
import type { ThreadOptions } from './options';
import {
  storedOptions,
  storedTurnPage,
  storedItemPage,
  storedMatchPage,
  storedSessionPage,
  type StoredSessionPage,
  type StoredForkOptions,
  type StoredTurnPage,
  type StoredItemPage,
  type StoredMatchPage,
} from './stored-history';
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
import {
  captureWritableRoots,
  Environment,
  projectSearchRuntime,
} from './environment';
import {
  managedApproval,
  ToolOutput,
  toolOutputSchema,
  captureTools,
  isDirectFunctionTool,
  toolIdentity,
  toolRef,
  type ToolRef,
  toolNamespace,
  toolDeclarationIdentity,
  type ToolSelector,
  invokeFunctionTool,
  toolErrorFormatterBinding,
  type ToolErrorFormatter,
  registerToolSessionOwner,
  outputOf,
  type ToolResponse,
  type SessionTool,
  type Tool,
  type ToolCatalog,
  type FunctionTool,
  type ToolCallContext,
} from './tools';
import type { NativeProviderRoutes } from './http-model';

type ToolStatus = 'completed' | 'failed' | 'cancelled';

interface CapturedStepMcp {
  readonly servers: readonly McpTool[];
  readonly names: readonly ReturnType<typeof toolIdentity>[];
  readonly projection: readonly {
    server: string;
    tool: string;
    namespace: string;
    name: string;
  }[];
  readonly generation: bigint;
}
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
  z.object({
    status: z.literal('not_submitted'),
    reason: losslessJsonValueSchema,
  }),
]);
export type AcceptedSubmission = Exclude<
  z.infer<typeof submissionSchema>,
  { status: 'not_submitted' }
>;

export interface SessionOptions {
  modelBackend?: NativeModel | ModelProvider;
  /** @internal The Session uses the registered ChatGPT plan inference route. */
  chatGPTPlan?: boolean;
  /** @internal Captured provider credential, independent of text producer admission. */
  realtimeApiKey?: string;
  decisions?: DecisionProvider;
  observationRetention?: 'bounded' | 'all';
  includeRawProviderEvents?: boolean;
  beforeComplete?: BeforeComplete<any>;
  inputGuardrails?: readonly InputGuardrail<any>[];
  outputGuardrails?: readonly OutputGuardrail<any>[];
  /** @internal Captured root declaration; profile declarations own child guards. */
  agentInputGuardrails?: readonly InputGuardrail<any>[];
  /** @internal Captured root declaration; profile declarations own child guards. */
  agentOutputGuardrails?: readonly OutputGuardrail<any>[];
  beforeCompact?: BeforeCompact<any>;
  transformContext?: ContextTransform<any>;
  contextTransformPurpose?: 'turn' | 'output_repair';
  /** @internal Detached fresh-opening data; removed before Session construction. */
  initialMessages?: readonly import('./initial-messages').InitialMessage[];
  maxFunctionConcurrency?: number;
  onInteraction?: InteractionHandler;
  toolErrorFormatter?: ToolErrorFormatter<any>;
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
    transformContext?: ContextTransform<any>,
  ) => Promise<Session<string>>;
  applicationAgent?: import('./public-agent').Agent<any, any>;
  realtimeDeclaration?: import('./public-agent').Agent<any, any>;
  /** @internal Sealed live declarations; excluded from persisted options. */
  agentGraph?: CapturedAgentGraph & { readonly fingerprint: string };
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
  /** @internal Current application source; never persisted. */
  managedWorkspace?: ManagedWorkspaceBinding;
  /** @internal Reauthorize only a validated paired workspace opening. */
  [managedWorkspaceRestore]?: true;
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
  beforeStep?: OperationOptions<any>['beforeStep'];
  /** Private single-use owned-factory grant; never interpreted by truthiness. */
  privateEngineGrant?: object;
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
   * Return { action: 'stop' } to stop this turn before its pending model request.
   * Earlier tool effects remain; the stop does not accept a final answer.
   * An exhausted step limit or run budget blocks this callback.
   */
  beforeStep?: (
    context: BeforeStepContext<Context>,
  ) => StepDecision<Context> | Promise<StepDecision<Context>>;
}
/** Keep the operation tools, select a subset, or stop the exact owning turn. */
export type StepDecision<Context = unknown> =
  readonly ToolSelector<Context>[] | { readonly action: 'stop' } | undefined;

function isStepStop<Context>(
  decision: StepDecision<Context>,
): decision is { readonly action: 'stop' } {
  return (
    decision !== undefined && 'action' in decision && decision.action === 'stop'
  );
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
  readonly decide: BoundDecide;
  readonly context: Context;
  readonly submission: Turn<unknown>;
  readonly stepIndex: number;
  readonly signal: AbortSignal;
}
/** Start one independent root. A busy Session rejects; use enqueue or Turn.steer explicitly. */
export interface SubmitOptions<
  Context = unknown,
  Output = never,
> extends OperationOptions<Context> {
  outputType?: OutputSpec<Output>;
  ifBusy?: 'reject';
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
  readonly originCatalog?: ToolCatalog;
  readonly originMcp?: readonly McpTool[];
  readonly originProfileId?: string;
  readonly operationDeclarationSource?: AgentProfileReceipt;
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
  /** Present when a validated direct function call supplied the final output. */
  readonly toolCall?: ToolCallInfo;
  /** Cumulative native thread usage at completion, rather than a per-turn delta. */
  readonly threadUsage: TokenUsageInfo | null;
  readonly runUsage: RunUsage;
  readonly state?: SessionState;
  /** Conversation records from returnHistory, for replay with the destination Session's instructions. */
  readonly history?: CanonicalHistorySnapshot['items'];
  readonly repairAttempts: readonly RecordedTurn[];
  readonly guardrailResults?: readonly GuardrailRecord[];
}

/** Wait for the captured turn's completion or its current manual request batch. */
export interface RequestWaitOptions {
  until: 'manual_tool';
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
    | 'interrupted'
    | 'connection_lost'
    | 'rate_limited'
    | 'quota_blocked'
    | 'budget_exceeded';
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
  if (
    error.code === 'run_budget_exceeded' ||
    error.code === 'run_budget_usage_unavailable'
  )
    return 'budget_exceeded';
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
  guardrailResults?(): readonly GuardrailRecord[];
  runUsage?(): RunUsage;
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

  get guardrailResults(): readonly GuardrailRecord[] {
    return Object.freeze([...(this.requests?.guardrailResults?.() ?? [])]);
  }

  /** Detached measured totals; root snapshots include exactly attributed native children. */
  get runUsage(): RunUsage {
    return this.requests?.runUsage?.() ?? runUsageSnapshot(null);
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
      agent: import('./public-agent').Agent<any, any>;
      model?: never;
      modelSettings?: never;
      instructions?: never;
      tools?: never;
    }
  | {
      agent?: never;
      model?: string;
      modelSettings?: ModelSettings;
      instructions?: never;
      tools?: never;
    }
  | {
      agent?: never;
      instructions: string;
      model?: never;
      modelSettings?: never;
      tools?: never;
    }
  | {
      agent?: never;
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

interface ToolInvocation {
  session: Session<any, any>;
  run?: NativeTurn;
  child?: ChildCallbackOwner;
  active: boolean;
  realtimeAdapter?: object;
  parent?: ToolInvocation;
}
const toolInvocation = new AsyncLocalStorage<ToolInvocation>();

function cleanupFailure(run: NativeTurn, primary?: unknown): unknown {
  if (!run.toolCleanupErrors.length) return primary;
  return new AggregateError(
    [...(primary === undefined ? [] : [primary]), ...run.toolCleanupErrors],
    'Native tool callback cleanup failed',
    primary === undefined ? undefined : { cause: primary },
  );
}

async function engineCloseFailure(
  engine: Engine,
  failure: NativeError | undefined,
  deferSavedLoginRefresh = false,
): Promise<NativeError | undefined> {
  const report = deferSavedLoginRefresh
    ? await engine._close_report_defer_saved_login()
    : await engine._close_report();
  if (!report) return failure;
  if (!failure) return new NativeError(report);
  if (deferSavedLoginRefresh) return failure;
  // The full native report appends the refresh diagnostic to the same ordinary
  // report. Keep the ordinary diagnostic once and retain the refresh on its own.
  const ordinaryReport = await engine._close_report_defer_saved_login();
  if (report === ordinaryReport) return failure;
  const refreshReport =
    ordinaryReport === null
      ? report
      : report.slice(`${ordinaryReport}; `.length);
  return new NativeError(failure.message, {
    cause: new AggregateError(
      [failure, new NativeError(refreshReport)],
      'Native thread and engine cleanup failed',
      { cause: failure },
    ),
  });
}

interface CompletionInspection {
  readonly candidate: (text: string) => Promise<CompletionDecision | undefined>;
  readonly signal: AbortSignal;
  readonly check: () => void;
}

type RepairedOutput =
  | { readonly type: 'validated'; readonly output: unknown }
  | { readonly type: 'decision'; readonly decision: CompletionDecision }
  | { readonly type: 'stopped' };

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
    output: PreparedOutput;
    readonly outputOverride: boolean;
    profileSettlement?: Promise<void>;
    callerSignal?: AbortSignal;
    observation: ObservationPhase;
    observationAfter: number;
    next?: NativeTurn;
    previous?: NativeTurn;
    cancelled?: boolean;
    blankFinal?: boolean;
    compaction?: boolean;
    realtimeTools?: { generation: string };
    review?: boolean;
    retirement?: Promise<never>;
    tracingAdmissionFailed?: boolean;
    repair?: OutputRepair;
    repairAttemptsUsed?: number;
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

const nativeCallbackReceipt = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('tool'),
      request: z
        .object({
          _sdk_python_tool: nativeMarker.strict(),
          turnId: z.string(),
          callId: z.string(),
        })
        .strict(),
      invocation: z.string().regex(/^(0|[1-9][0-9]*)$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal('preparation'),
      thread: z.string(),
      instance: z.string().optional(),
      id: z.string().regex(/^(0|[1-9][0-9]*)$/),
    })
    .strict(),
]);
interface NativeCallbackDelivery {
  wire: string;
  native: NativeThread;
  controller: AbortController;
  claimed: boolean;
  buffered: boolean;
  retired: boolean;
  released: boolean;
}

class NativeTurn {
  readonly guardrailResults: GuardrailRecord[] = [];
  guardrailInput?: UserInput;
  inputGuardrailsStarted = false;
  inputGuardrailsTask?: Promise<void>;
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
  tokenUsage: TokenUsage | null = null;
  requests: TokenCount = 0;
  missingUsageRequests: TokenCount = 0;
  addUsage(
    raw: JsonObject,
    requests: TokenCount = 1,
    missing: TokenCount = 0,
  ): void {
    this.tokenUsage = addRunUsage(this.tokenUsage, raw);
    this.requests = addTokenCounts(this.requests, requests);
    this.missingUsageRequests = addTokenCounts(
      this.missingUsageRequests,
      missing,
    );
    this.usageParent?.addUsage(raw, requests, missing);
  }
  failure: unknown;
  nativeFailure?: NativeError;
  constructor(
    private readonly beforeWait: () => void,
    private readonly usageParent?: NativeTurn,
  ) {
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

/** @internal The optional MCP App helper borrows this Session-owned dispatch closure. */
export interface MCPAppBinding {
  readonly view: import('../mcp-apps').MCPAppView;
  callTool(name: string, arguments_: JsonObject): Promise<JsonObject>;
}

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

interface RealtimeToolSelection {
  readonly selection_id: string;
  readonly function_tools: JsonObject[];
  readonly catalog_generation: string;
  readonly profile_receipt: unknown;
}

function realtimeToolSelection(
  value: unknown,
  admitted?: { active: AgentProfileReceipt; activeCatalog: ToolCatalog },
): RealtimeToolSelection {
  if (
    !value ||
    typeof value !== 'object' ||
    !('selection_id' in value) ||
    typeof value.selection_id !== 'string' ||
    !value.selection_id ||
    !('function_tools' in value) ||
    !Array.isArray(value.function_tools) ||
    value.function_tools.some(
      (tool) => !tool || typeof tool !== 'object' || Array.isArray(tool),
    )
  )
    throw new NativeError(
      'Native Realtime tool selection has no captured owner',
    );
  return {
    selection_id: value.selection_id,
    function_tools: value.function_tools,
    catalog_generation: admitted
      ? admitted.activeCatalog.generation.toString()
      : profileInteger(
          'catalog_generation' in value ? value.catalog_generation : undefined,
        ),
    profile_receipt:
      admitted?.active ??
      ('profile_receipt' in value ? value.profile_receipt : null),
  };
}

export class Session<OutputT = string, Context = unknown> {
  private profileRuntimes: ReadonlyMap<string, AgentProfileRuntime> = new Map();
  private readonly voiceProfileGraphs = new Map<string, CapturedAgentGraph>();
  private voiceGraphGeneration?: string;
  private readonly profileCatalogs = new Map<string, ToolCatalog>();
  private readonly profileMcp = new Map<string, readonly McpTool[]>();
  private readonly profileStepMcp = new Map<string, readonly McpTool[]>();
  private profileCurrent?: AgentProfileReceipt;
  private profileHighWater = 0n;
  private profileKey(id: string, generation: bigint | string): string {
    return `${id}\0${generation}`;
  }
  private get hasMcpPolicyReaders(): boolean {
    return (
      this.options.mcpTools !== undefined ||
      [...this.profileRuntimes.values()].some(
        (profile) => profile.mcp.length > 0,
      )
    );
  }

  private realtimeOwner?: ReturnType<typeof createNativeRealtimeOwner>;

  /** Detached speech usage for the current connection, separate from thread usage.
   * Undefined means no reported usage or no current connection. A new connection
   * starts new totals; retain its RealtimeSession to read those totals after close.
   */
  get realtimeUsage():
    import('./realtime-usage').NativeRealtimeUsage | undefined {
    return this.realtimeOwner?.usage;
  }

  /**
   * Build the call-accept request body for an inbound SIP call using the captured
   * Agent instructions, tools, and handoffs. Send it to the Realtime calls accept
   * endpoint, then attach with
   * `realtime({ ...options, transport: { type: 'sip', callId } })` using the same
   * model, voice, instructions, output modality, settings, and tool selection.
   * The builder saves no configuration for a later attachment.
   * This prepares Session-owned MCP tools just as connecting does, but does not
   * connect media or resolve voice credentials.
   */
  async buildRealtimeSipConfig(
    options: NativeRealtimeSipConfigOptions = {},
  ): Promise<JsonObject> {
    if (this.options.chatGPTPlan)
      throw new TypeError('Sign in with ChatGPT does not support Realtime');
    this.checkCallbackOperation('build Realtime SIP configuration on');
    if (
      !this.isOpen ||
      this.lifecycle.kind === 'mutation' ||
      this.manualSeal ||
      this.manualSealed ||
      this.graphStops.size
    )
      throw new NativeError(
        'Realtime requires an open Session without checkpoint or mutation work',
      );
    for (const [name, value] of Object.entries(options)) {
      if (
        ![
          'model',
          'voice',
          'instructions',
          'isToolEnabled',
          'outputModality',
          'settings',
          'tools',
        ].includes(name)
      )
        throw new TypeError(
          `Unsupported Realtime SIP configuration option: ${name}`,
        );
      if (
        ['model', 'voice'].includes(name) &&
        value !== undefined &&
        typeof value !== 'string'
      )
        throw new TypeError(`Realtime ${name} must be a string`);
    }
    if (
      options.instructions !== undefined &&
      typeof options.instructions !== 'string' &&
      typeof options.instructions !== 'function'
    )
      throw new TypeError('Realtime instructions must be a string or callback');
    if (
      options.isToolEnabled !== undefined &&
      typeof options.isToolEnabled !== 'function'
    )
      throw new TypeError('Realtime isToolEnabled must be a callback');
    if (options.tools !== undefined && !Array.isArray(options.tools))
      throw new TypeError(
        'Realtime tools must be an array of captured function declarations',
      );
    options = {
      ...options,
      tools: options.tools === undefined ? undefined : [...options.tools],
    };
    let settings = options.settings
      ? serializeRealtimeSettings(options.settings)
      : null;
    if (options.tools === undefined) await this._prepareRealtimeMcp();
    const hasConfig = this._hasRealtimeAgentConfiguration();
    const snapshot =
      hasConfig ||
      (options.tools !== undefined &&
        (typeof options.instructions === 'function' ||
          options.isToolEnabled !== undefined))
        ? await this._realtimeSourceSnapshot()
        : undefined;
    const policy = await resolveRealtimePolicy(
      this,
      options,
      undefined,
      () => {
        if (!this.isOpen) throw new NativeError('Session is not open');
      },
      undefined,
      snapshot,
    );
    let instructions = policy.instructions;
    let selection =
      options.tools === undefined
        ? null
        : await this._realtimeFunctionTools([...options.tools], { snapshot });
    if (hasConfig && snapshot) {
      const exact = this._realtimeConfigurationSource(snapshot.profile_receipt);
      const config = await this._runVoiceCallback(() =>
        resolveRealtimeAgentConfiguration({
          ...exact,
          selection: snapshot,
          selectedTools: selection?.tools,
          instructions,
          settings: settings ?? {},
        }),
      );
      instructions = config.instructions;
      settings = config.settings;
      selection = { tools: config.tools, selectionId: config.selectionId };
    }
    const params = realtimePrepareParams(
      { ...options, instructions },
      { type: 'websocket' },
      settings,
      selection?.tools ?? null,
      policy.selectionId ?? selection?.selectionId ?? null,
    );
    if (policy.disabledToolNames !== undefined)
      params.disabled_tool_names = policy.disabledToolNames;
    delete params.hosted_mcp_auto_response;
    delete params.include_raw_provider_events;
    const result: unknown = JSON.parse(
      await this.#native.call(
        'realtime_conversation_config_sdk',
        encode(params),
      ),
    );
    if (!result || typeof result !== 'object' || Array.isArray(result))
      throw new NativeError(
        'Native Realtime SIP configuration is not an object',
      );
    return result as JsonObject;
  }

  /** Open native media; closing the returned owner leaves this Session open. */
  async realtime(
    options: NativeRealtimeOptions = {},
  ): Promise<NativeRealtimeSession> {
    if (this.options.chatGPTPlan)
      throw new TypeError('Sign in with ChatGPT does not support Realtime');
    this.checkCallbackOperation('open Realtime on');
    // A rejected startup cannot return its owner as a cleanup retry handle.
    // Keep it installed until this explicit retry joins its retained cleanup.
    if (this.realtimeOwner?._startupFailed) await this.realtimeOwner.close();
    if (
      !this.isOpen ||
      this.lifecycle.kind === 'mutation' ||
      this.manualSeal ||
      this.manualSealed ||
      this.graphStops.size
    )
      throw new NativeError(
        'Realtime requires an open Session without checkpoint or mutation work',
      );
    if (this.realtimeOwner)
      throw new NativeError('Session already has a native Realtime owner');
    options.signal?.throwIfAborted();
    for (const [name, value] of Object.entries(options)) {
      if (
        ![
          'model',
          'voice',
          'instructions',
          'isToolEnabled',
          'toolErrorFormatter',
          'signal',
          'outputModality',
          'settings',
          'transport',
          'tools',
          'outputGuardrails',
          'guardrailTextThreshold',
          'automaticallyTriggerResponseForMcpToolCalls',
          'apiKey',
          'adapter',
          'historyStoreAudio',
          'includeRawProviderEvents',
        ].includes(name)
      )
        throw new TypeError(`Unsupported Realtime option: ${name}`);
      if (
        name !== 'instructions' &&
        name !== 'isToolEnabled' &&
        name !== 'toolErrorFormatter' &&
        name !== 'signal' &&
        name !== 'settings' &&
        name !== 'transport' &&
        name !== 'tools' &&
        name !== 'outputGuardrails' &&
        name !== 'guardrailTextThreshold' &&
        name !== 'automaticallyTriggerResponseForMcpToolCalls' &&
        name !== 'apiKey' &&
        name !== 'adapter' &&
        name !== 'historyStoreAudio' &&
        name !== 'includeRawProviderEvents' &&
        value !== undefined &&
        typeof value !== 'string'
      )
        throw new TypeError(`Realtime ${name} must be a string`);
    }
    if (
      options.instructions !== undefined &&
      typeof options.instructions !== 'string' &&
      typeof options.instructions !== 'function'
    )
      throw new TypeError('Realtime instructions must be a string or callback');
    if (
      options.isToolEnabled !== undefined &&
      typeof options.isToolEnabled !== 'function'
    )
      throw new TypeError('Realtime isToolEnabled must be a callback');
    if (
      options.toolErrorFormatter !== undefined &&
      typeof options.toolErrorFormatter !== 'function'
    )
      throw new TypeError('Realtime toolErrorFormatter must be a callback');
    if (
      this.options.modelBackend !== undefined &&
      options.adapter === undefined &&
      options.apiKey === undefined
    ) {
      const apiKey = this.options.realtimeApiKey;
      if (!apiKey?.trim())
        throw new TypeError(
          'Built-in Realtime requires a provider or voice API key',
        );
      options = { ...options, apiKey };
    }
    const native = this.#native;
    const mediaCleanup = native._realtime_cleanup();
    const owner = createNativeRealtimeOwner(
      this,
      (operation, params) => {
        // Only this private profile DTO carries a native u64 epoch. Settings
        // metadata and application JSON retain their ordinary JSON semantics.
        const profile = params.profile;
        if (
          operation === 'realtime_conversation_update_sdk' &&
          profile &&
          typeof profile === 'object' &&
          !Array.isArray(profile)
        ) {
          const target = profile.target;
          if (target && typeof target === 'object' && !Array.isArray(target))
            return native.call(
              operation,
              JSON.stringify({
                ...params,
                profile: {
                  ...profile,
                  target: {
                    ...target,
                    epoch: JSON.rawJSON(profileInteger(target.epoch)),
                  },
                },
              }),
            );
        }
        return native.call(operation, encode(params));
      },
      () => {
        if (this.realtimeOwner === owner) this.realtimeOwner = undefined;
      },
      { ...options },
      (generation) => mediaCleanup.close(generation),
      {
        create: (generation) => native._realtime_adapter(generation),
        prepare: (params, handle) =>
          native._prepare_realtime(encode(params), handle),
      },
    );
    this.realtimeOwner = owner;
    return owner._start();
  }

  /** @internal Promote inherited idle MCP defaults without starting a model turn. */
  async _prepareRealtimeMcp(): Promise<void> {
    this.checkCallbackOperation('open Realtime MCP on');
    if (
      this.options.agentGraph ||
      this.lifecycle.kind === 'turn' ||
      !this.mcpBindings.length
    )
      return;
    await this.mutate(() => this.promoteMcp(undefined));
  }

  private capturedVoiceTool(
    tool: SessionTool,
    catalog: ToolCatalog,
    declarationCatalog: ToolCatalog,
  ): SessionTool | undefined {
    let admitted = declarationCatalog.tools.find(
      (candidate) =>
        toolDeclarationIdentity(candidate) === toolDeclarationIdentity(tool),
    );
    if (!admitted && !this.options.agentGraph && catalog === this.catalog) {
      const identity = toolIdentity(tool);
      if (
        this.admittedDeclarations
          .get(JSON.stringify([identity.namespace, identity.name]))
          ?.has(toolDeclarationIdentity(tool))
      )
        admitted = tool;
    }
    const captured = catalog.tools.find((candidate) => {
      if (toolDeclarationIdentity(candidate) === toolDeclarationIdentity(tool))
        return true;
      if (!admitted) return false;
      const original = toolIdentity(admitted);
      const current = toolIdentity(candidate);
      return (
        original.name === current.name &&
        original.namespace === current.namespace
      );
    });
    return captured;
  }

  /** @internal Normalize voice declarations immediately before strict submission. */
  _voiceFunctionTools(tools: readonly ToolSelector[]): readonly ToolSelector[] {
    const declarationCatalog = this.options.agentGraph
      ? this.profileRuntimes.get(this.profileCurrent!.profile_id)!.catalog
      : this.openingCatalog;
    return tools.map((tool) => {
      if (tool.kind === 'tool_ref' || tool.kind === 'manual') return tool;
      const captured = this.capturedVoiceTool(
        tool,
        this.catalog,
        declarationCatalog,
      );
      if (
        !captured ||
        (captured.kind === 'manual' && !managedApproval(captured))
      )
        throw new TypeError(
          'Voice tool was not admitted in the current Agent catalog',
        );
      return captured;
    });
  }

  private async realtimeSelectionCatalog(snapshot?: RealtimeToolSelection) {
    const raw =
      snapshot ??
      parseProfileReceipt(
        await this.#native.call('realtime_tool_selection_sdk', '{}'),
      );
    if (
      !raw ||
      typeof raw !== 'object' ||
      !('selection_id' in raw) ||
      typeof raw.selection_id !== 'string' ||
      !raw.selection_id ||
      !('catalog_generation' in raw)
    )
      throw new NativeError(
        'Native Realtime tool selection has no captured owner',
      );
    const generation = profileInteger(raw.catalog_generation);
    let catalog: ToolCatalog | undefined;
    let declarationCatalog = this.openingCatalog;
    const graph = this.callbackProfileGraph(
      'profile_receipt' in raw ? raw.profile_receipt : undefined,
    );
    if (graph) {
      const receipt = checkProfileReceipt(
        'profile_receipt' in raw ? raw.profile_receipt : undefined,
        graph,
      );
      catalog = this.profileCatalogs.get(
        this.profileKey(receipt.profile_id, generation),
      );
      declarationCatalog = this.callbackProfileRuntime(
        receipt.profile_id,
      )!.catalog;
    } else if (
      ('profile_receipt' in raw && raw.profile_receipt != null) ||
      generation !== this.catalog.generation.toString()
    )
      throw new NativeError(
        'Native Realtime tool selection is no longer current',
      );
    else catalog = this.catalog;
    if (!catalog)
      throw new NativeError(
        'Native Realtime tool selection has no captured catalog',
      );
    return {
      raw,
      catalog,
      declarationCatalog,
      selectionId: raw.selection_id as string,
    };
  }

  /** @internal Resolve policies against the exact current native selection receipt. */
  async _realtimePolicySource(snapshot?: RealtimeToolSelection) {
    this.checkCallbackOperation('configure Realtime policies in');
    const { raw, catalog, selectionId } =
      await this.realtimeSelectionCatalog(snapshot);
    const receipt = 'profile_receipt' in raw ? raw.profile_receipt : null;
    const source = this._realtimeGuardrailSource(receipt);
    const graph = this.callbackProfileGraph(receipt);
    const profile = graph
      ? this.callbackProfileRuntime(
          checkProfileReceipt(receipt, graph).profile_id,
        )
      : undefined;
    const specs = JSON.parse(catalog.specsJson) as JsonObject[];
    const tools: import('./realtime-policy').NativeRealtimeTool[] =
      specs.flatMap((spec) =>
        spec.type === 'function' && typeof spec.name === 'string'
          ? [{ type: 'function' as const, name: spec.name }]
          : [],
      );
    for (const name of Object.keys(profile?.profile.handoffs ?? {}))
      tools.push({ type: 'handoff', name });
    return { ...source, receipt, tools, selectionId };
  }

  /** @internal A completed response keeps its original captured handoff source. */
  _realtimeHandoffSource(receipt: unknown, name: string) {
    const graph = this.callbackProfileGraph(receipt);
    if (!graph) return undefined;
    const source = checkProfileReceipt(receipt, graph);
    const profile = this.callbackProfileRuntime(source.profile_id)!;
    return Object.hasOwn(profile.profile.handoffs, name)
      ? this._realtimeGuardrailSource(source)
      : undefined;
  }

  /** @internal Select only sealed captured functions; Core rechecks its atomic source catalog. */
  async _realtimeFunctionTools(
    tools: readonly FunctionTool<any>[],
    {
      allowMissing = false,
      snapshot,
    }: { allowMissing?: boolean; snapshot?: RealtimeToolSelection } = {},
  ): Promise<{ tools: JsonObject[]; selectionId: string | null }> {
    this.checkCallbackOperation('configure Realtime tools in');
    if (!tools.length) return { tools: [], selectionId: null };
    const { catalog, declarationCatalog, selectionId } =
      await this.realtimeSelectionCatalog(snapshot);
    const selected: JsonObject[] = [];
    const seen = new Set<SessionTool>();
    for (const tool of tools) {
      if (
        !tool ||
        typeof tool !== 'object' ||
        (tool.kind !== undefined && tool.kind !== 'function')
      )
        throw new TypeError(
          'Realtime tools must be captured function declarations',
        );
      const captured = this.capturedVoiceTool(
        tool,
        catalog,
        declarationCatalog,
      );
      if (
        !captured ||
        (captured.kind === 'manual' && managedApproval(captured) === undefined)
      ) {
        if (allowMissing) continue;
        throw new TypeError(
          'Realtime tool was not admitted in the current Agent catalog',
        );
      }
      if (seen.has(captured))
        throw new TypeError(`Duplicate Realtime tool: ${captured.name}`);
      seen.add(captured);
      const [spec] = JSON.parse(captureTools([captured]).specsJson);
      if (spec.type !== 'function')
        throw new TypeError(
          'Realtime tools require bare function declarations',
        );
      const { type: _type, ...definition } = spec;
      selected.push(definition);
    }
    return { tools: selected, selectionId };
  }

  /** @internal A provider refresh carries the native receipt, never an inferred Agent. */
  _realtimeProfileTarget(value: unknown): JsonObject | null {
    const graph = this.callbackProfileGraph(value);
    if (!graph) {
      if (value != null)
        throw new NativeError('Unexpected Realtime Agent profile');
      return null;
    }
    const receipt = checkProfileReceipt(value, graph);
    return { profile_id: receipt.profile_id, epoch: receipt.epoch };
  }
  async _realtimeCurrentProfile(): Promise<JsonObject | null> {
    if (!this.options.agentGraph) return null;
    return this._realtimeProfileTarget(
      parseProfileReceipt(await this.#native._active_agent_profile()),
    );
  }

  private callbackProfileGraph(
    receipt: unknown,
  ): CapturedAgentGraph | undefined {
    const id =
      receipt &&
      typeof receipt === 'object' &&
      'profile_id' in receipt &&
      typeof receipt.profile_id === 'string'
        ? receipt.profile_id
        : undefined;
    return (
      (id ? this.voiceProfileGraphs.get(id) : undefined) ??
      this.options.agentGraph
    );
  }

  private callbackProfileRuntime(id: string): AgentProfileRuntime | undefined {
    return (
      this.voiceProfileGraphs.get(id)?.profiles.get(id) ??
      this.profileRuntimes.get(id)
    );
  }

  /** @internal Preserve the zero-query path for Sessions without voice-specific defaults. */
  _hasRealtimeAgentConfiguration(receipt?: JsonObject | null): boolean {
    const id =
      receipt === undefined
        ? this.profileCurrent?.profile_id
        : receipt?.profile_id;
    const runtime =
      typeof id === 'string' ? this.callbackProfileRuntime(id) : undefined;
    const declaration =
      runtime?.profile.declaration ??
      this.options.realtimeDeclaration ??
      this.options.applicationAgent;
    return (
      declaration !== undefined && hasRealtimeAgentConfiguration(declaration)
    );
  }

  /** @internal Exact source defaults for startup, provider handoffs, and voice-only updates. */
  _realtimeConfigurationSource(receipt?: unknown): {
    agent: import('./public-agent').Agent<any, any>;
    declaration: import('./public-agent').Agent<any, any>;
    context: unknown;
    handoffs?: Readonly<
      Record<string, import('./realtime-agent-config').RealtimeHandoff<any>>
    >;
  } {
    if (receipt === undefined) receipt = this.profileCurrent ?? null;
    const graph = this.callbackProfileGraph(receipt);
    const runtime =
      graph && receipt != null
        ? this.callbackProfileRuntime(
            checkProfileReceipt(receipt, graph).profile_id,
          )
        : undefined;
    const agent = runtime?.profile.agent ?? this.options.applicationAgent;
    const declaration =
      runtime?.profile.declaration ?? this.options.realtimeDeclaration ?? agent;
    if (!agent || !declaration || (receipt != null && !runtime))
      throw new NativeError(
        'Native voice source has no admitted Agent profile',
      );
    return {
      agent,
      declaration,
      context: this.options.context,
      handoffs: runtime?.profile.handoffOptions,
    };
  }

  /** @internal Preserve absent application identity on a bare native Session. */
  _realtimeEventSource(receipt: unknown) {
    if (receipt == null && !this.options.applicationAgent) return undefined;
    return this._realtimeConfigurationSource(receipt ?? null);
  }

  /** @internal Capture the actual native catalog before resolving app callbacks. */
  async _realtimeSourceSnapshot(
    generation?: string,
    receipt?: unknown,
  ): Promise<RealtimeToolSelection> {
    const target =
      receipt === undefined ? undefined : this._realtimeProfileTarget(receipt);
    const retained =
      target && this.voiceProfileGraphs.has(target.profile_id as string);
    const raw = parseProfileReceipt(
      retained && generation
        ? await this.#native._realtime_agent_source(
            generation,
            encodeProfileReceipt(
              checkProfileReceipt(target, this.callbackProfileGraph(target)!),
            ),
          )
        : await this.#native.call(
            'realtime_tool_selection_sdk',
            this.options.agentGraph
              ? '{}'
              : encode({
                  mcp_policy: { names: mcpToolNames(this.openingMcpTools) },
                }),
          ),
    );
    const snapshot = realtimeToolSelection(raw);
    if (
      target !== undefined &&
      !isDeepStrictEqual(
        this._realtimeProfileTarget(snapshot.profile_receipt),
        target,
      )
    )
      throw new NativeError(
        'Native Realtime Agent changed during configuration capture',
      );
    return snapshot;
  }

  /** @internal Admit a graph for one voice owner while preserving the attached backend Session. */
  async _admitRealtimeGraph(
    generation: string,
    agent: import('./public-agent').Agent<any, any>,
    expected: JsonObject | null,
  ): Promise<RealtimeToolSelection> {
    const opening =
      this.options.realtimeDeclaration ?? this.options.applicationAgent;
    if (!opening)
      throw new NativeError('Session has no captured opening Agent');
    const { captureRealtimeAgentGraph } = await import('./public-agent');
    const graph = captureRealtimeAgentGraph(
      opening,
      agent,
      `voice_${generation}_${this.voiceProfileGraphs.size}_`,
    );
    if ([...graph.profiles.values()].some((profile) => profile.mcp.length)) {
      if (!this.mcpReaderStarted) {
        this.#native._enable_native_mcp_results(30);
        this.mcpReaderStarted = true;
        this.ownReader(withoutTracing(() => this.readMcpResults()));
      }
      if (!this.interceptionReaderStarted) {
        this.#native._enable_native_interception(30, 'thread_tree');
        this.#native._configure_native_interception('[]');
        this.interceptionReaderStarted = true;
        this.ownReader(withoutTracing(() => this.readInterceptions()));
      }
    }
    this.voiceGraphGeneration = generation;
    const raw = parseProfileReceipt(
      await this.#native._admit_realtime_agent_graph(
        generation,
        JSON.stringify(profileRoster(graph, this.options.environment)),
        graph.rootId,
        expected === null
          ? 'null'
          : encodeProfileReceipt(
              checkProfileReceipt(
                expected,
                this.callbackProfileGraph(expected)!,
              ),
            ),
      ),
    );
    const allocated = allocatedProfileCatalogs(
      graph,
      raw,
      this.profileHighWater,
    );
    const captured = { ...graph, profiles: allocated.profiles };
    this.profileHighWater = allocated.highWater;
    for (const [id, profile] of allocated.profiles) {
      this.voiceProfileGraphs.set(id, captured);
      const key = this.profileKey(id, profile.catalog.generation);
      this.profileCatalogs.set(key, profile.catalog);
      this.profileMcp.set(key, profile.mcp);
      this.profileStepMcp.set(key, profile.mcp);
    }
    return realtimeToolSelection(raw, allocated);
  }

  /** @internal Discard only an admitted graph whose update has never been invoked. */
  async _discardRealtimeGraph(
    generation: string,
    receipt: JsonObject | null,
  ): Promise<void> {
    const graph =
      receipt && this.voiceProfileGraphs.get(receipt.profile_id as string);
    if (this.voiceGraphGeneration !== generation || !graph)
      throw new NativeError('Voice has no matching staged Agent graph');
    const target = checkProfileReceipt(receipt, graph);
    await this.#native._discard_realtime_agent_graph(
      generation,
      encodeProfileReceipt(target),
    );
    for (const [id, profile] of graph.profiles) {
      this.voiceProfileGraphs.delete(id);
      const key = this.profileKey(id, profile.catalog.generation);
      this.profileCatalogs.delete(key);
      this.profileMcp.delete(key);
      this.profileStepMcp.delete(key);
    }
    if (!this.voiceProfileGraphs.size) this.voiceGraphGeneration = undefined;
  }

  _hasRetainedRealtimeProfile(receipt: JsonObject | null | undefined): boolean {
    return (
      typeof receipt?.profile_id === 'string' &&
      this.voiceProfileGraphs.has(receipt.profile_id)
    );
  }

  /** @internal Release source catalogs after the owner has joined all native callbacks. */
  async _releaseRealtimeGraph(generation: string): Promise<void> {
    if (this.voiceGraphGeneration !== generation) return;
    if (this.isOpen)
      await this.#native._restore_realtime_agent_graph(generation);
    for (const [id, graph] of this.voiceProfileGraphs) {
      const key = this.profileKey(
        id,
        graph.profiles.get(id)!.catalog.generation,
      );
      this.profileCatalogs.delete(key);
      this.profileMcp.delete(key);
      this.profileStepMcp.delete(key);
    }
    this.voiceProfileGraphs.clear();
    this.voiceGraphGeneration = undefined;
  }

  private messageProfile(
    message: Record<string, unknown>,
  ): AgentProfileReceipt | undefined {
    const marker =
      message.profile_id == null &&
      message.profile_epoch == null &&
      message._sdk_python_tool &&
      typeof message._sdk_python_tool === 'object'
        ? (message._sdk_python_tool as Record<string, unknown>)
        : message;
    if (marker.profile_id == null && marker.profile_epoch == null) {
      if (this.options.agentGraph)
        throw new NativeError(
          'Native callback is missing its source Agent profile',
        );
      return;
    }
    const receipt = {
      profile_id: marker.profile_id,
      epoch: marker.profile_epoch,
    };
    const graph = this.callbackProfileGraph(receipt);
    if (!graph)
      throw new NativeError('Native callback has an unexpected Agent profile');
    return checkProfileReceipt(receipt, graph);
  }
  private sourceCatalog(
    message: Record<string, unknown>,
    generation: string,
  ): ToolCatalog {
    const source = this.messageProfile(message);
    const catalog = source
      ? this.profileCatalogs.get(
          this.profileKey(source.profile_id, profileInteger(generation)),
        )
      : this.catalog;
    if (!catalog || catalog.generation.toString() !== generation)
      throw new NativeError('Native callback has no captured source catalog');
    return catalog;
  }
  private sourceMcp(
    message: Record<string, unknown>,
    generation: string,
  ): readonly McpTool[] {
    const source = this.messageProfile(message);
    if (!source) {
      if (this.mcpGeneration.toString() !== generation)
        throw new NativeError('Expired native MCP source');
      return this.mcpTools;
    }
    const servers = this.profileMcp.get(
      this.profileKey(source.profile_id, profileInteger(generation)),
    );
    if (!servers)
      throw new NativeError(
        'Native MCP callback has no captured source selection',
      );
    return servers;
  }
  private sourceApplicationAgent(
    message: Record<string, unknown>,
  ): import('./public-agent').Agent<any, any> | undefined {
    const receipt = this.messageProfile(message);
    return receipt
      ? this.callbackProfileRuntime(receipt.profile_id)!.profile.agent
      : this.options.applicationAgent;
  }
  /** @internal Resolve a source snapshot without consulting the currently active Agent. */
  _realtimeGuardrailSource(receipt: unknown): {
    agent: import('./public-agent').Agent<any, any>;
    context: unknown;
  } {
    if (receipt == null && this.options.agentGraph)
      throw new NativeError(
        'Native Realtime guardrail is missing its source Agent',
      );
    const { agent, context } = this._realtimeConfigurationSource(receipt);
    return { agent, context };
  }
  /** Return the original admitted Agent identified by Core's committed receipt.
   * This dynamic observation erases context while preserving the Session output type.
   */
  async getActiveAgent(): Promise<
    import('./public-agent').Agent<any, OutputT>
  > {
    this.checkCallbackOperation('inspect the active Agent of');
    if (!this.isOpen) throw new NativeError('Session is closed');
    if (!this.options.agentGraph) {
      if (!this.options.applicationAgent)
        throw new NativeError('Session has no application Agent');
      return this.options.applicationAgent;
    }
    const receipt = checkProfileReceipt(
      parseProfileReceipt(await this.#native._active_agent_profile()),
      this.options.agentGraph,
    );
    if (!this.isOpen) throw new NativeError('Session is closed');
    return this.profileRuntimes.get(receipt.profile_id)!.profile.agent;
  }
  private rememberProfileBindings(): void {
    if (!this.profileCurrent) return;
    this.profileHighWater = [
      this.catalog.generation,
      this.mcpGeneration,
      this.profileHighWater,
    ].reduce((highest, generation) =>
      generation > highest ? generation : highest,
    );
    this.profileCatalogs.set(
      this.profileKey(this.profileCurrent.profile_id, this.catalog.generation),
      this.catalog,
    );
    this.profileStepMcp.set(
      this.profileKey(this.profileCurrent.profile_id, this.catalog.generation),
      Object.freeze([...this.mcpBindings]),
    );
    this.profileMcp.set(
      this.profileKey(this.profileCurrent.profile_id, this.mcpGeneration),
      Object.freeze([...this.mcpBindings]),
    );
  }
  private async acknowledgeProfilePublication(): Promise<void> {
    const graph = this.options.agentGraph;
    // Restore publishes saved defaults before configure establishes this binding.
    if (!graph || !this.profileCurrent) return;
    const previous = this.profileCurrent;
    const lifecycle = this.lifecycle;
    try {
      const receipt = checkProfileReceipt(
        parseProfileReceipt(await this.#native._active_agent_profile()),
        graph,
      );
      if (
        !previous ||
        receipt.profile_id !== previous.profile_id ||
        this.lifecycle !== lifecycle ||
        this.profileCurrent !== previous
      )
        throw new NativeError(
          'Native Agent changed during an owned publication',
        );
      // This acknowledgement belongs to our own config update. Keep its new
      // bindings; real activation/handoff continues to install declaration defaults.
      this.profileCurrent = receipt;
      this.rememberProfileBindings();
    } catch (error) {
      this.retire(error);
      throw error;
    }
  }

  private adoptProfile(
    receipt: AgentProfileReceipt,
    preserveCurrent = false,
  ): void {
    const graph = this.options.agentGraph;
    if (!graph) return;
    const same =
      this.profileCurrent?.profile_id === receipt.profile_id &&
      this.profileCurrent.epoch === receipt.epoch;
    if (preserveCurrent && same) {
      this.rememberProfileBindings();
      return;
    }
    const profile = this.profileRuntimes.get(receipt.profile_id)!;
    this.catalog = profile.catalog;
    this.openingCatalog = profile.catalog;
    this.defaultTools = [...profile.catalog.tools];
    this.defaultOutput = profile.output;
    this.openingMcpTools = profile.mcp;
    this.mcpBindings = profile.mcp;
    this.defaultMcpTools = profile.mcp;
    this.mcpTools = profile.mcp.filter(
      (server) =>
        (server.tools.length > 0 ||
          (server instanceof StdioMCP && server.lifetime === 'turn')) &&
        (!(server instanceof HttpMCP) || server.activation !== 'operation'),
    );
    this.mcpGeneration = profile.catalog.generation;
    this.allowedTools.clear();
    this.allowedMcpTools.clear();
    this.admittedDeclarations.clear();
    for (const tool of profile.catalog.tools) {
      const identity = toolIdentity(tool);
      const key = JSON.stringify([identity.namespace, identity.name]);
      this.allowedTools.add(key);
      this.admittedDeclarations.set(
        key,
        new WeakSet([toolDeclarationIdentity(tool)]),
      );
    }
    for (const identity of mcpToolNames(profile.mcp))
      this.allowedMcpTools.add(
        JSON.stringify([identity.namespace, identity.name]),
      );
    this.threadOptions.instructions = profile.instructions;
    this.profileCurrent = receipt;
    this.rememberProfileBindings();
  }
  private async commitProfile(
    receipt: AgentProfileReceipt,
    preserveCurrent = true,
    owner?: NativeTurn,
  ): Promise<void> {
    const lifecycle = this.lifecycle;
    const same =
      this.profileCurrent?.profile_id === receipt.profile_id &&
      this.profileCurrent.epoch === receipt.epoch;
    const catalog =
      preserveCurrent && same
        ? this.catalog
        : this.profileRuntimes.get(receipt.profile_id)!.catalog;
    const manual = catalog.tools.some((tool) => tool.kind === 'manual')
      ? await this.#native._manual_checkpoint_config_supported()
      : false;
    if (owner && !this.owns(owner)) return;
    if (this.lifecycle !== lifecycle)
      throw new NativeError('Session changed while capturing its active Agent');
    this.adoptProfile(receipt, preserveCurrent);
    this.nativeManualCheckpoint = manual;
  }
  private async refreshProfileBindings(
    preserveCurrent = true,
    owner?: NativeTurn,
  ): Promise<void> {
    if (!this.options.agentGraph) return;
    const lifecycle = this.lifecycle;
    const receipt = checkProfileReceipt(
      parseProfileReceipt(await this.#native._active_agent_profile()),
      this.options.agentGraph,
    );
    if (owner && !this.owns(owner)) return;
    if (this.lifecycle !== lifecycle)
      throw new NativeError('Session changed while capturing its active Agent');
    await this.commitProfile(receipt, preserveCurrent, owner);
  }

  private sessionInteractionFailure?: { error: unknown };
  private restoredRoot?: { turn: Turn<unknown>; output: PreparedOutput };

  /** The opening manual root, validated against this opening output contract. */
  get restoredTurn(): Turn<OutputT> | null {
    if (!this.restoredRoot) return null;
    if (this.restoredRoot.output !== this.defaultOutput)
      throw new TypeError(
        'Restored root has a separate captured output contract; use its captured Turn',
      );
    return this.restoredRoot.turn as Turn<OutputT>;
  }
  private repairUsageParent?: NativeTurn;
  private apiRateLimitState: { snapshot: ApiRateLimits } = {
    snapshot: Object.freeze({}),
  };

  /** Latest usable provider limits and retry advice observed in this live session. */
  rateLimits(): ApiRateLimits {
    return this.apiRateLimitState.snapshot;
  }

  /**
   * Read current account usage for this Session's saved Codex login.
   * Other authentication modes return `null`. A read can be cancelled with
   * `signal`, and it rejects if the Session closes or replaces its engine.
   * Treat unverified snapshots as display data. Use `observedAt` to decide
   * whether a snapshot is fresh enough for your application.
   */
  async planUsage({
    signal,
  }: { signal?: AbortSignal } = {}): Promise<CodexPlanUsage | null> {
    this.checkCallbackOperation('read plan usage for');
    const thread = this.#native;
    const check = () => {
      signal?.throwIfAborted();
      if (!this.isOpen) throw new NativeError('Session is closed');
      if (this.replacingNative === thread || this.#native !== thread)
        throw new NativeError('Session changed during plan usage read');
    };
    check();
    const native = await binding();
    check();
    const request = new native._ModelHttpRequest();
    const abort = signal && addAbortListener(signal, () => request.cancel());
    let wire: string | null;
    try {
      wire = await thread._read_plan_usage(request);
    } catch {
      check();
      throw new NativeError('Unable to read Codex plan usage');
    } finally {
      abort?.[Symbol.dispose]();
    }
    check();
    return wire === null ? null : parsePlanUsage(wire);
  }

  private readonly turnHandles = new WeakMap<
    NativeTurn,
    Turn<unknown, string | null>
  >();
  private readonly pendingRoots: { run: NativeTurn; parts: JsonValue[] }[] = [];
  private readonly decodedOutputs = new WeakMap<NativeTurn, unknown>();
  private readonly terminalProposals = new WeakMap<
    NativeTurn | ChildCallbackOwner,
    {
      proposal?: {
        readonly requestId: string;
        readonly nativeStep: string;
        readonly accepted: boolean;
        readonly generation: bigint;
        readonly callId: string;
        readonly name: string;
        readonly namespace: string | null;
        readonly value?: unknown;
        readonly json?: JsonValue;
        waiterConsumed?: true;
      };
      observations: Map<string, { identity: ToolIdentity; status: ToolStatus }>;
    }
  >();
  private readonly terminalCalls = new WeakMap<NativeTurn, ToolCallInfo>();
  private readonly childOutput = prepareOutput<string>(undefined);
  private readonly repairTurns: RepairTurnWire[];
  private readonly repairItems: RepairItemWire[];
  private repairReceiptsIncomplete = false;
  private readonly completedResults = new WeakMap<
    NativeRunResult,
    Completed<unknown>
  >();
  // Close must release tracing on surviving handles without retaining old results.
  private readonly runs = new Set<WeakRef<NativeTurn>>();
  private readonly runFinalizer: FinalizationRegistry<WeakRef<NativeTurn>>;
  private readonly callbackDeliveries = new Map<
    string,
    NativeCallbackDelivery
  >();
  private readonly callbackEvents = new WeakMap<
    NativeEvent,
    NativeCallbackDelivery
  >();
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
  private readonly nativeQuestionRetirementReplies = new Set<Promise<void>>();
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
  // The selector barrier drains the preceding sample before publishing this source.
  private readonly stepMcp = new WeakMap<NativeTurn, CapturedStepMcp>();
  private readonly questionMcp = new WeakMap<NativeEvent, CapturedStepMcp>();
  private starting?: SessionStartup;
  private defaultOutput: PreparedOutput;
  private openingCatalog: ToolCatalog;
  private readonly capabilityView: Capabilities;
  private sealedStateJson?: string;
  private mcpTools: readonly McpTool[];
  private openingMcpTools: readonly McpTool[];
  private mcpBindings: readonly McpTool[];
  private defaultMcpTools: readonly McpTool[];
  private readonly allowedMcpTools: Set<string>;
  private mcpGeneration = 0n;
  private mcpAppToolsUpdated = false;
  private mcpReaderStarted = false;
  private interceptionReaderStarted = false;
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
      tracing?: ReturnType<typeof captureTraceValidation>;
      ready: boolean;
      identity: ToolIdentity;
    }
  >();
  private readonly manualAdmissions = new Map<
    string,
    { promise: Promise<void>; publishOnAdmission: boolean }
  >();
  private readonly approvalDecisions = new WeakMap<
    object,
    Map<string, ApprovalDecision>
  >();
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
    callbackTraceStorages: new Map(),
  };
  private changedExecutorRoots = false;
  private lastRun: NativeTurn | null = null;
  private readonly childCallbacks = new ChildCallbacks(
    () => this.observations.currentSequence,
  );
  private readonly toolSessionOwner = Object.freeze({});
  private readonly functionAdmissions = new WeakMap<
    NativeTurn | ChildCallbackOwner,
    FunctionAdmission
  >();
  private readonly childSelections = new WeakMap<
    ChildCallbackOwner,
    OperationSelection
  >();
  // Only one-shot manual handlers report child cleanup to the owning run.
  private readonly oneShotChildCleanupErrors: unknown[] = [];
  #native: NativeThread;
  private storedHistoryClose?: ReturnType<
    NativeThread['_stored_history_close_action']
  >;
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
    const runs = this.runs;
    this.runFinalizer = new FinalizationRegistry((reference) =>
      runs.delete(reference),
    );
    this.profileRuntimes = options.agentGraph?.profiles ?? new Map();
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
    const restoredProfile = options.agentGraph?.restoredSource
      ? options.agentGraph.profiles.get(
          options.agentGraph.restoredSource.profile_id,
        )
      : undefined;
    this.openingMcpTools = Object.freeze([
      ...(restoredProfile?.mcp ?? options.mcpTools ?? []),
    ]);
    this.mcpBindings = this.openingMcpTools;
    this.defaultMcpTools = checkpointResourceServers(
      readCheckpointSelections(restored).default_resource_servers,
      this.openingMcpTools,
    );
    this.mcpTools = this.defaultMcpTools.filter(
      (server) =>
        (server.tools.length > 0 ||
          (server instanceof StdioMCP && server.lifetime === 'turn')) &&
        (!(server instanceof HttpMCP) || server.activation !== 'operation'),
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
      retention: options.observationRetention,
      validate: () => this.checkCallbackOperation('observe'),
      pendingManual: () =>
        [...this.manualCalls.values()].flatMap((call) => {
          const request = call.ready ? call.grant.request() : null;
          return request ? [request] : [];
        }),
    });
    if (options.includeRawProviderEvents) native._enable_raw_provider_events();
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
          // Native LocalStorage has already checked the original owners.
          // A Legacy descendant's audit can still contain a copied call.
          if (
            this.options.customStore &&
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
            captureTools(
              this.catalog.tools,
              (this.options.agentGraph
                ? this.profileHighWater
                : this.catalog.generation) + 1n,
            ),
          defaults,
        );
      }
      const executorPolicy =
        this.environment !== null && hasExecutorPolicy(this.environment);
      if (
        this.catalog.tools.some(
          (tool) => tool.kind === 'manual' || tool.finishTurn,
        )
      )
        await this.configureManualTools();
      this.ownReader(withoutTracing(() => this.readEvents()));
      if (
        (!this.options.agentGraph && this.options.mcpTools) ||
        (this.options.agentGraph && this.restored)
      ) {
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
      if (this.hasMcpPolicyReaders) {
        this.mcpReaderStarted = true;
        this.ownReader(withoutTracing(() => this.readMcpResults()));
      }
      if (
        executorPolicy ||
        this.options.nativeAgents ||
        this.hasMcpPolicyReaders
      ) {
        this.interceptionReaderStarted = true;
        this.ownReader(withoutTracing(() => this.readInterceptions()));
      }
      if (this.options.agentGraph) {
        const graph = this.options.agentGraph;
        const allocated = allocatedProfileCatalogs(
          graph,
          parseProfileReceipt(
            await this.#native._configure_agent_profiles(
              JSON.stringify(graph.roster),
              graph.rootId,
            ),
          ),
          this.profileHighWater,
        );
        this.profileRuntimes = allocated.profiles;
        this.profileHighWater = allocated.highWater;
        for (const [id, profile] of this.profileRuntimes) {
          this.profileCatalogs.set(
            this.profileKey(id, profile.catalog.generation),
            profile.catalog,
          );
          this.profileStepMcp.set(
            this.profileKey(id, profile.catalog.generation),
            profile.mcp,
          );
          this.profileMcp.set(
            this.profileKey(id, profile.catalog.generation),
            profile.mcp,
          );
        }
        // Immutable templates remain separate from an accepted restored subset.
        this.profileCatalogs.set(
          this.profileKey(
            allocated.active.profile_id,
            allocated.activeCatalog.generation,
          ),
          allocated.activeCatalog,
        );
        if (this.options.agentGraph?.restoredSource) {
          this.catalog = allocated.activeCatalog;
          this.profileCurrent = allocated.active;
          this.mcpGeneration = allocated.activeCatalog.generation;
          this.defaultOutput = this.profileRuntimes.get(
            allocated.active.profile_id,
          )!.output;
          this.rememberProfileBindings();
          await this.commitProfile(allocated.active, true);
        } else await this.commitProfile(allocated.active, false);
      }
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
    if (this.hasMcpPolicyReaders) native._enable_native_mcp_results(30);
    const executorPolicy =
      this.environment !== null && hasExecutorPolicy(this.environment);
    if (
      executorPolicy ||
      this.options.nativeAgents ||
      this.hasMcpPolicyReaders
    ) {
      native._enable_native_interception(
        30,
        this.options.nativeAgents || this.hasMcpPolicyReaders
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
    this.childObservationProducer = {
      ended: false,
      eventReaderEnded: false,
      callbackTraceStorages: new Map(),
    };
    this.ownReader(withoutTracing(() => this.readEvents()));
    this.mcpReaderStarted = this.hasMcpPolicyReaders;
    if (this.mcpReaderStarted)
      this.ownReader(withoutTracing(() => this.readMcpResults()));
    this.interceptionReaderStarted = !!(
      executorPolicy ||
      this.options.nativeAgents ||
      this.hasMcpPolicyReaders
    );
    if (this.interceptionReaderStarted)
      this.ownReader(withoutTracing(() => this.readInterceptions()));
    this.watchChildObservationProducer();
  }

  private watchChildObservationProducer(): void {
    const producer = this.childObservationProducer;
    // Auxiliary readers can still publish child observations after the main
    // event reader ends.
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
      (owner) => {
        this.flushTerminalObservations(owner);
        if (this.terminalProposals.get(owner)?.proposal?.waiterConsumed)
          this.clearTerminalProposal(owner);
        this.observations.notify();
      },
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
    if (!this.isOpen) throw new NativeError('Session is closed');
    await this.refreshNativeQuestions();
    if (!this.isOpen) throw new NativeError('Session is closed');
    const owners: (NativeTurn | ChildCallbackOwner)[] =
      this.childCallbacks.entered();
    if (this.lifecycle.kind === 'turn') owners.unshift(this.lifecycle.run);
    const requests: Interaction[] = [];
    for (const owner of owners) {
      if (!this.canReturnRequests(owner)) continue;
      for (const event of this.pendingManual(owner)) {
        const admission = this.admitManualCall(owner, event, true);
        const key = this.manualCallKey(event);
        const call = key === undefined ? undefined : this.manualCalls.get(key);
        // Admission can register the grant before its approval policy finishes.
        if (
          !call ||
          call.run !== owner ||
          (!call.ready && admission) ||
          !this.manualCurrent(event)
        )
          continue;
        this.publishManualRequest(owner, event);
        const request = call.grant.request();
        if (request) requests.push(request);
      }
    }
    for (const owner of owners) {
      if (!this.canReturnRequests(owner))
        requests.push(...this.pendingEnteredManual(owner));
      requests.push(...this.pendingNativeQuestions(owner));
    }
    return Object.freeze(requests);
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

  private trackNativeQuestionRetirement(reply: Promise<void>): void {
    this.nativeQuestionRetirementReplies.add(reply);
    void reply.then(
      () => this.nativeQuestionRetirementReplies.delete(reply),
      () => this.nativeQuestionRetirementReplies.delete(reply),
    );
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
      this.trackNativeQuestionRetirement(reply);
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
        if (record.form || request.type === 'user_verification_request')
          this.trackNativeQuestionRetirement(reply);
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
          workflowForTrace,
          run instanceof NativeTurn
            ? undefined
            : run.observationProducer.callbackTraceStorages,
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
    const stepSource = this.questionMcp.get(event);
    const sourceServers = stepSource?.servers ?? this.mcpTools;
    const generation = stepSource?.generation ?? this.mcpGeneration;
    const sourceCurrent = () =>
      stepSource
        ? this.stepMcp.get(run as NativeTurn) === stepSource
        : this.mcpGeneration === generation;
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
            !sourceCurrent() ||
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
        sourceServers.some((tool) => tool.name === server)
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
      current: url ? undefined : sourceCurrent,
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
          stopUrl,
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
          ((options.current?.() ?? this.mcpGeneration === generation) &&
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
    {
      const handler = this.options.onInteraction;
      if (!handler && this.oneShot) {
        void this.trackQuestionCallback(run, async () => {
          throw new InteractionRequired();
        }).catch(() => {});
        return;
      }
      if (!handler) return;
      void this.trackQuestionCallback(run, async () => {
        try {
          const reply = await handler(grant.request, run.controller.signal);
          if (!this.current(run)) return;
          if (!isNativeQuestionReply(reply))
            throw new NativeError('onInteraction must return its issued reply');
          if (nativeReplyRequest(reply) !== grant.request)
            throw new TypeError(
              'Native reply is foreign, expired, or already delivered',
            );
          if (!grant.current()) return;
          await this.submitNativeQuestion(reply, grant.request);
        } catch (error) {
          if (
            !this.current(run) &&
            error instanceof TypeError &&
            error.message === 'Native request is expired or already answered'
          )
            return;
          if (
            grant.request.submissionId === null &&
            this.canAnswerNativeQuestions(run)
          ) {
            this.sessionInteractionFailure ??= { error };
            toolInvocation.exit(() => this.readerFailed(error));
          }
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
            this.#complete(run, value),
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
          guardrailResults: () =>
            [...this.rootSteps(run)].flatMap((step) => step.guardrailResults),
          rootResultReady: () => scope.phase() === 'ended',
          runUsage: () => this.runUsage(run),
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
  #complete(root: NativeTurn, result: NativeRunResult): Completed<unknown> {
    const saved = this.completedResults.get(result);
    if (saved) return saved;
    const run = [...this.rootSteps(root)].find(
      (step) => step.id === result.turnId,
    );
    if (!run) throw new NativeError('Result has no issued turn');
    const completed = Object.freeze({
      turn: this.#turnFor(run),
      finalOutput: this.decodedOutputs.has(run)
        ? this.decodedOutputs.get(run)
        : result.finalOutput,
      ...(this.terminalCalls.has(run)
        ? { toolCall: this.terminalCalls.get(run)! }
        : {}),
      threadUsage: tokenUsageInfo(result.usage),
      guardrailResults: Object.freeze(
        [...this.rootSteps(root)].flatMap((step) => step.guardrailResults),
      ),
      runUsage: this.runUsage(root),
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
  private runUsage(run: NativeTurn): RunUsage {
    let total = runUsageSnapshot(null);
    const origins = new Set<string>();
    for (const step of this.rootSteps(this.rootRun(run))) {
      if (step.id) origins.add(step.id);
      total = mergeRunUsage(
        total,
        runUsageSnapshot(
          step.tokenUsage,
          step.requests,
          step.missingUsageRequests,
        ),
      );
    }
    for (const child of this.childCallbacks.forOrigins(origins))
      total = mergeRunUsage(
        total,
        runUsageSnapshot(
          child.tokenUsage,
          child.requests,
          child.missingUsageRequests,
        ),
      );
    return total;
  }

  private toolUsageReporter(
    owner: NativeTurn | ChildCallbackOwner,
    check: () => boolean,
  ): UsageReporter {
    return (usage, options) => {
      owner.controller.signal.throwIfAborted();
      if (!check())
        throw new NativeError('Usage report invocation is no longer admitted');
      const captured = captureUsageReport(usage, options?.requests);
      if (!check())
        throw new NativeError('Usage report invocation is no longer admitted');
      if (owner instanceof NativeTurn)
        owner.addUsage(captured.raw, captured.requests, captured.missing);
      else {
        owner.tokenUsage = addRunUsage(owner.tokenUsage, captured.raw);
        owner.requests = addTokenCounts(owner.requests, captured.requests);
        owner.missingUsageRequests = addTokenCounts(
          owner.missingUsageRequests,
          captured.missing,
        );
      }
    };
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
      get after() {
        return submissions.get(root)!.observationAfter;
      },
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
    run.guardrailInput = undefined;
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
    guardrailInput?: UserInput,
  ): Promise<NativeRunResult> {
    this.startTurn(
      input,
      false,
      undefined,
      false,
      this.captureSelection(
        {
          maxModelSteps,
          prepareRequest: this.oneShot?.prepareRequest,
          beforeStep: this.oneShot?.beforeStep,
        },
        this.defaultOutput,
        budget,
      ),
      callerSignal,
      undefined,
      undefined,
      undefined,
      guardrailInput,
    );

    return this.#waitResult();
  }
  private get hasInputGuardrails(): boolean {
    return !!(
      this.options.inputGuardrails?.length ||
      this.options.agentInputGuardrails?.length ||
      [...this.profileRuntimes.values()].some(
        (profile) => profile.profile.declaration.inputGuardrails.length > 0,
      )
    );
  }

  /** Register FIFO new work and issue its exact handle before native admission. */
  enqueue(
    input: UserInput,
    options?: Omit<SubmitOptions<Context>, 'ifBusy'>,
  ): Promise<Turn<OutputT, string | null>>;
  enqueue<Next>(
    input: UserInput,
    options: Omit<SubmitOptions<Context, Next>, 'ifBusy'> & {
      outputType: OutputSpec<Next>;
    },
  ): Promise<Turn<Next, string | null>>;
  enqueue<Next>(
    input: UserInput,
    options?: Omit<SubmitOptions<Context, Next>, 'ifBusy'>,
  ): Promise<Turn<OutputT | Next, string | null>>;
  async enqueue<Next>(
    input: UserInput,
    options?: Omit<SubmitOptions<Context, Next>, 'ifBusy'>,
  ): Promise<Turn<OutputT | Next, string | null>> {
    this.checkCallbackOperation('enqueue on');
    if (options && 'ifBusy' in options && options.ifBusy !== undefined)
      throw new TypeError(
        'enqueue queues work; use submit to reject busy work',
      );
    const outputType = options?.outputType;
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
        : this.captureExecutorRoots(options.writableRoots);
    const run = this.allocateRun(output, outputType !== undefined);
    run.parentTrace = parentTrace;
    run.guardrailInput = this.hasInputGuardrails
      ? structuredClone(input)
      : undefined;
    run.selection = selection;
    run.writableRoots = writableRoots;
    run.tracing = this.captureRootTracing(options?.tracing);
    submissions.get(run)!.observationAfter = -1;
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
    if (entry) {
      if (
        this.options.agentGraph &&
        !submissions.get(entry.run)!.outputOverride
      )
        submissions.get(entry.run)!.output = this.defaultOutput;
      try {
        this.dispatchStart(entry.run, entry.parts);
      } catch (error) {
        entry.run.controller.abort(error);
        entry.run.accepted.reject(error);
        entry.run.completion.reject(error);
        this.finishObservation(entry.run);
        this.drainPending();
      }
    }
  }

  submit(
    input: UserInput,
    options?: SubmitOptions<Context>,
  ): Promise<Turn<OutputT>>;
  submit<Next>(
    input: UserInput,
    options: SubmitOptions<Context, Next> & { outputType: OutputSpec<Next> },
  ): Promise<Turn<Next>>;
  submit<Next>(
    input: UserInput,
    options?: SubmitOptions<Context, Next>,
  ): Promise<Turn<OutputT | Next>>;
  async submit<Next>(
    input: UserInput,
    options?: SubmitOptions<Context, Next>,
  ): Promise<Turn<unknown>> {
    this.checkCallbackOperation('submit to');
    if (options?.ifBusy !== undefined && options.ifBusy !== 'reject')
      throw new TypeError(
        'submit rejects busy work; use enqueue or Turn.steer',
      );
    const supplied: unknown = input;
    if (
      isManualReply(supplied) ||
      (typeof supplied === 'object' &&
        supplied !== null &&
        'type' in supplied &&
        supplied.type === 'function_call_output')
    )
      throw new TypeError('Use Session.respond to deliver a reply');
    this.idle('submit');
    const parts = nativeInput(input);
    const output =
      options?.outputType === undefined
        ? this.defaultOutput
        : prepareOutput(options.outputType);
    const selection = this.captureSelection(options, output);
    const parentTrace =
      captureTraceContext(options?.parentTrace) ?? this.options.parentTrace;
    const run = this.startTurn(
      parts,
      true,
      output,
      options?.outputType !== undefined,
      selection,
      undefined,
      options?.tracing,
      options?.writableRoots,
      parentTrace,
      this.hasInputGuardrails ? structuredClone(input) : undefined,
    );
    await afterSubmissionRetirement(run, run.accepted.promise);
    return this.#turnFor(run);
  }

  /** @internal Reuse the existing Session callback scope for owned voice policies. */
  async _runVoiceCallback<T>(
    callback: () => T | Promise<T>,
    realtimeAdapter?: object,
  ): Promise<T> {
    const scope = {
      session: this,
      active: true,
      realtimeAdapter,
      parent: toolInvocation.getStore(),
    };
    try {
      return await toolInvocation.run(scope, callback);
    } finally {
      scope.active = false;
    }
  }

  /** @internal Adapter callbacks cannot wait on their own ordered I/O. */
  _checkVoiceAdapterOperation(owner: object, operation: string): void {
    let scope = toolInvocation.getStore();
    while (scope) {
      if (
        scope.active &&
        scope.session === this &&
        scope.realtimeAdapter === owner
      )
        throw new NativeError(
          `A Realtime adapter callback cannot ${operation}`,
        );
      scope = scope.parent;
    }
  }

  /** @internal Public voice lifecycle operations cannot join their own callbacks. */
  _checkVoiceOperation(operation: string): void {
    this.checkCallbackOperation(operation);
  }

  /** @internal One response's admitted native tools, without a fabricated model request. */
  async _submitRealtimeTools(
    generation: string,
    responseId: string,
    callIds: readonly string[],
    signal?: AbortSignal,
    beforeDispatch?: () => Promise<readonly string[]>,
  ): Promise<Turn<unknown>> {
    this.checkCallbackOperation('start Realtime tools in');
    if (
      !generation ||
      !responseId ||
      !callIds.length ||
      callIds.some((id) => typeof id !== 'string' || !id) ||
      new Set(callIds).size !== callIds.length
    )
      throw new TypeError(
        'Realtime tool batches require a response and distinct nonempty call IDs',
      );
    const selected = [...callIds];
    const parentTrace = captureTraceContext() ?? this.options.parentTrace;
    const wait = <T>(pending: Promise<T>): Promise<T> => {
      if (!signal) return pending;
      signal.throwIfAborted();
      return new Promise<T>((resolve, reject) => {
        const abort = () => {
          signal.removeEventListener('abort', abort);
          reject(signal.reason);
        };
        signal.addEventListener('abort', abort, { once: true });
        pending
          .then(resolve, reject)
          .finally(() => signal.removeEventListener('abort', abort));
      });
    };
    for (;;) {
      signal?.throwIfAborted();
      const current =
        this.lifecycle.kind === 'turn'
          ? this.rootRun(this.lifecycle.run)
          : undefined;
      if (
        !current ||
        submissions.get(current)?.realtimeTools?.generation !== generation
      )
        break;
      await wait(current.accepted.promise);
      if (!this.owns(current)) continue;
      signal?.throwIfAborted();
      const tracingContext = current.tracing
        ? await wait(this.tracingContext(current))
        : undefined;
      signal?.throwIfAborted();
      if (!this.owns(current)) continue;
      const disabled = beforeDispatch ? await beforeDispatch() : [];
      signal?.throwIfAborted();
      const raw = parseNative(
        await this.#native._submit_realtime_tools(
          JSON.stringify({
            generation,
            response_id: responseId,
            call_ids: selected,
            disabled_call_ids: disabled,
            expected_root_turn_id: current.id,
            ...(parentTrace ? { trace: parentTrace.toHeaders() } : {}),
            ...(tracingContext ? { tracing_context: tracingContext } : {}),
          }),
        ),
      );
      const receipt = z
        .discriminatedUnion('status', [
          z.object({
            status: z.literal('attached'),
            root_turn_id: z.string().min(1),
          }),
          z.object({
            status: z.literal('not_submitted'),
            reason: z.object({ type: z.enum(['not_idle', 'superseded']) }),
          }),
        ])
        .parse(raw);
      if (receipt.status === 'attached') {
        if (receipt.root_turn_id !== current.id)
          throw new NativeError('Native Realtime attachment changed its root');
        return this.#turnFor(current);
      }
      if (this.owns(current)) {
        try {
          await wait(current.completion.promise);
        } catch (error) {
          if (!(error instanceof TurnAborted)) throw error;
        }
      }
    }
    signal?.throwIfAborted();
    this.idle('start Realtime tools');
    const output = prepareOutput(undefined);
    const selection = this.captureSelection(undefined, output, undefined, true);
    const run = this.allocateRun(output, true);
    submissions.get(run)!.realtimeTools = { generation };
    run.parentTrace = parentTrace;
    run.selection = selection;
    run.tracing = this.captureRootTracing(undefined);
    const send = async (tracingContext?: string) => {
      const disabled = beforeDispatch ? await beforeDispatch() : [];
      signal?.throwIfAborted();
      return this.#native._submit_realtime_tools(
        JSON.stringify({
          generation,
          response_id: responseId,
          call_ids: selected,
          disabled_call_ids: disabled,
          observation_submission_id: this.submissionIds.get(run)!,
          ...(run.parentTrace ? { trace: run.parentTrace.toHeaders() } : {}),
          ...(tracingContext ? { tracing_context: tracingContext } : {}),
        }),
      );
    };
    this.dispatchRun(run, () =>
      run.tracing
        ? this.tracingContext(run).then((context) => {
            if (
              !this.owns(run) ||
              !this.isOpen ||
              run.controller.signal.aborted
            )
              throw new TurnAborted(
                'Realtime tools stopped before native admission',
              );
            return send(context);
          })
        : send(),
    );
    await afterSubmissionRetirement(run, run.accepted.promise);
    return this.#turnFor(run);
  }

  private selectionNames(
    selectors: readonly ToolSelector[],
    sourceCatalog: ToolCatalog | undefined = this.options.agentGraph
      ? this.catalog
      : undefined,
    sourceMcp: readonly McpTool[] = this.openingMcpTools,
    mcpIndex = this.mcpNameIndex(sourceMcp),
  ): readonly ReturnType<typeof toolIdentity>[] {
    // A graph operation captures object authority, not a historical name alias.
    // Keep ordinary mono Session selector compatibility unchanged.
    const seen = new Set<string>();
    const policy = this.threadOptions.tool_policy;
    const opening =
      policy && typeof policy === 'object' && !Array.isArray(policy)
        ? policy.allowed_tools
        : undefined;
    const currentMcp =
      this.hasOperationMcp && sourceMcp === this.openingMcpTools
        ? sourceMcp === this.mcpBindings
          ? mcpIndex
          : this.mcpNameIndex(this.mcpBindings)
        : undefined;
    return Object.freeze(
      selectors.map((selector) => {
        let identity =
          selector.kind === 'tool_ref'
            ? {
                name: selector.name,
                namespace: selector.namespace || 'functions',
              }
            : toolIdentity(selector);
        const rawIdentity =
          selector.kind === 'tool_ref' ? mcpRefIdentity(selector) : undefined;
        if (rawIdentity) {
          const declared = mcpIndex.byRaw.get(JSON.stringify(rawIdentity));
          if (!declared)
            throw new TypeError(
              'MCP identity was not admitted by this Session',
            );
          identity = declared;
        }
        const key = JSON.stringify([identity.namespace, identity.name]);
        // Preserve immediate rejection outside the captured opening authority.
        // Core derives tool_search from admitted leaves and still resolves every
        // reference against the actual model's candidates before sampling.
        if (selector.kind === 'tool_ref')
          assertAdmittedToolReference(identity, opening);
        if (
          currentMcp &&
          selector.kind === 'tool_ref' &&
          mcpIndex.byProjected.has(key) &&
          !currentMcp.byProjected.has(key)
        )
          throw new TypeError(
            'MCP selector requires a current captured raw binding',
          );
        if (
          selector.kind !== 'tool_ref' &&
          !(sourceCatalog
            ? sourceCatalog.tools.some(
                (tool) =>
                  toolDeclarationIdentity(tool) ===
                  toolDeclarationIdentity(selector),
              )
            : this.admittedDeclarations
                .get(key)
                ?.has(toolDeclarationIdentity(selector)))
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
    required = false,
  ): OperationSelection | undefined {
    if (!this.options.openCorrection) assertOutputRepairSupported(output);
    if (
      this.options.chatGPTPlan &&
      (output.repair || options?.prepareRequest !== undefined)
    )
      throw new TypeError(
        'Sign in with ChatGPT does not support output repair or prepareRequest',
      );
    if (
      !required &&
      !this.options.agentGraph &&
      !this.options.inputGuardrails?.length &&
      !this.options.agentInputGuardrails?.length &&
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
      originCatalog: this.catalog,
      originMcp: this.mcpBindings,
      originProfileId: this.profileCurrent?.profile_id,
      operationDeclarationSource:
        options?.tools !== undefined && options.tools.length
          ? this.profileCurrent
          : undefined,
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
          encode(
            {
              mode: 'steer',
              expected_turn_id: run.id,
              input,
              ...(expectedTurnId !== undefined ? { exact_steering: true } : {}),
              ...(tracingContext ? { tracing_context: tracingContext } : {}),
            },
            audioInputByteLimit(input),
          ),
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
      this.clearTerminalProposal(run);
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

  private pendingEnteredManual(
    owner: NativeTurn | ChildCallbackOwner,
  ): Interaction[] {
    if (!this.canAnswerNativeQuestions(owner)) return [];
    return [...this.manualCalls.values()].flatMap((call) => {
      if (call.run !== owner || !call.ready || !this.manualCurrent(call.event))
        return [];
      const request = call.grant.request();
      return request ? [request] : [];
    });
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
          const requests = [
            ...this.pendingEnteredManual(current),
            ...this.pendingNativeQuestions(current, true),
          ];
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
        const next = submissions.get(run)?.next;
        if (next && error instanceof OutputValidationError) {
          try {
            await afterSubmissionRetirement(next, next.accepted.promise);
          } catch (admissionError) {
            if (continuationWasSuperseded(admissionError)) throw error;
            throw admissionError;
          }
          run = next;
          continue;
        }
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

  private async promoteMcp(run: NativeTurn | undefined): Promise<void> {
    const assertOwner = () => {
      if (
        !this.isOpen ||
        (run
          ? !this.owns(run) || run.controller.signal.aborted
          : this.lifecycle.kind !== 'mutation')
      )
        throw new TurnAborted('HTTP activation no longer owns this root');
    };
    assertOwner();
    const names = run?.selection?.names;
    const selectedNames =
      names === undefined
        ? undefined
        : new Set(names.map((name) => encode([name.namespace, name.name])));
    const next = this.mcpBindings.flatMap((server) => {
      if (!(server instanceof HttpMCP) || server.activation !== 'operation')
        return this.defaultMcpTools.filter(
          (selected) =>
            selected.name === server.name &&
            (selected.tools.length > 0 ||
              this.mcpTools.some((active) => active.name === selected.name)),
        );
      if (!server.tools.length)
        return this.mcpTools.filter(
          (active) =>
            active.name === server.name &&
            this.defaultMcpTools.some(
              (selected) => selected.name === server.name,
            ),
        );
      const projected =
        selectedNames === undefined ? [] : mcpToolNames([server]);
      const tools =
        selectedNames === undefined
          ? (this.defaultMcpTools.find(
              (selected) => selected.name === server.name,
            )?.tools ?? [])
          : server.tools.filter((_raw, index) => {
              const name = projected[index];
              return selectedNames.has(encode([name.namespace, name.name]));
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
    const generation =
      (this.options.agentGraph ? this.profileHighWater : this.mcpGeneration) +
      1n;
    const guarded = hasMcpPrePolicy(this.mcpTools) || hasMcpPrePolicy(next);
    const receipt = parseNative(
      await this.#native._replace_mcp_servers(
        config,
        mcpPolicies(next, generation),
        guarded ? encode(this.interceptionRules(next, generation)) : undefined,
      ),
    );
    checkMcpPublication(receipt, next, generation, this.mcpBindings);
    assertOwner();
    this.mcpTools = next;
    this.mcpGeneration = generation;
    await this.acknowledgeProfilePublication();
  }

  private captureExecutorRoots(roots: readonly string[]): string[] {
    if (this.environment?.mounts?.length)
      throw new TypeError(
        'Cannot replace writableRoots while storage mounts are active',
      );
    const captured = captureWritableRoots(roots);
    if (this.environment?.readOnly && captured.length)
      throw new TypeError('Read-only execution does not accept writableRoots');
    return captured;
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
    guardrailInput?: UserInput,
  ): NativeTurn {
    this.idle('submit');
    if (
      !interactive &&
      this.defaultTools.some((tool) => tool.kind === 'manual') &&
      !this.options.onInteraction &&
      !this.canCheckpointManual(output, selection)
    )
      throw new InteractionRequired();
    const roots =
      writableRoots === undefined
        ? undefined
        : this.captureExecutorRoots(writableRoots);
    const run = this.allocateRun(output, outputOverride);
    run.guardrailInput = this.hasInputGuardrails ? guardrailInput : undefined;
    run.parentTrace = parentTrace;
    run.writableRoots = roots;
    submissions.get(run)!.callerSignal = callerSignal;
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
    const byteLimit = audioInputByteLimit(parts);
    const receipt = {
      ...(selection
        ? {
            selection: {
              generation: this.catalog.generation.toString(),
              ...(selection.operationDeclarationSource
                ? {
                    operation_declaration_source:
                      selection.operationDeclarationSource,
                  }
                : {}),
              names: selection.names ?? null,
              before_step:
                this.options.agentGraph !== undefined ||
                !!this.options.inputGuardrails?.length ||
                !!this.options.agentInputGuardrails?.length ||
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
    };
    const wire = run.tracing ? undefined : encodeReceipt(receipt, byteLimit);
    // Active-only state never changes when another root merely registers.
    this.manualCheckpointRun = run;
    this.dispatchRun(
      run,
      async () => {
        const tracing = run.tracing;
        if (!tracing) return this.#native._submit(wire!);
        let submission: string;
        try {
          const span = await tracing.ready;
          const native = this.options.nativeAgents
            ? await binding()
            : undefined;
          if (!this.owns(run) || !this.isOpen || run.controller.signal.aborted)
            throw new TurnAborted(
              'Tracing admission stopped before native submission',
            );
          const context = tracing.dispatchContext(
            span,
            native && {
              native,
              storages: this.childObservationProducer.callbackTraceStorages,
            },
          );
          submission = encodeReceipt(
            { ...receipt, tracing_context: context },
            byteLimit,
          );
        } catch (error) {
          submissions.get(run)!.tracingAdmissionFailed = true;
          throw error;
        }
        return this.#native._submit(submission);
      },
      this.hasOperationMcp,
    );
  }

  private allocateRun(
    output = this.defaultOutput,
    outputOverride = false,
  ): NativeTurn {
    if (this.options.localStorage && output.repair)
      throw new TypeError('Persistent storage does not support output repair');
    const run = new NativeTurn(
      () => this.assertCanWait(run),
      this.repairUsageParent,
    );
    run.controller.signal.addEventListener(
      'abort',
      () => this.discardTerminalValue(run),
      { once: true },
    );
    const reference = new WeakRef(run);
    this.runs.add(reference);
    this.runFinalizer.register(run, reference, reference);
    submissions.set(run, {
      output,
      outputOverride,
      observation: 'open',
      observationAfter: this.observations.currentSequence,
    });
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
    submissions.get(run)!.observationAfter = this.observations.currentSequence;
    this.observations.notify();
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
    void this.runOutputRepair(run, output, submissions.get(run)!.output).then(
      (result) => {
        if (result.type === 'validated')
          this.decodedOutputs.set(run, result.output);
        this.finish(run, run.failure, output);
      },
      (error: unknown) => {
        const repair = submissions.get(run)!.repair!;
        if (!repair.session && !repair.opening?.failedOpeningCleanup)
          this.finish(run, run.failure ?? error, output);
      },
    );
  }

  private runOutputRepair(
    run: NativeTurn,
    output: string,
    prepared: PreparedOutput,
    inspect?: CompletionInspection,
  ): Promise<RepairedOutput> {
    const submission = submissions.get(run)!;
    const repair: OutputRepair = {
      completion: Promise.resolve(),
      finished: false,
    };
    submission.repair = repair;
    for (const stop of this.graphStops)
      if (stop.run === run) this.stopCorrection(repair, stop.options.mode);
    const abort = () => this.stopCorrection(repair, 'force');
    const signal = inspect?.signal ?? run.controller.signal;
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    let result: RepairedOutput;
    repair.completion = Promise.resolve().then(async () => {
      let failure: unknown;
      try {
        const correct = () =>
          this.repairOutput(run, repair, output, prepared, inspect);
        result = await (run.tracing
          ? run.tracing.run('host.output_repair', 'validation', correct)
          : correct());
      } catch (error) {
        failure = run.failure ?? error;
      } finally {
        repair.finished = true;
        signal.removeEventListener('abort', abort);
      }
      if (repair.session || repair.opening?.failedOpeningCleanup) {
        // A failed close retains its exact Session for the parent's next close.
        const error =
          failure ?? new NativeError('Output repair cleanup is incomplete');
        this.retire(error);
        throw error;
      }
      if (failure !== undefined) throw failure;
    });
    repair.completion.catch(() => {});
    return repair.completion.then(() => result!);
  }

  private async repairOutput(
    run: NativeTurn,
    repair: OutputRepair,
    text: string,
    prepared: PreparedOutput,
    inspect?: CompletionInspection,
  ): Promise<RepairedOutput> {
    const submission = submissions.get(run)!;
    const check = (opening = false) => {
      inspect?.signal.throwIfAborted();
      inspect?.check();
      if (run.failure !== undefined) throw run.failure;
      if (
        !this.owns(run) ||
        run.controller.signal.aborted ||
        repair.stop === 'force'
      )
        throw new TurnAborted('Output repair stopped');
      if (opening && repair.stop === 'graceful') {
        if (inspect) return false;
        throw new TurnAborted('Output repair stopped');
      }
      return true;
    };
    if (!check(true)) return { type: 'stopped' };
    // Output overrides do not identify the producing Agent. Capture Core's
    // committed profile before opening any correction Session.
    const source = this.options.agentGraph
      ? checkProfileReceipt(
          parseProfileReceipt(await this.#native._active_agent_profile()),
          this.options.agentGraph,
        )
      : undefined;
    if (!check(true)) return { type: 'stopped' };
    const transformContext = source
      ? this.profileRuntimes.get(source.profile_id)!.profile.declaration
          .transformContext
      : this.options.transformContext;
    const history = await this.#readHistory();
    if (!check(true)) return { type: 'stopped' };
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
    if (captured.invocation_timeout_ms !== undefined)
      settings.invocationTimeoutMs =
        captured.invocation_timeout_ms as ModelSettings['invocationTimeoutMs'];
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
    let issues: OutputValidationError['issues'] = [];
    while ((submission.repairAttemptsUsed ?? 0) < prepared.repair!.maxRetries) {
      if (!check(true)) return { type: 'stopped' };
      submission.repairAttemptsUsed = (submission.repairAttemptsUsed ?? 0) + 1;
      repair.session = await open(
        accepted.data.model,
        settings,
        (owner) => {
          repair.opening = owner;
        },
        run.parentTrace,
        transformContext,
      );
      repair.opening = undefined;
      const correction = repair.session;
      // A correction uses the owning session's model provider and reports into
      // the same live snapshot in the order its response headers arrive.
      correction.apiRateLimitState = this.apiRateLimitState;
      correction.repairUsageParent = run;
      correction.observations.linkRepairParent(
        this.observations,
        this.submissionIds.get(run)!,
      );
      let possiblyAdmitted = false;
      let stoppedBeforeAdmission = false;
      let result: NativeRunResult | undefined;
      let failure: unknown;
      try {
        stoppedBeforeAdmission = !check(true);
        if (!stoppedBeforeAdmission) {
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
        }
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
      if (stoppedBeforeAdmission) return { type: 'stopped' };
      text = result!.finalOutput;
      const continuation = await inspect?.candidate(text);
      check();
      if (continuation) {
        if (!check(true)) return { type: 'stopped' };
        return { type: 'decision', decision: continuation };
      }
      try {
        return { type: 'validated', output: prepared.parse!(text) };
      } catch (error) {
        if (!(error instanceof OutputValidationError)) throw error;
        issues = error.issues;
      }
    }
    if (!check(true)) return { type: 'stopped' };
    throw new OutputValidationError(text, issues);
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
    const profileSubmission = submissions.get(run)!;
    if (
      error === undefined &&
      this.options.agentGraph &&
      (!profileSubmission.outputOverride || profileSubmission.realtimeTools) &&
      !profileSubmission.compaction &&
      !profileSubmission.profileSettlement
    ) {
      profileSubmission.profileSettlement = this.refreshProfileBindings(
        true,
        run,
      ).then(() => {
        if (this.owns(run) && !profileSubmission.realtimeTools)
          profileSubmission.output = this.defaultOutput;
      });
      this.track(run, profileSubmission.profileSettlement, run.callbacks, () =>
        this.finish(
          run,
          run.failure ??
            (run.controller.signal.aborted
              ? new TurnAborted('Turn cancelled during profile settlement')
              : undefined),
          output,
          unsampledSteering,
        ),
      );
      return;
    }
    error = cleanupFailure(run, error);
    this.flushTerminalObservations(run);
    if (error !== undefined) this.clearTerminalProposal(run);
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
    const retained =
      unsampledSteering &&
      this.threadOptions._managed_instructions === true &&
      run.id !== null &&
      submission !== undefined;
    let predecessorValidationError: OutputValidationError | undefined;
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
        // A retained successor owns final validation. Keep this exact failure
        // for the typed fallback if native refuses that continuation.
        if (retained && cause instanceof OutputValidationError)
          predecessorValidationError = cause;
        else error = cause;
      }
    }
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
      const settlementError = error ?? predecessorValidationError;
      if (settlementError !== undefined) {
        run.accepted.reject(settlementError);
        run.completion.reject(settlementError);
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
      this.drainPending();
    } finally {
      this.finishObservation(run);
    }
  }
  private captureCallbackDelivery(
    native: NativeThread,
    receipt: unknown,
    event?: NativeEvent,
  ): NativeCallbackDelivery {
    const wire = encodeReceipt(nativeCallbackReceipt.parse(receipt));
    let delivery = this.callbackDeliveries.get(wire);
    if (!delivery) {
      delivery = {
        wire,
        native,
        controller: new AbortController(),
        claimed: false,
        buffered: false,
        retired: false,
        released: false,
      };
      this.callbackDeliveries.set(wire, delivery);
    } else if (delivery.native !== native) {
      throw new NativeError('Native callback receipt changed its owner');
    }
    if (event) this.callbackEvents.set(event, delivery);
    return delivery;
  }
  private releaseCallbackDelivery(delivery: NativeCallbackDelivery): void {
    if (delivery.released) return;
    delivery.native._release_python_callback(delivery.wire);
    delivery.released = true;
    if (this.callbackDeliveries.get(delivery.wire) === delivery)
      this.callbackDeliveries.delete(delivery.wire);
  }
  private retireCallbackDelivery(delivery: NativeCallbackDelivery): void {
    delivery.retired = true;
    delivery.controller.abort(new NativeError('Native callback cancelled'));
    if (!delivery.claimed) this.releaseCallbackDelivery(delivery);
  }
  private callbackAuthorityFailed(
    delivery: NativeCallbackDelivery | undefined,
    error: unknown,
  ): never {
    let cancelled = delivery?.retired ?? false;
    if (delivery && !cancelled) {
      try {
        cancelled = delivery.native._python_callback_cancelled(delivery.wire);
      } catch {
        throw error;
      }
    }
    if (delivery && cancelled) {
      this.retireCallbackDelivery(delivery);
      throw delivery.controller.signal.reason;
    }
    throw error;
  }
  private decisionScope(message: Record<string, unknown>, signal: AbortSignal) {
    const profile = this.messageProfile(message);
    const provider =
      (profile
        ? this.callbackProfileRuntime(profile.profile_id)!.profile.declaration
            .decisions
        : undefined) ?? this.options.decisions;
    let active = true;
    const controller = new AbortController();
    const pending = new Set<Promise<unknown>>();
    const make = (effectiveSignal: AbortSignal): BoundDecide =>
      bindDecide({
        provider,
        signal: AbortSignal.any([effectiveSignal, controller.signal]),
        track(work) {
          pending.add(work);
          void work.then(
            () => pending.delete(work),
            () => pending.delete(work),
          );
        },
        assertActive() {
          if (!active)
            throw new NativeError('Decision callback is no longer active');
        },
      });
    return {
      decide: make(signal),
      [decisionBinding]: make,
      async close() {
        active = false;
        controller.abort(
          new NativeError('Decision callback is no longer active'),
        );
        await Promise.allSettled([...pending]);
      },
    };
  }

  private async ownCallbackDelivery(
    event: NativeEvent,
    owner: NativeTurn | ChildCallbackOwner,
    callback: (
      signal: AbortSignal,
      delivery?: NativeCallbackDelivery,
    ) => Promise<void>,
  ): Promise<void> {
    const delivery = this.callbackEvents.get(event);
    if (!delivery) return callback(owner.controller.signal);
    if (delivery.claimed || delivery.released) return;
    delivery.claimed = true;
    const signal = AbortSignal.any([
      owner.controller.signal,
      delivery.controller.signal,
    ]);
    let primary: { error: unknown } | undefined;
    try {
      // The outer owner registers this Promise before native claim or any
      // application validation, including synchronous policy callbacks.
      await Promise.resolve();
      if (
        !signal.aborted &&
        delivery.native._enter_python_callback(delivery.wire)
      )
        await callback(signal, delivery);
    } catch (error) {
      if (!(
        delivery.retired &&
        signal.aborted &&
        Object.is(error, signal.reason)
      ))
        primary = { error };
    } finally {
      try {
        this.releaseCallbackDelivery(delivery);
      } catch (error) {
        primary ??= { error };
      }
    }
    if (primary) throw primary.error;
  }

  private observeProfileChange(
    msg: NativeEvent['msg'],
    submissionId: string | null,
  ): void {
    if (msg.thread_id !== this.id) return;
    const receipt = checkProfileReceipt(
      { profile_id: msg.profile_id, epoch: msg.profile_epoch },
      this.options.agentGraph!,
    );
    const declaration = this.profileRuntimes.get(receipt.profile_id)!.profile
      .declaration;
    const previous =
      typeof msg.previous_profile_id === 'string'
        ? this.profileRuntimes.get(msg.previous_profile_id)?.profile
        : undefined;
    this.observations.append({
      type: 'agent_profile_changed',
      profileId: receipt.profile_id,
      profileEpoch: receipt.epoch,
      agentName: declaration.name ?? null,
      ...(previous && {
        previousProfileId: previous.id,
        previousAgentName: previous.declaration.name ?? null,
      }),
      turnId: typeof msg.turn_id === 'string' ? msg.turn_id : null,
      submissionId,
    });
  }

  private async readEvents(): Promise<void> {
    const native = this.#native;
    const producer = this.childObservationProducer;
    let batch: string[] = [];
    let batchIndex = 0;
    let delivery: NativeCallbackDelivery | undefined;
    try {
      while (this.isOpen && this.#native === native) {
        if (delivery && !delivery.claimed && !delivery.buffered)
          this.releaseCallbackDelivery(delivery);
        delivery = undefined;
        let event: NativeEvent;
        try {
          if (batchIndex === batch.length) {
            try {
              batch = await native._next_session_events();
            } catch (error) {
              // Failed startup closes the engine before joining this reader.
              if (
                this.lifecycle.kind === 'closing' &&
                this.starting?.cause &&
                error instanceof Error &&
                error.message === 'Codex thread is closed' &&
                'code' in error &&
                error.code === 'GenericFailure'
              )
                return;
              throw error;
            }
            batchIndex = 0;
            if (batch.length === 0)
              throw new NativeError('Native event batch was empty');
          }
          const raw = batch[batchIndex++]!;
          event = parseEvent(raw);
          if (event.msg._sdk_callback !== undefined)
            delivery = this.captureCallbackDelivery(
              native,
              event.msg._sdk_callback,
              event,
            );
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
        if (this.#native !== native) return;
        if (event.msg.type === '_sdk_callback_cancel') {
          const wire = encodeReceipt(
            nativeCallbackReceipt.parse(event.msg.receipt),
          );
          const cancelled = this.callbackDeliveries.get(wire);
          if (cancelled?.native === native)
            this.retireCallbackDelivery(cancelled);
          continue;
        }
        if (!this.isOpen) return;
        if (this.realtimeOwner?._ingest(event)) continue;
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
        if (msg.type === 'agent_profile_changed' && msg.turn_id === null) {
          this.observeProfileChange(msg, null);
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
          if (this.interceptionReaderStarted)
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
            else {
              if (delivery) delivery.buffered = true;
              run.pending.push(event);
            }
          }
          continue;
        }
        if (run.id === null) {
          if (delivery) delivery.buffered = true;
          run.pending.push(event);
        } else this.process(run, event);
      }
    } finally {
      try {
        // A batch can already contain requests never routed to application work.
        // Release those deliveries as well as buffered, unclaimed requests.
        for (const raw of batch.slice(batchIndex)) {
          const pending = parseNative(raw);
          if (
            pending &&
            typeof pending === 'object' &&
            !Array.isArray(pending) &&
            'msg' in pending &&
            pending.msg &&
            typeof pending.msg === 'object' &&
            !Array.isArray(pending.msg) &&
            '_sdk_callback' in pending.msg &&
            pending.msg._sdk_callback !== undefined
          )
            this.captureCallbackDelivery(native, pending.msg._sdk_callback);
        }
        for (const pending of this.callbackDeliveries.values())
          if (pending.native === native && !pending.claimed)
            this.releaseCallbackDelivery(pending);
      } finally {
        this.realtimeOwner?._readerClosed();
        // Release callbacks waiting for this reader before auxiliary readers
        // join their callback work during replacement, suspension, or close.
        producer.eventReaderEnded = true;
        this.observations.notify();
        // Retire receipts from this native owner, without closing the new one.
        native._finish_child_event_reader();
      }
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
        'raw_response_completed',
        'hosted_tool_call_progress',
        'sdk_raw_provider_event',
      ].includes(msg.type)
        ? event.id
        : undefined);
    if (typeof turnId !== 'string') return;
    if (msg.type === 'sdk_raw_provider_event') {
      const owner = this.childCallbacks.find(id, incarnation, turnId);
      if (
        owner &&
        owner.observationPhase !== 'ended' &&
        (!owner.instanceId ||
          owner.instanceId === event.subagent_instance_id) &&
        event.id === turnId &&
        msg.source === 'responses' &&
        (msg.transport === 'sse' ||
          msg.transport === 'websocket' ||
          msg.transport === 'json') &&
        msg.payload &&
        typeof msg.payload === 'object' &&
        !Array.isArray(msg.payload)
      )
        this.observations.append({
          type: 'raw_provider_event',
          turnId,
          submissionId: `child:${id}:${incarnation}:${turnId}`,
          source: msg.source,
          transport: msg.transport,
          payload: msg.payload,
        });
      return;
    }
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
      msg.type === 'token_count' || msg.type === 'raw_response_completed'
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
      if (
        owner.rootTurnId === undefined &&
        typeof msg.root_turn_id === 'string' &&
        msg.root_turn_id
      )
        owner.rootTurnId = msg.root_turn_id;
      this.observations.notify();
    }
    owner.instanceId ??= event.subagent_instance_id;
    if (msg.type === 'raw_response_item')
      this.releaseTerminalObservation(owner, msg.item);

    if (msg.type === 'raw_response_completed' && event.id === owner.turnId) {
      const raw = msg.token_usage;
      const usage =
        raw !== null && typeof raw === 'object' && !Array.isArray(raw)
          ? raw
          : undefined;
      owner.tokenUsage = addRunUsage(owner.tokenUsage, usage ?? {});
      owner.requests = addTokenCounts(owner.requests, 1);
      owner.missingUsageRequests = addTokenCounts(
        owner.missingUsageRequests,
        usage ? 0 : 1,
      );
    }
    const submissionId = `child:${id}:${incarnation}:${turnId}`;
    if (msg.type === 'token_count')
      this.observeTokenCount(event, turnId, submissionId);
    if (
      msg.type === 'response_fact' &&
      msg.thread_id === id &&
      msg.turn_id === turnId
    ) {
      const record = projectResponseFactRecord(msg);
      if (record)
        this.observations.append({
          type: 'response_fact',
          turnId,
          submissionId,
          record,
        });
    }
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
      const completed = toolCompletionSchema.safeParse(msg.tool_completion);
      const fact = completed.success ? completed.data : undefined;
      const proposal = this.terminalProposals.get(owner)?.proposal;
      if (
        msg.type !== 'turn_aborted' &&
        event.subagent_turn_failed === false &&
        owner.failure === undefined &&
        !owner.controller.signal.aborted &&
        fact &&
        proposal?.accepted &&
        proposal.callId === fact.call_id &&
        proposal.name === fact.name &&
        (proposal.namespace ?? 'functions') ===
          (fact.namespace ?? 'functions') &&
        typeof fact.final_output === 'string' &&
        isDeepStrictEqual(proposal.json, fact.final_output)
      ) {
        // Matching native completion receipt; publication of the accepted
        // single-text body through the existing observation budget/reader path.
        this.releaseTerminalObservation(owner, {
          type: 'function_call_output',
          call_id: fact.call_id,
          output: fact.final_output,
        });
      }
      this.flushTerminalObservations(owner);
      if (
        proposal?.waiterConsumed ||
        msg.type === 'turn_aborted' ||
        msg.tool_completion === undefined
      )
        this.clearTerminalProposal(owner);
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
    if (msg.type === '_sdk_tool_completion_failed') {
      this.failToolCompletion(owner, event);
      return;
    }
    if (msg.type === '_sdk_tool_completion') {
      if (this.current(owner))
        void this.proposeToolCompletion(owner, event, native).catch(() => {});
      return;
    }
    if (
      msg.type === '_sdk_model_produce' ||
      msg.type === '_sdk_before_compact' ||
      msg.type === '_sdk_transform_context' ||
      msg.type === '_sdk_before_complete'
    ) {
      if (this.current(owner))
        void this.modelCallback(owner, event, native).catch(() => {});
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
    const delivery = this.callbackEvents.get(event);
    if (delivery) delivery.buffered = true;
    this.childCallbacks.track(
      owner,
      async () => {
        const scope = {
          session: this,
          child: owner,
          active: true,
          parent: toolInvocation.getStore(),
        };
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
        !(this.stepMcp.get(owner)?.servers ?? this.mcpTools).some(
          (server) =>
            server.name === invocation.server &&
            server.tools.includes(invocation.tool as string),
        )
      )
        return;
      const source = this.stepMcp.get(owner);
      if (
        source &&
        !source.servers.some(
          (server) =>
            server.name === invocation.server &&
            source.projection.some(
              (identity) =>
                identity.server === server.name &&
                identity.tool === invocation.tool &&
                source.names.some(
                  (name) =>
                    name.namespace === identity.namespace &&
                    name.name === identity.name,
                ),
            ),
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
      const source = this.stepMcp.get(run);
      if (source) this.questionMcp.set(event, source);
      void this.trackNativeQuestion(run, event).catch(() => {});
      return;
    }
    if (kind === '_sdk_tool_completion_failed') {
      this.failToolCompletion(run, event);
      return;
    }
    if (kind === '_sdk_tool_completion') {
      if (msg.turn_id !== run.id) return;
      void this.proposeToolCompletion(run, event, this.#native).catch(() => {});
      return;
    }
    if (kind === '_sdk_prepare_request') {
      if (msg.turn_id !== run.id) return;
      this.track(run, this.prepareRequest(run, event));
      return;
    }
    if (
      kind === '_sdk_model_produce' ||
      kind === '_sdk_before_compact' ||
      kind === '_sdk_transform_context' ||
      kind === '_sdk_before_complete'
    ) {
      if (msg.turn_id === run.id)
        void this.modelCallback(run, event, this.#native).catch(() => {});
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
      kind === 'turn_aborted' ||
      kind === 'sdk_raw_provider_event'
        ? event.id
        : null);
    if (eventTurn !== null && eventTurn !== undefined && eventTurn !== run.id)
      return;
    if (kind === 'agent_profile_changed') {
      this.observeProfileChange(msg, this.submissionIds.get(run)!);
      return;
    }
    if (
      (kind === 'mcp_tool_call_begin' || kind === 'mcp_tool_call_end') &&
      msg.turn_id === run.id
    )
      this.observeMcp(run, event);
    if (kind === 'raw_response_item' && event.id === run.id)
      this.releaseTerminalObservation(run, msg.item);
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
      kind === 'sdk_raw_provider_event' &&
      eventTurn === run.id &&
      msg.source === 'responses' &&
      (msg.transport === 'sse' ||
        msg.transport === 'websocket' ||
        msg.transport === 'json') &&
      msg.payload &&
      typeof msg.payload === 'object' &&
      !Array.isArray(msg.payload)
    )
      this.observations.append({
        type: 'raw_provider_event',
        turnId: run.id!,
        submissionId: this.submissionIds.get(run)!,
        source: msg.source,
        transport: msg.transport,
        payload: msg.payload,
      });
    if (
      kind === 'response_fact' &&
      eventTurn === run.id &&
      msg.thread_id === this.id &&
      msg.turn_id === run.id
    ) {
      const record = projectResponseFactRecord(msg);
      if (record)
        this.observations.append({
          type: 'response_fact',
          turnId: run.id!,
          submissionId: this.submissionIds.get(run)!,
          record,
        });
    }
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
      run.addUsage(usage ?? {}, 1, usage ? 0 : 1);
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
        this.mcpReaderStarted &&
        run.id &&
        this.#native._take_native_mcp_result_failure(
          run.id,
          kind === 'turn_aborted',
        )
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
      if (error === undefined && msg.tool_completion !== undefined) {
        try {
          const fact = toolCompletionSchema.parse(msg.tool_completion);
          const proposal = this.terminalProposals.get(run)?.proposal;
          if (
            !proposal ||
            !proposal.accepted ||
            proposal.callId !== fact.call_id ||
            proposal.name !== fact.name ||
            (proposal.namespace ?? 'functions') !==
              (fact.namespace ?? 'functions') ||
            !isDeepStrictEqual(proposal.json, fact.final_output)
          )
            throw new NativeError(
              'Terminal tool completion has no matching accepted proposal',
            );
          this.decodedOutputs.set(run, proposal.value);
          this.terminalCalls.set(
            run,
            terminalCallInfo(
              {
                sessionId: this.id,
                turnId: run.id!,
                childId: null,
                childIncarnation: null,
              },
              fact,
              proposal.namespace,
            ),
          );
        } catch (cause) {
          error = cause;
        }
      }
      this.clearTerminalProposal(run);
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
  private terminalState(owner: NativeTurn | ChildCallbackOwner) {
    let state = this.terminalProposals.get(owner);
    if (!state) {
      state = { observations: new Map() };
      this.terminalProposals.set(owner, state);
    }
    return state;
  }

  private clearTerminalProposal(owner: NativeTurn | ChildCallbackOwner): void {
    const state = this.terminalProposals.get(owner);
    if (state) state.proposal = undefined;
  }

  private registerTerminalObservation(
    owner: NativeTurn | ChildCallbackOwner,
    identity: ToolIdentity,
    status: ToolStatus,
  ): void {
    const state = this.terminalState(owner);
    if (state.observations.has(identity.callId))
      throw new NativeError('Repeated terminal tool observation identity');
    state.observations.set(identity.callId, {
      identity: { ...identity },
      status,
    });
  }

  private releaseTerminalObservation(
    owner: NativeTurn | ChildCallbackOwner,
    value: unknown,
  ): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const item = value as Record<string, unknown>;
    if (
      item.type !== 'function_call_output' ||
      typeof item.call_id !== 'string'
    )
      return;
    const state = this.terminalProposals.get(owner);
    const observation = state?.observations.get(item.call_id);
    if (!observation) return;
    state!.observations.delete(item.call_id);
    const parts =
      typeof item.output === 'string'
        ? [{ type: 'inputText', text: item.output }]
        : Array.isArray(item.output)
          ? item.output.map((part: unknown) => {
              if (!part || typeof part !== 'object' || Array.isArray(part))
                return null;
              const { type, ...fields } = part as Record<string, unknown>;
              if (type === 'input_text')
                return { ...fields, type: 'inputText' };
              if (type === 'input_file')
                return { ...fields, type: 'inputFile' };
              if (type === 'input_audio')
                return { type: 'inputAudio', audioUrl: fields.audio_url };
              if (type === 'input_image')
                return {
                  type: 'inputImage',
                  ...('image_url' in fields
                    ? { imageUrl: fields.image_url }
                    : { fileId: fields.file_id }),
                  ...(fields.detail === undefined
                    ? {}
                    : { detail: fields.detail }),
                };
              return null;
            })
          : null;
    const output = toolOutputSchema.safeParse({
      contentItems: parts,
      success: observation.status === 'completed',
    });
    this.observeTool(
      owner,
      observation.identity,
      'tool_finished',
      observation.status,
      output.success
        ? new ToolOutput(output.data.contentItems, output.data.success)
        : null,
    );
  }

  private flushTerminalObservations(
    owner: NativeTurn | ChildCallbackOwner,
  ): void {
    const state = this.terminalProposals.get(owner);
    if (!state) return;
    const pending = [...state.observations.values()];
    state.observations.clear();
    for (const observation of pending)
      this.observeTool(
        owner,
        observation.identity,
        'tool_finished',
        owner.controller.signal.aborted ? 'cancelled' : observation.status,
        null,
      );
  }

  private discardTerminalValue(owner: NativeTurn | ChildCallbackOwner): void {
    const proposal = this.terminalProposals.get(owner)?.proposal;
    if (!proposal) return;
    const { value: _value, json: _json, ...attempt } = proposal;
    this.terminalState(owner).proposal = { ...attempt, accepted: false };
  }

  /** Strict Core failure has no TurnComplete; this notice settles its exact waiter. */
  private failToolCompletion(
    owner: NativeTurn | ChildCallbackOwner,
    event: NativeEvent,
  ): boolean {
    const msg = event.msg;
    const child = !(owner instanceof NativeTurn);
    const proposal = this.terminalProposals.get(owner)?.proposal;
    if (
      !proposal ||
      msg.thread !== (child ? owner.childId : this.id) ||
      (msg.instance ?? null) !== (child ? owner.incarnation : null) ||
      msg.turn_id !== (child ? owner.turnId : owner.id) ||
      msg.generation !== proposal.generation.toString() ||
      msg.request_id !== proposal.requestId ||
      msg.native_step !== proposal.nativeStep
    )
      return false;
    this.clearTerminalProposal(owner);
    this.flushTerminalObservations(owner);
    owner.failure ??= new NativeError(
      'Terminal tool completion failed before durable publication',
    );
    if (owner instanceof NativeTurn) this.finish(owner, owner.failure);
    else {
      this.childCallbacks.end(owner.childId, owner.incarnation, owner.turnId);
      if (owner.observationPhase === 'open') {
        owner.observationPhase = 'finishing';
        const settled = this.childCallbacks
          .drain(owner.childId, owner.incarnation, owner.turnId)
          .catch(() => {})
          .then(() => {
            this.observations.append({
              type: 'turn_finished',
              turnId: owner.turnId,
              submissionId: `child:${owner.childId}:${owner.incarnation}:${owner.turnId}`,
              status: 'failed',
              errorType:
                owner.failure instanceof Error
                  ? owner.failure.name
                  : 'NativeError',
            });
            owner.observationPhase = 'ended';
            this.observations.notify();
          });
        this.childContinuations.add(settled);
        void settled.finally(() => this.childContinuations.delete(settled));
      }
    }
    return true;
  }

  /** Convert a provisional proposal on the existing root/child callback owner. */
  private proposeToolCompletion(
    owner: NativeTurn | ChildCallbackOwner,
    event: NativeEvent,
    nativeSource: NativeThread,
  ): Promise<void> {
    const buffered = this.callbackEvents.get(event);
    if (buffered) buffered.buffered = true;
    return this.trackOwnedCallback(owner, () =>
      this.ownCallbackDelivery(event, owner, async (signal, delivery) => {
        const native = delivery?.native ?? nativeSource;
        const msg = event.msg;
        const child = !(owner instanceof NativeTurn);
        const turnId = child ? owner.turnId : owner.id;
        const receipt = {
          thread: child ? owner.childId : this.id,
          instance: child ? owner.incarnation : null,
          turn_id: turnId,
          generation: msg.generation,
          request_id: msg.request_id,
          native_step: msg.native_step,
        };
        let replied = false;
        let capturedCatalog: ToolCatalog | undefined;
        const reject = () => {
          if (replied) return;
          replied = true;
          try {
            native._reply_tool_completion(
              encode({
                ...receipt,
                error: 'Terminal output conversion failed',
              }),
            );
          } catch {
            /* This exact native waiter may already have retired. */
          }
        };
        const check = () => {
          signal.throwIfAborted();
          if (
            !this.current(owner) ||
            native !== this.#native ||
            msg.thread !== receipt.thread ||
            msg.turn_id !== turnId ||
            (child && msg.instance !== owner.incarnation) ||
            !capturedCatalog ||
            this.sourceCatalog(msg, z.string().parse(msg.generation)) !==
              capturedCatalog ||
            !native._check_tool_completion(encode(receipt))
          )
            throw new NativeError('Expired terminal proposal owner');
        };
        const abort = () => {
          this.discardTerminalValue(owner);
          reject();
        };
        signal.addEventListener('abort', abort, { once: true });
        try {
          this.clearTerminalProposal(owner);
          capturedCatalog = this.sourceCatalog(
            msg,
            z.string().parse(msg.generation),
          );
          check();
          await this.awaitInputGuardrails(
            owner instanceof NativeTurn ? this.rootRun(owner) : owner,
          );
          const slot = z.number().int().nonnegative().safe().parse(msg.slot);
          const captured = capturedCatalog.tools[slot];
          const declaration =
            captured && (managedApproval(captured)?.function ?? captured);
          const identity = z
            .object({ name: z.string(), namespace: z.string().nullable() })
            .parse(msg.tool);
          if (
            !declaration ||
            declaration.kind === 'manual' ||
            !declaration.finishTurn ||
            declaration.name !== identity.name ||
            (toolNamespace(declaration) ?? 'functions') !==
              (identity.namespace ?? 'functions')
          )
            throw new NativeError(
              'Terminal proposal does not match its captured declaration',
            );
          const attempt = {
            requestId: z.string().parse(msg.request_id),
            nativeStep: z.string().parse(msg.native_step),
            generation: capturedCatalog.generation,
            callId: z.string().parse(msg.call_id),
            name: declaration.name,
            namespace: toolNamespace(declaration),
          };
          this.terminalState(owner).proposal = { ...attempt, accepted: false };
          let output: PreparedOutput = this.childOutput;
          if (!child) {
            const submission = submissions.get(owner)!;
            const source = this.messageProfile(msg);
            output = submission.output;
            if (
              source &&
              !submission.outputOverride &&
              !submission.compaction &&
              !submission.review &&
              !submission.realtimeTools
            )
              output = this.profileRuntimes.get(source.profile_id)!.output;
          }
          const converted = parseToolCompletion(output, msg.output);
          check();
          const beforeComplete = this.sourceModelCallbacks(msg).beforeComplete;
          if (beforeComplete && msg.guard_only !== true) {
            const scope = this.decisionScope(event.msg, signal);
            try {
              const model = z.string().parse(msg.model);
              const returned = beforeComplete(
                Object.freeze({
                  decide: scope.decide,
                  context: this.options.context,
                  text: null,
                  sessionId: this.id,
                  turnId: z.string().parse(turnId),
                  ...(child ? { subagentId: owner.childId } : {}),
                  model,
                  continuationCount: z
                    .number()
                    .int()
                    .nonnegative()
                    .safe()
                    .parse(msg.continuation_count),
                  signal,
                  finalOutput: losslessJsonValueSchema.parse(converted.json),
                  toolCall: Object.freeze({
                    ...terminalCallInfo(
                      {
                        sessionId: this.id,
                        turnId: z.string().parse(turnId),
                        childId: child ? owner.childId : null,
                        childIncarnation: child ? owner.incarnation : null,
                      },
                      {
                        call_id: z.string().parse(msg.call_id),
                        name: declaration.name,
                        namespace: toolNamespace(declaration),
                        final_output: converted.json,
                      },
                    ),
                    model,
                  }),
                }),
              );
              const settled =
                returned &&
                typeof (returned as Promise<unknown>).then === 'function'
                  ? await returned
                  : returned;
              const decision = captureCompletionDecision(settled);
              check();
              if (decision) {
                this.discardTerminalValue(owner);
                const data =
                  decision.action === 'stop'
                    ? { stop: true }
                    : { continue: decision.instructions };
                if (
                  !native._reply_tool_completion(
                    encode({ ...receipt, ...data }),
                  )
                )
                  throw new NativeError('Terminal decision reply expired');
                replied = true;
                return;
              }
            } finally {
              await scope.close();
            }
          }
          check();
          await this.checkOutputGuardrails(
            owner,
            msg,
            {
              context: this.options.context,
              text: null,
              sessionId: this.id,
              turnId: z.string().parse(turnId),
              ...(child ? { subagentId: owner.childId } : {}),
              model: z.string().parse(msg.model),
              signal,
              continuationCount: z
                .number()
                .int()
                .nonnegative()
                .parse(msg.continuation_count),
              finalOutput: converted.value,
              toolCall: terminalCallInfo(
                {
                  sessionId: this.id,
                  turnId: z.string().parse(turnId),
                  childId: child ? owner.childId : null,
                  childIncarnation: child ? owner.incarnation : null,
                },
                {
                  call_id: z.string().parse(msg.call_id),
                  name: declaration.name,
                  namespace: toolNamespace(declaration),
                  final_output: converted.json,
                },
              ),
            },
            check,
          );
          check();
          if (msg.guard_only === true) this.clearTerminalProposal(owner);
          else
            this.terminalState(owner).proposal = {
              ...attempt,
              accepted: true,
              value: converted.value,
              json: converted.json,
            };
          check();
          if (
            !native._reply_tool_completion(
              JSON.stringify(
                losslessJsonValueSchema.parse({
                  ...receipt,
                  final_output: converted.json,
                }),
              ),
            )
          )
            throw new NativeError('Terminal proposal reply expired');
          replied = true;
        } catch (error) {
          this.discardTerminalValue(owner);
          reject();
          // Preserve the owning OutputValidationError for result and stream settlement.
          owner.failure ??= error;
          throw error;
        } finally {
          signal.removeEventListener('abort', abort);
          if (!replied) reject();
        }
      }),
    );
  }

  private async awaitInputGuardrails(
    run: NativeTurn | ChildCallbackOwner,
  ): Promise<void> {
    await run.inputGuardrailsTask;
    if (run.failure !== undefined) throw run.failure;
  }

  private async checkInputGuardrails(
    run: NativeTurn | ChildCallbackOwner,
    message: Record<string, unknown>,
    guards: readonly InputGuardrail<any>[],
    childContext?: ChildBeforeStepContext<Context>,
  ): Promise<void> {
    if (!guards.length) return;
    const agent = this.sourceApplicationAgent(message);
    if (!agent) throw new NativeError('Guardrail has no source Agent');
    const signal = run.controller.signal;
    const check = () => {
      signal.throwIfAborted();
      if (!this.current(run))
        throw new NativeError('Expired input guardrail owner');
    };
    const scope = this.decisionScope(message, signal);
    let observedFailure: { error: unknown } | undefined;
    const parallel = guards.some((guard) => guard.runInParallel !== false);
    try {
      const settled = await Promise.allSettled(
        guards
          .map(async (guard) => {
            check();
            const result = captureGuardrailResult(
              await (childContext
                ? guard.childCallback!(
                    Object.freeze({
                      ...childContext,
                      decide: scope.decide,
                      signal,
                      agent,
                      input: structuredClone(
                        (run as ChildCallbackOwner).guardrailInput!,
                      ),
                    }),
                  )
                : guard.callback(
                    Object.freeze({
                      decide: scope.decide,
                      context: this.options.context,
                      submission: this.#turnFor(
                        this.rootRun(run as NativeTurn),
                      ),
                      signal,
                      agent,
                      input: structuredClone(
                        (run as NativeTurn).guardrailInput!,
                      ),
                    }),
                  )),
            );
            check();
            return Object.freeze({
              kind: 'input' as const,
              name: guard.name,
              result,
              agent,
              sessionId: this.id,
              turnId: z
                .string()
                .parse(run instanceof NativeTurn ? run.id : run.turnId),
              ...(run instanceof NativeTurn ? {} : { subagentId: run.childId }),
            });
          })
          .map((pending) =>
            pending.catch((error) => {
              if (parallel && !observedFailure) {
                observedFailure = { error };
                if (
                  this.current(run) &&
                  !signal.aborted &&
                  run.failure === undefined
                )
                  toolInvocation.exit(() => {
                    // Existing owner failure delivery before the pending peer callbacks join.
                    void this.trackOwnedCallback(run, () =>
                      Promise.reject(error),
                    ).catch(() => {});
                  });
              }
              throw error;
            }),
          ),
      );
      const records = settled.flatMap((entry) =>
        entry.status === 'fulfilled' ? [entry.value] : [],
      );
      run.guardrailResults.push(...records);
      const failed = settled.find((entry) => entry.status === 'rejected');
      if (observedFailure) throw observedFailure.error;
      if (failed?.status === 'rejected') throw failed.reason;
      check();
      const tripped = records.find((record) => record.result.tripwireTriggered);
      if (tripped)
        throw new GuardrailTripwire(
          tripped,
          Object.freeze([...run.guardrailResults]),
        );
    } finally {
      await scope.close();
    }
  }

  private async checkOutputGuardrails(
    owner: NativeTurn | ChildCallbackOwner,
    message: Record<string, unknown>,
    request: Omit<CompletionContext<any, unknown>, 'decide'>,
    check: () => void,
  ): Promise<void> {
    const source = this.messageProfile(message);
    const declaration = source
      ? this.profileRuntimes.get(source.profile_id)!.profile.declaration
      : undefined;
    const agent = this.sourceApplicationAgent(message);
    if (!agent) throw new NativeError('Guardrail has no source Agent');
    const guards = [
      ...(this.options.outputGuardrails ?? []),
      ...(source
        ? declaration!.outputGuardrails
        : (this.options.agentOutputGuardrails ?? [])),
    ];
    if (!guards.length) return;
    const scope = this.decisionScope(message, request.signal);
    try {
      const settled = await Promise.allSettled(
        guards.map(async (guard) => {
          check();
          const result = captureGuardrailResult(
            await guard.callback(
              Object.freeze({
                ...request,
                finalOutput: structuredClone(request.finalOutput),
                decide: scope.decide,
              }),
              agent,
            ),
          );
          check();
          return Object.freeze({
            kind: 'output' as const,
            name: guard.name,
            result,
            agent,
            sessionId: request.sessionId,
            turnId: request.turnId,
            ...(request.subagentId ? { subagentId: request.subagentId } : {}),
            ...(request.toolCall ? { toolCall: request.toolCall } : {}),
          });
        }),
      );
      const records = settled.flatMap((entry) =>
        entry.status === 'fulfilled' ? [entry.value] : [],
      );
      owner.guardrailResults.push(...records);
      const failed = settled.find((entry) => entry.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      check();
      const tripped = records.find((record) => record.result.tripwireTriggered);
      if (tripped)
        throw new GuardrailTripwire(
          tripped,
          Object.freeze([...owner.guardrailResults]),
        );
    } finally {
      await scope.close();
    }
  }

  private sourceModelCallbacks(message: Record<string, unknown>): {
    beforeComplete?: BeforeComplete<any>;
    beforeCompact?: BeforeCompact<any>;
    transformContext?: ContextTransform<any>;
  } {
    const source = this.messageProfile(message);
    return source
      ? this.profileRuntimes.get(source.profile_id)!.profile.declaration
      : this.options;
  }

  private modelCallback(
    owner: NativeTurn | ChildCallbackOwner,
    event: NativeEvent,
    native: NativeThread,
  ): Promise<void> {
    const buffered = this.callbackEvents.get(event);
    if (buffered) buffered.buffered = true;
    return this.trackOwnedCallback(
      owner,
      () =>
        this.ownCallbackDelivery(event, owner, async (signal, delivery) => {
          const sourceNative = delivery?.native ?? native;
          const msg = event.msg;
          const child = !(owner instanceof NativeTurn);
          const receipt = {
            thread: child ? owner.childId : this.id,
            instance: child ? owner.incarnation : null,
            turn_id: child ? owner.turnId : owner.id,
            generation: msg.generation,
            request_id: msg.request_id,
          };
          const contextEdit = msg.type === '_sdk_transform_context';
          const compact = msg.type === '_sdk_before_compact';
          const produce = msg.type === '_sdk_model_produce';
          const sourceCatalog = this.sourceCatalog(
            msg,
            z.string().parse(msg.generation),
          );
          const { beforeComplete, beforeCompact, transformContext } =
            this.sourceModelCallbacks(msg);
          let replied = false;
          const reply = (result: Record<string, unknown>, failed = false) => {
            if (replied) return;
            const envelope = { owner: receipt, ...result, failed };
            const data = contextEdit
              ? JSON.stringify(losslessJsonValueSchema.parse(envelope))
              : encode(envelope);
            if (produce) sourceNative._reply_model_producer(data);
            else if (compact) sourceNative._reply_compaction(data);
            else if (contextEdit) sourceNative._reply_model_context(data);
            else sourceNative._reply_natural_completion(data);
            replied = true;
          };
          const reject = () => {
            if (replied) return;
            try {
              reply({}, true);
            } catch {
              /* The exact native waiter may have retired. */
            }
          };
          const check = () => {
            signal.throwIfAborted();
            if (
              !this.current(owner) ||
              sourceNative !== this.#native ||
              msg.thread !== receipt.thread ||
              msg.turn_id !== receipt.turn_id ||
              this.sourceCatalog(msg, msg.generation as string) !==
                sourceCatalog ||
              !sourceNative._check_step(encode(receipt))
            )
              throw new NativeError('Expired model callback owner');
          };
          signal.addEventListener('abort', reject, { once: true });
          try {
            check();
            if (msg.type === '_sdk_before_complete')
              await this.awaitInputGuardrails(
                child
                  ? (owner as ChildCallbackOwner)
                  : this.rootRun(owner as NativeTurn),
              );
            const base = {
              context: this.options.context,
              sessionId: this.id,
              turnId: z.string().parse(receipt.turn_id),
              ...(child ? { subagentId: owner.childId } : {}),
              model: z.string().parse(msg.model),
              signal,
            };
            if (produce) {
              if (!this.options.modelBackend)
                throw new NativeError(
                  'Native model producer has no application backend',
                );
              const backend =
                'complete' in this.options.modelBackend
                  ? this.options.modelBackend
                  : this.options.modelBackend.getModel(base.model);
              check();
              const request = {
                ...base,
                body: losslessJsonObjectSchema.parse(msg.data),
              };
              if (backend.stream) {
                const stream = await backend.stream(request);
                const iterator = stream[Symbol.asyncIterator]();
                let finished = false;
                try {
                  check();
                  const streamOwner = encode(receipt);
                  sourceNative._start_model_producer(streamOwner);
                  while (true) {
                    check();
                    const next = await iterator.next();
                    check();
                    if (next.done) {
                      finished = true;
                      break;
                    }
                    const continuing = await sourceNative._push_model_producer(
                      streamOwner,
                      JSON.stringify(
                        losslessJsonObjectSchema.parse(next.value),
                      ),
                    );
                    check();
                    if (!continuing) break;
                  }
                } finally {
                  if (!finished) await iterator.return?.();
                }
                check();
                reply({});
              } else {
                const returned = await backend.complete(request);
                check();
                const data = captureModelResponse(returned);
                check();
                reply({ data });
              }
            } else if (compact) {
              const items = z.array(losslessJsonObjectSchema).parse(msg.items);
              const returned = beforeCompact?.(
                Object.freeze({
                  ...base,
                  items: Object.freeze(items),
                  requestId: z.string().parse(msg.request_id),
                  automatic: z.boolean().parse(msg.automatic),
                }),
              );
              const settled =
                returned &&
                typeof (returned as Promise<unknown>).then === 'function'
                  ? await returned
                  : returned;
              if (
                settled !== undefined &&
                (typeof settled !== 'string' || !settled.trim())
              )
                throw new TypeError(
                  'beforeCompact must return a nonempty summary or undefined',
                );
              check();
              reply(settled === undefined ? {} : { summary: settled });
            } else if (contextEdit) {
              const items = z.array(losslessJsonObjectSchema).parse(msg.items);
              const returned = transformContext?.(
                Object.freeze({
                  ...base,
                  items: Object.freeze(items),
                  requestId: z.string().parse(msg.request_id),
                  purpose:
                    msg.compaction === true
                      ? 'compaction'
                      : (this.options.contextTransformPurpose ?? 'turn'),
                }),
              );
              const settled =
                returned &&
                typeof (returned as Promise<unknown>).then === 'function'
                  ? await returned
                  : returned;
              const replacement =
                settled === undefined
                  ? undefined
                  : z.array(losslessJsonObjectSchema).parse(settled);
              check();
              reply(replacement === undefined ? {} : { items: replacement });
            } else {
              const invoke = async (text: string | null) => {
                const scope = this.decisionScope(event.msg, signal);
                try {
                  const returned = beforeComplete?.(
                    Object.freeze({
                      ...base,
                      text,
                      continuationCount: z
                        .number()
                        .int()
                        .nonnegative()
                        .safe()
                        .parse(msg.continuation_count),
                      decide: scope.decide,
                    }),
                  );
                  const settled =
                    returned &&
                    typeof (returned as Promise<unknown>).then === 'function'
                      ? await returned
                      : returned;
                  const decision = captureCompletionDecision(settled);
                  check();
                  return decision;
                } finally {
                  await scope.close();
                }
              };
              if (!child) this.decodedOutputs.delete(owner);
              const text = z.string().nullable().parse(msg.text);
              let decision = await invoke(text);
              if (!child && decision === undefined) {
                const submission = submissions.get(owner)!;
                const profile = this.messageProfile(msg);
                const prepared =
                  profile &&
                  !submission.outputOverride &&
                  !submission.realtimeTools
                    ? this.profileRuntimes.get(profile.profile_id)!.output
                    : submission.output;
                if (!submission.compaction && prepared.repair) {
                  try {
                    this.decodedOutputs.set(owner, prepared.parse!(text ?? ''));
                  } catch (error) {
                    if (!(error instanceof OutputValidationError)) throw error;
                    const repaired = await this.runOutputRepair(
                      owner,
                      text ?? '',
                      prepared,
                      { candidate: invoke, signal, check },
                    );
                    if (repaired.type === 'stopped') {
                      // Preserve the accepted repair stop before Core settles the callback.
                      owner.failure ??= new TurnAborted('Turn interrupted');
                      decision = { action: 'stop' };
                    } else if (repaired.type === 'decision') {
                      decision = repaired.decision;
                    } else {
                      this.decodedOutputs.set(owner, repaired.output);
                    }
                  }
                }
              }
              if (decision === undefined) {
                const source = this.messageProfile(msg);
                const agent = source
                  ? this.profileRuntimes.get(source.profile_id)!.profile
                      .declaration
                  : this.options.applicationAgent;
                if (
                  (this.options.outputGuardrails?.length ?? 0) +
                    (source
                      ? (agent?.outputGuardrails.length ?? 0)
                      : (this.options.agentOutputGuardrails?.length ?? 0)) >
                  0
                ) {
                  let value: unknown = text ?? '';
                  if (!child) {
                    const submission = submissions.get(owner)!;
                    const prepared =
                      source &&
                      !submission.outputOverride &&
                      !submission.realtimeTools
                        ? this.profileRuntimes.get(source.profile_id)!.output
                        : submission.output;
                    if (this.decodedOutputs.has(owner))
                      value = this.decodedOutputs.get(owner);
                    else {
                      value = prepared.parse
                        ? prepared.parse(text ?? '')
                        : (text ?? '');
                      this.decodedOutputs.set(owner, value);
                    }
                  }
                  await this.checkOutputGuardrails(
                    owner,
                    msg,
                    {
                      ...base,
                      text,
                      finalOutput: value,
                      continuationCount: z
                        .number()
                        .int()
                        .nonnegative()
                        .parse(msg.continuation_count),
                    },
                    check,
                  );
                }
              }
              if (!child && decision !== undefined)
                this.decodedOutputs.delete(owner);
              check();
              reply(decision === undefined ? {} : { decision });
            }
          } catch (error) {
            if (!child) this.decodedOutputs.delete(owner);
            reject();
            owner.failure ??= error;
            throw error;
          } finally {
            signal.removeEventListener('abort', reject);
            if (!replied) reject();
          }
        }),
      typeof event.msg.tracing_context === 'string'
        ? event.msg.tracing_context
        : undefined,
    );
  }

  private prepareRequest(run: NativeTurn, event: NativeEvent): Promise<void> {
    return this.ownCallbackDelivery(event, run, (signal, delivery) =>
      this.prepareCallbackRequest(run, event, signal, delivery),
    );
  }
  private prepareCallbackRequest(
    run: NativeTurn,
    event: NativeEvent,
    callbackSignal: AbortSignal,
    delivery?: NativeCallbackDelivery,
  ): Promise<void> {
    const msg = event.msg;
    const native = delivery?.native ?? this.#native;
    const selection = run.selection;
    const preparation = new AbortController();
    const signal = AbortSignal.any([callbackSignal, preparation.signal]);
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
              native._reply_prepared_request(receipt);
            } catch {
              /* Already revoked. */
            }
          } else {
            try {
              (delivery?.native ?? this.#native)._reply_prepared_request(
                receipt,
              );
            } catch (error) {
              this.callbackAuthorityFailed(delivery, error);
            }
          }
        };
        const abort = () => reply(undefined, true);
        signal.addEventListener('abort', abort, { once: true });
        try {
          const sourceCatalog = this.sourceCatalog(
            msg,
            msg.generation as string,
          );
          if (
            !selection?.prepareRequest ||
            !this.current(run) ||
            msg.turn_id !== run.id ||
            (!this.options.agentGraph &&
              selection.generation !== sourceCatalog.generation)
          )
            throw new NativeError('Expired prepared request owner');
          signal.throwIfAborted();
          if (this.graphStops.size)
            throw new TurnAborted('Request preparation stopped');
          const scope = this.decisionScope(event.msg, signal);
          let captured: ReturnType<typeof capturePreparedRequest> | undefined;
          try {
            const returned = selection.prepareRequest({
              decide: scope.decide,
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
                : (returned as PreparedRequestData | undefined);
            // Capture mutable application data before joining admitted helper work.
            captured =
              replacement === undefined
                ? undefined
                : capturePreparedRequest(replacement);
          } finally {
            await scope.close();
          }
          signal.throwIfAborted();
          if (
            !this.current(run) ||
            this.sourceCatalog(msg, msg.generation as string) !== sourceCatalog
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
    return this.ownCallbackDelivery(event, run, (signal, delivery) =>
      this.selectCallbackStep(run, event, signal, delivery),
    );
  }
  private selectCallbackStep(
    run: NativeTurn,
    event: NativeEvent,
    callbackSignal: AbortSignal,
    delivery?: NativeCallbackDelivery,
  ): Promise<void> {
    const msg = event.msg;
    const native = delivery?.native ?? this.#native;
    const selection = run.selection;
    const preparation = new AbortController();
    const signal = AbortSignal.any([callbackSignal, preparation.signal]);
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
              native._reply_step(response);
            } catch {
              /* Already revoked. */
            }
          } else {
            try {
              native._reply_step(response);
            } catch (error) {
              this.callbackAuthorityFailed(delivery, error);
            }
          }
        };
        const abort = () => reply(null);
        signal.addEventListener('abort', abort, { once: true });
        try {
          const sourceCatalog = this.sourceCatalog(
            msg,
            msg.generation as string,
          );
          const sourceProfile = this.messageProfile(msg);
          if (
            !selection ||
            !this.current(run) ||
            msg.turn_id !== run.id ||
            (!sourceProfile &&
              selection.generation !== sourceCatalog.generation)
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
            try {
              if (
                !this.current(run) ||
                this.sourceCatalog(msg, msg.generation as string) !==
                  sourceCatalog ||
                !native._check_step(nonce)
              )
                throw new NativeError('Step selection is no longer active');
            } catch (error) {
              this.callbackAuthorityFailed(delivery, error);
            }
          };
          assertActive();
          selection.budget?.check(assertActive);
          const stepIndex = selection.stepIndex++;
          if (run.failure !== undefined) throw run.failure;
          // Selection can repeat before the first provider request. Parallel
          // input checks join at completion, not during this preparation.
          if (!run.inputGuardrailsStarted && run.guardrailInput !== undefined) {
            run.inputGuardrailsStarted = true;
            const source = this.messageProfile(msg);
            const agent = source
              ? this.profileRuntimes.get(source.profile_id)!.profile.declaration
              : this.options.applicationAgent;
            if (!agent) throw new NativeError('Guardrail has no source Agent');
            const guards = [
              ...(this.options.inputGuardrails ?? []),
              ...(source
                ? agent.inputGuardrails
                : (this.options.agentInputGuardrails ?? [])),
            ];
            try {
              await this.checkInputGuardrails(
                run,
                msg,
                guards.filter((guard) => guard.runInParallel === false),
              );
              const parallel = guards.filter(
                (guard) => guard.runInParallel !== false,
              );
              if (parallel.length) {
                run.inputGuardrailsTask = this.invokeCallback(run, () =>
                  this.checkInputGuardrails(run, msg, parallel),
                ).finally(() => {
                  run.guardrailInput = undefined;
                });
                this.track(run, run.inputGuardrailsTask);
              }
            } finally {
              if (!run.inputGuardrailsTask) run.guardrailInput = undefined;
            }
          }
          const scope = this.decisionScope(event.msg, signal);
          let names: ReturnType<typeof this.selectedStepNames> = [];
          let stopped = false;
          try {
            const selected = await selection.beforeStep?.({
              decide: scope.decide,
              context: this.options.context as Context,
              submission: this.#turnFor(this.rootRun(run)),
              stepIndex,
              signal,
            });
            if (isStepStop(selected)) stopped = true;
            else
              names = this.selectedStepNames(
                event,
                selected,
                this.profileOperationNames(selection, event, sourceCatalog),
                sourceCatalog,
              );
          } finally {
            await scope.close();
          }
          assertActive();
          if (stopped) {
            if (native._stop_step(nonce)) replied = true;
            else reply(null);
            return;
          }
          selection.budget?.check(assertActive);
          signal.throwIfAborted();
          {
            const source = sourceProfile;
            const servers = source
              ? this.profileStepMcp.get(
                  this.profileKey(source.profile_id, sourceCatalog.generation),
                )
              : this.mcpTools;
            if (!servers)
              throw new NativeError(
                'Native step has no captured source MCP bindings',
              );
            const selectedNames = new Set(
              names.map((name) => JSON.stringify([name.namespace, name.name])),
            );
            this.stepMcp.set(run, {
              servers: servers.filter((server) =>
                this.stepMcpProjection(event).some(
                  (identity) =>
                    identity.server === server.name &&
                    server.tools.includes(identity.tool) &&
                    selectedNames.has(
                      JSON.stringify([identity.namespace, identity.name]),
                    ),
                ),
              ),
              names,
              projection: this.stepMcpProjection(event),
              generation: source
                ? sourceCatalog.generation
                : this.mcpGeneration,
            });
          }
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
    const delivery = this.callbackEvents.get(event);
    if (delivery) delivery.buffered = true;
    return this.trackOwnedCallback(owner, () =>
      this.ownCallbackDelivery(event, owner, (signal, captured) =>
        this.selectCallbackChildStep(
          owner,
          event,
          captured?.native ?? native,
          signal,
          captured,
        ),
      ),
    );
  }
  private async selectCallbackChildStep(
    owner: ChildCallbackOwner,
    event: NativeEvent,
    native: NativeThread,
    signal: AbortSignal,
    delivery?: NativeCallbackDelivery,
  ): Promise<void> {
    const beforeStep = this.options.nativeAgents?.beforeStep;
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
      } else {
        try {
          native._reply_child_step(response);
        } catch (error) {
          this.callbackAuthorityFailed(delivery, error);
        }
      }
    };
    const abort = () => reply(null);
    const treeStopping = () =>
      [...this.graphStops].some((stop) => stop.options.scope === 'thread_tree');
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      const original = await native._child_turn(owner.childId);
      if (
        !this.current(owner) ||
        native !== this.#native ||
        treeStopping() ||
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
      const scope = this.decisionScope(event.msg, signal);
      const context = Object.freeze({
        decide: scope.decide,
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
      const stepReceipt = encode(receipt);
      const isAdmitted = (diagnose = false) => {
        if (signal.aborted) return false;
        if (
          !this.current(owner) ||
          native !== this.#native ||
          treeStopping() ||
          capturedSelection.generation !== this.catalog.generation
        ) {
          if (diagnose) reply(null);
          return false;
        }
        try {
          if (native._check_step(stepReceipt)) return true;
          if (
            diagnose &&
            delivery &&
            delivery.native._python_callback_cancelled(delivery.wire)
          )
            throw new NativeError('Child step selection is no longer active');
          return false;
        } catch (error) {
          this.callbackAuthorityFailed(delivery, error);
        }
      };
      signal.throwIfAborted();
      if (!isAdmitted(true)) return;
      if (owner.failure !== undefined) throw owner.failure;
      const skipped = Symbol();
      let selected: StepDecision<Context> | typeof skipped;
      let names: ReturnType<typeof this.selectedStepNames> = [];
      let stopped = false;
      try {
        selected = await withNativeCallbackContext<
          StepDecision<Context> | typeof skipped
        >(
          typeof event.msg.tracing_context === 'string'
            ? event.msg.tracing_context
            : undefined,
          async (retainStorage) => {
            if (!owner.inputGuardrailsStarted) {
              const source = this.messageProfile(event.msg);
              const agent = source
                ? this.profileRuntimes.get(source.profile_id)!.profile
                    .declaration
                : this.options.applicationAgent;
              const guards = [
                ...(this.options.inputGuardrails ?? []),
                ...(source
                  ? agent!.inputGuardrails
                  : (this.options.agentInputGuardrails ?? [])),
              ].filter((guard) => guard.childCallback !== undefined);
              if (guards.length) {
                if (!isAdmitted()) return skipped;
                if (!agent)
                  throw new NativeError('Child guardrail has no source Agent');
                const initial = event.msg.initial_input;
                if (
                  !Array.isArray(initial) ||
                  !initial.every(
                    (item) =>
                      item !== null &&
                      typeof item === 'object' &&
                      !Array.isArray(item),
                  )
                )
                  throw new NativeError(
                    'Child guardrail lacks admitted initial input',
                  );
                owner.guardrailInput = structuredClone(initial) as JsonObject[];
                owner.inputGuardrailsStarted = true;
                let releaseParallelStorage: (() => void) | undefined;
                try {
                  await this.checkInputGuardrails(
                    owner,
                    event.msg,
                    guards.filter((guard) => guard.runInParallel === false),
                    context,
                  );
                  if (!isAdmitted()) return skipped;
                  const parallel = guards.filter(
                    (guard) => guard.runInParallel !== false,
                  );
                  if (parallel.length) {
                    releaseParallelStorage = retainStorage?.();
                    owner.inputGuardrailsTask = this.trackOwnedCallback(
                      owner,
                      async () => {
                        try {
                          if (!isAdmitted()) return;
                          await this.checkInputGuardrails(
                            owner,
                            event.msg,
                            parallel,
                            context,
                          );
                        } finally {
                          owner.guardrailInput = undefined;
                          releaseParallelStorage?.();
                        }
                      },
                    );
                  }
                } finally {
                  if (!owner.inputGuardrailsTask) {
                    owner.guardrailInput = undefined;
                    releaseParallelStorage?.();
                  }
                }
              }
            }
            if (beforeStep && !isAdmitted()) return skipped;
            capturedSelection.stepIndex++;
            return beforeStep?.(context);
          },
          signal,
          workflowForTrace,
          owner.observationProducer.callbackTraceStorages,
        );
        if (selected !== skipped) {
          if (isStepStop(selected)) stopped = true;
          else names = this.selectedStepNames(event, selected);
        }
      } finally {
        await scope.close();
      }
      signal.throwIfAborted();
      if (!isAdmitted(true) || selected === skipped) return;
      if (stopped) {
        if (native._stop_step(stepReceipt)) replied = true;
        else reply(null);
        return;
      }
      reply(names);
    } catch (error) {
      reply(null);
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }

  private profileOperationNames(
    selection: OperationSelection,
    event: NativeEvent,
    sourceCatalog: ToolCatalog,
  ): OperationSelection['names'] {
    const source = this.messageProfile(event.msg);
    if (!source || selection.names === undefined) return selection.names;
    const sourceMcp = this.profileStepMcp.get(
      this.profileKey(source.profile_id, sourceCatalog.generation),
    );
    if (!sourceMcp)
      throw new NativeError('Native step has no captured source MCP bindings');
    const key = (tool: ReturnType<typeof toolIdentity>) =>
      JSON.stringify([tool.namespace, tool.name]);
    return selection.names.filter((identity) => {
      const original = selection.originCatalog?.tools.find(
        (tool) => key(toolIdentity(tool)) === key(identity),
      );
      if (original)
        return sourceCatalog.tools.some(
          (tool) =>
            toolDeclarationIdentity(tool) === toolDeclarationIdentity(original),
        );
      const originalServer = selection.originMcp?.find((server) =>
        mcpToolNames([server]).some((tool) => key(tool) === key(identity)),
      );
      if (originalServer) return sourceMcp.includes(originalServer);
      const handoff = [...this.profileRuntimes.values()].some((profile) =>
        Object.hasOwn(profile.profile.handoffs, identity.name),
      );
      if (handoff) return source.profile_id === selection.originProfileId;
      // Fixed native runtime grants are required to match across the captured graph.
      return true;
    });
  }

  private stepMcpProjection(event: NativeEvent) {
    return z
      .array(
        z.object({
          server: z.string(),
          tool: z.string(),
          namespace: z.string(),
          name: z.string(),
        }),
      )
      .parse(event.msg.mcp_names ?? []);
  }

  private mcpNameIndex(servers: readonly McpTool[]) {
    const byRaw = new Map<string, ReturnType<typeof toolIdentity>>();
    const byProjected = new Map<string, readonly [string, string]>();
    for (const server of servers) {
      const names = mcpToolNames([server]);
      for (let index = 0; index < names.length; index++) {
        const name = names[index]!;
        const raw = [server.name, server.tools[index]!] as const;
        const rawKey = JSON.stringify(raw);
        const projectedKey = JSON.stringify([name.namespace, name.name]);
        // Preserve the first captured declaration when identities overlap.
        if (!byRaw.has(rawKey)) byRaw.set(rawKey, name);
        if (!byProjected.has(projectedKey)) byProjected.set(projectedKey, raw);
      }
    }
    return { byRaw, byProjected };
  }

  private selectedStepNames(
    event: NativeEvent,
    selected: readonly ToolSelector<Context>[] | undefined,
    defaults?: readonly ReturnType<typeof toolIdentity>[],
    sourceCatalog?: ToolCatalog,
  ): readonly ReturnType<typeof toolIdentity>[] {
    const toolNames = z.array(
      z.object({ name: z.string(), namespace: z.string().nullish() }),
    );
    const normalize = (tools: z.infer<typeof toolNames>) =>
      tools.map((tool) => ({
        name: tool.name,
        namespace: tool.namespace || 'functions',
      }));
    const candidates = normalize(toolNames.parse(event.msg.candidates));
    const nativeDefaults =
      event.msg.defaults === undefined
        ? undefined
        : normalize(toolNames.parse(event.msg.defaults));
    const projection = this.stepMcpProjection(event);
    const source = this.messageProfile(event.msg);
    if (source && !sourceCatalog)
      sourceCatalog = this.sourceCatalog(
        event.msg,
        z.string().parse(event.msg.generation),
      );
    const servers = source
      ? (this.profileStepMcp.get(
          this.profileKey(source.profile_id, sourceCatalog!.generation),
        ) ?? [])
      : this.mcpTools;
    const declared = this.mcpNameIndex(servers);
    const nativeByRaw = new Map<string, (typeof projection)[number]>();
    for (const item of projection) {
      const key = JSON.stringify([item.server, item.tool]);
      if (!nativeByRaw.has(key)) nativeByRaw.set(key, item);
    }
    const resolve = (
      name: ReturnType<typeof toolIdentity>,
      selector?: ToolSelector<Context>,
    ) => {
      const raw =
        selector?.kind === 'tool_ref' ? mcpRefIdentity(selector) : undefined;
      const match =
        raw ??
        declared.byProjected.get(JSON.stringify([name.namespace, name.name]));
      if (!match) return name;
      const actual = nativeByRaw.get(JSON.stringify(match));
      if (!actual)
        throw new TypeError('MCP selector is outside the captured native step');
      return { name: actual.name, namespace: actual.namespace };
    };
    const resolvedDefaults = defaults?.map((name) => resolve(name));
    const names =
      selected === undefined
        ? (resolvedDefaults ?? nativeDefaults ?? candidates)
        : this.selectionNames(
            [...selected],
            sourceCatalog,
            servers,
            declared,
          ).map((name, index) => resolve(name, selected[index]));
    const ceiling =
      resolvedDefaults && source
        ? new Set(
            resolvedDefaults.map((tool) =>
              JSON.stringify([tool.namespace, tool.name]),
            ),
          )
        : undefined;
    const allowed = new Set(
      candidates
        .filter(
          (tool) =>
            !ceiling ||
            ceiling.has(JSON.stringify([tool.namespace, tool.name])),
        )
        .map((tool) => JSON.stringify([tool.namespace, tool.name])),
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
          if (this.manualRestoring)
            void this.resumeManualIfReady(run).catch((error) =>
              this.readerFailed(error),
            );
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
    signal = run.controller.signal,
  ): Promise<void> {
    if (run.toolCallIds.has(callId))
      return Promise.reject(new NativeError('Native tool call ID was reused'));
    run.toolCallIds.add(callId);
    return this.invokeCallback(run, callback, signal, tracingContext);
  }

  private invokeCallback(
    run: NativeTurn,
    callback: () => Promise<void>,
    signal: AbortSignal = run.controller.signal,
    tracingContext?: string,
  ): Promise<void> {
    const scope = {
      session: this,
      run,
      active: true,
      parent: toolInvocation.getStore(),
    };
    const tracing = run.tracing ?? run.issuedTracing;
    const invokeNative = () =>
      withNativeCallbackContext(
        tracingContext,
        callback,
        signal,
        workflowForTrace,
      );
    // Register before application code runs; remove before track handles errors.
    const invocation = Promise.resolve()
      .then(() =>
        toolInvocation.run(scope, () =>
          tracingContext !== undefined
            ? tracing
              ? tracing.runWithStorage(invokeNative)
              : invokeNative()
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
    for (let scope = toolInvocation.getStore(); scope; scope = scope.parent)
      if (scope.active && scope.session === this)
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
    output: ToolOutput | null = null,
    deferred = false,
  ): void {
    if (deferred) {
      const state = this.terminalProposals.get(owner);
      if (status !== 'completed' && state?.observations.delete(identity.callId))
        this.observeTool(owner, identity, 'tool_finished', status, null);
      return;
    }
    this.observeTool(owner, identity, 'tool_finished', status, output);
  }

  private observeTool(
    run: NativeTurn | ChildCallbackOwner,
    identity: ToolIdentity,
    type: 'tool_started' | 'tool_finished',
    status: 'completed' | 'failed' | 'cancelled' = 'completed',
    output: ToolOutput | null = null,
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
      this.observations.append({ ...event, type, status, output });
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

  private manualCallKey(
    event: NativeEvent,
    includeApproved = false,
  ): string | undefined {
    const msg = event.msg;
    const marker = msg._sdk_python_tool;
    if (
      msg.type !== 'dynamic_tool_call_request' ||
      !marker ||
      (msg._sdk_managed_approved === true && !includeApproved)
    )
      return;
    const catalog = this.sourceCatalog(msg, marker.generation);
    if (catalog.tools[marker.slot]?.kind !== 'manual') return;
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
    publishOnAdmission = false,
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
    if (pending) {
      pending.publishOnAdmission ||= publishOnAdmission;
      return pending.promise;
    }
    const calls = run instanceof NativeTurn ? run.toolCallIds : run.calls;
    if (calls.has(key)) return;
    // Reserve the full native grant key before deferred callback admission.
    // The inbox and every external waiter join this same operation.
    const reservation = {
      ...Promise.withResolvers<void>(),
      publishOnAdmission,
    };
    this.manualAdmissions.set(key, reservation);
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
      const catalog = this.sourceCatalog(msg, marker.generation);
      if (
        marker.thread !== (root ? this.id : run.childId) ||
        (!root && marker.instance !== run.incarnation) ||
        BigInt(marker.generation) !== catalog.generation
      )
        throw new NativeError('Expired managed tool generation');
      const tool = catalog.tools[marker.slot];
      if (
        !tool ||
        tool.kind !== 'manual' ||
        msg.tool !== tool.name ||
        msg.namespace != null
      )
        throw new NativeError('Invalid managed tool identity');
      const approval = managedApproval(tool);
      if (
        msg._sdk_restored_approval === true &&
        msg._sdk_approval_required === true &&
        !approval
      )
        throw new NativeError(
          'Saved managed approval requires an approval-enabled callback',
        );
      const identity = {
        callId,
        toolName: tool.name,
        namespace: null,
        family: 'function' as const,
      };
      this.observeToolStart(run, identity);
      let release: (() => void) | undefined;
      let admission: FunctionAdmission | undefined;
      try {
        if (approval) {
          admission = this.functionAdmissions.get(run);
          if (!admission && this.options.maxFunctionConcurrency !== undefined) {
            admission = new FunctionAdmission(
              this.options.maxFunctionConcurrency,
            );
            this.functionAdmissions.set(run, admission);
          }
          release = admission
            ? await admission.acquire(run.controller.signal)
            : undefined;
        }
        if (
          !this.current(run) ||
          run.failure !== undefined ||
          !this.manualCurrent(event)
        )
          return;
        if (
          !(await this.realtimeFunctionEnabled(
            run,
            msg,
            tool.name,
            run.controller.signal,
          ))
        ) {
          if (this.current(run) && this.manualCurrent(event)) {
            const accepted = await this.#native._respond_python_tool(
              encodeReceipt({
                request: msg,
                response: {
                  success: false,
                  contentItems: [
                    { type: 'inputText', text: `Tool ${tool.name} not found` },
                  ],
                },
                start_response: false,
              }),
            );
            if (accepted) this.observeToolEnd(run, identity, 'failed');
          }
          return;
        }
        if (!this.current(run) || !this.manualCurrent(event)) return;
        const args =
          typeof msg.arguments === 'string'
            ? decode(losslessJsonValueSchema, msg.arguments)
            : losslessJsonValueSchema.parse(msg.arguments);
        const withApprovalContext = async <T>(
          callback: (context: ToolCallContext, check: () => void) => Promise<T>,
        ): Promise<T> => {
          const submission = root
            ? this.#turnFor(run)
            : await this.childSubmission(run);
          if (!submission)
            throw new NativeError('Managed approval submission is unavailable');
          const scope = this.decisionScope(event.msg, run.controller.signal);
          const context = {
            decide: scope.decide,
            [decisionBinding]: scope[decisionBinding],
            [toolErrorFormatterBinding]: this.options.toolErrorFormatter,
            realtimeUsage: this.realtimeUsage,
            ...(this.realtimeOwner?._realtimeToolContext(
              msg._sdk_realtime_tool_call,
              this.options.context,
            ) ?? { context: this.options.context }),
            submission,
            call: managedCallInfo(
              {
                sessionId: this.id,
                childId: root ? null : run.childId,
                childIncarnation: root ? null : run.incarnation,
              },
              msg,
            ),
            threadId: root ? this.id : run.childId,
            turnId,
            callId,
            signal: run.controller.signal,
          };
          const check = () => {
            context.signal.throwIfAborted();
            admission?.check();
            if (!this.current(run) || !this.manualCurrent(event))
              throw new NativeError(
                'Managed approval expired during policy evaluation',
              );
          };
          try {
            return await callback(context, check);
          } finally {
            await scope.close();
          }
        };
        const initialInput =
          approval?.prepareOriginalInput &&
          msg._sdk_restored_approval !== true &&
          msg._sdk_effective_arguments === undefined
            ? await withApprovalContext((context, check) =>
                approval.prepareOriginalInput!(args, context, check),
              )
            : undefined;
        if (initialInput && 'failure' in initialInput) {
          run.controller.signal.throwIfAborted();
          admission?.check();
          if (!this.current(run) || !this.manualCurrent(event)) return;
          const accepted = await this.#native._respond_python_tool(
            encodeReceipt({
              request: msg,
              response: {
                success: false,
                contentItems: [
                  { type: 'inputText', text: initialInput.failure },
                ],
              },
            }),
          );
          if (accepted) this.observeToolEnd(run, identity, 'failed');
          return;
        }
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
          managedApproval(tool) !== undefined,
          initialInput && 'value' in initialInput ? initialInput : undefined,
        );
        this.manualCalls.set(key, {
          run,
          event,
          tool,
          grant,
          tracing: captureTraceValidation(),
          identity,
          ready: false,
        });
        calls.add(key);
        if (approval) {
          if (
            msg._sdk_restored_approval === true &&
            msg._sdk_approval_required !== true
          )
            throw new NativeError(
              'Saved manual call cannot acquire managed callback authority',
            );
          if (!this.#native._require_tool_approval(encodeReceipt(msg))) return;
          const source = JSON.stringify([
            msg.profile_id ?? null,
            msg.profile_epoch ?? null,
            String(marker.generation),
          ]);
          const cached = this.approvalDecisions
            .get(toolDeclarationIdentity(tool))
            ?.get(source);
          const decision = await withApprovalContext((context, check) =>
            approval.prepare(
              args,
              context,
              check,
              msg._sdk_restored_approval === true || cached !== undefined,
              msg._sdk_effective_arguments === undefined
                ? undefined
                : losslessJsonValueSchema.parse(msg._sdk_effective_arguments),
            ),
          );
          run.controller.signal.throwIfAborted();
          admission?.check();
          if (!this.current(run) || !this.manualCurrent(event))
            throw new NativeError(
              'Managed approval expired during policy evaluation',
            );
          const effectiveInput =
            decision.effective === undefined ? args : decision.effective;
          if (
            !this.#native._require_tool_approval(
              encodeReceipt(msg),
              encodeReceipt(effectiveInput),
            )
          )
            return;
          if (decision.denial === undefined)
            grant.setValidatedEffectiveArguments(decision.validated);
          const action = grant.request();
          if (!isFunctionApprovalRequest(action))
            throw new NativeError('Managed approval capability was not issued');
          if (
            decision.denial !== undefined ||
            (msg._sdk_restored_approval !== true && cached)
          ) {
            const remembered = cached ?? {
              approve: false,
              always: false,
              reason: decision.denial!,
            };
            await this.submitManualResult(
              remembered.approve && decision.denial === undefined
                ? action.approve()
                : action.reject(
                    decision.denial ??
                      (cached?.useDefaultReason
                        ? undefined
                        : remembered.reason),
                  ),
              key,
            );
          } else if (!decision.required) {
            await this.submitManualResult(action.approve(), key);
          }
        }
      } catch (error) {
        if (!this.current(run) || !this.manualCurrent(event)) {
          this.observeToolEnd(run, identity, 'cancelled');
          return;
        }
        this.observeToolEnd(run, identity, 'failed');
        run.failure ??= error;
        admission?.seal(error);
        throw error;
      } finally {
        release?.();
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
    const retire = () => {
      if (this.manualAdmissions.get(key) === reservation)
        this.manualAdmissions.delete(key);
    };
    void admission
      .then(
        () => {
          // Retire before reading the flag so a later snapshot can publish directly.
          retire();
          reservation.resolve();
          if (reservation.publishOnAdmission)
            this.publishManualRequest(run, event);
        },
        (error) => {
          retire();
          reservation.reject(error);
        },
      )
      .finally(() => this.observations.notify())
      .catch((error) => this.readerFailed(error));
    return reservation.promise;
  }

  private publishManualRequest(
    run: NativeTurn | ChildCallbackOwner,
    event: NativeEvent,
  ): void {
    if (run.failure !== undefined) return;
    const key = this.manualCallKey(event);
    if (key === undefined) return;
    const call = this.manualCalls.get(key);
    if (!call || call.run !== run || call.ready) return;
    call.ready = true;
    this.observations.notify();
    const action = call.grant.request();
    if (!action) return;
    const handler = this.options.onInteraction;
    if (
      !handler &&
      isFunctionApprovalRequest(action) &&
      action.call?.route === 'direct' &&
      action.call.callId
    ) {
      this.observations.append({
        type: 'function_approval_requested',
        submissionId: action.submissionId,
        turnId: action.turnId,
        approvalId: action.approvalId,
        callId: action.call.callId,
        name: action.name,
      });
    }
    if (handler) {
      const root =
        run instanceof NativeTurn
          ? run
          : this.lifecycle.kind === 'turn'
            ? this.lifecycle.run
            : undefined;
      // One-shot ownership ends with the root. An explicit Session can still
      // receive child manual requests after its root completes.
      if (this.oneShot && !root) return;
      const answer = async () => {
        if (
          run.failure !== undefined ||
          (this.oneShot && root && !this.current(root)) ||
          !this.current(run) ||
          !call.grant.request()
        )
          return;
        const reply = await handler(action, run.controller.signal);
        if ((this.oneShot && root && !this.current(root)) || !this.current(run))
          return;
        if (!call.grant.ownsReply(reply))
          throw new TypeError(
            'onInteraction must return a reply to the manual request it received',
          );
        if (!call.grant.request()) return;
        if (!(await this.submitManualResult(reply, key)))
          throw new TypeError(
            'onInteraction must return a reply to the manual request it received',
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
                if (
                  root &&
                  this.oneShot &&
                  this.current(root) &&
                  root.failure === undefined
                ) {
                  root.failure = error;
                  // Child cleanup is joined by close, never from the callback
                  // that close itself must drain.
                  toolInvocation.exit(() => {
                    void this.#cancel(root).catch((cause) =>
                      this.readerFailed(cause),
                    );
                  });
                } else if (this.oneShot && root && error !== root.failure) {
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

  private async decideManagedApproval(
    key: string,
    call: {
      run: NativeTurn | ChildCallbackOwner;
      event: NativeEvent;
      tool: ManualTool;
      identity: ToolIdentity;
    },
    decision: ApprovalDecision,
  ): Promise<boolean> {
    const run = call.run;
    const operation = (async () => {
      let accepted: boolean;
      if (decision.approve)
        accepted = await this.#native._approve_manual_tool(
          encodeReceipt(call.event.msg),
        );
      else {
        if (!this.current(run) || !this.manualCurrent(call.event)) return false;
        let reason = decision.reason;
        if (
          decision.useDefaultReason &&
          run instanceof NativeTurn &&
          submissions.get(run)?.realtimeTools &&
          this.realtimeOwner
        ) {
          const source = this.sourceApplicationAgent(call.event.msg);
          reason = await this.realtimeOwner._formatApprovalRejection(
            source,
            this.options.context,
            call.tool.name,
            call.event.msg.callId as string,
            reason,
            run.controller.signal,
          );
        }
        const response: ToolResponse = {
          success: false,
          contentItems: [{ type: 'inputText', text: reason }],
        };
        if (this.manualRestoring) {
          await this.#native._respond_manual_continuation(
            encodeReceipt({ request: call.event.msg, response }),
          );
          accepted = true;
        } else
          accepted = await this.#native._respond_python_tool(
            encodeReceipt({ request: call.event.msg, response }),
          );
      }
      if (!accepted)
        throw new TypeError('Managed approval is expired or already decided');
      // Approval enqueues a callback; its native result still owns this call.
      // Keep the consumed grant until that callback commits its real receipt.
      if (!decision.approve) this.manualCalls.delete(key);
      if (decision.always) {
        const declaration = toolDeclarationIdentity(call.tool);
        let policy = this.approvalDecisions.get(declaration);
        if (!policy)
          this.approvalDecisions.set(declaration, (policy = new Map()));
        policy.set(
          JSON.stringify([
            call.event.msg.profile_id ?? null,
            call.event.msg.profile_epoch ?? null,
            String(call.event.msg._sdk_python_tool!.generation),
          ]),
          decision,
        );
      }
      this.notifyManualProgress();
      this.observations.notify();
      if (!decision.approve) this.observeToolEnd(run, call.identity, 'failed');
      return true;
    })();
    const settled = operation.then(() => {});
    if (run instanceof NativeTurn) this.track(run, settled, run.manualReplies);
    else this.trackOwnedCallback(run, () => settled);
    return operation;
  }

  private async submitManualResult(
    reply: unknown,
    expectedKey?: string,
    beforeConsume?: (output: ToolResponse) => void,
  ): Promise<boolean> {
    for (const [key, call] of this.manualCalls) {
      if (expectedKey !== undefined && key !== expectedKey) continue;
      if (!call.grant.matchesReply(reply)) continue;
      const decision = call.grant.takeApprovalReply(reply);
      if (decision) return this.decideManagedApproval(key, call, decision);
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
      if (run instanceof NativeTurn)
        await this.resumeManualIfReady(run, expectedKey === undefined);
      return accepted;
    }
    return false;
  }

  private async resumeManualIfReady(
    run: NativeTurn,
    closeOnError = false,
  ): Promise<void> {
    if (
      this.manualRestoring &&
      !this.manualCalls.size &&
      !run.manualReplies.size &&
      !run.toolInvocations.size &&
      !run.callbacks.size &&
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
            ? encodeOperationSelection({
                generation: this.catalog.generation.toString(),
                ...(run.selection.operationDeclarationSource
                  ? {
                      operation_declaration_source:
                        run.selection.operationDeclarationSource,
                    }
                  : {}),
                names: run.selection.names ?? null,
                before_step:
                  run.selection.maxModelSteps !== undefined ||
                  this.options.agentGraph !== undefined,
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
          return;
        }
        this.retire(error);
        // An owned handler must leave before Agent.run can join and close it.
        if (closeOnError) await this.close();
        throw error;
      }
    }
  }

  private maybeSealManual(run: NativeTurn): void {
    if (
      !this.oneShot ||
      this.options.onInteraction ||
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
    const action = [...this.manualCalls.values()]
      .filter((call) => call.run === run)
      .map((call) => call.grant.request())
      .find((request) => request !== undefined);
    if (!action) return;
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

  /** @internal Resolve only an original current grant's captured declaration. */
  _manualTool(request: ManualToolRequest): ManualTool | undefined {
    return [...this.manualCalls.values()].find(
      (call) => call.grant.request() === request && this.current(call.run),
    )?.tool;
  }

  private async refreshManualProfile(run: NativeTurn): Promise<void> {
    if (!this.options.agentGraph || !this.current(run)) return;
    await this.refreshProfileBindings(true, run);
    if (this.current(run) && !submissions.get(run)!.outputOverride)
      submissions.get(run)!.output = this.defaultOutput;
  }

  private async captureManualTurn(
    run: NativeTurn,
    beforeSeal?: (entries: readonly ManualCheckpointEntry[]) => void,
    signal?: AbortSignal,
  ): Promise<SessionState> {
    await this.refreshManualProfile(run);
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
              ? decode(losslessJsonValueSchema, call.event.msg.arguments)
              : losslessJsonValueSchema.parse(call.event.msg.arguments),
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
              manual_continuation: losslessJsonObjectSchema,
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
        const measuredUsage = this.runUsage(run);
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
                run.tokenUsage === null
                  ? null
                  : runUsageToWire(
                      measuredUsage,
                      measuredUsage.requests,
                      measuredUsage.missingUsageRequests,
                    ),
            },
          },
          this.checkpointSelections(run),
          networkPolicyDigest(this.environment?.network),
          this.environment?.readOnly ?? false,
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
        z.array(losslessJsonObjectSchema),
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
    const origin = this.options.agentGraph?.operationSource;
    if (this.options.agentGraph && operation?.length && !origin)
      throw new NativeError(
        'Suspended operation is missing its proved declaration source',
      );
    const originalProfile = origin
      ? this.profileRuntimes.get(origin.profile_id)!
      : undefined;
    const remaining = state.manual_context.remaining_model_steps;
    if (
      this.options.agentGraph ||
      operation !== undefined ||
      remaining !== undefined
    )
      run.selection = {
        originCatalog: originalProfile?.catalog ?? this.catalog,
        originMcp: originalProfile?.mcp ?? this.mcpBindings,
        originProfileId: origin?.profile_id,
        operationDeclarationSource: origin,
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
      run.addUsage(
        {
          input_tokens: usage.inputTokens,
          cached_input_tokens: usage.cachedInputTokens,
          cache_write_input_tokens: usage.cacheWriteInputTokens,
          output_tokens: usage.outputTokens,
          reasoning_output_tokens: usage.reasoningOutputTokens,
          total_tokens: usage.totalTokens,
        },
        parseTokenCount(usage.requests ?? 0),
        parseTokenCount(usage.missingUsageRequests ?? 0),
      );
    this.lifecycle = { kind: 'turn', run };
    this.lastRun = run;
    this.manualCheckpointRun = run;
    this.manualRestoring = true;
    this.restoredRoot = {
      turn: this.#turnFor(run),
      output: restoredOutput.output,
    };

    // Keep argument data intact while the event decoder validates its envelope.
    const events = requests.map((request) =>
      parseEvent(JSON.stringify(request)),
    );
    for (const event of events) await this.handleRequest(run, event);
    // Register all saved requests before a handler can resolve the last grant
    // and restart the original turn.
    for (const event of events) {
      this.publishManualRequest(run, event);
    }
  }
  /** @internal Recheck the declaration that owns the retained native source. */
  async _realtimeAgentToolEnabled(
    receipt: unknown,
    reference: ToolRef,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (
      receipt == null &&
      !this.options.agentGraph &&
      !this.options.applicationAgent &&
      !this.options.realtimeDeclaration
    )
      return true;
    const source = this._realtimeConfigurationSource(receipt);
    const predicate = source.declaration.realtime?.toolEnabled;
    if (!predicate) return true;
    signal.throwIfAborted();
    const enabled = await this._runVoiceCallback(() =>
      predicate(
        Object.freeze({ agent: source.agent, context: source.context, signal }),
        reference,
      ),
    );
    signal.throwIfAborted();
    if (typeof enabled !== 'boolean')
      throw new TypeError('Realtime toolEnabled must return a boolean');
    return enabled;
  }

  private async realtimeFunctionEnabled(
    owner: NativeTurn | ChildCallbackOwner,
    msg: NativeEvent['msg'],
    name: string,
    signal: AbortSignal,
    recheckHandoff = false,
  ): Promise<boolean> {
    if (
      !(owner instanceof NativeTurn) ||
      !submissions.get(owner)?.realtimeTools ||
      !this.realtimeOwner
    )
      return true;
    const source = this.sourceApplicationAgent(msg);
    const checkAgent = () =>
      this._realtimeAgentToolEnabled(
        this.messageProfile(msg) ?? null,
        toolRef(
          typeof msg._sdk_realtime_tool_name === 'string'
            ? msg._sdk_realtime_tool_name
            : name,
        ),
        signal,
      );
    let enabled =
      (await checkAgent()) &&
      (await this.realtimeOwner._toolEnabled(
        source,
        this.options.context,
        name,
        signal,
        'function',
        checkAgent,
      ));
    if (enabled && recheckHandoff && source) {
      const handoff = this._realtimeConfigurationSource(
        this.messageProfile(msg) ?? null,
      ).handoffs?.[name];
      if (handoff) {
        const predicate = handoff.isEnabled;
        let asynchronous = false;
        enabled =
          typeof predicate === 'function'
            ? await this._runVoiceCallback(() => {
                const result = predicate(
                  Object.freeze({
                    agent: source,
                    context: this.options.context,
                  }),
                );
                asynchronous = typeof result !== 'boolean';
                return result;
              })
            : predicate;
        signal.throwIfAborted();
        if (typeof enabled !== 'boolean')
          throw new TypeError(
            'Realtime handoff isEnabled must return a boolean',
          );
        if (enabled && asynchronous) {
          // The awaited handoff grant applies to this dispatch. Refresh the
          // source and connection grants after that application wait.
          return this.realtimeFunctionEnabled(owner, msg, name, signal);
        }
      }
    }
    if (!enabled) this.realtimeOwner._markToolUnavailable(msg.callId as string);
    return enabled;
  }

  private handleRequest(
    owner: NativeTurn | ChildCallbackOwner,
    event: NativeEvent,
  ): Promise<void> {
    return this.ownCallbackDelivery(event, owner, (signal, delivery) =>
      this.executeCallbackRequest(owner, event, signal, delivery),
    );
  }
  private async executeCallbackRequest(
    owner: NativeTurn | ChildCallbackOwner,
    event: NativeEvent,
    signal: AbortSignal,
    delivery?: NativeCallbackDelivery,
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
    const catalog = this.sourceCatalog(msg, marker.generation);
    if (
      marker.thread !== (root ? this.id : owner.childId) ||
      (!root && marker.instance !== owner.incarnation) ||
      BigInt(marker.generation) !== catalog.generation
    )
      throw new NativeError('Expired managed tool generation');
    const captured = catalog.tools[marker.slot];
    const tool = captured && (managedApproval(captured)?.function ?? captured);
    if (
      !tool ||
      msg.tool !== tool.name ||
      (msg.namespace ?? null) !== toolNamespace(tool)
    )
      throw new NativeError('Invalid managed tool identity');
    if (tool.kind === 'manual') return;
    if (typeof msg.callId !== 'string')
      throw new NativeError('Native tool invocation has no call identity');
    let admission = this.functionAdmissions.get(owner);
    if (!admission && this.options.maxFunctionConcurrency !== undefined) {
      admission = new FunctionAdmission(this.options.maxFunctionConcurrency);
      this.functionAdmissions.set(owner, admission);
    }
    // Private sentinel stays within this invocation; it is not a public error.
    const admissionEnded = Symbol();
    const native = delivery?.native ?? this.#native;
    const check = (): boolean => {
      signal.throwIfAborted();
      admission?.check();
      if (owner.failure !== undefined) throw owner.failure;
      try {
        return native._check_python_tool(encodeReceipt(msg));
      } catch (error) {
        this.callbackAuthorityFailed(delivery, error);
      }
    };
    const execute = async () => {
      if (!this.current(owner) || signal.aborted) return;
      if (!check()) return;
      const submission = root
        ? this.#turnFor(owner)
        : await this.childSubmission(owner);
      if (!submission) return;
      if (!root) {
        if (!this.current(owner)) return;
        if (!check()) return;
      }
      const scope = this.decisionScope(event.msg, signal);
      const context = {
        [usageReportBinding]: this.toolUsageReporter(owner, check),
        [toolErrorFormatterBinding]: this.options.toolErrorFormatter,
        decide: scope.decide,
        [decisionBinding]: scope[decisionBinding],
        traceContext: nativeTraceContext(
          msg._sdk_trace_context as TraceContextHeaders | null | undefined,
        ),
        realtimeUsage: this.realtimeUsage,
        ...(this.realtimeOwner?._realtimeToolContext(
          msg._sdk_realtime_tool_call,
          this.options.context,
        ) ?? { context: this.options.context }),
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
        signal,
      };
      registerToolSessionOwner(context, this.toolSessionOwner);
      const identity: ToolIdentity = {
        callId: context.callId,
        toolName: tool.name,
        namespace: toolNamespace(tool),
        family: 'function',
      };
      // Native manual admission already records the start before its decision.
      if (msg._sdk_managed_approved !== true)
        this.observeToolStart(owner, identity);
      let status: ToolStatus | undefined;
      let observedOutput: ToolOutput | null = null;
      let deferredObservation = false;
      try {
        if (
          !(await this.realtimeFunctionEnabled(owner, msg, tool.name, signal))
        ) {
          if (
            check() &&
            (await native._respond_python_tool(
              encodeReceipt({
                request: msg,
                response: {
                  success: false,
                  contentItems: [
                    { type: 'inputText', text: `Tool ${tool.name} not found` },
                  ],
                },
                start_response: false,
              }),
            ))
          )
            status = 'failed';
          return;
        }
        if (!check()) return;
        const args =
          typeof msg.arguments === 'string'
            ? decode(losslessJsonValueSchema, msg.arguments)
            : losslessJsonValueSchema.parse(msg.arguments);
        const approved =
          msg._sdk_managed_approved === true
            ? this.manualCalls
                .get(this.manualCallKey(event, true) ?? '')
                ?.grant.executionArguments()
            : undefined;
        if (msg._sdk_managed_approved === true && !approved)
          throw new NativeError(
            'Managed approval arguments are no longer available',
          );
        const response = await invokeFunctionTool(
          tool,
          args,
          context,
          (error) => {
            owner.failure ??= error;
            admission?.seal(error);
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
            if (!check()) throw admissionEnded;
          },
          msg._sdk_effective_arguments === undefined
            ? undefined
            : losslessJsonValueSchema.parse(msg._sdk_effective_arguments),
          approved,
          () =>
            this.realtimeFunctionEnabled(owner, msg, tool.name, signal, true),
          () =>
            this.realtimeOwner?._toolBodyStarted(
              msg._sdk_realtime_tool_call,
              msg._sdk_realtime_tool_name as string,
              toolDeclarationIdentity(tool) as FunctionTool<any>,
            ),
        );
        if (!this.current(owner) || signal.aborted) {
          status = 'cancelled';
          return;
        }
        if (!check()) {
          status = 'cancelled';
          return;
        }
        const responseOutput = structuredClone(response);
        if (tool.finishTurn && responseOutput.success) {
          this.registerTerminalObservation(owner, identity, 'completed');
          deferredObservation = true;
        }
        let accepted: boolean;
        try {
          accepted = await native._respond_python_tool(
            encodeReceipt({
              request: msg,
              response: responseOutput,
              ...(isBackgroundToolResponse(response)
                ? { start_response: false }
                : {}),
            }),
          );
          if (accepted && msg._sdk_managed_approved === true) {
            const key = this.manualCallKey(event, true);
            if (key !== undefined) this.manualCalls.delete(key);
          }
        } catch (error) {
          this.callbackAuthorityFailed(delivery, error);
        }
        if (accepted && !deferredObservation)
          observedOutput = new ToolOutput(
            responseOutput.contentItems,
            responseOutput.success,
          );
        status = accepted
          ? responseOutput.success
            ? 'completed'
            : 'failed'
          : 'cancelled';
      } catch (error) {
        if (error === admissionEnded) {
          status = 'cancelled';
          return;
        }
        if (
          admission &&
          !(
            delivery?.retired &&
            signal.aborted &&
            Object.is(error, signal.reason)
          )
        ) {
          owner.failure ??= error;
          admission.seal(error);
        }
        throw error;
      } finally {
        await scope.close();
        const finalStatus = signal.aborted ? 'cancelled' : status;
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
        this.observeToolEnd(
          owner,
          identity,
          finalStatus ?? 'failed',
          finalStatus === 'cancelled' ? null : observedOutput,
          deferredObservation,
        );
      }
    };
    const release = admission ? await admission.acquire(signal) : undefined;
    try {
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
          signal,
        );
      else
        await withNativeCallbackContext(
          typeof msg.tracing_context === 'string'
            ? msg.tracing_context
            : undefined,
          execute,
          signal,
          workflowForTrace,
          owner.observationProducer.callbackTraceStorages,
        );
    } catch (error) {
      if (
        admission &&
        !(
          delivery?.retired &&
          signal.aborted &&
          Object.is(error, signal.reason)
        )
      ) {
        owner.failure ??= error;
        admission.seal(error);
      }
      throw error;
    } finally {
      release?.();
    }
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
    if (options.agent !== undefined) {
      if (
        options.model !== undefined ||
        options.modelSettings !== undefined ||
        options.instructions !== undefined ||
        options.tools !== undefined
      )
        throw new TypeError('Update the Agent separately from other settings');
      if (!this.options.agentGraph) {
        if (options.agent === this.options.applicationAgent) return;
        throw new TypeError(
          'Target Agent was not admitted in this Session handoff graph',
        );
      }
      const target = [...this.profileRuntimes].find(
        ([, profile]) => profile.profile.agent === options.agent,
      )?.[0];
      if (!target)
        throw new TypeError(
          'Target Agent was not admitted in this Session handoff graph',
        );
      return this.mutate(async () => {
        await this.refreshProfileBindings();
        const receipt = checkProfileReceipt(
          parseProfileReceipt(
            await this.#native._activate_agent_profile(
              target,
              encodeProfileReceipt(this.profileCurrent!),
            ),
          ),
          this.options.agentGraph!,
        );
        if (receipt.profile_id !== target) {
          const error = new NativeError(
            'Native Agent activation acknowledgement did not match',
          );
          this.retire(error);
          throw error;
        }
        await this.commitProfile(receipt, true);
        await this.realtimeOwner?._syncProfile(true);
      });
    }
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
      if (
        this.options.chatGPTPlan &&
        next.tools.some((tool) => !isDirectFunctionTool(tool))
      )
        throw new TypeError(
          'Sign in with ChatGPT requires direct local function tools',
        );
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
        this.openingMcpTools.some((server) => server.deferLoading);
      if (!discoveryGranted && next.tools.some((tool) => tool.deferLoading))
        throw new TypeError(
          'Schema discovery must have been granted when the Session opened',
        );
      for (const server of next.mcp) {
        const opening = this.openingMcpTools.find(
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
      const replacements = captureTools(next.tools);
      if (
        this.options.customStore &&
        replacements.tools.some((tool) => tool.kind === 'manual')
      )
        throw new TypeError(
          'Custom canonical storage does not support manual tools',
        );
      const byName = new Map(
        replacements.tools.map((tool) => [
          JSON.stringify(toolIdentity(tool)),
          tool,
        ]),
      );
      let candidate = captureTools(
        this.catalog.tools.map(
          (tool) => byName.get(JSON.stringify(toolIdentity(tool))) ?? tool,
        ),
        (this.options.agentGraph
          ? this.profileHighWater
          : this.catalog.generation) + 1n,
      );
      if (!this.openingMcpTools.length) {
        await this.publishCatalog(async () => candidate, replacements.tools);
        await this.realtimeOwner?._syncProfile(true);
        return;
      }
      for (const server of next.mcp) {
        const opening = this.openingMcpTools.find(
          (original) => original.name === server.name,
        );
        if (
          !opening ||
          server.tools.some((raw) => !opening.tools.includes(raw))
        )
          throw new TypeError(
            'Updated MCP raw identities and activation must match Session opening',
          );
        if (
          !this.hasOperationMcp &&
          !(server instanceof HttpMCP && server.activation === 'operation')
        )
          continue;
        if (
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
          (server.tools.length > 0 ||
            (server instanceof StdioMCP && server.lifetime === 'turn') ||
            this.mcpTools.some((active) => active.name === server.name)) &&
          (!(server instanceof HttpMCP) || server.activation !== 'operation'),
      );
      const guarded = hasMcpPrePolicy(this.mcpTools) || hasMcpPrePolicy(active);
      const slots = this.catalogSlots(candidate, replacements.tools);
      const generation =
        (this.options.agentGraph ? this.profileHighWater : this.mcpGeneration) +
        1n;
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
                undefined,
                undefined,
                this.terminalSlots(candidate),
                encode(slots),
                true,
              ),
            );
            // The combined ingress owns function and MCP publication. Any
            // uncertain failure is retired below, rather than retried as old state.
            published = true;
            candidate = this.publishedCatalog(
              candidate,
              losslessJsonObjectSchema.parse(jsonObject.parse(receipt).result)
                .tools_generation,
            );
          } else {
            const accepted = await this.#native._replace_tools(
              candidate.generation.toString(),
              candidate.specsJson,
              encode(slots),
              this.terminalSlots(candidate),
              true,
            );
            published = true;
            candidate = this.publishedCatalog(candidate, accepted);
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
          this.mcpAppToolsUpdated = true;
          this.acceptCatalog(candidate, replacements.tools, slots);
          this.mcpTools = active;
          this.defaultMcpTools = Object.freeze([...next.mcp]);
          this.mcpBindings = Object.freeze(bindings);
          this.mcpGeneration = generation;
          this.rememberProfileBindings();
          await this.configureManualTools();
          await this.acknowledgeProfilePublication();
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
          await this.acknowledgeProfilePublication();
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
    if (categories) await this.realtimeOwner?._syncProfile(true);
  }

  private catalogSlots(
    catalog: ToolCatalog,
    defaults: readonly SessionTool[],
  ): number[] {
    return defaults.map((tool) => {
      const identity = toolIdentity(tool);
      return catalog.tools.findIndex((binding) => {
        const current = toolIdentity(binding);
        return (
          current.name === identity.name &&
          current.namespace === identity.namespace
        );
      });
    });
  }
  private acceptCatalog(
    candidate: ToolCatalog,
    defaults: readonly SessionTool[],
    slots: readonly number[],
  ): void {
    this.catalog = candidate;
    this.rememberProfileBindings();
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
  }
  private publishedCatalog(
    candidate: ToolCatalog,
    accepted: unknown,
  ): ToolCatalog {
    const generation = BigInt(profileInteger(accepted));
    if (generation <= this.catalog.generation)
      throw new NativeError('Native tool publication was not confirmed');
    return { ...candidate, generation };
  }

  private async publishCatalog(
    create: () => Promise<ToolCatalog>,
    defaults: readonly SessionTool[],
  ): Promise<void> {
    let confirmed = false;
    await this.mutate(async () => {
      let candidate = await create();
      const slots = this.catalogSlots(candidate, defaults);
      const accepted = await this.#native._replace_tools(
        candidate.generation.toString(),
        candidate.specsJson,
        encode(slots),
        this.terminalSlots(candidate),
        true,
      );
      try {
        candidate = this.publishedCatalog(candidate, accepted);
      } catch {
        return;
      }
      confirmed = true;
      this.acceptCatalog(candidate, defaults, slots);
      await this.configureManualTools();
      await this.acknowledgeProfilePublication();
    });
    if (!confirmed) {
      await this.close();
      throw new NativeError(
        'Unconfirmed native tool publication; session retired',
      );
    }
  }
  private terminalSlots(catalog: ToolCatalog = this.catalog): string {
    return encode({
      generation: catalog.generation.toString(),
      slots: catalog.tools.flatMap((tool, slot) =>
        (tool.kind !== 'manual' && tool.finishTurn) ||
        managedApproval(tool)?.function.finishTurn
          ? [slot]
          : [],
      ),
    });
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
      this.terminalSlots(),
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
        if (this.options.agentGraph)
          this.threadOptions.instructions = instructions;
        await this.acknowledgeProfilePublication();
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
  /**
   * Read one resource page from a currently selected ordinary MCP server while idle.
   * Pass nextCursor explicitly for another page. Servers without the resources
   * capability return an empty list. Results never enter model context.
   * An inactive selected server connects lazily without granting tools.
   */
  async listMcpResources(
    server: string,
    cursor?: string,
  ): Promise<MCPListResourcesResult> {
    if (cursor !== undefined && typeof cursor !== 'string')
      throw new TypeError('MCP cursor must be a string');
    return this.mcpRequest(
      'list_mcp_resources',
      server,
      cursor === undefined ? {} : { cursor },
    ) as Promise<MCPListResourcesResult>;
  }

  /**
   * Read one template page while idle, preserving the cursor and metadata.
   * Servers without the resources capability return an empty list.
   */
  async listMcpResourceTemplates(
    server: string,
    cursor?: string,
  ): Promise<MCPListResourceTemplatesResult> {
    if (cursor !== undefined && typeof cursor !== 'string')
      throw new TypeError('MCP cursor must be a string');
    return this.mcpRequest(
      'list_mcp_resource_templates',
      server,
      cursor === undefined ? {} : { cursor },
    ) as Promise<MCPListResourceTemplatesResult>;
  }

  /** @internal Bind one live canonical call; native MCP ownership stays in this Session. */
  async _openMcpApp(
    turn: Turn<any, any>,
    callId: string,
  ): Promise<MCPAppBinding> {
    this.checkCallbackOperation('open MCPApp');
    if (typeof callId !== 'string' || !callId)
      throw new TypeError('MCPApp requires a nonempty callId');
    return this.mutate(async () => {
      const run = this.lastRun;
      const native = this.#native;
      const generation = this.mcpGeneration;
      const check = () => {
        if (
          !this.isOpen ||
          this.#native !== native ||
          this.lastRun !== run ||
          this.mcpGeneration !== generation ||
          this.mcpAppToolsUpdated ||
          this.options.nativeAgents !== undefined ||
          (this.options.agentGraph?.profiles.size ?? 0) > 1 ||
          !run ||
          this.#turnFor(run) !== turn ||
          turn.childId !== null ||
          run.failure !== undefined
        )
          throw new TypeError(
            'MCPApp requires the latest settled root Turn and fixed opening tools',
          );
      };
      check();
      await turn.wait();
      check();
      const history = projectHistory(await this.#readHistory(), this.id);
      check();
      if (
        !history.turns.some(
          (entry) => entry.id === turn.turnId && entry.status === 'completed',
        )
      )
        throw new TypeError(
          'MCPApp requires a successfully completed root Turn',
        );
      const calls = history.items.filter(
        (item) =>
          item.type === 'mcp_call' &&
          item.turnId === turn.turnId &&
          item.callId === callId &&
          item.threadId === this.id,
      );
      if (calls.length !== 1 || calls[0].type !== 'mcp_call')
        throw new TypeError('MCPApp requires one exact canonical MCP call');
      const call = calls[0];
      const result = losslessJsonObjectSchema.parse(call.output);
      if (
        call.status !== 'completed' ||
        call.error != null ||
        result.isError === true
      )
        throw new TypeError('MCPApp requires a successful completed MCP call');
      const selected = this.openingMcpTools.find(
        (server) => server.name === call.serverLabel,
      );
      if (
        !selected ||
        !this.defaultMcpTools.includes(selected) ||
        !this.mcpTools.includes(selected) ||
        isHostedRegistration(selected) ||
        selected.approvalMode !== 'preapproved' ||
        selected.before ||
        selected.approval ||
        selected.transformResult ||
        (selected as { requestMetadata?: unknown }).requestMetadata ||
        (selected instanceof StdioMCP &&
          (selected.lifetime !== 'session' || selected.location !== 'host')) ||
        (selected instanceof HttpMCP && selected.activation !== 'session') ||
        !selected.tools.includes(call.name)
      )
        throw new TypeError(
          'MCPApp requires a fixed preapproved local MCP declaration without callbacks',
        );
      const mimeType = 'text/html;profile=mcp-app';
      // Read the current negotiated declaration from this native connection, not result data.
      const metadata = JSON.parse(
        await native.call(
          'mcp_app_tool_metadata',
          encode({
            server: selected.name,
            params: { name: call.name, arguments: {} },
          }),
        ),
      );
      check();
      const meta =
        metadata === null ? {} : losslessJsonObjectSchema.parse(metadata);
      const ui = meta.ui;
      if (
        ui !== undefined &&
        (ui === null || typeof ui !== 'object' || Array.isArray(ui))
      )
        throw new TypeError('MCPApp tool UI metadata must be an object');
      const declared = ui === undefined ? undefined : ui.resourceUri;
      const legacy = meta['ui/resourceUri'];
      const declaredUri = declared ?? legacy;
      if (
        (declared !== undefined &&
          legacy !== undefined &&
          declared !== legacy) ||
        (declared !== undefined && typeof declared !== 'string') ||
        (legacy !== undefined && typeof legacy !== 'string')
      )
        throw new TypeError('MCPApp tool resource URI metadata is invalid');
      if (declaredUri !== undefined) {
        let valid = false;
        try {
          const parsed = new URL(declaredUri as string);
          valid =
            parsed.protocol === 'ui:' &&
            !!parsed.hostname &&
            !parsed.username &&
            !parsed.password &&
            (declaredUri as string).startsWith('ui://');
        } catch {
          /* Reject malformed declared authority instead of falling back. */
        }
        if (!valid)
          throw new TypeError(
            'MCPApp tool resource URI must be a valid ui:// URI',
          );
      }
      const content = Array.isArray(result.content) ? result.content : [];
      const candidates = content.flatMap((part) => {
        if (!part || typeof part !== 'object' || Array.isArray(part)) return [];
        const resource =
          part.type === 'resource'
            ? part.resource
            : part.type === 'resource_link'
              ? part
              : undefined;
        if (
          !resource ||
          typeof resource !== 'object' ||
          Array.isArray(resource) ||
          resource.mimeType !== mimeType ||
          typeof resource.uri !== 'string' ||
          !resource.uri.startsWith('ui://')
        )
          return [];
        return [{ resource, linked: part.type === 'resource_link' }];
      });
      if (declaredUri === undefined && candidates.length !== 1)
        throw new TypeError(
          'MCPApp requires one embedded or linked MCP App HTML resource',
        );
      const candidate =
        declaredUri === undefined
          ? candidates[0]
          : {
              resource: { uri: declaredUri, mimeType } as JsonObject,
              linked: true,
            };
      let resource = candidate.resource;
      if (candidate.linked) {
        const read = losslessJsonObjectSchema.parse(
          JSON.parse(
            await native.call(
              'read_mcp_resource',
              encode({ server: selected.name, params: { uri: resource.uri } }),
            ),
          ),
        );
        check();
        const matches = Array.isArray(read.contents)
          ? read.contents.filter(
              (entry) =>
                entry &&
                typeof entry === 'object' &&
                !Array.isArray(entry) &&
                entry.uri === resource.uri &&
                entry.mimeType === mimeType,
            )
          : [];
        if (matches.length !== 1)
          throw new TypeError(
            'MCPApp resource read did not return the exact HTML resource',
          );
        resource = losslessJsonObjectSchema.parse(matches[0]);
      }
      if (
        typeof resource.text !== 'string' ||
        resource.blob !== undefined ||
        Buffer.byteLength(resource.text, 'utf8') > 64 * 1024
      )
        throw new TypeError(
          'MCPApp resource must contain at most 64 KiB of HTML text',
        );
      const view: import('../mcp-apps').MCPAppView = {
        callId,
        toolName: call.name,
        arguments: structuredClone(call.arguments),
        result: structuredClone(result),
        resource: {
          uri: resource.uri as string,
          mimeType,
          text: resource.text,
          ...(resource._meta === undefined
            ? {}
            : { _meta: losslessJsonObjectSchema.parse(resource._meta) }),
        },
      };
      return {
        view,
        callTool: (name: string, arguments_: JsonObject) => {
          const request = JSON.stringify(
            losslessJsonObjectSchema.parse({
              server: selected.name,
              params: { name, arguments: arguments_ },
            }),
          );
          this.checkCallbackOperation('MCPApp tool call');
          return this.mutate(async () => {
            check();
            if (
              name !== call.name ||
              !this.defaultMcpTools.includes(selected) ||
              !this.mcpTools.includes(selected)
            )
              throw new TypeError(
                'MCPApp may call only its originating selected tool',
              );
            const output = losslessJsonObjectSchema.parse(
              JSON.parse(await native.call('call_mcp_app_tool', request)),
            );
            check();
            return output;
          });
        },
      };
    });
  }

  /**
   * Read a URI while idle as transport data, including text, base64 blobs and metadata.
   * The SDK never adds the result to instructions or model context. Native errors
   * propagate as NativeError. The existing Session reader cancels idle elicitation.
   * Turn-lifetime stdio is unavailable; use a session-lifetime declaration instead.
   */
  async readMcpResource(
    server: string,
    uri: string,
  ): Promise<MCPReadResourceResult> {
    if (typeof uri !== 'string' || !uri)
      throw new TypeError('MCP resource URI must be a nonempty string');
    return this.mcpRequest('read_mcp_resource', server, {
      uri,
    }) as Promise<MCPReadResourceResult>;
  }

  /**
   * List every prompt from a currently selected ordinary MCP server while idle.
   * Core exhausts pagination and rejects failures without returning a partial list.
   * Catalog limits are 100 pages, 2,048 items, 64 KiB per cursor, and 8 MiB total
   * across serialized prompt-page arrays. The server execution timeout bounds
   * the collection. Missing capability returns [].
   * Lazy activation grants no tools. Results never enter instructions or model context.
   */
  async listMcpPrompts(server: string): Promise<MCPPrompt[]> {
    return this.mcpRequest('list_mcp_prompts', server, {}) as Promise<
      MCPPrompt[]
    >;
  }

  /**
   * Get a named prompt as caller-owned data, preserving rich content and metadata.
   * Omitted arguments remain omitted; an explicit empty object remains empty.
   * The server validates names and required arguments. Native errors propagate.
   * HTTP POST responses are limited to 8 MiB. Legacy SSE continuations use the
   * transport's per-event limit, which defaults to 16 MiB.
   * Idle interaction and joined close semantics match readMcpResource.
   */
  async getMcpPrompt(
    server: string,
    name: string,
    args?: Readonly<Record<string, string>>,
  ): Promise<MCPGetPromptResult> {
    const params: JsonObject = { name };
    if (args !== undefined)
      params.arguments = Object.fromEntries(Object.entries(args));
    return this.mcpRequest(
      'get_mcp_prompt',
      server,
      params,
    ) as Promise<MCPGetPromptResult>;
  }

  private async mcpRequest(
    operation:
      | 'list_mcp_resources'
      | 'list_mcp_resource_templates'
      | 'read_mcp_resource'
      | 'list_mcp_prompts'
      | 'get_mcp_prompt',
    server: string,
    params: JsonObject,
  ): Promise<unknown> {
    this.checkCallbackOperation(operation);
    this.idle(operation);
    const selected = this.defaultMcpTools.find(
      (candidate) => candidate.name === server,
    );
    if (!selected || isHostedRegistration(selected))
      throw new TypeError(
        'MCP operations require a currently selected ordinary MCP server',
      );
    if (selected instanceof StdioMCP && selected.lifetime === 'turn')
      throw new TypeError(
        'Idle MCP operations require session-lifetime MCP stdio',
      );
    return this.mutate(async () => {
      try {
        if (!this.mcpTools.some((active) => active.name === server)) {
          const next = [...this.mcpTools, resourceMcpBinding(selected)];
          const generation =
            (this.options.agentGraph
              ? this.profileHighWater
              : this.mcpGeneration) + 1n;
          try {
            const receipt = parseNative(
              await this.#native._replace_mcp_servers(
                encode(
                  mcpConfig(
                    next,
                    this.environment ?? undefined,
                    this.codeModeEnabled,
                    this.mcpBindings,
                  ),
                ),
                mcpPolicies(next, generation),
                hasMcpPrePolicy(this.mcpTools) || hasMcpPrePolicy(next)
                  ? encode(this.interceptionRules(next, generation))
                  : undefined,
                undefined,
                undefined,
                undefined,
                true,
              ),
            );
            checkMcpPublication(receipt, next, generation, this.mcpBindings);
            this.mcpTools = next;
            this.mcpGeneration = generation;
            await this.acknowledgeProfilePublication();
          } catch (error) {
            this.retire(error);
            throw error;
          }
        }
        return parseNative(
          await this.#native.call(operation, encode({ server, params })),
        );
      } catch (error) {
        throw new NativeError(
          error instanceof Error ? error.message : String(error),
          { cause: error },
        );
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
            after: owner.observationAfter,
            includes: (event) =>
              'submissionId' in event && event.submissionId === key,
            phase: () => owner.observationPhase,
          }),
        toolCompletion: (raw) => {
          const fact = toolCompletionSchema.parse(raw);
          const proposal = this.terminalProposals.get(owner)?.proposal;
          if (
            !proposal ||
            !proposal.accepted ||
            proposal.callId !== fact.call_id ||
            proposal.name !== fact.name ||
            (proposal.namespace ?? 'functions') !==
              (fact.namespace ?? 'functions') ||
            typeof fact.final_output !== 'string' ||
            !isDeepStrictEqual(proposal.json, fact.final_output)
          ) {
            this.clearTerminalProposal(owner);
            throw new NativeError(
              'Child terminal tool completion has no matching accepted proposal',
            );
          }
          // The ordered reader still needs the accepted proposal to publish.
          if (owner.observationPhase === 'open') proposal.waiterConsumed = true;
          else this.clearTerminalProposal(owner);
          return terminalCallInfo(
            {
              sessionId: this.id,
              turnId: owner.turnId,
              childId: owner.childId,
              childIncarnation: owner.incarnation,
            },
            fact,
            proposal.namespace,
          );
        },
        drain: () =>
          this.childCallbacks.drain(
            native.child_id,
            native.incarnation,
            native.turn_id,
          ),
        requests: {
          guardrailResults: () => owner.guardrailResults,
          runUsage: () =>
            runUsageSnapshot(
              owner.tokenUsage,
              owner.requests,
              owner.missingUsageRequests,
            ),
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
    const parts = nativeInput(input as UserInput);
    const native = await thread._child_submit(
      id,
      instance,
      encode({ input: parts }, audioInputByteLimit(parts)),
    );
    return this.publicChildTurn(native, producer);
  }

  /** Native stored history branch, with the source Session remaining usable.
   * Idle LocalStorage root; fresh immutable ID at latest/before/through-turn.
   * History only: no descendant or native VM cloning. Subsequent opening with
   * the same LocalStorage and current Agent; no portable checkpoint conversion. */
  async forkStored(options: StoredForkOptions = {}): Promise<string> {
    this.checkCallbackOperation('fork stored history');
    if (!options || typeof options !== 'object' || Array.isArray(options))
      throw new TypeError('Stored fork options must be an object');
    if (!this.options.localStorage)
      throw new TypeError('Stored forks require native LocalStorage');
    if (this.realtimeOwner)
      throw new NativeError('Close native Realtime before a stored fork');
    this.requireCompleteRepairReceipts();
    if (this.graphStops.size || this.childContinuations.size)
      throw new NativeError('Stored fork requires a settled Session');
    const request: Record<string, string> = {};
    for (const [name, value] of [
      ['before_turn_id', options.beforeTurnId],
      ['through_turn_id', options.throughTurnId],
    ] as const) {
      if (value === undefined) continue;
      if (typeof value !== 'string' || !value)
        throw new TypeError('Stored fork turn IDs must be nonempty strings');
      request[name] = value;
    }
    if (Object.keys(request).length > 1)
      throw new TypeError('Choose either beforeTurnId or throughTurnId');
    return this.mutate(async () => {
      await this.discardForkCopy();
      try {
        const copy = await this.#native._fork_stored(encode(request));
        this.forkCopy = copy;
        const id = await copy._publish_stored_fork();
        this.forkCopy = undefined;
        return id;
      } catch (error) {
        try {
          await this.discardForkCopy();
          // Creation can succeed even when its wrapper never reaches JS.
          const diagnostic = await this.#native._discard_stored_fork();
          if (diagnostic) throw new NativeError(diagnostic);
        } catch (cleanup) {
          throw new AggregateError(
            [error, cleanup],
            'Stored fork and cleanup failed',
            {
              cause: error,
            },
          );
        }
        throw error;
      }
    });
  }

  /** Core has been closing this Session before reverting its stored conversation.
   * The named turn and every later turn: excluded. Immutable Session.id;
   * subsequent opening through the same LocalStorage and current Agent. */
  async revertStored(options: { beforeTurnId: string }): Promise<void> {
    const { beforeTurnId } = options;
    if (typeof beforeTurnId !== 'string' || !beforeTurnId)
      throw new TypeError('beforeTurnId must be a nonempty string');
    return this.closeStoredHistory({
      kind: 'revert',
      before_turn_id: beforeTurnId,
    });
  }

  /** Core has been closing this Session before deleting its stored conversation.
   * LocalStorage only; native writer/reference exclusion and sidecar cleanup.
   * Explicit rejection after a concurrent prior close; no silent success. */
  async deleteStored(): Promise<void> {
    return this.closeStoredHistory({ kind: 'delete' });
  }

  private closeStoredHistory(action: Record<string, string>): Promise<void> {
    this.checkCallbackOperation('change stored history while closing');
    this.idle('change stored history while closing');
    this.storedHistoryClose = this.#native._stored_history_close_action(
      JSON.stringify(action),
    );
    return this.close();
  }

  /** Persist this LocalStorage Session's label; null clears it.
   * Surrounding whitespace trimmed; blank names rejected. Nonunique labels,
   * immutable Session identity; no alias or resume authority. */
  async setStoredName(name: string | null): Promise<string | null> {
    if (name !== null && typeof name !== 'string')
      throw new TypeError('name must be a string or null');
    this.checkCallbackOperation('set the stored name on');
    if (!this.isOpen || this.manualSealing || this.manualSealed)
      throw new NativeError('Stored names require a healthy open Session');
    return JSON.parse(
      await this.#native._set_stored_name(JSON.stringify(name)),
    ) as string | null;
  }

  /** Committed native Exec application-session headers from this LocalStorage.
   * Exec category, including SDK/exec applications; interactive CLI, IDE and
   * subagent categories excluded. Native creation-order cursor; active and
   * approval-paused reads without snapshot isolation or totals. Archived
   * collection only for archived=true; active collection otherwise. Potential
   * short/empty pages with a next cursor after deletion. Concurrent opening or
   * fork entries; no stable pagination or publication promise. Validated links;
   * without opening the listed sessions or loading their history. Existing
   * materialization/flush of the current owner.
   *
   * Page sizes 1 through 1000; default 50. Opaque cursors for the same options.
   * Paging with the returned cursor, including empty pages:
   * ```ts
   * let cursor: string | undefined;
   * const ids: string[] = [];
   * do {
   *   const page = await session.storedSessions({ limit: 50, cursor });
   *   ids.push(...page.sessions.map((item) => item.id));
   *   cursor = page.nextCursor ?? undefined;
   * } while (cursor !== undefined);
   * ```
   */
  async storedSessions(
    options: { limit?: number; cursor?: string; archived?: boolean } = {},
  ): Promise<StoredSessionPage> {
    const { limit = 50, cursor, archived = false } = options;
    const query = storedOptions(limit, cursor);
    return storedSessionPage(
      await this.#native._stored_history(
        JSON.stringify({
          kind: 'sessions',
          limit: query.limit,
          cursor: query.cursor,
          archived,
        }),
      ),
    );
  }

  /** Core has been returning committed turn metadata and optional summary items.
   * Active/approval-paused availability; opaque native cursors without CAS
   * revisions. Full indexed item detail through storedItems. Unsupported stores
   * fail without a hidden full-journal fallback. */
  async storedTurns(
    options: {
      limit?: number;
      cursor?: string;
      direction?: 'asc' | 'desc';
      includeSummary?: boolean;
    } = {},
  ): Promise<StoredTurnPage> {
    const {
      limit = 50,
      cursor,
      direction = 'asc',
      includeSummary = false,
    } = options;
    const query = storedOptions(limit, cursor, direction);
    if (typeof includeSummary !== 'boolean')
      throw new TypeError('includeSummary must be a boolean');
    return storedTurnPage(
      await this.#native._stored_history(
        JSON.stringify({
          kind: 'turns',
          ...query,
          include_items: includeSummary,
        }),
      ),
    );
  }

  /** Core has been paging committed item projections in creation order.
   * Raw original JSON records through historySnapshot; independent copied pages. */
  async storedItems(
    options: {
      turnId?: string;
      limit?: number;
      cursor?: string;
      direction?: 'asc' | 'desc';
    } = {},
  ): Promise<StoredItemPage> {
    const { limit = 50, cursor, direction = 'asc', turnId } = options;
    const query = storedOptions(limit, cursor, direction);
    if (turnId !== undefined && (typeof turnId !== 'string' || !turnId))
      throw new TypeError('turnId must be a nonempty string');
    return storedItemPage(
      await this.#native._stored_history(
        JSON.stringify({ kind: 'items', ...query, turn_id: turnId ?? null }),
      ),
    );
  }

  /** Core has been searching indexed visible messages by literal substring.
   * Case-insensitive matching; UTF-16 snippet offsets. Inclusive turnCursor for
   * storedTurns at the matching turn. */
  async searchHistory(
    text: string,
    options: { limit?: number; cursor?: string } = {},
  ): Promise<StoredMatchPage> {
    const { limit = 50, cursor } = options;
    const query = storedOptions(limit, cursor);
    if (typeof text !== 'string' || !text.trim())
      throw new TypeError('Stored history search requires nonempty text');
    return storedMatchPage(
      await this.#native._stored_history(
        JSON.stringify({
          kind: 'search',
          limit: query.limit,
          cursor: query.cursor,
          text,
        }),
      ),
    );
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

  /** Core has been retaining original JSON object records independently of model
   * context truncation. A limit has been selecting the latest original records;
   * zero has been returning only the content revision and full count. Hot reads
   * have been copying only selected records; durable restore has been loading
   * the full stored history. Projected items() has been remaining a separate view. */
  async historySnapshot(
    options: { limit?: number } = {},
  ): Promise<CanonicalHistorySnapshot> {
    return this.#captureCanonicalHistory(options);
  }

  /** @internal One-shot replay capture with native size limits. */
  _historyForReplay(): Promise<CanonicalHistorySnapshot> {
    return this.#captureCanonicalHistory({}, true);
  }

  async #captureCanonicalHistory(
    options: { limit?: number },
    forReplay = false,
  ): Promise<CanonicalHistorySnapshot> {
    this.checkCallbackOperation('read canonical history from');
    this.idle('historySnapshot');
    const { limit } = options;
    if (
      limit !== undefined &&
      (!Number.isSafeInteger(limit) || limit < 0 || limit > 0xffffffff)
    )
      throw new RangeError('limit must be a nonnegative 32-bit integer');
    return this.mutate(async () => {
      const snapshot: { revision: string; total: number; items: string[] } =
        JSON.parse(
          await this.#native._canonical_history(limit ?? null, forReplay),
        );
      return {
        ...snapshot,
        items: snapshot.items.map(
          (item) => JSON.parse(item) as Record<string, unknown>,
        ),
      };
    });
  }

  /** Core has been atomically replacing a suffix of original JSON object records.
   * Positive keep=total has been preserving current model context while appending;
   * keep=0 has been explicitly replacing that context. Known executable items
   * have been requiring valid native shapes and complete client-tool pairs.
   * Core has been retaining unknown records for audit without model admission
   * and rejecting ambiguous prefix shortening after compaction before commit.
   * An uncertain persistence outcome has been retiring this Session, requiring
   * close and restore before further work. Pending work, child graphs and goals
   * have been continuing through their dedicated APIs. */
  async transactHistory(options: {
    expectedRevision: string;
    keep: number;
    items?: readonly Record<string, unknown>[];
  }): Promise<string> {
    this.checkCallbackOperation('edit canonical history in');
    this.idle('transactHistory');
    const { expectedRevision, keep } = options;
    if (typeof expectedRevision !== 'string' || !expectedRevision)
      throw new TypeError('expectedRevision must be nonempty text');
    if (!Number.isSafeInteger(keep) || keep < 0 || keep > 0xffffffff)
      throw new RangeError('keep must be a nonnegative 32-bit integer');
    // Original JSON has been crossing generic native Value conversions only as strings.
    const captured = JSON.stringify(
      (options.items ?? []).map((item) => JSON.stringify(item)),
    );
    return this.mutate(async () => {
      const value = JSON.parse(
        await this.#native._transact_history(expectedRevision, keep, captured),
      );
      if (value.outcome === 'uncertain') {
        const error = new NativeError(
          'Canonical history commit outcome is uncertain; close and restore the Session',
        );
        this.retire(error);
        throw error;
      }
      return value.revision;
    });
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
        'Persistent storage does not support a supplied compaction summary; use compact() without options for native compaction',
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
      this.captureSelection(),
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
      command.name === 'stop-background-terminals' ? 'stop' : command.name,
      command.arguments,
    );
    if (command.name === 'stop-background-terminals') {
      const accepted = decode(
        z.object({ session_id: z.string(), operation_id: z.string() }),
        receipt,
      );
      return Object.freeze({
        command: 'stop-background-terminals',
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
      return 'Persistent storage cannot export SessionState';
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
    try {
      await this.refreshManualProfile(run);
    } catch {
      return this.current(run) &&
        run.failure === undefined &&
        !run.controller.signal.aborted &&
        !this.checkpointRefusal()
        ? checkpointStatus(
            'unknown',
            'Native checkpoint readiness could not be verified',
          )
        : checkpointStatus('notReady', 'No settled pending manual boundary');
    }
    const afterRefresh = this.checkpointRefusal();
    if (afterRefresh) return checkpointStatus('notReady', afterRefresh);
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
    if (this.realtimeOwner)
      throw new NativeError('Close native Realtime before fork');
    this.requireCompleteRepairReceipts();
    if (this.options.localStorage)
      throw new TypeError(
        'Persistent storage does not support fork; retain Session.id and reopen with the same storage backend',
      );
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
      const {
        environment: _openingEnvironment,
        _sdk_project_search: _openingSearch,
        ...runtime
      } = this.threadOptions.runtime ?? {};
      const options: ThreadOptions = {
        ...this.threadOptions,
        instructions: current.instructions,
        _sdk_instruction_files: current.instruction_files,
        config: { ...this.threadOptions.config, mcp_servers: servers },
        runtime: { ...runtime, ...projectSearchRuntime(this.environment) },
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
      const manualSlots = encode(
        this.catalog.tools
          .filter((tool) => tool.kind === 'manual')
          .map((tool) => ({ name: tool.name })),
      );
      owner.thread._configure_manual_tools(manualSlots);
      if (this.options.includeRawProviderEvents)
        owner.thread._enable_raw_provider_events();
      await this.publishContextStartup(owner, signal);
      beforeRetirement();
      await owner.change.validateCandidate(owner.thread);
      beforeRetirement();
      // Validation retains the source catalog generation and narrowed defaults.
      owner.thread._configure_manual_tools(manualSlots, this.terminalSlots());
      const manualCheckpoint = this.catalog.tools.some(
        (tool) => tool.kind === 'manual',
      )
        ? await owner.thread._manual_checkpoint_config_supported()
        : false;
      beforeRetirement();
      owner.retiring = true;
      this.replacingNative = owner.source;
      const report = await owner.change.retire();
      owner.fenced = true;
      if (report) owner.completedFailure = new NativeError(report);
      await this.releaseContextSource(owner, true);
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

  private async releaseContextSource(
    owner: ContextReplacement,
    deferSavedLoginRefresh = false,
  ): Promise<void> {
    if (!owner.sourceReleased) {
      // Never retain a mutation guard while native close acquires its own guard.
      await this.releaseContextChange(owner);
      const threadReport = await owner.source._close_report();
      if (threadReport)
        owner.completedFailure ??= new NativeError(threadReport);
      await Promise.allSettled(owner.sourceReaders);
    }
    // The candidate shares the saved login. If both engines retire, read the
    // final report even when the source already finished native shutdown.
    owner.completedFailure = await engineCloseFailure(
      owner.sourceEngine,
      owner.completedFailure,
      deferSavedLoginRefresh,
    );
    if (!owner.sourceReleased) {
      this.carrier?.unbindEngine(owner.sourceEngine);
      owner.sourceReleased = true;
    }
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
  /** Retire this owned Session and capture its associated durable workspace. */
  async suspendWorkspace(): Promise<ManagedWorkspaceCheckpoint> {
    this.checkCallbackOperation('suspend managed workspace on');
    const managed = this.options.managedWorkspace;
    if (!managed)
      throw new TypeError(
        'Managed capture requires an owned managed sandbox source',
      );
    if (managed.capture) return managed.capture;
    managed.captureRequested = true;
    let capture: Promise<SessionState>;
    try {
      capture =
        this.lifecycle.kind === 'turn'
          ? this.captureSuspendedState()
          : this.captureIdleState(true);
    } catch (error) {
      managed.captureRequested = false;
      throw error;
    }
    if (
      this.lifecycle.kind !== 'mutation' &&
      !this.manualSeal &&
      !this.manualSealed
    ) {
      managed.captureRequested = false;
      return capture.then(() => {
        throw new NativeError('Managed capture admission was not retained');
      });
    }
    const pending = capture.then(
      async (state) => {
        await this.close();
        if (!managed.receipt)
          throw new NativeError(
            'Managed retirement omitted its workspace receipt',
          );
        return captureRetiredWorkspace(state, managed.receipt);
      },
      async (error) => {
        try {
          await this.close();
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            'Managed capture and cleanup failed',
            { cause: error },
          );
        }
        throw error;
      },
    );
    managed.capture = pending;
    void pending.catch(() => {});
    return pending;
  }

  async saveState(): Promise<SessionState> {
    return this.captureIdleState(false);
  }
  private captureIdleState(retire: boolean): Promise<SessionState> {
    if (this.realtimeOwner)
      throw new NativeError('Close native Realtime before save');
    this.requireCompleteRepairReceipts();
    if (this.options.localStorage)
      throw new TypeError(
        'Persistent storage does not support saveState; retain Session.id and reopen with the same storage backend',
      );
    this.checkCallbackOperation('save');
    if (this.graphStops.size)
      throw new NativeError(
        'saveState is unavailable while Session is stopping',
      );

    this.idle('saveState');
    let snapshot: SessionState | null = null;
    return this.mutate(async () => {
      const state = this.decorateState(
        parseNativeCheckpoint(
          await this.#native._export_checkpoint(null, false),
        ),
      );

      snapshot = state;
      if (retire) {
        this.manualSealed = true;
        this.sealedStateJson = encode(state);
      }
    }).then(() => {
      if (!snapshot)
        throw new NativeError('Native checkpoint was not captured');
      return snapshot;
    });
  }
  async suspend(): Promise<SessionState> {
    if (this.options.managedWorkspace?.capture)
      throw new NativeError('Session is retiring a managed workspace');
    return this.captureSuspendedState();
  }
  private captureSuspendedState(): Promise<SessionState> {
    if (this.options.chatGPTPlan)
      throw new TypeError('Sign in with ChatGPT requires settled state');
    if (this.realtimeOwner)
      throw new NativeError('Close native Realtime before suspend');
    if (this.nativeQuestions.size)
      throw new TypeError('Native questions cannot be suspended or serialized');
    if (this.options.localStorage)
      throw new TypeError(
        'Persistent storage does not support suspend; retain Session.id and reopen with the same storage backend',
      );
    if (this.sealedStateJson !== undefined)
      return Promise.resolve(parseSessionState(this.sealedStateJson));
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
          ? decode(losslessJsonValueSchema, call.event.msg.arguments)
          : losslessJsonValueSchema.parse(call.event.msg.arguments),
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
    if (run) await this.refreshManualProfile(run);
    signal.throwIfAborted();
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
    const resourceServers = this.defaultMcpTools.filter(
      (server) => !isHostedRegistration(server),
    );
    const openingResourceServers = this.openingMcpTools.filter(
      (server) => !isHostedRegistration(server),
    );
    const changedResourceSelection =
      resourceServers.length !== openingResourceServers.length ||
      resourceServers.some(
        (server) =>
          !server.tools.length ||
          !openingResourceServers.some(
            (opening) => opening.name === server.name,
          ),
      );
    return {
      ...(changedResourceSelection
        ? {
            default_resource_servers: {
              selected: resourceServers.map((server) => server.name),
              resource_only: resourceServers
                .filter((server) => !server.tools.length)
                .map((server) => server.name),
            },
          }
        : {}),
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
          managed_tool_specs: decode(
            losslessJsonValueSchema,
            this.catalog.specsJson,
          ),
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
        this.environment?.readOnly ?? false,
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
      this.environment?.readOnly ?? false,
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
      const sourceServers = this.sourceMcp(
        raw as Record<string, unknown>,
        notice.generation ?? '',
      );
      const sourceGeneration = BigInt(notice.generation ?? '0');
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
            const transformed = await transformMcpResult(
              sourceServers,
              sourceGeneration,
              this.options.context,
              submission,
              { ...notice, incarnation, generation: notice.generation ?? '' },
            );
            if (
              !requestExpired &&
              notice.phase === 'metadata' &&
              owner instanceof NativeTurn &&
              submissions.get(owner)?.realtimeTools &&
              this.realtimeOwner
            ) {
              if (!notice.realtime_tool_name)
                throw new NativeError(
                  'Realtime MCP metadata is missing its captured wire name',
                );
              if (
                !(await this._realtimeAgentToolEnabled(
                  this.messageProfile(raw as Record<string, unknown>) ?? null,
                  toolRef(notice.realtime_tool_name),
                  owner.controller.signal,
                ))
              )
                return false;
            }
            return transformed;
          };
          let response: unknown;
          if (owner instanceof NativeTurn && tracing_context !== undefined) {
            await this.invokeCallback(
              owner,
              async () => {
                try {
                  response = await transform();
                } catch (error) {
                  if (
                    owner.controller.signal.aborted &&
                    error === owner.controller.signal.reason
                  )
                    throw error;
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
              workflowForTrace,
              owner instanceof NativeTurn
                ? undefined
                : producer.callbackTraceStorages,
            );
          }
          if (!requestExpired && this.current(owner)) {
            const accepted = native._resolve_native_mcp_result(
              notice.nonce,
              notice.turn_id,
              notice.call_id,
              JSON.stringify(losslessJsonValueSchema.parse(response)),
            );
            if (
              !accepted &&
              native._check_native_mcp_result(
                notice.nonce,
                notice.turn_id,
                notice.call_id,
              )
            ) {
              throw new NativeError('Native MCP result policy failed');
            }
          }
        } catch {
          if (
            !this.current(owner) ||
            !native._check_native_mcp_result(
              notice.nonce,
              notice.turn_id,
              notice.call_id,
            )
          )
            return;
          const failure = new NativeError('Native MCP result policy failed');
          // Retain the owning SDK failure before releasing a sender can wake native stop.
          // The current owner check keeps retired calls out of a replacement turn.
          if (this.current(owner)) {
            owner.failure ??= failure;
            throw owner.failure;
          }
          throw failure;
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
          const scope = {
            session: this,
            child: owner,
            active: true,
            parent: toolInvocation.getStore(),
          };
          try {
            await toolInvocation.run(scope, () =>
              withNativeCallbackContext(
                tracingContext,
                callback,
                owner.controller.signal,
                workflowForTrace,
                owner.observationProducer.callbackTraceStorages,
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
              mcp_identity: z.tuple([z.string(), z.string()]).optional(),
              realtime_tool_name: z.string().optional(),
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
        const sourceServers =
          !binding && notice.generation !== undefined
            ? this.sourceMcp(raw as Record<string, unknown>, notice.generation)
            : undefined;
        const sourceGeneration =
          !binding && notice.generation !== undefined
            ? BigInt(notice.generation)
            : undefined;
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
              name.name === 'apply_patch' ||
              name.name === 'project_glob' ||
              name.name === 'project_grep');
          const before =
            request!.phase === 'before' && request!.boundary === 'pre_dispatch';
          const after =
            request!.phase === 'after' &&
            (request!.boundary === 'executor_return' ||
              (builtin &&
                (name.name === 'project_glob' ||
                  name.name === 'project_grep') &&
                request!.boundary === 'nested_return'));
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
                      sourceServers!,
                      sourceGeneration!,
                      this.options.context,
                      submission,
                      {
                        ...request!,
                        _mcp_generation: notice.generation,
                        ...(notice.mcp_identity
                          ? { _mcp_identity: notice.mcp_identity }
                          : {}),
                      },
                      signal,
                      () => {
                        if (
                          !this.current(owner) ||
                          reservation.cancelled ||
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
                      owner instanceof NativeTurn &&
                        submissions.get(owner)?.realtimeTools &&
                        this.realtimeOwner
                        ? () => {
                            if (!notice.realtime_tool_name)
                              throw new NativeError(
                                'Realtime MCP policy is missing its captured wire name',
                              );
                            return this._realtimeAgentToolEnabled(
                              this.messageProfile(
                                raw as Record<string, unknown>,
                              ) ?? null,
                              toolRef(notice.realtime_tool_name),
                              signal,
                            );
                          }
                        : undefined,
                    )
                  : this.options.nativeAgents && collaboration
                    ? await (async () => {
                        const scope = this.decisionScope(
                          raw as JsonObject,
                          signal,
                        );
                        try {
                          return await applyNativeAgentsApproval(
                            this.options.nativeAgents!,
                            this.options.context,
                            submission,
                            request!,
                            signal,
                            scope.decide,
                          );
                        } finally {
                          await scope.close();
                        }
                      })()
                    : this.environment instanceof Environment &&
                        hasExecutorPolicy(this.environment)
                      ? await applyExecutorPolicy(
                          this.environment,
                          this,
                          this.sourceApplicationAgent(
                            raw as Record<string, unknown>,
                          )!,
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
    const storedAction = this.storedHistoryClose;
    this.storedHistoryClose = undefined;
    // Join exact form and verification declines, including earlier retirements.
    // Native shutdown must still precede held schema compilation cleanup.
    await Promise.allSettled([...this.nativeQuestionRetirementReplies]);
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
      const message = privateRuntime(this)
        ? await this.#native._close_private_root_report()
        : await this.#native._close_report();
      if (message) return new NativeError(message);
    }
    if (storedAction) {
      try {
        await storedAction.apply();
      } catch (error) {
        // Native shutdown has joined. Preserve the operation failure through
        // the existing report channel while engine/carrier teardown continues.
        return error as NativeError;
      }
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
      // A failed media cleanup retains its owner after other resources retire.
      // Retry only that manager, without rerunning provider/onClose effects.
      if (this.realtimeOwner)
        return this.realtimeOwner
          ._nativeShutdown()
          .then(() => this.closeOwned());
      if (this.sessionInteractionFailure)
        return Promise.reject(this.sessionInteractionFailure.error);
      if (this.environmentCloseFailure) return this.environmentCloseFailure;
      // Completed persistent cleanup retains the engine's durability report.
      // Release-only diagnostics have already been consumed by native close.
      return this.options.localStorage
        ? this.#engine._close_report_defer_saved_login().then((message) => {
            if (message) throw new NativeError(message);
          })
        : Promise.resolve();
    }
    if (state.kind === 'closing') return state.completion;
    const realtime = this.realtimeOwner;
    realtime?._retireFromSession();
    let realtimeShutdown: Promise<void> | undefined;
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
        ...(this.sessionInteractionFailure
          ? [this.sessionInteractionFailure.error]
          : []),
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
    const joinRealtimeShutdown = async () => {
      const task = realtimeShutdown;
      realtimeShutdown = undefined;
      if (!task) return;
      const [result] = await Promise.allSettled([task]);
      if (result.status === 'rejected')
        interceptionFailures.push(result.reason);
    };
    done.promise.catch(() => {});
    void (async () => {
      if (repair) {
        // A repaired completion hook may await auxiliary work until revoked.
        // Keep the native reader alive below while that work commits its usage.
        run?.controller.abort(
          state.kind === 'retired'
            ? state.cause
            : new TurnAborted('Session closed'),
        );
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
        if (this.interceptionReaderStarted)
          this.#native._revoke_native_interception();
        if (this.mcpReaderStarted) this.#native._revoke_native_mcp_results();
        phase = 'native';
      }
      if (phase === 'native' && this.starting) {
        acknowledgmentFailure = await engineCloseFailure(
          this.#engine,
          acknowledgmentFailure,
        );
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
        if (!privateRuntime(this)) {
          acknowledgmentFailure = await engineCloseFailure(
            this.#engine,
            acknowledgmentFailure,
          );
        }
        phase = 'carrier';
      }
      // A fulfilled native/engine close proves graph retirement even when its
      // report retains an external command-termination diagnostic. Release only
      // this voice owner's public-wrapper waits; never bypass public Turn waits.
      if (phase === 'carrier' || phase === 'provider') {
        realtimeShutdown = realtime?._nativeShutdown();
        void realtimeShutdown?.catch(() => {});
      }
      if (phase === 'carrier') {
        if (!privateRuntime(this)) await this.carrier?.close();
        phase = 'provider';
      }
      if (phase === 'provider') {
        try {
          if (!this.environmentDisposalFinished) {
            try {
              await this.options.environmentOwner?.dispose(async (dispose) => {
                const scope = {
                  session: this,
                  active: true,
                  parent: toolInvocation.getStore(),
                };
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
          const computerScope = {
            session: this,
            active: true,
            parent: toolInvocation.getStore(),
          };
          try {
            try {
              await toolInvocation.run(computerScope, () =>
                closeComputerResources(this.toolSessionOwner),
              );
            } finally {
              computerScope.active = false;
            }
          } catch (error) {
            try {
              await this.options.onClose?.();
            } catch (releaseError) {
              throw new AggregateError(
                [error, releaseError],
                'Computer and provider lease cleanup failed',
                { cause: error },
              );
            }
            throw error;
          }
          await this.options.onClose?.();
        } finally {
          // Native, readers and child callbacks have joined; late discovery is now impossible.
          this.options.tracingCapture = undefined;
          for (const reference of this.runs) {
            const owned = reference.deref();
            if (owned) {
              owned.tracing = undefined;
              owned.issuedTracing = undefined;
            }
            this.runFinalizer.unregister(reference);
          }
          this.runs.clear();
        }
      }
      await joinRealtimeShutdown();
      this.observations.finish('closed');
      if (run) this.finishObservation(run);
      this.lifecycle = { kind: 'closed', completion: done.promise };

      settleClose(run ? cleanupFailure(run) : undefined);
    })().catch(async (error) => {
      await joinRealtimeShutdown();
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
