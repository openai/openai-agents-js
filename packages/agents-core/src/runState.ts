import { z } from 'zod';
import { randomUUID } from '@openai/agents-core/_shims';
import { Agent } from './agent';
import type { Handoff } from './handoff';
import { getAgentToolSourceAgent } from './agentToolSourceRegistry';
import { buildAgentIdentityMap } from './runStateIdentity';
export { buildAgentIdentityMap } from './runStateIdentity';
import {
  RunMessageOutputItem,
  RunItem,
  RunToolApprovalItem,
  RunToolCallItem,
  RunToolCallOutputItem,
  RunToolSearchCallItem,
  RunToolSearchOutputItem,
  RunReasoningItem,
  RunCompactionItem,
  RunHandoffCallItem,
  RunHandoffOutputItem,
} from './items';
import type { ModelResponse, ModelSettings } from './model';
import { RunContext } from './runContext';
import {
  extractOutputItemsFromRunItems,
  getTurnInput,
  type ReasoningItemIdPolicy,
} from './runner/items';
import { AgentToolUseTracker } from './runner/toolUseTracker';
import { nextStepSchema, NextStep } from './runner/steps';
import { createToolRunFunction, type ProcessedResponse } from './runner/types';
import { hasBlockedOutputExecutionEffect } from './runner/blockedOutputPersistence';
import type { AgentSpanData, Span } from './tracing/spans';
import { SystemError, UserError } from './errors';
import { getGlobalTraceProvider } from './tracing/provider';
import { Usage } from './usage';
import { Trace } from './tracing/traces';
import { getCurrentTrace } from './tracing';
import logger from './logger';
import * as protocol from './types/protocol';
import { AgentInputItem, UnknownContext } from './types';
import {
  SANDBOX_SESSION_STATE_VERSION,
  SUPPORTED_SANDBOX_SESSION_STATE_VERSIONS,
} from './sandbox/session';
import type { InputGuardrailResult, OutputGuardrailResult } from './guardrail';
import type {
  ToolInputGuardrailResult,
  ToolOutputGuardrailResult,
} from './toolGuardrail';
import { safeExecute } from './utils/safeExecute';
import {
  getClientToolSearchExecutor,
  getToolSearchRuntimeRoutingKey,
  HostedMCPTool,
  FunctionTool,
  ShellTool,
  ApplyPatchTool,
  Tool,
} from './tool';
import type { AgentToolInvocation } from './agentToolInvocation';
import {
  buildFunctionToolLookupMap,
  type FunctionToolLookupKey,
  getFunctionToolLookupKey,
  getFunctionToolLegacyStateKeyFromStateKey,
  getFunctionToolQualifiedName,
  getFunctionToolStateKey,
  getFunctionToolStateKeyForCall,
  getFunctionToolStateKeyForResolvedCall,
  getFunctionToolStateKeys,
  getToolCallNamespace,
  getToolCallDisplayName,
  resolveFunctionToolCall,
} from './toolIdentity';
import {
  getToolSearchExecution,
  getToolSearchOutputReplacementKey,
  getToolSearchProviderCallId,
  resolveToolSearchCallId,
} from './utils/toolSearch';
import {
  executeCustomClientToolSearch,
  filterEnabledToolSearchRuntimeTools,
  getClientToolSearchHelper,
  registerRuntimeToolSearchTools,
  validateClientToolSearchSupport,
} from './runner/toolSearch';
import { resolveModelVisibleToolNameCollisions } from './runner/modelPreparation';
import { ensureToolCallerAllowed } from './runner/toolCaller';
import {
  getSerializedApplyPatchToolPlaceholder,
  getSerializedComputerToolPlaceholder,
  getSerializedFunctionToolPlaceholder,
  getSerializedShellToolPlaceholder,
} from './sandbox/runtime/toolRehydration';

/**
 * The schema version of the serialized run state. This is used to ensure that the serialized
 * run state is compatible with the current version of the SDK.
 * If anything in this schema changes, the version will have to be incremented.
 *
 * Version history.
 * - 1.0: Initial serialized RunState schema.
 * - 1.1: Adds optional currentTurnInProgress, conversationId, and previousResponseId fields,
 *   plus broader tool_call_output_item rawItem variants for non-function tools. Older 1.0
 *   payloads remain readable but resumes may lack mid-turn or server-managed context precision.
 * - 1.2: Adds pendingAgentToolRuns for nested agent tool resumption.
 * - 1.3: Adds computer tool approval items to serialized tool_approval_item unions.
 * - 1.4: Adds optional toolInput to serialized run context.
 * - 1.5: Adds optional reasoningItemIdPolicy to preserve reasoning input policy across resume.
 * - 1.6: Adds optional requestId to serialized model responses.
 * - 1.7: Adds optional approval rejection messages.
 * - 1.8: Adds tool search item variants, batched computer actions, and GA computer tool
 *   aliasing to serialized run state payloads.
 * - 1.9: Adds optional sandbox session persistence with a versioned session-state
 *   envelope for sandbox-agent resume.
 * - 1.10: Adds optional stable agent identity keys so duplicate-name agent graphs can
 *   serialize and resume without ambiguous name resolution.
 * - 1.11: Allows null maxTurns to persist runs without a turn limit.
 * - 1.12: Adds optional missing function tool calls to processed responses.
 * - 1.13: Adds optional SDK-only customData on tool output run items.
 * - 1.14: Adds Programmatic Tool Calling program items, outputs, caller linkage,
 *   and optional assistant message phases.
 * - 1.15: Adds reconstructable sandbox environment value references and sandbox
 *   session-state envelope version 2.
 * - 1.16: Adds compaction items, category-aware function tool keys, and agent-scoped
 *   function approvals, including aliases for legacy pending-run accessors.
 * - 1.17: Adds durable local tool execution provenance and blocked-output session
 *   persistence bookkeeping.
 */
export const CURRENT_SCHEMA_VERSION = '1.17' as const;
const SUPPORTED_SCHEMA_VERSIONS = [
  '1.0',
  '1.1',
  '1.2',
  '1.3',
  '1.4',
  '1.5',
  '1.6',
  '1.7',
  '1.8',
  '1.9',
  '1.10',
  '1.11',
  '1.12',
  '1.13',
  '1.14',
  '1.15',
  '1.16',
  CURRENT_SCHEMA_VERSION,
] as const;
type SupportedSchemaVersion = (typeof SUPPORTED_SCHEMA_VERSIONS)[number];
const $schemaVersion = z.enum(SUPPORTED_SCHEMA_VERSIONS);

function schemaVersionSupportsV116State(
  schemaVersion: SupportedSchemaVersion,
): boolean {
  return schemaVersion === '1.16' || schemaVersion === CURRENT_SCHEMA_VERSION;
}

type ContextOverrideStrategy = 'merge' | 'replace';

const pendingSessionHistoryTransactionSchema = z
  .object({
    operationId: z.string().min(1),
    transactionKind: z.enum(['blocked_append', 'accepted_replace']),
    runItemIndexes: z.array(z.number().int().min(0)),
    replaceRunItemIndexes: z.array(z.number().int().min(0)),
    alreadyPersistedCount: z.number().int().min(0),
    persistedItemCount: z.number().int().min(0),
    deferredItemIndexes: z.array(z.number().int().min(0)),
  })
  .strict();

type PendingSessionHistoryTransaction = z.infer<
  typeof pendingSessionHistoryTransactionSchema
>;

type RunStateContextOverrideOptions<TContext> = {
  contextOverride?: RunContext<TContext>;
  contextStrategy?: ContextOverrideStrategy;
};

const serializedAgentSchema = z.object({
  name: z.string(),
  identity: z.string().optional(),
});
type SerializedAgentReference = z.infer<typeof serializedAgentSchema>;

const serializedSpanBase = z.object({
  object: z.literal('trace.span'),
  id: z.string(),
  trace_id: z.string(),
  parent_id: z.string().nullable(),
  started_at: z.string().nullable(),
  ended_at: z.string().nullable(),
  error: z
    .object({
      message: z.string(),
      data: z.record(z.string(), z.any()).optional(),
    })
    .nullable(),
  span_data: z.record(z.string(), z.any()),
});

type SerializedSpanType = z.infer<typeof serializedSpanBase> & {
  previous_span?: SerializedSpanType;
};

const SerializedSpan: z.ZodType<SerializedSpanType> = serializedSpanBase.extend(
  {
    previous_span: z.lazy(() => SerializedSpan).optional(),
  },
);

const requestUsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
  inputTokensDetails: z.record(z.string(), z.number()).optional(),
  outputTokensDetails: z.record(z.string(), z.number()).optional(),
  endpoint: z.string().optional(),
});

const usageSchema = z.object({
  requests: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  totalTokens: z.number(),
  inputTokensDetails: z.array(z.record(z.string(), z.number())).optional(),
  outputTokensDetails: z.array(z.record(z.string(), z.number())).optional(),
  requestUsageEntries: z.array(requestUsageSchema).optional(),
});

const modelResponseSchema = z.object({
  usage: usageSchema,
  output: z.array(protocol.OutputModelItem),
  responseId: z.string().optional(),
  requestId: z.string().optional(),
  providerData: z.record(z.string(), z.any()).optional(),
});

const itemSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message_output_item'),
    rawItem: protocol.AssistantMessageItem,
    agent: serializedAgentSchema,
  }),
  z.object({
    type: z.literal('tool_search_call_item'),
    rawItem: protocol.ToolSearchCallItem,
    agent: serializedAgentSchema,
  }),
  z.object({
    type: z.literal('tool_search_output_item'),
    rawItem: protocol.ToolSearchOutputItem,
    agent: serializedAgentSchema,
  }),
  z.object({
    type: z.literal('tool_call_item'),
    rawItem: protocol.ToolCallItem.or(protocol.HostedToolCallItem),
    agent: serializedAgentSchema,
  }),
  z.object({
    type: z.literal('tool_call_output_item'),
    rawItem: protocol.FunctionCallResultItem.or(protocol.ComputerCallResultItem)
      .or(protocol.ShellCallResultItem)
      .or(protocol.ApplyPatchCallResultItem)
      .or(protocol.ProgramCallResultItem),
    agent: serializedAgentSchema,
    output: z.string(),
    customData: z.record(z.string(), z.any()).optional(),
    executionStatus: z.literal('executed').optional(),
  }),
  z.object({
    type: z.literal('reasoning_item'),
    rawItem: protocol.ReasoningItem,
    agent: serializedAgentSchema,
  }),
  z.object({
    type: z.literal('compaction_item'),
    rawItem: protocol.CompactionItem,
    agent: serializedAgentSchema,
  }),
  z.object({
    type: z.literal('handoff_call_item'),
    rawItem: protocol.FunctionCallItem,
    agent: serializedAgentSchema,
  }),
  z.object({
    type: z.literal('handoff_output_item'),
    rawItem: protocol.FunctionCallResultItem,
    sourceAgent: serializedAgentSchema,
    targetAgent: serializedAgentSchema,
  }),
  z.object({
    type: z.literal('tool_approval_item'),
    rawItem: protocol.FunctionCallItem.or(protocol.HostedToolCallItem)
      .or(protocol.ComputerUseCallItem)
      .or(protocol.ShellCallItem)
      .or(protocol.ApplyPatchCallItem),
    agent: serializedAgentSchema,
    toolName: z.string().optional(),
    functionToolStateKey: z.string().optional(),
  }),
]);

const serializedTraceSchema = z.object({
  object: z.literal('trace'),
  id: z.string(),
  workflow_name: z.string(),
  group_id: z.string().nullable(),
  metadata: z.record(z.string(), z.any()),
  // Populated only if the trace was created with a per-run tracingApiKey (e.g., Runner.run({ tracing: { apiKey } }))
  // and serialization opts in to include it. By default this is omitted to avoid persisting secrets.
  tracing_api_key: z.string().optional().nullable(),
});

const sandboxSessionStateEnvelopeSchema = z.object({
  version: z.union(
    SUPPORTED_SANDBOX_SESSION_STATE_VERSIONS.map((version) =>
      z.literal(version),
    ) as [z.ZodLiteral<1>, z.ZodLiteral<typeof SANDBOX_SESSION_STATE_VERSION>],
  ),
  backendId: z.string(),
  manifest: z.record(z.string(), z.any()),
  snapshot: z.record(z.string(), z.any()).nullable().optional(),
  snapshotFingerprint: z.string().nullable().optional(),
  snapshotFingerprintVersion: z.string().nullable().optional(),
  workspaceReady: z.boolean(),
  exposedPorts: z.record(z.string(), z.any()).optional(),
  providerState: z.record(z.string(), z.any()),
});

const sandboxSessionEntrySchema = z.object({
  backendId: z.string(),
  currentAgentKey: z.string(),
  currentAgentName: z.string(),
  sessionState: sandboxSessionStateEnvelopeSchema,
  preservedOwnedSession: z.boolean().optional(),
  reuseLiveSession: z.boolean().optional(),
});

const sandboxStateSchema = z.object({
  backendId: z.string(),
  currentAgentKey: z.string(),
  currentAgentName: z.string(),
  sessionState: sandboxSessionStateEnvelopeSchema,
  sessionsByAgent: z.record(z.string(), sandboxSessionEntrySchema),
});

const serializedProcessedResponseSchema = z.object({
  newItems: z.array(itemSchema),
  toolsUsed: z.array(z.string()),
  handoffs: z.array(
    z.object({
      toolCall: z.any(),
      handoff: z.any(),
      targetAgent: serializedAgentSchema.optional(),
    }),
  ),
  functions: z.array(
    z.object({
      toolCall: z.any(),
      tool: z.any(),
    }),
  ),
  functionToolsNotFound: z
    .array(
      z.object({
        toolCall: z.any(),
        toolName: z.string(),
      }),
    )
    .optional(),
  computerActions: z.array(
    z.object({
      toolCall: z.any(),
      computer: z.any(),
    }),
  ),
  shellActions: z
    .array(
      z.object({
        toolCall: z.any(),
        shell: z.any(),
      }),
    )
    .optional(),
  applyPatchActions: z
    .array(
      z.object({
        toolCall: z.any(),
        applyPatch: z.any(),
      }),
    )
    .optional(),
  mcpApprovalRequests: z
    .array(
      z.object({
        requestItem: z.object({
          // protocol.HostedToolCallItem
          rawItem: z.object({
            type: z.literal('hosted_tool_call'),
            name: z.string(),
            arguments: z.string().optional(),
            status: z.string().optional(),
            output: z.string().optional(),
            caller: protocol.ToolCaller.optional(),
            // this always exists but marked as optional for early version compatibility; when releasing 1.0, we can remove the nullable and optional
            providerData: z.record(z.string(), z.any()).nullable().optional(),
          }),
        }),
        // HostedMCPTool
        mcpTool: z.object({
          type: z.literal('hosted_tool'),
          name: z.literal('hosted_mcp'),
          providerData: z.record(z.string(), z.any()),
        }),
      }),
    )
    .optional(),
});

const guardrailFunctionOutputSchema = z.object({
  tripwireTriggered: z.boolean(),
  outputInfo: z.any(),
});

const toolGuardrailBehaviorSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('allow') }),
  z.object({
    type: z.literal('rejectContent'),
    message: z.string(),
  }),
  z.object({ type: z.literal('throwException') }),
]);

const toolGuardrailFunctionOutputSchema = z.object({
  outputInfo: z.any().optional(),
  behavior: toolGuardrailBehaviorSchema,
});

const toolGuardrailMetadataSchema = z.object({
  type: z.union([z.literal('tool_input'), z.literal('tool_output')]),
  name: z.string(),
});

const inputGuardrailResultSchema = z.object({
  guardrail: z.object({
    type: z.literal('input'),
    name: z.string(),
  }),
  output: guardrailFunctionOutputSchema,
});

const outputGuardrailResultSchema = z.object({
  guardrail: z.object({
    type: z.literal('output'),
    name: z.string(),
  }),
  agentOutput: z.any(),
  agent: serializedAgentSchema,
  output: guardrailFunctionOutputSchema,
});

const toolInputGuardrailResultSchema = z.object({
  guardrail: toolGuardrailMetadataSchema.extend({
    type: z.literal('tool_input'),
  }),
  output: toolGuardrailFunctionOutputSchema,
});

const toolOutputGuardrailResultSchema = z.object({
  guardrail: toolGuardrailMetadataSchema.extend({
    type: z.literal('tool_output'),
  }),
  output: toolGuardrailFunctionOutputSchema,
});

const approvalRecordSchema = z.object({
  approved: z.array(z.string()).or(z.boolean()),
  rejected: z.array(z.string()).or(z.boolean()),
  messages: z.record(z.string(), z.string()).optional(),
  stickyRejectMessage: z.string().optional(),
});

const canonicalFunctionToolStateKeySchema = z
  .string()
  .refine(
    (value) => getFunctionToolLegacyStateKeyFromStateKey(value) !== undefined,
    'Function approval keys must use a canonical category-aware identity.',
  );

const functionApprovalsSchema = z.array(
  z.object({
    agentIdentity: z.string(),
    approvals: z.record(
      canonicalFunctionToolStateKeySchema,
      approvalRecordSchema,
    ),
  }),
);

const functionApprovalContextSchema = z.object({
  functionApprovals: functionApprovalsSchema.optional(),
  legacyFunctionApprovals: z
    .record(z.string(), approvalRecordSchema)
    .optional(),
});

export const SerializedRunState = z.object({
  $schemaVersion,
  currentTurn: z.number(),
  currentAgent: serializedAgentSchema,
  originalInput: z.string().or(z.array(protocol.ModelItem)),
  modelResponses: z.array(modelResponseSchema),
  context: z.object({
    usage: usageSchema,
    approvals: z.record(z.string(), approvalRecordSchema),
    functionApprovals: functionApprovalsSchema.optional(),
    legacyFunctionApprovals: z
      .record(z.string(), approvalRecordSchema)
      .optional(),
    context: z.record(z.string(), z.any()),
    toolInput: z.any().optional(),
  }),
  toolUseTracker: z.record(z.string(), z.array(z.string())),
  maxTurns: z.number().nullable(),
  currentAgentSpan: SerializedSpan.nullable().optional(),
  noActiveAgentRun: z.boolean(),
  inputGuardrailResults: z.array(inputGuardrailResultSchema),
  outputGuardrailResults: z.array(outputGuardrailResultSchema),
  toolInputGuardrailResults: z
    .array(toolInputGuardrailResultSchema)
    .optional()
    .default([]),
  toolOutputGuardrailResults: z
    .array(toolOutputGuardrailResultSchema)
    .optional()
    .default([]),
  currentTurnInProgress: z.boolean().optional(),
  currentStep: nextStepSchema.optional(),
  lastModelResponse: modelResponseSchema.optional(),
  generatedItems: z.array(itemSchema),
  pendingAgentToolRuns: z.record(z.string(), z.string()).optional().default({}),
  pendingAgentToolRunAliases: z
    .record(z.string(), z.string())
    .optional()
    .default({}),
  lastProcessedResponse: serializedProcessedResponseSchema.optional(),
  currentTurnPersistedItemCount: z.number().int().min(0).optional(),
  currentTurnDeferredSessionItemIndexes: z
    .array(z.number().int().min(0))
    .optional(),
  currentTurnBlockedSessionStartIndex: z.number().int().min(0).optional(),
  currentTurnExecutedWithSessionBinding: z.literal(true).optional(),
  currentTurnSessionInputItems: z.array(protocol.ModelItem).optional(),
  pendingSessionHistoryTransaction:
    pendingSessionHistoryTransactionSchema.optional(),
  pendingLegacyCompactionSessionItems: z.array(protocol.ModelItem).optional(),
  conversationId: z.string().optional(),
  previousResponseId: z.string().optional(),
  reasoningItemIdPolicy: z.enum(['preserve', 'omit']).optional(),
  trace: serializedTraceSchema.nullable(),
  sandbox: sandboxStateSchema.optional(),
});

export type FinalOutputSource = 'error_handler' | 'turn_resolution';

type ToolSearchRuntimeToolEntry<TContext = UnknownContext> = {
  order: number;
  tools: Tool<TContext>[];
};

type ToolSearchRuntimeToolState<TContext = UnknownContext> = {
  keyedEntries: Map<string, ToolSearchRuntimeToolEntry<TContext>>;
  routedOwners: Map<
    string,
    {
      entry: ToolSearchRuntimeToolEntry<TContext>;
      tool: Tool<TContext>;
      toolIndex: number;
    }
  >;
  nextOrder: number;
};

/**
 * Serializable snapshot of an agent's run, including context, usage and trace.
 * While this class has publicly writable properties (prefixed with `_`), they are not meant to be
 * used directly. To read these properties, use the `RunResult` instead.
 *
 * Manipulation of the state directly can lead to unexpected behavior and should be avoided.
 * Instead, use the `approve` and `reject` methods to interact with the state.
 */
export class RunState<TContext, TAgent extends Agent<any, any>> {
  /**
   * Current turn number in the conversation.
   */
  public _currentTurn = 0;
  /**
   * Whether the current turn has already been counted (useful when resuming mid-turn).
   */
  public _currentTurnInProgress = false;
  /**
   * The agent currently handling the conversation.
   */
  public _currentAgent: TAgent;
  /**
   * The root agent that started the run.
   */
  #startingAgent: TAgent;
  /**
   * Original user input prior to any processing.
   */
  public _originalInput: string | AgentInputItem[];
  /**
   * Responses from the model so far.
   */
  public _modelResponses: ModelResponse[];
  /**
   * Conversation identifier when the server manages conversation history.
   */
  public _conversationId: string | undefined;
  /**
   * Latest response identifier returned by the server for server-managed conversations.
   */
  public _previousResponseId: string | undefined;
  /**
   * Runtime options that control how run items are converted into model turn input.
   * This value is serialized so resumed runs keep the same turn-input behavior.
   */
  public _reasoningItemIdPolicy: ReasoningItemIdPolicy | undefined;
  /**
   * Effective model settings used for the most recent model call.
   */
  public _lastModelSettings: ModelSettings | undefined;
  /**
   * Active tracing span for the current agent if tracing is enabled.
   */
  public _currentAgentSpan: Span<AgentSpanData> | undefined;
  /**
   * Run context tracking approvals, usage, and other metadata.
   */
  public _context: RunContext<TContext>;
  /**
   * Runtime-only metadata for the current nested agent-tool invocation.
   */
  public _agentToolInvocation: AgentToolInvocation | undefined;

  /**
   * The usage aggregated for this run. This includes per-request breakdowns when available.
   */
  get usage(): Usage {
    return this._context.usage;
  }
  /**
   * Tracks what tools each agent has used.
   */
  public _toolUseTracker: AgentToolUseTracker;
  /**
   * Serialized pending nested agent runs keyed by tool name and call id.
   */
  public _pendingAgentToolRuns: Map<string, string>;
  /**
   * Legacy pending-run keys mapped to their canonical category-aware keys.
   */
  public _pendingAgentToolRunAliases: Map<string, string>;
  /**
   * Items generated by the agent during the run.
   */
  public _generatedItems: RunItem[];
  /**
   * Number of `_generatedItems` already flushed to session storage for the current turn.
   *
   * Persisting the entire turn on every save would duplicate responses and tool outputs.
   * Instead, `saveToSession` appends only the delta since the previous write. This counter
   * tracks how many generated run items from *this turn* were already written so the next
   * save can slice off only the new entries. When a turn is interrupted (e.g., awaiting tool
   * approval) and later resumed, we rewind the counter before continuing so the pending tool
   * output still gets stored.
   */
  public _currentTurnPersistedItemCount: number;
  /**
   * Current-turn item indexes intentionally deferred when a blocked output persisted only a
   * replay-safe subset. A later accepted resume replaces the sparse suffix in original order.
   */
  public _currentTurnDeferredSessionItemIndexes: Set<number>;
  /**
   * First current-turn index governed by the sparse blocked-output session suffix.
   */
  public _currentTurnBlockedSessionStartIndex: number | undefined;
  /**
   * Logical session bound to the current turn before a transaction-aware tool effect can occur.
   */
  public _currentTurnSessionHistoryTransactionSessionId: string | undefined;
  /**
   * Effective reasoning-item ID policy frozen for the current transaction-aware session turn.
   */
  public _currentTurnSessionReasoningItemIdPolicy:
    ReasoningItemIdPolicy | undefined;
  /**
   * Normalized session input frozen before the current transaction-aware model request.
   */
  public _currentTurnSessionHistoryTransactionInputItems:
    AgentInputItem[] | undefined;
  /**
   * Whether the current live batch may later replace its sparse suffix with accepted output.
   */
  public _currentTurnSessionHistoryTransactionCanReplaceAcceptedOutput:
    boolean | undefined;
  /**
   * Current step reconstructed from serialized state. This reference is not serialized and is
   * cleared implicitly when the live runner installs another step.
   */
  public _serializedCurrentStep: NextStep | undefined;
  /**
   * Stable per-run identifier used to derive idempotent session history transaction IDs.
   */
  public _sessionHistoryTransactionId: string;
  /**
   * Transaction reconstruction data awaiting confirmation from the session backend. Its
   * generated-item indexes, operation identity, and post-commit bookkeeping remain stable across
   * retries on the same live RunState; input stays in the separately frozen current-turn snapshot.
   */
  public _pendingSessionHistoryTransaction:
    PendingSessionHistoryTransaction | undefined;
  /**
   * Compaction marker and persisted suffix that an ordinary session must reconcile once after a
   * pre-1.16 snapshot is restored. The field remains serialized until reconciliation succeeds.
   */
  public _pendingLegacyCompactionSessionItems: AgentInputItem[] | undefined;
  /**
   * Maximum allowed turns before forcing termination.
   */
  public _maxTurns: number | null;
  /**
   * Whether the run has an active agent step in progress.
   */
  public _noActiveAgentRun = true;
  /**
   * Last model response for the previous turn.
   */
  public _lastTurnResponse: ModelResponse | undefined;
  /**
   * Results from input guardrails applied to the run.
   */
  public _inputGuardrailResults: InputGuardrailResult[];
  /**
   * Results from output guardrails applied to the run.
   */
  public _outputGuardrailResults: OutputGuardrailResult<any, any>[];
  /**
   * Results from tool input guardrails applied during tool execution.
   */
  public _toolInputGuardrailResults: ToolInputGuardrailResult[];
  /**
   * Results from tool output guardrails applied during tool execution.
   */
  public _toolOutputGuardrailResults: ToolOutputGuardrailResult[];
  /**
   * Next step computed for the agent to take.
   */
  public _currentStep: NextStep | undefined = undefined;
  /**
   * Indicates how the final output was produced for the current run.
   * This value is not serialized.
   */
  public _finalOutputSource: FinalOutputSource | undefined;
  /**
   * Parsed model response after applying guardrails and tools.
   */
  public _lastProcessedResponse: ProcessedResponse<TContext> | undefined =
    undefined;
  /**
   * Trace associated with this run if tracing is enabled.
   */
  public _trace: Trace | null = null;
  /**
   * Runtime-only tool_search-loaded tools, scoped by agent object and preserved across turns for
   * the lifetime of this in-memory run.
   */
  public _toolSearchRuntimeToolsByAgent = new Map<
    Agent<any, any>,
    ToolSearchRuntimeToolState<TContext>
  >();
  /**
   * Persisted sandbox session metadata for sandbox-agent resume.
   */
  public _sandbox: z.infer<typeof sandboxStateSchema> | undefined = undefined;

  constructor(
    context: RunContext<TContext>,
    originalInput: string | AgentInputItem[],
    startingAgent: TAgent,
    maxTurns: number | null,
  ) {
    this._context = context;
    this._agentToolInvocation = undefined;
    this._originalInput = structuredClone(originalInput);
    this._modelResponses = [];
    this._currentAgentSpan = undefined;
    this._currentAgent = startingAgent;
    this.#startingAgent = startingAgent;
    this._reasoningItemIdPolicy = undefined;
    this._toolUseTracker = new AgentToolUseTracker();
    this._pendingAgentToolRuns = new Map();
    this._pendingAgentToolRunAliases = new Map();
    this._generatedItems = [];
    this._currentTurnPersistedItemCount = 0;
    this._currentTurnDeferredSessionItemIndexes = new Set();
    this._currentTurnBlockedSessionStartIndex = undefined;
    this._currentTurnSessionHistoryTransactionSessionId = undefined;
    this._currentTurnSessionReasoningItemIdPolicy = undefined;
    this._currentTurnSessionHistoryTransactionInputItems = undefined;
    this._currentTurnSessionHistoryTransactionCanReplaceAcceptedOutput =
      undefined;
    this._serializedCurrentStep = undefined;
    this._sessionHistoryTransactionId = randomUUID();
    this._pendingSessionHistoryTransaction = undefined;
    this._pendingLegacyCompactionSessionItems = undefined;
    this._maxTurns = maxTurns;
    this._inputGuardrailResults = [];
    this._outputGuardrailResults = [];
    this._toolInputGuardrailResults = [];
    this._toolOutputGuardrailResults = [];
    this._trace = getCurrentTrace();
  }

  /**
   * Updates server-managed conversation identifiers as a single operation.
   */
  public setConversationContext(
    conversationId?: string,
    previousResponseId?: string,
  ): void {
    this._conversationId = conversationId;
    this._previousResponseId = previousResponseId;
  }

  /**
   * Updates runtime options for converting run items into turn input.
   */
  public setReasoningItemIdPolicy(policy?: ReasoningItemIdPolicy): void {
    this._reasoningItemIdPolicy = policy;
  }

  /**
   * Updates the agent span associated with the current run.
   */
  public setCurrentAgentSpan(span?: Span<AgentSpanData>): void {
    this._currentAgentSpan = span;
  }

  /**
   * Clears the restored trace and current agent span from this run state.
   *
   * Use this before resuming a serialized state when the resumed run should attach
   * to the current ambient trace instead of the trace persisted in the state.
   */
  public clearTrace(): void {
    this._trace = null;
    this._currentAgentSpan = undefined;
  }

  private getOrCreateToolSearchRuntimeToolState(
    agent: Agent<any, any>,
  ): ToolSearchRuntimeToolState<TContext> {
    let state = this._toolSearchRuntimeToolsByAgent.get(agent);
    if (!state) {
      state = {
        keyedEntries: new Map(),
        routedOwners: new Map(),
        nextOrder: 0,
      };
      this._toolSearchRuntimeToolsByAgent.set(agent, state);
    }
    return state;
  }

  public recordToolSearchRuntimeTools(
    agent: Agent<any, any>,
    toolSearchOutput: protocol.ToolSearchOutputItem,
    tools: Tool<TContext>[],
  ): void {
    const runtimeState = this.getOrCreateToolSearchRuntimeToolState(agent);
    const entry: ToolSearchRuntimeToolEntry<TContext> = {
      order: runtimeState.nextOrder++,
      tools,
    };
    const replacementKey = getToolSearchOutputReplacementKey(toolSearchOutput);
    if (replacementKey) {
      const previousEntry = runtimeState.keyedEntries.get(replacementKey);
      if (previousEntry) {
        for (const [routingKey, owner] of runtimeState.routedOwners) {
          if (owner.entry === previousEntry) {
            runtimeState.routedOwners.delete(routingKey);
          }
        }
      }
      runtimeState.keyedEntries.set(replacementKey, entry);
    }

    for (const [toolIndex, tool] of tools.entries()) {
      const routingKey = getToolSearchRuntimeRoutingKey(tool);
      if (!routingKey) {
        continue;
      }
      runtimeState.routedOwners.set(routingKey, {
        entry,
        tool,
        toolIndex,
      });
    }
  }

  public getToolSearchRuntimeToolsForOutput(
    agent: Agent<any, any>,
    toolSearchOutput: protocol.ToolSearchOutputItem,
  ): Tool<TContext>[] {
    const replacementKey = getToolSearchOutputReplacementKey(toolSearchOutput);
    if (!replacementKey) {
      return [];
    }
    const runtimeState = this._toolSearchRuntimeToolsByAgent.get(agent);
    const entry = runtimeState?.keyedEntries.get(replacementKey);
    if (!runtimeState || !entry) {
      return [];
    }
    return entry.tools.filter((tool) => {
      const routingKey = getToolSearchRuntimeRoutingKey(tool);
      return (
        typeof routingKey === 'string' &&
        runtimeState.routedOwners.get(routingKey)?.entry === entry
      );
    });
  }

  public getToolSearchRuntimeTools(agent: Agent<any, any>): Tool<TContext>[] {
    const runtimeState = this._toolSearchRuntimeToolsByAgent.get(agent);
    if (!runtimeState) {
      return [];
    }

    return [...runtimeState.routedOwners.values()]
      .sort(
        (left, right) =>
          left.entry.order - right.entry.order ||
          left.toolIndex - right.toolIndex,
      )
      .map((owner) => owner.tool);
  }

  /**
   * Switches the active agent handling the run.
   */
  public setCurrentAgent(agent: TAgent): void {
    this._currentAgent = agent;
  }

  /**
   * Returns the agent currently handling the run.
   */
  get currentAgent(): TAgent {
    return this._currentAgent;
  }

  /**
   * Resets the counter that tracks how many items were persisted for the current turn.
   */
  public resetTurnPersistence(): void {
    this._currentTurnPersistedItemCount = 0;
    this._currentTurnDeferredSessionItemIndexes.clear();
  }

  /**
   * Rewinds the persisted item counter when pending approvals require re-writing outputs.
   */
  public rewindTurnPersistence(count: number): void {
    if (count <= 0) {
      return;
    }
    this._currentTurnPersistedItemCount = Math.max(
      0,
      this._currentTurnPersistedItemCount - count,
    );
  }

  /**
   * The history of the agent run. This includes the input items and the new items generated during the run.
   *
   * This can be used as inputs for the next agent run.
   */
  get history(): AgentInputItem[] {
    return getTurnInput(
      this._originalInput,
      this._generatedItems,
      this._reasoningItemIdPolicy,
    );
  }

  /**
   * Returns all interruptions if the current step is an interruption otherwise returns an empty array.
   */
  getInterruptions(): RunToolApprovalItem[] {
    if (this._currentStep?.type !== 'next_step_interruption') {
      return [];
    }
    const interruptions = this._currentStep.data.interruptions;
    return Array.isArray(interruptions)
      ? (interruptions as RunToolApprovalItem[])
      : [];
  }

  private getPendingAgentToolRunKey(toolName: string, callId: string): string {
    return `${toolName}:${callId}`;
  }

  private resolvePendingAgentToolRunKey(
    toolName: string,
    callId: string,
  ): string {
    const key = this.getPendingAgentToolRunKey(toolName, callId);
    return this._pendingAgentToolRunAliases.get(key) ?? key;
  }

  getPendingAgentToolRun(toolName: string, callId: string): string | undefined {
    return this._pendingAgentToolRuns.get(
      this.resolvePendingAgentToolRunKey(toolName, callId),
    );
  }

  hasPendingAgentToolRun(toolName: string, callId: string): boolean {
    return this._pendingAgentToolRuns.has(
      this.resolvePendingAgentToolRunKey(toolName, callId),
    );
  }

  setPendingAgentToolRun(
    toolName: string,
    callId: string,
    serializedState: string,
    aliases: readonly string[] = [],
  ) {
    const canonicalKey = this.resolvePendingAgentToolRunKey(toolName, callId);
    this._pendingAgentToolRuns.set(canonicalKey, serializedState);
    for (const alias of aliases) {
      const aliasKey = this.getPendingAgentToolRunKey(alias, callId);
      if (aliasKey === canonicalKey) {
        continue;
      }
      this._pendingAgentToolRuns.delete(aliasKey);
      this._pendingAgentToolRunAliases.set(aliasKey, canonicalKey);
    }
  }

  clearPendingAgentToolRun(toolName: string, callId: string) {
    const requestedKey = this.getPendingAgentToolRunKey(toolName, callId);
    const canonicalKey = this.resolvePendingAgentToolRunKey(toolName, callId);
    this._pendingAgentToolRuns.delete(canonicalKey);
    this._pendingAgentToolRuns.delete(requestedKey);
    for (const [aliasKey, targetKey] of this._pendingAgentToolRunAliases) {
      if (aliasKey === requestedKey || targetKey === canonicalKey) {
        this._pendingAgentToolRuns.delete(aliasKey);
        this._pendingAgentToolRunAliases.delete(aliasKey);
      }
    }
  }

  /**
   * Approves a tool call requested by the agent through an interruption and approval item request.
   *
   * To approve the request use this method and then run the agent again with the same state object
   * to continue the execution.
   *
   * By default it will only approve the current tool call. To allow the tool to be used multiple
   * times throughout the run, set the `alwaysApprove` option to `true`.
   *
   * @param approvalItem - The tool call approval item to approve.
   * @param options - Options for the approval.
   * @param options.alwaysApprove - Approve this tool for all future calls in this run.
   */
  approve(
    approvalItem: RunToolApprovalItem,
    options: { alwaysApprove?: boolean } = {
      alwaysApprove: false,
    },
  ) {
    this._context.approveTool(approvalItem, options);
  }

  /**
   * Rejects a tool call requested by the agent through an interruption and approval item request.
   *
   * To reject the request use this method and then run the agent again with the same state object
   * to continue the execution.
   *
   * By default it will only reject the current tool call. To reject the tool for all future
   * calls throughout the run, set the `alwaysReject` option to `true`.
   *
   * When `message` is provided, it is used as the rejection text sent to the model.
   * Otherwise, `toolErrorFormatter` (if configured) or the SDK default is used.
   *
   * @param approvalItem - The tool call approval item to reject.
   * @param options - Options for the rejection.
   * @param options.alwaysReject - Reject this tool for all future calls in this run.
   * @param options.message - The rejection text sent to the model.
   *   If not provided, `toolErrorFormatter` (if configured) or the SDK default is used.
   */
  reject(
    approvalItem: RunToolApprovalItem,
    options: { alwaysReject?: boolean; message?: string } = {
      alwaysReject: false,
    },
  ) {
    this._context.rejectTool(approvalItem, options);
  }

  /**
   * Serializes the run state to a JSON object.
   *
   * This method is used to serialize the run state to a JSON object that can be used to
   * resume the run later.
   *
   * @returns The serialized run state.
   */
  /**
   * Serializes the run state. By default, tracing API keys are omitted to prevent
   * accidental persistence of secrets. Pass `includeTracingApiKey: true` only when you
   * intentionally need to migrate a run along with its tracing credentials (e.g., to
   * rehydrate in a separate process that lacks the original environment variables).
   */
  toJSON(
    options: { includeTracingApiKey?: boolean } = {},
  ): z.infer<typeof SerializedRunState> {
    const agentIdentity = buildAgentIdentityMap(this.#startingAgent);

    const includeTracingApiKey = options.includeTracingApiKey === true;
    const contextJson = this._context._toJSONForRunState(agentIdentity.byAgent);
    const output = {
      $schemaVersion: CURRENT_SCHEMA_VERSION,
      currentTurn: this._currentTurn,
      currentAgent: serializeAgentReference(
        this._currentAgent,
        agentIdentity.byAgent,
      ),
      originalInput: this._originalInput as any,
      modelResponses: this._modelResponses.map((response) => {
        return {
          usage: {
            requests: response.usage.requests,
            inputTokens: response.usage.inputTokens,
            outputTokens: response.usage.outputTokens,
            totalTokens: response.usage.totalTokens,
            inputTokensDetails: response.usage.inputTokensDetails,
            outputTokensDetails: response.usage.outputTokensDetails,
            ...(response.usage.requestUsageEntries &&
            response.usage.requestUsageEntries.length > 0
              ? {
                  requestUsageEntries: response.usage.requestUsageEntries.map(
                    (entry) => ({
                      inputTokens: entry.inputTokens,
                      outputTokens: entry.outputTokens,
                      totalTokens: entry.totalTokens,
                      inputTokensDetails: entry.inputTokensDetails,
                      outputTokensDetails: entry.outputTokensDetails,
                      ...(entry.endpoint ? { endpoint: entry.endpoint } : {}),
                    }),
                  ),
                }
              : {}),
          },
          output: response.output as any,
          responseId: response.responseId,
          requestId: response.requestId,
          providerData: response.providerData,
        };
      }),
      context: contextJson,
      toolUseTracker: this._toolUseTracker.toJSON({
        agentIdentityKeys: agentIdentity.byAgent,
      }),
      maxTurns: this._maxTurns,
      currentAgentSpan: this._currentAgentSpan?.toJSON() as any,
      noActiveAgentRun: this._noActiveAgentRun,
      currentTurnInProgress: this._currentTurnInProgress,
      inputGuardrailResults: this._inputGuardrailResults,
      outputGuardrailResults: this._outputGuardrailResults.map((r) => ({
        ...r,
        agent: serializeAgentReference(r.agent, agentIdentity.byAgent),
      })),
      toolInputGuardrailResults: this._toolInputGuardrailResults,
      toolOutputGuardrailResults: this._toolOutputGuardrailResults,
      currentStep: serializeCurrentStep(
        this._currentStep,
        agentIdentity.byAgent,
      ) as any,
      lastModelResponse: this._lastTurnResponse as any,
      generatedItems: this._generatedItems.map(
        (item) => serializeRunItem(item, agentIdentity.byAgent) as any,
      ),
      pendingAgentToolRuns: Object.fromEntries(
        this._pendingAgentToolRuns.entries(),
      ),
      pendingAgentToolRunAliases: Object.fromEntries(
        this._pendingAgentToolRunAliases.entries(),
      ),
      currentTurnPersistedItemCount: this._currentTurnPersistedItemCount,
      currentTurnDeferredSessionItemIndexes:
        this._currentTurnDeferredSessionItemIndexes.size > 0
          ? [...this._currentTurnDeferredSessionItemIndexes].sort(
              (left, right) => left - right,
            )
          : undefined,
      currentTurnBlockedSessionStartIndex:
        this._currentTurnBlockedSessionStartIndex,
      currentTurnExecutedWithSessionBinding:
        this._currentTurnSessionHistoryTransactionSessionId !== undefined &&
        hasBlockedOutputExecutionEffect(
          this._generatedItems,
          this._currentTurnPersistedItemCount,
        )
          ? true
          : undefined,
      currentTurnSessionInputItems:
        this._currentTurnSessionHistoryTransactionSessionId === undefined &&
        this._currentTurnSessionHistoryTransactionInputItems !== undefined &&
        this._currentTurnSessionHistoryTransactionInputItems.length > 0 &&
        hasBlockedOutputExecutionEffect(
          this._generatedItems,
          this._currentTurnPersistedItemCount,
        )
          ? this._currentTurnSessionHistoryTransactionInputItems
          : undefined,
      pendingSessionHistoryTransaction: this._pendingSessionHistoryTransaction,
      pendingLegacyCompactionSessionItems:
        this._pendingLegacyCompactionSessionItems,
      lastProcessedResponse: this._lastProcessedResponse
        ? (serializeProcessedResponse(
            this._lastProcessedResponse,
            agentIdentity.byAgent,
          ) as any)
        : undefined,
      conversationId: this._conversationId,
      previousResponseId: this._previousResponseId,
      reasoningItemIdPolicy: this._reasoningItemIdPolicy,
      trace: this._trace
        ? (this._trace.toJSON({ includeTracingApiKey }) as any)
        : null,
      sandbox: this._sandbox,
    };

    // parsing the schema to ensure the output is valid for reparsing
    const parsed = SerializedRunState.safeParse(output);
    if (!parsed.success) {
      throw new SystemError(
        `Failed to serialize run state. ${parsed.error.message}`,
      );
    }

    return parsed.data;
  }

  /**
   * Serializes the run state to a string.
   *
   * This method is used to serialize the run state to a string that can be used to
   * resume the run later.
   *
   * @returns The serialized run state.
   */
  toString(options: { includeTracingApiKey?: boolean } = {}) {
    return JSON.stringify(this.toJSON(options));
  }

  /**
   * Deserializes a run state from a string.
   *
   * This method is used to deserialize a run state from a string that was serialized using the
   * `toString` method.
   */
  static async fromString<TContext, TAgent extends Agent<any, any>>(
    initialAgent: TAgent,
    str: string,
  ): Promise<RunState<TContext, TAgent>> {
    return buildRunStateFromString(initialAgent, str);
  }

  static async fromStringWithContext<TContext, TAgent extends Agent<any, any>>(
    initialAgent: TAgent,
    str: string,
    context: RunContext<TContext>,
    options: { contextStrategy?: ContextOverrideStrategy } = {},
  ): Promise<RunState<TContext, TAgent>> {
    return buildRunStateFromString(initialAgent, str, {
      contextOverride: context,
      contextStrategy: options.contextStrategy,
    });
  }
}

async function buildRunStateFromString<
  TContext,
  TAgent extends Agent<any, any>,
>(
  initialAgent: TAgent,
  str: string,
  options: RunStateContextOverrideOptions<TContext> = {},
): Promise<RunState<TContext, TAgent>> {
  const [parsingError, jsonResult] = await safeExecute(() => JSON.parse(str));
  if (parsingError) {
    throw new UserError(
      `Failed to parse run state. ${parsingError instanceof Error ? parsingError.message : String(parsingError)}`,
    );
  }

  const currentSchemaVersion = jsonResult.$schemaVersion;
  if (!currentSchemaVersion) {
    throw new UserError('Run state is missing schema version');
  }
  if (
    !SUPPORTED_SCHEMA_VERSIONS.includes(
      currentSchemaVersion as SupportedSchemaVersion,
    )
  ) {
    throw new UserError(
      `Run state schema version ${currentSchemaVersion} is not supported. Please use version ${CURRENT_SCHEMA_VERSION}.`,
    );
  }
  validateFunctionApprovalEnvelope(
    currentSchemaVersion as SupportedSchemaVersion,
    jsonResult,
  );
  const stateJson = SerializedRunState.parse(jsonResult);
  assertSchemaVersionSupportsToolSearch(
    currentSchemaVersion as SupportedSchemaVersion,
    stateJson,
  );
  assertSchemaVersionSupportsCustomData(
    currentSchemaVersion as SupportedSchemaVersion,
    stateJson,
  );
  assertSchemaVersionSupportsProgrammaticToolCalling(
    currentSchemaVersion as SupportedSchemaVersion,
    stateJson,
  );
  assertSchemaVersionSupportsSandboxSessionEnvelope(
    currentSchemaVersion as SupportedSchemaVersion,
    stateJson,
  );
  assertSchemaVersionSupportsCompactionItems(
    currentSchemaVersion as SupportedSchemaVersion,
    stateJson,
  );
  assertSchemaVersionSupportsOutputGuardrailSessionPersistence(
    currentSchemaVersion as SupportedSchemaVersion,
    stateJson,
  );
  const normalizedState = rehydrateLegacyCompactionRunItems(
    currentSchemaVersion as SupportedSchemaVersion,
    stateJson,
  );
  const state = await buildRunStateFromJson(
    initialAgent,
    normalizedState.stateJson,
    options,
  );
  if (normalizedState.sessionReconciliation) {
    const { generatedInsertionIndex, previousPersistedItemCount } =
      normalizedState.sessionReconciliation;
    state._pendingLegacyCompactionSessionItems = extractOutputItemsFromRunItems(
      state._generatedItems.slice(
        generatedInsertionIndex,
        previousPersistedItemCount + 1,
      ),
    );
    state._currentTurnPersistedItemCount = previousPersistedItemCount + 1;
  }
  return state;
}

function validateFunctionApprovalEnvelope(
  schemaVersion: SupportedSchemaVersion,
  stateJson: unknown,
): void {
  if (!stateJson || typeof stateJson !== 'object') {
    return;
  }
  const context = (stateJson as { context?: unknown }).context;
  if (!context || typeof context !== 'object') {
    return;
  }
  const hasFunctionApprovals = Object.prototype.hasOwnProperty.call(
    context,
    'functionApprovals',
  );
  const hasLegacyFunctionApprovals = Object.prototype.hasOwnProperty.call(
    context,
    'legacyFunctionApprovals',
  );
  if (!hasFunctionApprovals && !hasLegacyFunctionApprovals) {
    return;
  }
  if (!schemaVersionSupportsV116State(schemaVersion)) {
    throw new UserError(
      `Run state schema version ${schemaVersion} does not support owner-scoped function approvals. Please reserialize the run state with schema ${CURRENT_SCHEMA_VERSION}.`,
    );
  }
  if (!functionApprovalContextSchema.safeParse(context).success) {
    throw new UserError(
      'Failed to parse owner-scoped function approvals because their structure does not match the supported schema.',
    );
  }
}

function assertSchemaVersionSupportsToolSearch(
  schemaVersion: SupportedSchemaVersion,
  stateJson: z.infer<typeof SerializedRunState>,
): void {
  if (
    schemaVersion === '1.8' ||
    schemaVersion === '1.9' ||
    schemaVersion === '1.10' ||
    schemaVersion === '1.11' ||
    schemaVersion === '1.12' ||
    schemaVersion === '1.13' ||
    schemaVersion === '1.14' ||
    schemaVersion === '1.15' ||
    schemaVersion === '1.16' ||
    schemaVersion === CURRENT_SCHEMA_VERSION
  ) {
    return;
  }

  if (!containsSerializedToolSearchState(stateJson)) {
    return;
  }

  throw new UserError(
    `Run state schema version ${schemaVersion} does not support tool_search items. Please reserialize the run state with schema ${CURRENT_SCHEMA_VERSION}.`,
  );
}

function assertSchemaVersionSupportsCustomData(
  schemaVersion: SupportedSchemaVersion,
  stateJson: z.infer<typeof SerializedRunState>,
): void {
  if (
    schemaVersion === '1.13' ||
    schemaVersion === '1.14' ||
    schemaVersion === '1.15' ||
    schemaVersion === '1.16' ||
    schemaVersion === CURRENT_SCHEMA_VERSION
  ) {
    return;
  }

  if (!containsSerializedToolOutputCustomData(stateJson)) {
    return;
  }

  throw new UserError(
    `Run state schema version ${schemaVersion} does not support tool output customData. Please reserialize the run state with schema ${CURRENT_SCHEMA_VERSION}.`,
  );
}

function schemaVersionSupportsAgentIdentity(
  schemaVersion: SupportedSchemaVersion,
): boolean {
  return (
    schemaVersion === '1.10' ||
    schemaVersion === '1.11' ||
    schemaVersion === '1.12' ||
    schemaVersion === '1.13' ||
    schemaVersion === '1.14' ||
    schemaVersion === '1.15' ||
    schemaVersion === '1.16' ||
    schemaVersion === CURRENT_SCHEMA_VERSION
  );
}

function assertSchemaVersionSupportsProgrammaticToolCalling(
  schemaVersion: SupportedSchemaVersion,
  stateJson: z.infer<typeof SerializedRunState>,
): void {
  if (
    schemaVersion === '1.14' ||
    schemaVersion === '1.15' ||
    schemaVersion === '1.16' ||
    schemaVersion === CURRENT_SCHEMA_VERSION
  ) {
    return;
  }

  if (!containsProgrammaticToolCallingState(stateJson)) {
    return;
  }

  throw new UserError(
    `Run state schema version ${schemaVersion} does not support Programmatic Tool Calling items. Please reserialize the run state with schema ${CURRENT_SCHEMA_VERSION}.`,
  );
}

function assertSchemaVersionSupportsSandboxSessionEnvelope(
  schemaVersion: SupportedSchemaVersion,
  stateJson: z.infer<typeof SerializedRunState>,
): void {
  if (
    schemaVersion === '1.15' ||
    schemaVersionSupportsV116State(schemaVersion) ||
    !stateJson.sandbox
  ) {
    return;
  }

  const envelopes = [
    stateJson.sandbox.sessionState,
    ...Object.values(stateJson.sandbox.sessionsByAgent).map(
      (entry) => entry.sessionState,
    ),
  ];
  if (
    envelopes.every(
      (envelope) => envelope.version !== SANDBOX_SESSION_STATE_VERSION,
    )
  ) {
    return;
  }

  throw new UserError(
    `Run state schema version ${schemaVersion} does not support sandbox session state version ${SANDBOX_SESSION_STATE_VERSION}. Please reserialize the run state with schema ${CURRENT_SCHEMA_VERSION}.`,
  );
}

/**
 * Rejects older schemas that carry the new wrapper. Current snapshots treat generated items as
 * the replay authority because a supported handoff input filter may remove or replace raw model
 * output before it becomes history.
 */
function assertSchemaVersionSupportsCompactionItems(
  schemaVersion: SupportedSchemaVersion,
  stateJson: z.infer<typeof SerializedRunState>,
): void {
  if (schemaVersionSupportsV116State(schemaVersion)) {
    return;
  }

  if (
    !containsSerializedCompactionRunItems(stateJson) &&
    stateJson.pendingLegacyCompactionSessionItems === undefined
  ) {
    return;
  }

  throw new UserError(
    `Run state schema version ${schemaVersion} does not support compaction items. Please reserialize the run state with schema ${CURRENT_SCHEMA_VERSION}.`,
  );
}

function assertSchemaVersionSupportsOutputGuardrailSessionPersistence(
  schemaVersion: SupportedSchemaVersion,
  stateJson: z.infer<typeof SerializedRunState>,
): void {
  if (schemaVersion === CURRENT_SCHEMA_VERSION) {
    validateOutputGuardrailSessionPersistenceState(stateJson);
    return;
  }

  const hasExecutionProvenance = [
    ...stateJson.generatedItems,
    ...(stateJson.lastProcessedResponse?.newItems ?? []),
  ].some(
    (item) =>
      item.type === 'tool_call_output_item' &&
      item.executionStatus !== undefined,
  );
  const hasV117PersistenceEnvelope =
    stateJson.currentTurnDeferredSessionItemIndexes !== undefined ||
    stateJson.currentTurnBlockedSessionStartIndex !== undefined ||
    stateJson.currentTurnExecutedWithSessionBinding !== undefined ||
    stateJson.currentTurnSessionInputItems !== undefined ||
    stateJson.pendingSessionHistoryTransaction !== undefined;
  if (!hasV117PersistenceEnvelope && !hasExecutionProvenance) {
    return;
  }

  throw new UserError(
    `Run state schema version ${schemaVersion} does not support output guardrail session persistence state. Please reserialize the run state with schema ${CURRENT_SCHEMA_VERSION}.`,
  );
}

function validateOutputGuardrailSessionPersistenceState(
  stateJson: z.infer<typeof SerializedRunState>,
): void {
  const persistedItemCount = stateJson.currentTurnPersistedItemCount ?? 0;
  const deferredIndexes = stateJson.currentTurnDeferredSessionItemIndexes ?? [];
  if (
    deferredIndexes.length > 0 ||
    stateJson.currentTurnBlockedSessionStartIndex !== undefined ||
    stateJson.currentTurnExecutedWithSessionBinding === true ||
    stateJson.pendingSessionHistoryTransaction !== undefined
  ) {
    throw new UserError(
      'Serialized output guardrail session transaction authority cannot be resumed safely. Start a new run from the persisted session history.',
    );
  }
  if (persistedItemCount > stateJson.generatedItems.length) {
    throw new UserError(
      'Run state contains unsupported serialized output guardrail session transaction state.',
    );
  }

  const hasUnsupportedExecutionProvenance = [
    ...stateJson.generatedItems,
    ...(stateJson.lastProcessedResponse?.newItems ?? []),
  ].some(
    (item) =>
      item.type === 'tool_call_output_item' &&
      item.executionStatus === 'executed' &&
      item.rawItem.type !== 'function_call_result' &&
      item.rawItem.type !== 'shell_call_output' &&
      item.rawItem.type !== 'computer_call_result' &&
      item.rawItem.type !== 'apply_patch_call_output',
  );
  if (hasUnsupportedExecutionProvenance) {
    throw new UserError(
      'Run state contains execution provenance for an unsupported tool output type.',
    );
  }
}

function containsSerializedCompactionRunItems(
  stateJson: z.infer<typeof SerializedRunState>,
): boolean {
  return (
    containsCompactionRunItems(stateJson.generatedItems) ||
    containsCompactionRunItems(stateJson.lastProcessedResponse?.newItems)
  );
}

function containsCompactionRunItems(
  items: z.infer<typeof itemSchema>[] | undefined,
): boolean {
  return Boolean(items?.some((item) => item.type === 'compaction_item'));
}

function getCompactionSourceResponses(
  stateJson: z.infer<typeof SerializedRunState>,
): z.infer<typeof modelResponseSchema>[] {
  return stateJson.modelResponses.length > 0
    ? stateJson.modelResponses
    : stateJson.lastModelResponse
      ? [stateJson.lastModelResponse]
      : [];
}

function findLatestCompactionSource(
  stateJson: z.infer<typeof SerializedRunState>,
):
  | {
      sourceResponses: z.infer<typeof modelResponseSchema>[];
      responseIndex: number;
      itemIndex: number;
      item: protocol.CompactionItem;
    }
  | undefined {
  const sourceResponses = getCompactionSourceResponses(stateJson);
  for (
    let responseIndex = sourceResponses.length - 1;
    responseIndex >= 0;
    responseIndex -= 1
  ) {
    const output = sourceResponses[responseIndex].output;
    for (let itemIndex = output.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = output[itemIndex];
      if (item.type === 'compaction') {
        return { sourceResponses, responseIndex, itemIndex, item };
      }
    }
  }
  return undefined;
}

/**
 * Older writers kept raw compaction output but dropped its RunItem wrapper. Restore the latest
 * marker before resuming because it carries the context required for the next model window.
 */
type LegacyCompactionRehydration = {
  stateJson: z.infer<typeof SerializedRunState>;
  sessionReconciliation?: {
    generatedInsertionIndex: number;
    previousPersistedItemCount: number;
  };
};

function rehydrateLegacyCompactionRunItems(
  schemaVersion: SupportedSchemaVersion,
  stateJson: z.infer<typeof SerializedRunState>,
): LegacyCompactionRehydration {
  if (schemaVersionSupportsV116State(schemaVersion)) {
    return { stateJson };
  }

  const latestCompaction = findLatestCompactionSource(stateJson);
  if (!latestCompaction) {
    return { stateJson };
  }

  const {
    sourceResponses,
    responseIndex: sourceResponseIndex,
    itemIndex: compactionIndex,
    item: compactionItem,
  } = latestCompaction;
  const sourceResponse = sourceResponses[sourceResponseIndex];
  const isLatestSourceResponse =
    sourceResponseIndex === sourceResponses.length - 1;
  const processedItems = isLatestSourceResponse
    ? stateJson.lastProcessedResponse?.newItems
    : undefined;
  const optionalLatestFunctionCallIndices =
    getOmittedLegacyHandoffFunctionCallIndices(
      sourceResponses.at(-1)?.output ?? [],
      stateJson.lastProcessedResponse,
    );
  const processedInsertion = processedItems
    ? findLegacyCompactionInsertionIndex(
        processedItems,
        sourceResponse.output,
        compactionIndex,
        optionalLatestFunctionCallIndices,
      )
    : undefined;
  let generatedInsertionAgent: SerializedAgentReference | undefined;
  let generatedInsertionIndex: number;
  if (!isLatestSourceResponse) {
    const followingResponseBoundary = stateJson.lastProcessedResponse
      ? findFollowingLegacyResponsesBoundary(
          stateJson.generatedItems,
          stateJson.lastProcessedResponse.newItems,
          sourceResponses
            .slice(sourceResponseIndex + 1)
            .map((response) => response.output),
          optionalLatestFunctionCallIndices,
        )
      : undefined;
    if (!followingResponseBoundary) {
      throwLegacyCompactionOrderingError();
    }
    const historicalInsertion = findHistoricalLegacyCompactionInsertion(
      stateJson.generatedItems.slice(0, followingResponseBoundary.itemIndex),
      sourceResponse.output,
      compactionIndex,
      followingResponseBoundary,
      sourceResponseIndex > 0,
    );
    generatedInsertionIndex = historicalInsertion.itemIndex;
    generatedInsertionAgent = historicalInsertion.agent;
  } else if (processedItems !== undefined) {
    const segmentStart = findTrailingProcessedSegmentStart(
      stateJson.generatedItems,
      processedItems,
    );
    if (segmentStart === undefined) {
      throwLegacyCompactionOrderingError();
    }
    const generatedInsertion = findLegacyCompactionInsertionIndex(
      stateJson.generatedItems.slice(segmentStart),
      sourceResponse.output,
      compactionIndex,
      optionalLatestFunctionCallIndices,
    );
    generatedInsertionIndex = segmentStart + generatedInsertion.itemIndex;
    generatedInsertionAgent = generatedInsertion.agent;
  } else {
    const generatedInsertion = findLegacyCompactionInsertionIndex(
      stateJson.generatedItems,
      sourceResponse.output,
      compactionIndex,
    );
    generatedInsertionIndex = generatedInsertion.itemIndex;
    generatedInsertionAgent = generatedInsertion.agent;
  }

  const serializedCompactionAgent =
    processedInsertion?.agent ??
    generatedInsertionAgent ??
    stateJson.currentAgent;
  if (
    processedInsertion?.agent &&
    generatedInsertionAgent &&
    getCanonicalLegacyCompactionKey(processedInsertion.agent) !==
      getCanonicalLegacyCompactionKey(generatedInsertionAgent)
  ) {
    throwLegacyCompactionOrderingError();
  }

  const serializedCompactionItem = {
    type: 'compaction_item' as const,
    rawItem: compactionItem,
    agent: serializedCompactionAgent,
  };

  const previousPersistedItemCount =
    stateJson.currentTurnPersistedItemCount ?? 0;
  return {
    stateJson: {
      ...stateJson,
      generatedItems: [
        ...stateJson.generatedItems.slice(0, generatedInsertionIndex),
        serializedCompactionItem,
        ...stateJson.generatedItems.slice(generatedInsertionIndex),
      ],
      ...(processedItems
        ? {
            lastProcessedResponse: {
              ...stateJson.lastProcessedResponse!,
              newItems: [
                ...processedItems.slice(0, processedInsertion!.itemIndex),
                serializedCompactionItem,
                ...processedItems.slice(processedInsertion!.itemIndex),
              ],
            },
          }
        : {}),
    },
    ...(generatedInsertionIndex < previousPersistedItemCount
      ? {
          sessionReconciliation: {
            generatedInsertionIndex,
            previousPersistedItemCount,
          },
        }
      : {}),
  };
}

function findHistoricalLegacyCompactionInsertion(
  items: z.infer<typeof itemSchema>[],
  sourceOutput: protocol.OutputModelItem[],
  compactionIndex: number,
  followingResponseBoundary: {
    itemIndex: number;
    agent: SerializedAgentReference;
  },
  allowEarlierResponseAnchors: boolean,
): { itemIndex: number; agent: SerializedAgentReference } {
  const providerAnchors = getLegacyProviderOutputAnchors(items, sourceOutput);
  const representedSourceItems = getRepresentedLegacySourceItems(
    sourceOutput,
    compactionIndex,
    providerAnchors,
  );
  const requiredSourceItems = getRequiredLegacySourceItems(
    sourceOutput,
    compactionIndex,
  );
  assertRequiredLegacySourceItemsRepresented(
    requiredSourceItems,
    representedSourceItems,
  );
  if (representedSourceItems.length === 0) {
    if (!allowEarlierResponseAnchors && providerAnchors.length > 0) {
      throwLegacyCompactionOrderingError();
    }
    return followingResponseBoundary;
  }

  const matchingStarts: number[] = [];
  for (
    let start = 0;
    start <= providerAnchors.length - representedSourceItems.length;
    start += 1
  ) {
    if (
      representedSourceItems.every(
        (sourceItem, offset) =>
          providerAnchors[start + offset]?.key === sourceItem.key,
      )
    ) {
      matchingStarts.push(start);
    }
  }
  if (matchingStarts.length !== 1) {
    throwLegacyCompactionOrderingError();
  }

  const matchedAnchors = providerAnchors.slice(
    matchingStarts[0],
    matchingStarts[0] + representedSourceItems.length,
  );
  const agent = matchedAnchors[0].agent;
  const agentKey = getCanonicalLegacyCompactionKey(agent);
  if (
    matchedAnchors.some(
      (anchor) => getCanonicalLegacyCompactionKey(anchor.agent) !== agentKey,
    )
  ) {
    throwLegacyCompactionOrderingError();
  }

  const followingSourceIndex = representedSourceItems.findIndex(
    (item) => item.sourceIndex > compactionIndex,
  );
  if (followingSourceIndex >= 0) {
    return {
      itemIndex: matchedAnchors[followingSourceIndex].itemIndex,
      agent,
    };
  }

  const previousAnchor = matchedAnchors[matchedAnchors.length - 1];
  let itemIndex = previousAnchor.itemIndex + 1;
  while (
    items[itemIndex]?.type === 'tool_approval_item' &&
    getCanonicalLegacyCompactionKey(items[itemIndex].rawItem) ===
      previousAnchor.key
  ) {
    itemIndex += 1;
  }
  return { itemIndex, agent };
}

function findFollowingLegacyResponseBoundary(
  generatedItems: z.infer<typeof itemSchema>[],
  processedItems: z.infer<typeof itemSchema>[],
  sourceOutput: protocol.OutputModelItem[],
  optionalFunctionCallIndices: ReadonlySet<number> = new Set(),
): { itemIndex: number; agent: SerializedAgentReference } | undefined {
  const itemIndex = findTrailingProcessedSegmentStart(
    generatedItems,
    processedItems,
  );
  if (itemIndex === undefined) {
    throwLegacyCompactionOrderingError();
  }
  if (
    getLegacyProviderOutputAnchors(
      generatedItems.slice(itemIndex + processedItems.length),
      sourceOutput,
    ).length > 0
  ) {
    throwLegacyCompactionOrderingError();
  }

  const providerAnchors = getLegacyProviderOutputAnchors(
    processedItems,
    sourceOutput,
  );
  const representedSourceItems = getRepresentedLegacySourceItems(
    sourceOutput,
    -1,
    providerAnchors,
    optionalFunctionCallIndices,
  );
  assertRequiredLegacySourceItemsRepresented(
    getRequiredLegacySourceItems(sourceOutput, -1, optionalFunctionCallIndices),
    representedSourceItems,
  );
  if (
    providerAnchors.length === 0 ||
    providerAnchors.length !== representedSourceItems.length ||
    providerAnchors.some(
      (anchor, index) => anchor.key !== representedSourceItems[index]?.key,
    )
  ) {
    return undefined;
  }

  const agent = providerAnchors[0].agent;
  const agentKey = getCanonicalLegacyCompactionKey(agent);
  if (
    providerAnchors.some(
      (anchor) => getCanonicalLegacyCompactionKey(anchor.agent) !== agentKey,
    )
  ) {
    throwLegacyCompactionOrderingError();
  }
  return { itemIndex, agent };
}

function findFollowingLegacyResponsesBoundary(
  generatedItems: z.infer<typeof itemSchema>[],
  processedItems: z.infer<typeof itemSchema>[],
  sourceOutputs: protocol.OutputModelItem[][],
  optionalLatestFunctionCallIndices: ReadonlySet<number>,
): { itemIndex: number; agent: SerializedAgentReference } | undefined {
  const latestSourceOutput = sourceOutputs.at(-1);
  if (!latestSourceOutput) {
    return undefined;
  }

  let boundary = findFollowingLegacyResponseBoundary(
    generatedItems,
    processedItems,
    latestSourceOutput,
    optionalLatestFunctionCallIndices,
  );
  if (!boundary) {
    return undefined;
  }

  for (let index = sourceOutputs.length - 2; index >= 0; index -= 1) {
    boundary = findPrecedingLegacyResponseBoundary(
      generatedItems,
      boundary.itemIndex,
      sourceOutputs[index],
    );
  }
  return boundary;
}

function findPrecedingLegacyResponseBoundary(
  generatedItems: z.infer<typeof itemSchema>[],
  followingBoundaryIndex: number,
  sourceOutput: protocol.OutputModelItem[],
): { itemIndex: number; agent: SerializedAgentReference } {
  const precedingItems = generatedItems.slice(0, followingBoundaryIndex);
  const providerAnchors = getLegacyProviderOutputAnchors(
    precedingItems,
    sourceOutput,
  );
  const representedSourceItems = getRepresentedLegacySourceItems(
    sourceOutput,
    -1,
    providerAnchors,
  );
  assertRequiredLegacySourceItemsRepresented(
    getRequiredLegacySourceItems(sourceOutput, -1),
    representedSourceItems,
  );
  if (representedSourceItems.length === 0) {
    throwLegacyCompactionOrderingError();
  }

  const matchingStarts: number[] = [];
  for (
    let start = 0;
    start <= providerAnchors.length - representedSourceItems.length;
    start += 1
  ) {
    if (
      representedSourceItems.every(
        (sourceItem, offset) =>
          providerAnchors[start + offset]?.key === sourceItem.key,
      )
    ) {
      matchingStarts.push(start);
    }
  }
  if (matchingStarts.length !== 1) {
    throwLegacyCompactionOrderingError();
  }

  const matchingStart = matchingStarts[0];
  const matchedAnchors = providerAnchors.slice(
    matchingStart,
    matchingStart + representedSourceItems.length,
  );
  const trailingAnchors = providerAnchors.slice(
    matchingStart + representedSourceItems.length,
  );
  if (
    trailingAnchors.some(
      (anchor) =>
        precedingItems[anchor.itemIndex]?.type !== 'tool_call_output_item',
    )
  ) {
    throwLegacyCompactionOrderingError();
  }

  const agent = matchedAnchors[0].agent;
  const agentKey = getCanonicalLegacyCompactionKey(agent);
  if (
    matchedAnchors.some(
      (anchor) => getCanonicalLegacyCompactionKey(anchor.agent) !== agentKey,
    )
  ) {
    throwLegacyCompactionOrderingError();
  }
  return { itemIndex: matchedAnchors[0].itemIndex, agent };
}

function isLegacyProviderOutputRunItem(
  item: z.infer<typeof itemSchema>,
): item is z.infer<typeof itemSchema> & { agent: SerializedAgentReference } {
  return (
    item.type === 'message_output_item' ||
    item.type === 'tool_search_call_item' ||
    item.type === 'tool_search_output_item' ||
    item.type === 'tool_call_item' ||
    (item.type === 'tool_call_output_item' &&
      (item.rawItem.type === 'program_output' ||
        item.rawItem.type === 'shell_call_output')) ||
    item.type === 'reasoning_item' ||
    item.type === 'handoff_call_item'
  );
}

function getLegacyProviderOutputAnchors(
  items: z.infer<typeof itemSchema>[],
  sourceOutput: protocol.OutputModelItem[],
): Array<{
  key: string;
  itemIndex: number;
  agent: SerializedAgentReference;
}> {
  const sourceOutputKeys = new Set(
    sourceOutput.map((item) => getLegacyProviderOutputKey(item)),
  );
  return items.flatMap((item, itemIndex) => {
    if (!isLegacyProviderOutputRunItem(item)) {
      return [];
    }
    const key = getLegacyProviderOutputKey(item.rawItem);
    if (
      (item.type === 'tool_search_output_item' ||
        (item.type === 'tool_call_output_item' &&
          (item.rawItem.type === 'program_output' ||
            item.rawItem.type === 'shell_call_output'))) &&
      !sourceOutputKeys.has(key)
    ) {
      return [];
    }
    return [{ key, itemIndex, agent: item.agent }];
  });
}

function getRepresentedLegacySourceItems(
  sourceOutput: protocol.OutputModelItem[],
  compactionIndex: number,
  providerAnchors: Array<{ key: string }>,
  optionalFunctionCallIndices: ReadonlySet<number> = new Set(),
): Array<{ key: string; sourceIndex: number }> {
  if (optionalFunctionCallIndices.size > 0) {
    let providerAnchorIndex = 0;
    return sourceOutput.flatMap((item, sourceIndex) => {
      if (
        sourceIndex === compactionIndex ||
        optionalFunctionCallIndices.has(sourceIndex)
      ) {
        return [];
      }
      const key = getLegacyProviderOutputKey(item);
      if (providerAnchors[providerAnchorIndex]?.key !== key) {
        return [];
      }
      providerAnchorIndex += 1;
      return [{ key, sourceIndex }];
    });
  }

  const providerKeys = new Set(providerAnchors.map((anchor) => anchor.key));
  return sourceOutput.flatMap((item, sourceIndex) => {
    if (sourceIndex === compactionIndex) {
      return [];
    }
    const key = getLegacyProviderOutputKey(item);
    return providerKeys.has(key) ? [{ key, sourceIndex }] : [];
  });
}

function getRequiredLegacySourceItems(
  sourceOutput: protocol.OutputModelItem[],
  compactionIndex: number,
  optionalFunctionCallIndices: ReadonlySet<number> = new Set(),
): Array<{ key: string; sourceIndex: number }> {
  return sourceOutput.flatMap((item, sourceIndex) => {
    const isOmittedHandoff =
      item.type === 'function_call' &&
      optionalFunctionCallIndices.has(sourceIndex);
    if (
      sourceIndex === compactionIndex ||
      item.type === 'compaction' ||
      isOmittedHandoff ||
      item.type === 'function_call_result' ||
      item.type === 'apply_patch_call_output' ||
      item.type === 'unknown'
    ) {
      return [];
    }
    return [{ key: getLegacyProviderOutputKey(item), sourceIndex }];
  });
}

function getOmittedLegacyHandoffFunctionCallIndices(
  sourceOutput: protocol.OutputModelItem[],
  processedResponse:
    z.infer<typeof serializedProcessedResponseSchema> | undefined,
): ReadonlySet<number> {
  const matchedIndices: number[] = [];
  let sourceStartIndex = 0;
  for (const serializedHandoff of processedResponse?.handoffs ?? []) {
    const parsedToolCall = protocol.FunctionCallItem.safeParse(
      serializedHandoff.toolCall,
    );
    if (!parsedToolCall.success) {
      return new Set();
    }
    const key = getLegacyProviderOutputKey(parsedToolCall.data);
    const sourceIndex = sourceOutput.findIndex(
      (item, index) =>
        index >= sourceStartIndex &&
        item.type === 'function_call' &&
        getLegacyProviderOutputKey(item) === key,
    );
    if (sourceIndex < 0) {
      return new Set();
    }
    matchedIndices.push(sourceIndex);
    sourceStartIndex = sourceIndex + 1;
  }
  return new Set(matchedIndices.slice(1));
}

function assertRequiredLegacySourceItemsRepresented(
  requiredItems: Array<{ key: string; sourceIndex: number }>,
  representedItems: Array<{ key: string; sourceIndex: number }>,
): void {
  if (!isLegacySourceSubsequenceRepresented(requiredItems, representedItems)) {
    throwLegacyCompactionOrderingError();
  }
}

function isLegacySourceSubsequenceRepresented(
  requiredItems: Array<{ key: string; sourceIndex: number }>,
  representedItems: Array<{ key: string; sourceIndex: number }>,
): boolean {
  let representedIndex = 0;
  for (const requiredItem of requiredItems) {
    while (
      representedIndex < representedItems.length &&
      representedItems[representedIndex].sourceIndex < requiredItem.sourceIndex
    ) {
      representedIndex += 1;
    }
    if (
      representedItems[representedIndex]?.sourceIndex !==
        requiredItem.sourceIndex ||
      representedItems[representedIndex]?.key !== requiredItem.key
    ) {
      return false;
    }
    representedIndex += 1;
  }
  return true;
}

function getLegacyProviderOutputKey(item: protocol.ModelItem): string {
  if (item.type !== 'function_call') {
    return getCanonicalLegacyCompactionKey(item);
  }

  const namespace = getToolCallNamespace(item);
  if (!namespace) {
    return getCanonicalLegacyCompactionKey(item);
  }

  const normalizedItem = { ...item, name: `${namespace}.${item.name}` };
  delete normalizedItem.namespace;
  return getCanonicalLegacyCompactionKey(normalizedItem);
}

function findLegacyCompactionInsertionIndex(
  items: z.infer<typeof itemSchema>[],
  sourceOutput: protocol.OutputModelItem[],
  compactionIndex: number,
  optionalFunctionCallIndices: ReadonlySet<number> = new Set(),
): { itemIndex: number; agent?: SerializedAgentReference } {
  const providerAnchors = getLegacyProviderOutputAnchors(items, sourceOutput);
  const representedSourceItems = getRepresentedLegacySourceItems(
    sourceOutput,
    compactionIndex,
    providerAnchors,
    optionalFunctionCallIndices,
  );
  assertRequiredLegacySourceItemsRepresented(
    getRequiredLegacySourceItems(
      sourceOutput,
      compactionIndex,
      optionalFunctionCallIndices,
    ),
    representedSourceItems,
  );

  if (
    providerAnchors.length !== representedSourceItems.length ||
    providerAnchors.some(
      (anchor, index) => anchor.key !== representedSourceItems[index]?.key,
    )
  ) {
    throwLegacyCompactionOrderingError();
  }

  if (representedSourceItems.length === 0) {
    if (items.length !== 0) {
      throwLegacyCompactionOrderingError();
    }
    return { itemIndex: 0 };
  }

  const agent = providerAnchors[0].agent;
  const agentKey = getCanonicalLegacyCompactionKey(agent);
  if (
    providerAnchors.some(
      (anchor) => getCanonicalLegacyCompactionKey(anchor.agent) !== agentKey,
    )
  ) {
    throwLegacyCompactionOrderingError();
  }

  const retainedBeforeCompaction = representedSourceItems.filter(
    (item) => item.sourceIndex < compactionIndex,
  ).length;
  const followingAnchor = providerAnchors[retainedBeforeCompaction];
  if (followingAnchor) {
    if (retainedBeforeCompaction === 0 && followingAnchor.itemIndex !== 0) {
      throwLegacyCompactionOrderingError();
    }
    return { itemIndex: followingAnchor.itemIndex, agent };
  }
  return { itemIndex: items.length, agent };
}

function findTrailingProcessedSegmentStart(
  generatedItems: z.infer<typeof itemSchema>[],
  processedItems: z.infer<typeof itemSchema>[],
): number | undefined {
  for (
    let start = generatedItems.length - processedItems.length;
    start >= 0;
    start -= 1
  ) {
    const matches = processedItems.every((processedItem, offset) => {
      const generatedItem = generatedItems[start + offset];
      return (
        getCanonicalLegacyCompactionKey(generatedItem) ===
        getCanonicalLegacyCompactionKey(processedItem)
      );
    });
    if (matches) {
      return start;
    }
  }
  return undefined;
}

function throwLegacyCompactionOrderingError(): never {
  throw new UserError(
    'Run state cannot safely restore a legacy compaction item because its provider order is ambiguous.',
  );
}

function getCanonicalLegacyCompactionKey(value: unknown): string {
  return JSON.stringify(sortLegacyCompactionValue(value));
}

function sortLegacyCompactionValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortLegacyCompactionValue);
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sortLegacyCompactionValue(record[key])]),
  );
}

function containsProgrammaticToolCallingState(
  stateJson: z.infer<typeof SerializedRunState>,
): boolean {
  return (
    containsProgrammaticToolCallingProtocolItems(stateJson.originalInput) ||
    stateJson.modelResponses.some(
      containsProgrammaticToolCallingInModelResponse,
    ) ||
    containsProgrammaticToolCallingInModelResponse(
      stateJson.lastModelResponse,
    ) ||
    containsProgrammaticToolCallingRunItems(stateJson.generatedItems) ||
    containsProgrammaticToolCallingInProcessedResponse(
      stateJson.lastProcessedResponse,
    )
  );
}

function containsProgrammaticToolCallingInModelResponse(
  modelResponse: z.infer<typeof modelResponseSchema> | undefined,
): boolean {
  return Boolean(
    modelResponse?.output.some(isProgrammaticToolCallingProtocolItem),
  );
}

function containsProgrammaticToolCallingRunItems(
  items: z.infer<typeof itemSchema>[] | undefined,
): boolean {
  return Boolean(
    items?.some((item) => isProgrammaticToolCallingProtocolItem(item.rawItem)),
  );
}

function containsProgrammaticToolCallingProtocolItems(
  items: string | protocol.ModelItem[],
): boolean {
  return Array.isArray(items)
    ? items.some(isProgrammaticToolCallingProtocolItem)
    : false;
}

function containsProgrammaticToolCallingInProcessedResponse(
  processedResponse:
    z.infer<typeof serializedProcessedResponseSchema> | undefined,
): boolean {
  if (!processedResponse) {
    return false;
  }

  return (
    containsProgrammaticToolCallingRunItems(processedResponse.newItems) ||
    processedResponse.functions.some(({ toolCall }) =>
      isProgrammaticToolCallingProtocolItem(toolCall),
    ) ||
    (processedResponse.functionToolsNotFound ?? []).some(({ toolCall }) =>
      isProgrammaticToolCallingProtocolItem(toolCall),
    ) ||
    (processedResponse.shellActions ?? []).some(({ toolCall }) =>
      isProgrammaticToolCallingProtocolItem(toolCall),
    ) ||
    (processedResponse.applyPatchActions ?? []).some(({ toolCall }) =>
      isProgrammaticToolCallingProtocolItem(toolCall),
    )
  );
}

function isProgrammaticToolCallingProtocolItem(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const item = value as {
    type?: unknown;
    caller?: { type?: unknown; callerId?: unknown };
  };
  if (item.type === 'program' || item.type === 'program_output') {
    return true;
  }

  if (
    item.type !== 'function_call' &&
    item.type !== 'function_call_result' &&
    item.type !== 'shell_call' &&
    item.type !== 'shell_call_output' &&
    item.type !== 'apply_patch_call' &&
    item.type !== 'apply_patch_call_output' &&
    item.type !== 'hosted_tool_call'
  ) {
    return false;
  }

  return (
    item.caller?.type === 'program' && typeof item.caller.callerId === 'string'
  );
}

function containsSerializedToolSearchState(
  stateJson: z.infer<typeof SerializedRunState>,
): boolean {
  return (
    containsToolSearchProtocolItems(stateJson.originalInput) ||
    containsToolSearchInModelResponses(stateJson.modelResponses) ||
    containsToolSearchInModelResponse(stateJson.lastModelResponse) ||
    containsToolSearchRunItems(stateJson.generatedItems) ||
    containsToolSearchInProcessedResponse(stateJson.lastProcessedResponse)
  );
}

function containsToolSearchInModelResponses(
  modelResponses: z.infer<typeof modelResponseSchema>[],
): boolean {
  return modelResponses.some(containsToolSearchInModelResponse);
}

function containsToolSearchInModelResponse(
  modelResponse: z.infer<typeof modelResponseSchema> | undefined,
): boolean {
  return Boolean(
    modelResponse?.output.some((item) => isToolSearchProtocolType(item.type)),
  );
}

function containsToolSearchRunItems(
  items: z.infer<typeof itemSchema>[] | undefined,
): boolean {
  return Boolean(
    items?.some(
      (item) =>
        item.type === 'tool_search_call_item' ||
        item.type === 'tool_search_output_item' ||
        isToolSearchProtocolType(item.rawItem?.type),
    ),
  );
}

function containsToolSearchProtocolItems(
  items: string | protocol.ModelItem[],
): boolean {
  return Array.isArray(items)
    ? items.some((item) => isToolSearchProtocolType(item.type))
    : false;
}

function containsToolSearchInProcessedResponse(
  processedResponse:
    z.infer<typeof serializedProcessedResponseSchema> | undefined,
): boolean {
  return containsToolSearchRunItems(processedResponse?.newItems);
}

function containsSerializedToolOutputCustomData(
  stateJson: z.infer<typeof SerializedRunState>,
): boolean {
  return (
    containsToolOutputCustomDataRunItems(stateJson.generatedItems) ||
    containsToolOutputCustomDataRunItems(
      stateJson.lastProcessedResponse?.newItems,
    )
  );
}

function containsToolOutputCustomDataRunItems(
  items: z.infer<typeof itemSchema>[] | undefined,
): boolean {
  return Boolean(
    items?.some(
      (item) =>
        item.type === 'tool_call_output_item' &&
        Object.prototype.hasOwnProperty.call(item, 'customData'),
    ),
  );
}

function isToolSearchProtocolType(type: unknown): boolean {
  return type === 'tool_search_call' || type === 'tool_search_output';
}

function addSerializedRuntimeToolKey(
  runtimeToolKeys: Set<string>,
  runtimeToolKey: string,
): void {
  if (runtimeToolKeys.has(runtimeToolKey)) {
    throw new UserError(
      'Serialized client tool_search output contains multiple tools with the same routed identity. Assign unique tool names or namespaces before resuming RunState.',
    );
  }
  runtimeToolKeys.add(runtimeToolKey);
}

function collectSerializedRuntimeToolKeys(
  value: unknown,
  runtimeToolKeys: Set<string>,
  namespace?: string,
  validateRecognizedShape = false,
): void {
  if (!value || typeof value !== 'object') {
    return;
  }

  const candidate = value as {
    type?: unknown;
    name?: unknown;
    namespace?: unknown;
    deferLoading?: unknown;
    defer_loading?: unknown;
    tools?: unknown;
    server_label?: unknown;
    providerData?: unknown;
  };

  if (candidate.type === 'namespace') {
    if (
      typeof candidate.name !== 'string' ||
      candidate.name.length === 0 ||
      !Array.isArray(candidate.tools)
    ) {
      if (validateRecognizedShape) {
        throw new UserError(
          'Serialized client tool_search output contains a namespace without a valid routed identity.',
        );
      }
      return;
    }
    const nestedNamespace =
      typeof candidate.name === 'string' ? candidate.name : namespace;
    for (const nestedTool of candidate.tools) {
      collectSerializedRuntimeToolKeys(
        nestedTool,
        runtimeToolKeys,
        nestedNamespace,
        true,
      );
    }
    return;
  }

  const explicitNamespace =
    typeof candidate.namespace === 'string' && candidate.namespace.length > 0
      ? candidate.namespace
      : namespace;
  if (candidate.type === 'function') {
    if (typeof candidate.name !== 'string' || candidate.name.length === 0) {
      if (validateRecognizedShape) {
        throw new UserError(
          'Serialized client tool_search output contains a function without a valid routed identity.',
        );
      }
      return;
    }
    const directNamespace =
      typeof candidate.namespace === 'string' && candidate.namespace.length > 0
        ? candidate.namespace
        : undefined;
    if (candidate.name === namespace || candidate.name === directNamespace) {
      throw new UserError(
        'Responses tool search reserves same-name namespaces for deferred top-level function tools. Rename the namespace or tool name to avoid ambiguous dispatch.',
      );
    }

    const lookupKey = getFunctionToolLookupKey(
      candidate.name,
      explicitNamespace ??
        (candidate.deferLoading === true || candidate.defer_loading === true
          ? candidate.name
          : undefined),
    );
    if (lookupKey) {
      addSerializedRuntimeToolKey(runtimeToolKeys, lookupKey);
    }
    return;
  }

  if (candidate.type === 'mcp') {
    if (
      typeof candidate.server_label !== 'string' ||
      candidate.server_label.length === 0
    ) {
      if (validateRecognizedShape) {
        throw new UserError(
          'Serialized client tool_search output contains an MCP tool without a valid routed identity.',
        );
      }
      return;
    }
    addSerializedRuntimeToolKey(
      runtimeToolKeys,
      `mcp:${candidate.server_label}`,
    );
    return;
  }

  if (!candidate.providerData || typeof candidate.providerData !== 'object') {
    return;
  }

  collectSerializedRuntimeToolKeys(
    candidate.providerData,
    runtimeToolKeys,
    explicitNamespace,
    false,
  );
}

function getSerializedRuntimeToolKeys(
  toolSearchOutput: protocol.ToolSearchOutputItem,
): Set<string> {
  const runtimeToolKeys = new Set<string>();
  for (const tool of toolSearchOutput.tools) {
    collectSerializedRuntimeToolKeys(tool, runtimeToolKeys, undefined, true);
  }
  return runtimeToolKeys;
}

function getRuntimeToolKeys<TContext>(
  runtimeTools: Tool<TContext>[],
  options: {
    allowUnsupported?: boolean;
    rejectDuplicateKeys?: boolean;
  } = {},
): Set<string> {
  const runtimeToolKeys = new Set<string>();
  const runtimeToolsByKey = new Map<string, Tool<TContext>>();
  for (const tool of runtimeTools) {
    const runtimeToolKey = getToolSearchRuntimeRoutingKey(tool);
    if (!runtimeToolKey) {
      if (options.allowUnsupported) {
        continue;
      }
      throw new UserError(
        'Client tool_search execute() returned an unsupported runtime tool during RunState rehydration.',
      );
    }
    if (options.rejectDuplicateKeys && runtimeToolsByKey.has(runtimeToolKey)) {
      throw new UserError(
        'Client tool_search execute() returned multiple tools with the same routed identity during RunState rehydration.',
      );
    }
    runtimeToolsByKey.set(runtimeToolKey, tool);
    runtimeToolKeys.add(runtimeToolKey);
  }
  return runtimeToolKeys;
}

function formatRuntimeToolKeys(runtimeToolKeys: Set<string>): string {
  return [...runtimeToolKeys].sort().join(', ');
}

function selectSerializedRuntimeTools<TContext>(args: {
  agent: Agent<any, any>;
  toolSearchCall: protocol.ToolSearchCallItem;
  expectedRuntimeToolKeys: Set<string>;
  enabledRuntimeTools: Tool<TContext>[];
}): Tool<TContext>[] {
  const {
    agent,
    toolSearchCall,
    expectedRuntimeToolKeys,
    enabledRuntimeTools,
  } = args;
  const actualRuntimeToolKeys = getRuntimeToolKeys(enabledRuntimeTools, {
    rejectDuplicateKeys: true,
  });
  const hasExpectedKeys = [...expectedRuntimeToolKeys].every((runtimeToolKey) =>
    actualRuntimeToolKeys.has(runtimeToolKey),
  );
  const hasActualKeys = [...actualRuntimeToolKeys].every((runtimeToolKey) =>
    expectedRuntimeToolKeys.has(runtimeToolKey),
  );
  if (hasExpectedKeys && hasActualKeys) {
    return enabledRuntimeTools.filter((runtimeTool) => {
      const runtimeToolKey = getToolSearchRuntimeRoutingKey(runtimeTool);
      return (
        runtimeToolKey != null && expectedRuntimeToolKeys.has(runtimeToolKey)
      );
    });
  }

  if (logger.dontLogToolData) {
    throw new UserError(
      'RunState cannot resume custom client tool_search because the registered execute callback returned different runtime tools than the serialized state.',
    );
  }

  const callId = resolveToolSearchCallId(toolSearchCall);
  throw new UserError(
    `RunState cannot resume custom client tool_search call ${callId} for agent ${agent.name} because the registered execute callback returned runtime tools [${formatRuntimeToolKeys(actualRuntimeToolKeys)}] but the serialized state expects [${formatRuntimeToolKeys(expectedRuntimeToolKeys)}].`,
  );
}

async function getConfiguredAgentTools<TContext>(args: {
  agent: Agent<TContext, any>;
  context: RunContext<TContext>;
  configuredToolsByAgent: Map<Agent<TContext, any>, Tool<TContext>[]>;
}): Promise<Tool<TContext>[]> {
  const { agent, context, configuredToolsByAgent } = args;
  const existing = configuredToolsByAgent.get(agent);
  if (existing) {
    return existing;
  }

  const configuredTools = (await agent.getAllTools(
    context,
  )) as Tool<TContext>[];
  configuredToolsByAgent.set(agent, configuredTools);
  return configuredTools;
}

type RunStateCapabilitySnapshot<TContext> = {
  availableTools: Tool<TContext>[];
  callbackTools: Tool<TContext>[];
  handoffs: Handoff<any, any>[];
  functionMap: Map<FunctionToolLookupKey, FunctionTool<TContext>>;
  functionToolsByCallId: Map<string, FunctionTool<TContext>>;
  runtimeFunctionTools: Set<FunctionTool<TContext>>;
  handoffMap: Map<string, Handoff<any, any>>;
  mcpToolMap: Map<string, HostedMCPTool>;
  replaceableRuntimeToolKeys: Set<string>;
};

function throwAmbiguousFunctionCallId(
  agent: Agent<any, any>,
  callId: string,
  routedToolKeys: Iterable<string>,
): never {
  if (logger.dontLogToolData) {
    throw new UserError(
      'RunState cannot resume because a function call ID is associated with multiple routed tool identities.',
    );
  }

  throw new UserError(
    `RunState cannot resume function call ${callId} for agent ${agent.name} because the call ID is reused across routed tool identities [${[
      ...routedToolKeys,
    ].join(', ')}]. Use a unique call ID for each function call.`,
  );
}

type DeferredFunctionCallExpectation = {
  agent: Agent<any, any>;
  toolCall: protocol.FunctionCallItem;
  resolvedRoutedToolKey: string;
};

function assertUnambiguousFunctionCallIds<
  TContext,
  TAgent extends Agent<any, any>,
>(
  state: RunState<TContext, TAgent>,
  agentMap: Map<string, Agent<any, any>>,
  serializedProcessedResponse?: z.infer<
    typeof serializedProcessedResponseSchema
  >,
): DeferredFunctionCallExpectation[] {
  const deferredFunctionCallExpectations: DeferredFunctionCallExpectation[] =
    [];
  const generatedCallsByAgent = new Map<Agent<any, any>, Map<string, string>>();
  for (const item of state._generatedItems) {
    if (
      !(item instanceof RunToolCallItem) ||
      item.rawItem.type !== 'function_call'
    ) {
      continue;
    }
    const agent = item.agent as Agent<any, any>;
    const routedToolKey = getFunctionToolStateKeyForCall(item.rawItem);
    if (!routedToolKey) {
      continue;
    }
    const callsById = generatedCallsByAgent.get(agent) ?? new Map();
    const previousRoutedToolKey = callsById.get(item.rawItem.callId);
    if (previousRoutedToolKey && previousRoutedToolKey !== routedToolKey) {
      throwAmbiguousFunctionCallId(agent, item.rawItem.callId, [
        previousRoutedToolKey,
        routedToolKey,
      ]);
    }
    callsById.set(item.rawItem.callId, routedToolKey);
    generatedCallsByAgent.set(agent, callsById);
  }

  type ProcessedFunctionCallIdentity = {
    rawRoutedToolKey: string;
    resolvedRoutedToolKey: string;
  };
  const processedCallsByAgent = new Map<
    Agent<any, any>,
    Map<string, ProcessedFunctionCallIdentity>
  >();
  if (serializedProcessedResponse) {
    const agent = state._currentAgent as Agent<any, any>;
    const processedCallsById = new Map<string, ProcessedFunctionCallIdentity>();
    for (const functionCall of serializedProcessedResponse.functions) {
      const toolCall = functionCall.toolCall as protocol.FunctionCallItem;
      const rawRoutedToolKey = getFunctionToolStateKeyForCall(toolCall);
      if (!rawRoutedToolKey) {
        continue;
      }
      const serializedToolStateKey = getToolCallNamespace(toolCall)
        ? rawRoutedToolKey
        : getFunctionToolStateKey(functionCall.tool);
      const resolvedRoutedToolKey = serializedToolStateKey
        ? getFunctionToolStateKeyForResolvedCall(
            toolCall,
            functionCall.tool,
            serializedToolStateKey,
          )
        : rawRoutedToolKey;
      if (!resolvedRoutedToolKey) {
        throwAmbiguousFunctionCallId(agent, toolCall.callId, [
          rawRoutedToolKey,
          serializedToolStateKey!,
        ]);
      }
      if (resolvedRoutedToolKey !== rawRoutedToolKey) {
        deferredFunctionCallExpectations.push({
          agent,
          toolCall,
          resolvedRoutedToolKey,
        });
      }
      const callId = toolCall.callId;
      const previousProcessedIdentity = processedCallsById.get(callId);
      if (
        previousProcessedIdentity &&
        previousProcessedIdentity.resolvedRoutedToolKey !==
          resolvedRoutedToolKey
      ) {
        throwAmbiguousFunctionCallId(agent, callId, [
          previousProcessedIdentity.resolvedRoutedToolKey,
          resolvedRoutedToolKey,
        ]);
      }
      const generatedRoutedToolKey = generatedCallsByAgent
        .get(agent)
        ?.get(callId);
      if (
        generatedRoutedToolKey &&
        generatedRoutedToolKey !== rawRoutedToolKey
      ) {
        throwAmbiguousFunctionCallId(agent, callId, [
          generatedRoutedToolKey,
          rawRoutedToolKey,
        ]);
      }
      processedCallsById.set(callId, {
        rawRoutedToolKey,
        resolvedRoutedToolKey,
      });
    }
    processedCallsByAgent.set(agent, processedCallsById);
  }

  if (state._currentStep?.type !== 'next_step_interruption') {
    return deferredFunctionCallExpectations;
  }

  for (const value of state._currentStep.data?.interruptions ?? []) {
    if (!value || typeof value !== 'object') {
      continue;
    }
    const interruption = value as {
      rawItem?: unknown;
      functionToolStateKey?: unknown;
      agent?: unknown;
    };
    if (
      !interruption.rawItem ||
      typeof interruption.rawItem !== 'object' ||
      (interruption.rawItem as { type?: unknown }).type !== 'function_call'
    ) {
      continue;
    }
    const rawItem = interruption.rawItem as protocol.FunctionCallItem;
    const rawItemRoutedToolKey = getFunctionToolStateKeyForCall(rawItem);
    if (!rawItemRoutedToolKey) {
      continue;
    }
    const interruptionAgent =
      interruption.agent && typeof interruption.agent === 'object'
        ? resolveSerializedAgent(
            interruption.agent as any,
            agentMap,
            state._currentAgent,
          )
        : (state._currentAgent as Agent<any, any>);
    const generatedRoutedToolKey = generatedCallsByAgent
      .get(interruptionAgent)
      ?.get(rawItem.callId);
    if (
      generatedRoutedToolKey &&
      generatedRoutedToolKey !== rawItemRoutedToolKey
    ) {
      throwAmbiguousFunctionCallId(interruptionAgent, rawItem.callId, [
        generatedRoutedToolKey,
        rawItemRoutedToolKey,
      ]);
    }
    const processedIdentity = processedCallsByAgent
      .get(interruptionAgent)
      ?.get(rawItem.callId);
    if (
      processedIdentity &&
      processedIdentity.rawRoutedToolKey !== rawItemRoutedToolKey
    ) {
      throwAmbiguousFunctionCallId(interruptionAgent, rawItem.callId, [
        processedIdentity.rawRoutedToolKey,
        rawItemRoutedToolKey,
      ]);
    }
    const expectedRoutedToolKey =
      processedIdentity?.resolvedRoutedToolKey ?? rawItemRoutedToolKey;
    if (typeof interruption.functionToolStateKey === 'string') {
      const validationRequiresPendingNestedState =
        interruptionAgent !== state._currentAgent && !processedIdentity;
      if (
        !validationRequiresPendingNestedState &&
        interruption.functionToolStateKey !== expectedRoutedToolKey
      ) {
        throwAmbiguousFunctionCallId(interruptionAgent, rawItem.callId, [
          expectedRoutedToolKey,
          interruption.functionToolStateKey,
        ]);
      }
    }
  }
  return deferredFunctionCallExpectations;
}

function collectDeferredToolSearchProvenanceByCallId<TContext>(args: {
  state: RunState<TContext, Agent<any, any>>;
  effectiveToolSearchOutputs: RunToolSearchOutputItem[];
  serializedRuntimeToolKeysByOutput: Map<RunToolSearchOutputItem, Set<string>>;
}): Map<Agent<any, any>, Map<string, string>> {
  const {
    state,
    effectiveToolSearchOutputs,
    serializedRuntimeToolKeysByOutput,
  } = args;
  const effectiveOutputs = new Set(effectiveToolSearchOutputs);
  const routedOwnersByAgent = new Map<
    Agent<any, any>,
    Map<string, RunToolSearchOutputItem>
  >();
  const entriesByReplacementKeyByAgent = new Map<
    Agent<any, any>,
    Map<string, RunToolSearchOutputItem>
  >();
  const deferredKeysByCallIdByAgent = new Map<
    Agent<any, any>,
    Map<string, string>
  >();

  for (const item of state._generatedItems) {
    if (item instanceof RunToolSearchOutputItem && effectiveOutputs.has(item)) {
      const agent = item.agent as Agent<any, any>;
      const routedOwners = routedOwnersByAgent.get(agent) ?? new Map();
      const entriesByReplacementKey =
        entriesByReplacementKeyByAgent.get(agent) ?? new Map();
      const replacementKey = getToolSearchOutputReplacementKey(item.rawItem);
      if (replacementKey) {
        const previousEntry = entriesByReplacementKey.get(replacementKey);
        if (previousEntry) {
          for (const [routedKey, owner] of routedOwners) {
            if (owner === previousEntry) {
              routedOwners.delete(routedKey);
            }
          }
        }
        entriesByReplacementKey.set(replacementKey, item);
      }
      for (const routedKey of serializedRuntimeToolKeysByOutput.get(item) ??
        []) {
        routedOwners.set(routedKey, item);
      }
      routedOwnersByAgent.set(agent, routedOwners);
      entriesByReplacementKeyByAgent.set(agent, entriesByReplacementKey);
      continue;
    }

    if (
      !(item instanceof RunToolCallItem) ||
      item.rawItem.type !== 'function_call' ||
      getToolCallNamespace(item.rawItem)
    ) {
      continue;
    }
    const name = item.rawItem.name;
    const bareKey = getFunctionToolLookupKey(name);
    const deferredKey = getFunctionToolLookupKey(name, name);
    const routedOwners = routedOwnersByAgent.get(item.agent);
    if (
      !bareKey ||
      !deferredKey ||
      routedOwners?.has(bareKey) ||
      !routedOwners?.has(deferredKey)
    ) {
      continue;
    }
    const keysByCallId =
      deferredKeysByCallIdByAgent.get(item.agent) ?? new Map();
    keysByCallId.set(item.rawItem.callId, deferredKey);
    deferredKeysByCallIdByAgent.set(item.agent, keysByCallId);
  }

  return deferredKeysByCallIdByAgent;
}

function assertDeferredFunctionCallProvenance<TContext>(args: {
  expectations: DeferredFunctionCallExpectation[];
  capabilitySnapshotsByAgent: Map<
    Agent<TContext, any>,
    RunStateCapabilitySnapshot<TContext>
  >;
  deferredToolSearchKeysByCallIdByAgent: Map<
    Agent<any, any>,
    Map<string, string>
  >;
}): void {
  const {
    expectations,
    capabilitySnapshotsByAgent,
    deferredToolSearchKeysByCallIdByAgent,
  } = args;
  for (const expectation of expectations) {
    const snapshot = capabilitySnapshotsByAgent.get(expectation.agent);
    if (snapshot?.handoffMap.has(expectation.toolCall.name)) {
      throwAmbiguousFunctionCallId(
        expectation.agent,
        expectation.toolCall.callId,
        [expectation.toolCall.name, expectation.resolvedRoutedToolKey],
      );
    }
    const configuredOwner = snapshot
      ? resolveFunctionToolCall(expectation.toolCall, snapshot.functionMap)
      : undefined;
    if (configuredOwner) {
      if (
        getFunctionToolStateKey(configuredOwner) ===
        expectation.resolvedRoutedToolKey
      ) {
        continue;
      }
      throwAmbiguousFunctionCallId(
        expectation.agent,
        expectation.toolCall.callId,
        [
          getFunctionToolStateKey(configuredOwner) ?? configuredOwner.name,
          expectation.resolvedRoutedToolKey,
        ],
      );
    }
    if (
      deferredToolSearchKeysByCallIdByAgent
        .get(expectation.agent)
        ?.get(expectation.toolCall.callId) !== expectation.resolvedRoutedToolKey
    ) {
      throwAmbiguousFunctionCallId(
        expectation.agent,
        expectation.toolCall.callId,
        [
          getFunctionToolStateKeyForCall(expectation.toolCall) ??
            expectation.toolCall.name,
          expectation.resolvedRoutedToolKey,
        ],
      );
    }
  }
}

async function rehydrateToolSearchRuntimeTools<
  TContext,
  TAgent extends Agent<any, any>,
>(
  state: RunState<TContext, TAgent>,
  options: {
    agentMap: Map<string, Agent<any, any>>;
    schemaVersion: SupportedSchemaVersion;
    serializedProcessedResponse?: z.infer<
      typeof serializedProcessedResponseSchema
    >;
    prepareCurrentAgentForLegacyApprovals?: boolean;
  },
): Promise<Map<Agent<TContext, any>, RunStateCapabilitySnapshot<TContext>>> {
  const deferredFunctionCallExpectations = assertUnambiguousFunctionCallIds(
    state,
    options.agentMap,
    options.serializedProcessedResponse,
  );
  const configuredToolsByAgent = new Map<
    Agent<TContext, any>,
    Tool<TContext>[]
  >();
  const capabilitySnapshotsByAgent = new Map<
    Agent<TContext, any>,
    RunStateCapabilitySnapshot<TContext>
  >();
  type ToolSearchCallOccurrence = {
    pendingCall: {
      agent: Agent<TContext, any>;
      toolSearchCall: protocol.ToolSearchCallItem;
    };
    output?: RunToolSearchOutputItem;
  };
  const toolSearchCallOccurrences: ToolSearchCallOccurrence[] = [];
  const latestOccurrenceByAgentAndCallId = new Map<
    Agent<TContext, any>,
    Map<string, ToolSearchCallOccurrence>
  >();
  const pendingOccurrencesByAgent = new Map<
    Agent<TContext, any>,
    ToolSearchCallOccurrence[]
  >();

  for (const item of state._generatedItems) {
    if (item instanceof RunToolSearchCallItem) {
      if (getToolSearchExecution(item.rawItem) === 'server') {
        continue;
      }

      const callId = resolveToolSearchCallId(item.rawItem);
      const agent = item.agent as Agent<TContext, any>;
      const occurrence: ToolSearchCallOccurrence = {
        pendingCall: {
          agent,
          toolSearchCall: item.rawItem,
        },
      };
      toolSearchCallOccurrences.push(occurrence);
      const pendingOccurrences = pendingOccurrencesByAgent.get(agent) ?? [];
      pendingOccurrences.push(occurrence);
      pendingOccurrencesByAgent.set(agent, pendingOccurrences);
      const occurrencesByCallId =
        latestOccurrenceByAgentAndCallId.get(agent) ?? new Map();
      occurrencesByCallId.set(callId, occurrence);
      latestOccurrenceByAgentAndCallId.set(agent, occurrencesByCallId);
      continue;
    }

    if (
      !(item instanceof RunToolSearchOutputItem) ||
      getToolSearchExecution(item.rawItem) === 'server'
    ) {
      continue;
    }

    const agent = item.agent as Agent<TContext, any>;
    const explicitCallId = getToolSearchProviderCallId(item.rawItem);
    const pendingOccurrences = pendingOccurrencesByAgent.get(agent) ?? [];
    const occurrence = explicitCallId
      ? latestOccurrenceByAgentAndCallId.get(agent)?.get(explicitCallId)
      : pendingOccurrences.shift();
    if (!occurrence) {
      const callId = resolveToolSearchCallId(item.rawItem);
      throw new UserError(
        logger.dontLogToolData
          ? 'RunState cannot resume custom client tool_search because the serialized state is missing the matching tool_search call item.'
          : `RunState cannot resume custom client tool_search output ${callId} for agent ${item.agent.name} because the serialized state is missing the matching tool_search call item.`,
      );
    }
    if (explicitCallId) {
      const pendingIndex = pendingOccurrences.indexOf(occurrence);
      if (pendingIndex >= 0) {
        pendingOccurrences.splice(pendingIndex, 1);
      }
    }
    occurrence.output = item;
  }

  const effectiveToolSearchOutputs = toolSearchCallOccurrences
    .map((occurrence) => occurrence.output)
    .filter((item): item is RunToolSearchOutputItem => Boolean(item));
  const occurrencesByOutput = new Map(
    toolSearchCallOccurrences.flatMap((occurrence) =>
      occurrence.output ? [[occurrence.output, occurrence] as const] : [],
    ),
  );
  const serializedRuntimeToolKeysByOutput = new Map<
    RunToolSearchOutputItem,
    Set<string>
  >();
  for (const item of effectiveToolSearchOutputs) {
    serializedRuntimeToolKeysByOutput.set(
      item,
      getSerializedRuntimeToolKeys(item.rawItem),
    );
  }

  const agentsToPrepare = new Set(
    effectiveToolSearchOutputs.map(
      (item) => item.agent as Agent<TContext, any>,
    ),
  );
  if (options.serializedProcessedResponse) {
    agentsToPrepare.add(state._currentAgent as Agent<TContext, any>);
  }
  if (options.prepareCurrentAgentForLegacyApprovals) {
    agentsToPrepare.add(state._currentAgent as Agent<TContext, any>);
  }

  for (const agent of agentsToPrepare) {
    const configuredTools = await getConfiguredAgentTools({
      agent,
      context: state._context,
      configuredToolsByAgent,
    });
    const existingRuntimeTools = state.getToolSearchRuntimeTools(agent);
    const enabledRuntimeTools = await getEnabledToolSearchRuntimeTools(
      state,
      agent,
    );
    const capabilities = resolveModelVisibleToolNameCollisions(
      [...configuredTools, ...enabledRuntimeTools],
      await agent.getEnabledHandoffs(state._context),
      'warn',
    );
    const availableTools = [...capabilities.tools];
    capabilitySnapshotsByAgent.set(agent, {
      availableTools,
      callbackTools: [...availableTools],
      handoffs: capabilities.handoffs,
      functionMap: buildFunctionToolLookupMap(
        availableTools.filter((tool) => tool.type === 'function'),
      ),
      functionToolsByCallId: new Map(),
      runtimeFunctionTools: new Set(
        existingRuntimeTools.filter(
          (tool): tool is FunctionTool<TContext> => tool.type === 'function',
        ),
      ),
      handoffMap: new Map(
        capabilities.handoffs.map((handoff) => [handoff.toolName, handoff]),
      ),
      mcpToolMap: new Map(
        availableTools
          .filter(
            (tool): tool is HostedMCPTool =>
              tool.type === 'hosted_tool' && tool.providerData?.type === 'mcp',
          )
          .map((tool) => [tool.providerData.server_label, tool]),
      ),
      replaceableRuntimeToolKeys: new Set(
        existingRuntimeTools
          .map((tool) => getToolSearchRuntimeRoutingKey(tool))
          .filter((key): key is string => typeof key === 'string'),
      ),
    });
  }

  assertDeferredFunctionCallProvenance({
    expectations: deferredFunctionCallExpectations,
    capabilitySnapshotsByAgent,
    deferredToolSearchKeysByCallIdByAgent:
      collectDeferredToolSearchProvenanceByCallId({
        state: state as RunState<TContext, Agent<any, any>>,
        effectiveToolSearchOutputs,
        serializedRuntimeToolKeysByOutput,
      }),
  });

  if (
    schemaVersionSupportsV116State(options.schemaVersion) &&
    options.serializedProcessedResponse
  ) {
    const currentAgent = state._currentAgent as Agent<TContext, any>;
    const currentSnapshot = capabilitySnapshotsByAgent.get(currentAgent)!;
    for (const serializedHandoff of options.serializedProcessedResponse
      .handoffs) {
      if (!serializedHandoff.targetAgent) {
        throw new UserError(
          'Run state handoff is missing its required target agent identity.',
        );
      }
      const targetAgent = resolveSerializedAgent(
        serializedHandoff.targetAgent,
        options.agentMap,
      );
      const handoff = currentSnapshot.handoffMap.get(
        serializedHandoff.handoff.toolName,
      );
      if (!handoff || handoff.agent !== targetAgent) {
        throw new UserError(
          `Handoff ${serializedHandoff.handoff.toolName} not found`,
        );
      }
    }
  }

  for (const agent of new Set(
    effectiveToolSearchOutputs.map(
      (item) => item.agent as Agent<TContext, any>,
    ),
  )) {
    validateClientToolSearchSupport(
      capabilitySnapshotsByAgent.get(agent)!.availableTools,
    );
  }

  type ToolSearchRehydrationRecord = {
    pendingCall: {
      agent: Agent<TContext, any>;
      toolSearchCall: protocol.ToolSearchCallItem;
    };
    expectedRuntimeToolKeys: Set<string>;
    toolSearchTool?: Tool<TContext>;
    runtimeTools?: Tool<TContext>[];
  };
  const rehydrationRecords = new Map<
    RunToolSearchOutputItem,
    ToolSearchRehydrationRecord
  >();

  for (const item of effectiveToolSearchOutputs) {
    const callId = resolveToolSearchCallId(item.rawItem);
    const agent = item.agent as Agent<TContext, any>;
    const snapshot = capabilitySnapshotsByAgent.get(agent)!;
    const expectedRuntimeToolKeys =
      serializedRuntimeToolKeysByOutput.get(item)!;
    const pendingCall = occurrencesByOutput.get(item)!.pendingCall;

    const toolSearchTool = getClientToolSearchHelper(snapshot.availableTools);
    const hasCustomExecutor = Boolean(
      toolSearchTool && getClientToolSearchExecutor(toolSearchTool),
    );
    if (expectedRuntimeToolKeys.size === 0) {
      rehydrationRecords.set(item, {
        pendingCall,
        expectedRuntimeToolKeys,
        ...(hasCustomExecutor ? { toolSearchTool } : {}),
      });
      continue;
    }
    if (!hasCustomExecutor) {
      const availableRuntimeToolKeys = getRuntimeToolKeys(
        snapshot.availableTools,
        { allowUnsupported: true },
      );
      if (
        [...expectedRuntimeToolKeys].every((runtimeToolKey) =>
          availableRuntimeToolKeys.has(runtimeToolKey),
        )
      ) {
        rehydrationRecords.set(item, {
          pendingCall,
          expectedRuntimeToolKeys,
        });
        continue;
      }
      if (logger.dontLogToolData) {
        throw new UserError(
          'RunState cannot resume custom client tool_search because the agent no longer provides toolSearchTool({ execution: "client", execute }).',
        );
      }
      throw new UserError(
        `RunState cannot resume custom client tool_search call ${callId} for agent ${pendingCall.agent.name} because the agent no longer provides toolSearchTool({ execution: "client", execute }).`,
      );
    }
    rehydrationRecords.set(item, {
      pendingCall,
      expectedRuntimeToolKeys,
      toolSearchTool,
    });
  }

  for (const generatedItem of state._generatedItems) {
    if (!(generatedItem instanceof RunToolSearchOutputItem)) {
      continue;
    }
    const record = rehydrationRecords.get(generatedItem);
    if (!record?.toolSearchTool) {
      continue;
    }
    const agent = record.pendingCall.agent;
    const snapshot = capabilitySnapshotsByAgent.get(agent)!;
    const { runtimeTools, callbackRuntimeTools } =
      await executeCustomClientToolSearch({
        agent,
        runContext: state._context,
        toolSearchCall: record.pendingCall.toolSearchCall,
        toolSearchTool: record.toolSearchTool,
        tools: snapshot.callbackTools,
      });
    const serializedRuntimeTools = selectSerializedRuntimeTools({
      agent,
      toolSearchCall: record.pendingCall.toolSearchCall,
      expectedRuntimeToolKeys: record.expectedRuntimeToolKeys,
      enabledRuntimeTools: runtimeTools,
    });
    record.runtimeTools = serializedRuntimeTools;
    snapshot.callbackTools.push(...callbackRuntimeTools);
  }

  for (const generatedItem of state._generatedItems) {
    if (generatedItem instanceof RunToolSearchOutputItem) {
      const record = rehydrationRecords.get(generatedItem);
      if (!record?.runtimeTools) {
        continue;
      }
      const agent = record.pendingCall.agent;
      const snapshot = capabilitySnapshotsByAgent.get(agent)!;
      const replacedRuntimeTools = state.getToolSearchRuntimeToolsForOutput(
        agent,
        generatedItem.rawItem,
      );
      const registeredRuntimeTools = registerRuntimeToolSearchTools({
        availableTools: snapshot.availableTools,
        functionMap: snapshot.functionMap,
        handoffMap: snapshot.handoffMap,
        mcpToolMap: snapshot.mcpToolMap,
        replaceableRuntimeToolKeys: snapshot.replaceableRuntimeToolKeys,
        replacedRuntimeTools,
        runtimeTools: record.runtimeTools,
      });
      for (const runtimeTool of registeredRuntimeTools) {
        if (runtimeTool.type === 'function') {
          snapshot.runtimeFunctionTools.add(runtimeTool);
        }
      }

      state.recordToolSearchRuntimeTools(
        agent,
        generatedItem.rawItem,
        registeredRuntimeTools,
      );
      continue;
    }

    if (
      generatedItem instanceof RunToolCallItem &&
      generatedItem.rawItem.type === 'function_call'
    ) {
      const agent = generatedItem.agent as Agent<TContext, any>;
      const snapshot = capabilitySnapshotsByAgent.get(agent);
      if (!snapshot) {
        continue;
      }
      const functionTool = resolveFunctionToolCall(
        generatedItem.rawItem,
        snapshot.functionMap,
      );
      if (functionTool) {
        if (snapshot.runtimeFunctionTools.has(functionTool)) {
          snapshot.functionToolsByCallId.set(
            generatedItem.rawItem.callId,
            functionTool,
          );
        }
      }
    }
  }

  return capabilitySnapshotsByAgent;
}

async function buildRunStateFromJson<TContext, TAgent extends Agent<any, any>>(
  initialAgent: TAgent,
  stateJson: z.infer<typeof SerializedRunState>,
  options: RunStateContextOverrideOptions<TContext> = {},
): Promise<RunState<TContext, TAgent>> {
  const schemaVersion = stateJson.$schemaVersion as SupportedSchemaVersion;
  const agentMap = schemaVersionSupportsAgentIdentity(schemaVersion)
    ? buildAgentIdentityMap(initialAgent).byIdentity
    : buildAgentMap(initialAgent);
  const generatedItems = stateJson.generatedItems.map((item) =>
    deserializeItem(item, agentMap),
  );
  const contextOverride = options.contextOverride;
  const contextStrategy = options.contextStrategy ?? 'merge';
  let deferredLegacyApprovalContext: RunContext<TContext> | undefined;

  //
  // Rebuild the context
  //
  const context =
    contextOverride ??
    new RunContext<TContext>(stateJson.context.context as TContext);
  context._validateFunctionApprovalOwners(
    stateJson.context.functionApprovals ?? [],
    agentMap,
  );
  if (contextOverride) {
    if (contextStrategy === 'merge') {
      if (schemaVersionSupportsV116State(schemaVersion)) {
        context._mergeApprovals(stateJson.context.approvals);
        context._mergeFunctionApprovals(
          stateJson.context.functionApprovals ?? [],
          agentMap,
        );
        context._mergeLegacyFunctionApprovals(
          stateJson.context.legacyFunctionApprovals ?? {},
        );
      } else {
        deferredLegacyApprovalContext = new RunContext<TContext>(
          stateJson.context.context as TContext,
        );
        deferredLegacyApprovalContext._rebuildApprovals(
          stateJson.context.approvals,
        );
        deferredLegacyApprovalContext._rebuildLegacyFunctionApprovals(
          stateJson.context.approvals,
        );
      }
    }
  } else {
    context._rebuildApprovals(stateJson.context.approvals);
    context._rebuildFunctionApprovals(
      stateJson.context.functionApprovals ?? [],
      agentMap,
    );
    context._rebuildLegacyFunctionApprovals(
      schemaVersionSupportsV116State(schemaVersion)
        ? (stateJson.context.legacyFunctionApprovals ?? {})
        : stateJson.context.approvals,
    );
  }
  const shouldRestoreSerializedContext =
    !contextOverride || contextStrategy === 'merge';
  if (
    shouldRestoreSerializedContext &&
    typeof stateJson.context.toolInput !== 'undefined' &&
    typeof context.toolInput === 'undefined'
  ) {
    context.toolInput = stateJson.context.toolInput;
  }

  // Restore the aggregated run usage. toJSON serializes context.usage, but a
  // freshly constructed RunContext starts with an empty Usage, so without this
  // a resumed run reports zero token usage.
  //
  // Only restore on the no-override path. A caller-supplied RunContext is
  // authoritative and owns its usage accounting: its counters do not reveal
  // whether its Usage is newly owned or shared with another run (for example a
  // nested agent-tool resume passes a context whose usage aggregate is shared
  // with the outer run), so it is left untouched.
  if (!contextOverride) {
    context.usage = new Usage(stateJson.context.usage);
  }

  //
  // Find the current agent from the initial agent
  //
  const currentAgent = resolveSerializedAgent(stateJson.currentAgent, agentMap);

  const state = new RunState<TContext, TAgent>(
    context,
    '',
    initialAgent,
    stateJson.maxTurns,
  );
  state._currentAgent = currentAgent as TAgent;
  state._currentTurn = stateJson.currentTurn;
  state._currentTurnInProgress = stateJson.currentTurnInProgress ?? false;
  state._conversationId = stateJson.conversationId ?? undefined;
  state._previousResponseId = stateJson.previousResponseId ?? undefined;
  state._reasoningItemIdPolicy = stateJson.reasoningItemIdPolicy ?? undefined;

  // rebuild tool use tracker
  state._toolUseTracker = new AgentToolUseTracker();
  for (const [agentName, toolNames] of Object.entries(
    stateJson.toolUseTracker,
  )) {
    const agent = agentMap.get(agentName);
    if (!agent) {
      throw new UserError(`Agent ${agentName} not found`);
    }
    state._toolUseTracker.addToolUse(agent as TAgent, toolNames, {
      allowEmpty: true,
    });
  }

  state._pendingAgentToolRuns = new Map(
    Object.entries(stateJson.pendingAgentToolRuns ?? {}),
  );
  state._pendingAgentToolRunAliases = new Map();

  // rebuild current agent span
  if (stateJson.currentAgentSpan) {
    if (!stateJson.trace) {
      logger.warn('Trace is not set, skipping tracing setup');
    }

    const trace = getGlobalTraceProvider().createTrace({
      traceId: stateJson.trace?.id,
      name: stateJson.trace?.workflow_name,
      groupId: stateJson.trace?.group_id ?? undefined,
      metadata: stateJson.trace?.metadata,
      tracingApiKey: stateJson.trace?.tracing_api_key ?? undefined,
    });

    state._currentAgentSpan = deserializeSpan(
      trace,
      stateJson.currentAgentSpan,
    );
    state._trace = trace;
  }
  state._noActiveAgentRun = stateJson.noActiveAgentRun;

  state._inputGuardrailResults =
    stateJson.inputGuardrailResults as InputGuardrailResult[];
  state._outputGuardrailResults = stateJson.outputGuardrailResults.map((r) => ({
    ...r,
    agent: resolveSerializedAgent(r.agent, agentMap),
  })) as OutputGuardrailResult<any, any>[];
  state._toolInputGuardrailResults =
    stateJson.toolInputGuardrailResults as ToolInputGuardrailResult[];
  state._toolOutputGuardrailResults =
    stateJson.toolOutputGuardrailResults as ToolOutputGuardrailResult[];

  state._currentStep = stateJson.currentStep;

  state._originalInput = stateJson.originalInput;
  state._modelResponses = stateJson.modelResponses.map(
    deserializeModelResponse,
  );
  state._lastTurnResponse = stateJson.lastModelResponse
    ? deserializeModelResponse(stateJson.lastModelResponse)
    : undefined;

  state._generatedItems = generatedItems;
  state._currentTurnPersistedItemCount =
    stateJson.currentTurnPersistedItemCount ?? 0;
  const supportsOutputGuardrailSessionPersistence =
    schemaVersion === CURRENT_SCHEMA_VERSION;
  const deferredSessionItemIndexes = supportsOutputGuardrailSessionPersistence
    ? (stateJson.currentTurnDeferredSessionItemIndexes ?? [])
    : [];
  state._currentTurnDeferredSessionItemIndexes = new Set(
    deferredSessionItemIndexes,
  );
  state._currentTurnBlockedSessionStartIndex = undefined;
  state._currentTurnSessionHistoryTransactionSessionId = undefined;
  state._currentTurnSessionReasoningItemIdPolicy = undefined;
  state._currentTurnSessionHistoryTransactionInputItems =
    schemaVersion === CURRENT_SCHEMA_VERSION
      ? stateJson.currentTurnSessionInputItems
      : undefined;
  state._currentTurnSessionHistoryTransactionCanReplaceAcceptedOutput =
    undefined;
  state._sessionHistoryTransactionId = randomUUID();
  state._pendingSessionHistoryTransaction = undefined;
  state._pendingLegacyCompactionSessionItems =
    stateJson.pendingLegacyCompactionSessionItems;
  state._sandbox = stateJson.sandbox ?? undefined;
  const capabilitySnapshotsByAgent = await rehydrateToolSearchRuntimeTools(
    state,
    {
      agentMap,
      schemaVersion,
      serializedProcessedResponse: stateJson.lastProcessedResponse,
      prepareCurrentAgentForLegacyApprovals:
        !schemaVersionSupportsV116State(schemaVersion) &&
        shouldRestoreSerializedContext &&
        Object.keys(stateJson.context.approvals).length > 0,
    },
  );
  const currentCapabilitySnapshot = capabilitySnapshotsByAgent.get(
    state._currentAgent as Agent<TContext, any>,
  );
  state._lastProcessedResponse = stateJson.lastProcessedResponse
    ? await deserializeProcessedResponse(
        agentMap,
        state,
        stateJson.lastProcessedResponse,
        {
          executionTools: currentCapabilitySnapshot!.availableTools,
          executionHandoffs: currentCapabilitySnapshot!.handoffs,
          executionFunctionToolsByCallId:
            currentCapabilitySnapshot!.functionToolsByCallId,
        },
      )
    : undefined;
  restorePendingAgentToolRunAliases(
    state,
    stateJson.pendingAgentToolRunAliases ?? {},
  );
  if (stateJson.currentStep?.type === 'next_step_handoff') {
    state._currentStep = {
      type: 'next_step_handoff',
      newAgent: resolveSerializedAgent(
        stateJson.currentStep.newAgent,
        agentMap,
      ) as TAgent,
    };
  } else if (stateJson.currentStep?.type === 'next_step_interruption') {
    const interruptions = deserializeInterruptions(
      stateJson.currentStep.data?.interruptions,
      agentMap,
      state._currentAgent,
    );
    rebindInterruptionFunctionToolStateKeys(
      interruptions,
      state._lastProcessedResponse,
      state._currentAgent,
      state,
      schemaVersion,
    );
    state._currentStep = {
      type: 'next_step_interruption',
      data: {
        ...stateJson.currentStep.data,
        interruptions,
      },
    };
  }
  const legacyAvailableToolsByAgent = new Map<
    Agent<any, any>,
    Tool<TContext>[]
  >();
  for (const agent of new Set(agentMap.values())) {
    legacyAvailableToolsByAgent.set(agent, [
      ...(agent.tools as Tool<TContext>[]),
    ]);
  }
  for (const [agent, snapshot] of capabilitySnapshotsByAgent) {
    const configuredTools = legacyAvailableToolsByAgent.get(agent) ?? [];
    legacyAvailableToolsByAgent.set(agent, [
      ...new Set([...configuredTools, ...snapshot.availableTools]),
    ]);
  }
  const legacyFunctionApprovalKeys = migrateLegacyFunctionToolState(
    state,
    schemaVersion,
    shouldRestoreSerializedContext,
    deferredLegacyApprovalContext,
    legacyAvailableToolsByAgent,
  );
  const legacyApprovalContext = deferredLegacyApprovalContext ?? context;
  if (!schemaVersionSupportsV116State(schemaVersion)) {
    legacyApprovalContext._retainLegacyFunctionApprovals(
      legacyFunctionApprovalKeys,
    );
    legacyApprovalContext._removeMigratedFunctionApprovalsFromAggregate(
      legacyFunctionApprovalKeys,
      new Set(
        [...legacyAvailableToolsByAgent.values()].flatMap((tools) =>
          tools.flatMap((tool) =>
            tool.type !== 'function' && typeof tool.name === 'string'
              ? [tool.name]
              : [],
          ),
        ),
      ),
    );
  }
  if (deferredLegacyApprovalContext) {
    context._mergeApprovalStatePreservingExactKeys(
      deferredLegacyApprovalContext,
      legacyFunctionApprovalKeys,
    );
  }
  state._serializedCurrentStep = state._currentStep;
  return state;
}

/**
 * @internal
 */
export async function rehydrateProcessedResponseTools<
  TContext,
  TAgent extends Agent<any, any>,
>(
  initialAgent: TAgent,
  state: RunState<TContext, TAgent>,
  executionTools: Tool<TContext>[],
): Promise<void> {
  if (!state._lastProcessedResponse) {
    return;
  }

  const agentIdentity = buildAgentIdentityMap(initialAgent);
  const serializedProcessedResponse = serializeProcessedResponse(
    state._lastProcessedResponse,
    agentIdentity.byAgent,
  );
  const executionFunctionToolsByCallId = new Map(
    state._lastProcessedResponse.functions.flatMap((functionCall) =>
      functionCall.preserveToolOnExecutionRehydration
        ? [[functionCall.toolCall.callId, functionCall.tool] as const]
        : [],
    ),
  );

  state._lastProcessedResponse = await deserializeProcessedResponse(
    agentIdentity.byIdentity,
    state as RunState<TContext, Agent<any, any>>,
    serializedProcessedResponse,
    {
      executionTools,
      executionFunctionToolsByCallId,
      allowSerializedExecutionToolPlaceholder: false,
    },
  );
}

/**
 * @internal
 */
export function buildAgentMap(
  initialAgent: Agent<any, any>,
): Map<string, Agent<any, any>> {
  const map = new Map<string, Agent<any, any>>();
  const visitedAgents = new Set<Agent<any, any>>();
  const queue: Agent<any, any>[] = [initialAgent];

  while (queue.length > 0) {
    const currentAgent = queue.shift()!;
    if (visitedAgents.has(currentAgent)) {
      continue;
    }
    visitedAgents.add(currentAgent);

    const existingAgent = map.get(currentAgent.name);
    if (existingAgent && existingAgent !== currentAgent) {
      throw new UserError(
        `Duplicate agent name "${currentAgent.name}" detected. Use unique agent names when serializing RunState.`,
      );
    }

    map.set(currentAgent.name, currentAgent);

    for (const handoff of currentAgent.handoffs) {
      if (handoff instanceof Agent) {
        queue.push(handoff);
      } else if (handoff.agent) {
        queue.push(handoff.agent);
      }
    }

    for (const tool of currentAgent.tools) {
      const sourceAgent = getAgentToolSourceAgent(tool);
      if (sourceAgent) {
        queue.push(sourceAgent);
      }
    }
  }

  return map;
}

function serializeAgentReference(
  agent: Agent<any, any>,
  agentIdentityKeys: ReadonlyMap<Agent<any, any>, string>,
): SerializedAgentReference {
  const identity = agentIdentityKeys.get(agent);
  if (!identity || identity === agent.name) {
    return { name: agent.name };
  }

  return { name: agent.name, identity };
}

function resolveSerializedAgent(
  serializedAgent: SerializedAgentReference,
  agentMap: Map<string, Agent<any, any>>,
  fallbackAgent?: Agent<any, any>,
): Agent<any, any> {
  const identity = serializedAgent.identity ?? serializedAgent.name;
  const agent = agentMap.get(identity);
  if (agent) {
    return agent;
  }
  if (!serializedAgent.identity && fallbackAgent) {
    return fallbackAgent;
  }
  if (serializedAgent.identity) {
    throw new UserError(`Agent identity ${serializedAgent.identity} not found`);
  }
  throw new UserError(`Agent ${serializedAgent.name} not found`);
}

function serializeRunItem(
  item: RunItem,
  agentIdentityKeys: ReadonlyMap<Agent<any, any>, string>,
): z.infer<typeof itemSchema> {
  const serialized = item.toJSON() as any;
  switch (item.type) {
    case 'handoff_output_item':
      serialized.sourceAgent = serializeAgentReference(
        item.sourceAgent,
        agentIdentityKeys,
      );
      serialized.targetAgent = serializeAgentReference(
        item.targetAgent,
        agentIdentityKeys,
      );
      return serialized;
    default:
      serialized.agent = serializeAgentReference(
        (item as RunItem & { agent: Agent<any, any> }).agent,
        agentIdentityKeys,
      );
      return serialized;
  }
}

function serializeCurrentStep(
  currentStep: NextStep | undefined,
  agentIdentityKeys: ReadonlyMap<Agent<any, any>, string>,
): NextStep | undefined {
  if (!currentStep) {
    return undefined;
  }
  if (currentStep.type === 'next_step_handoff') {
    return {
      ...currentStep,
      newAgent: serializeAgentReference(
        currentStep.newAgent as Agent<any, any>,
        agentIdentityKeys,
      ),
    };
  }
  if (currentStep.type === 'next_step_interruption') {
    const interruptions = Array.isArray(currentStep.data?.interruptions)
      ? currentStep.data.interruptions.map((item: unknown) =>
          item instanceof RunToolApprovalItem
            ? serializeRunItem(item, agentIdentityKeys)
            : item,
        )
      : currentStep.data?.interruptions;
    return {
      ...currentStep,
      data: {
        ...currentStep.data,
        interruptions,
      },
    };
  }

  return currentStep;
}

function serializeProcessedResponse<TContext>(
  processedResponse: ProcessedResponse<TContext>,
  agentIdentityKeys: ReadonlyMap<Agent<any, any>, string>,
): z.infer<typeof serializedProcessedResponseSchema> {
  return {
    ...processedResponse,
    newItems: processedResponse.newItems.map((item) =>
      serializeRunItem(item, agentIdentityKeys),
    ),
    functions: processedResponse.functions.map(({ toolCall, tool }) => ({
      toolCall,
      tool,
    })),
    handoffs: processedResponse.handoffs.map(
      ({ toolCall, handoff: processedHandoff }) => ({
        toolCall,
        handoff: processedHandoff,
        targetAgent: serializeAgentReference(
          processedHandoff.agent,
          agentIdentityKeys,
        ),
      }),
    ),
  } as z.infer<typeof serializedProcessedResponseSchema>;
}

/**
 * @internal
 */
export function deserializeSpan(
  trace: Trace,
  serializedSpan: SerializedSpanType,
): Span<any> {
  const spanData = serializedSpan.span_data;
  const previousSpan = serializedSpan.previous_span
    ? deserializeSpan(trace, serializedSpan.previous_span)
    : undefined;

  const span = getGlobalTraceProvider().createSpan(
    {
      spanId: serializedSpan.id,
      traceId: serializedSpan.trace_id,
      parentId: serializedSpan.parent_id ?? undefined,
      startedAt: serializedSpan.started_at ?? undefined,
      endedAt: serializedSpan.ended_at ?? undefined,
      data: spanData as any,
    },
    trace,
  );
  span.previousSpan = previousSpan;

  return span;
}

/**
 * @internal
 */
export function deserializeModelResponse(
  serializedModelResponse: z.infer<typeof modelResponseSchema>,
): ModelResponse {
  const usage = new Usage(serializedModelResponse.usage);

  return {
    usage,
    output: serializedModelResponse.output.map((item) =>
      protocol.OutputModelItem.parse(item),
    ),
    responseId: serializedModelResponse.responseId,
    requestId: serializedModelResponse.requestId,
    providerData: serializedModelResponse.providerData,
  };
}

/**
 * @internal
 */
export function deserializeItem(
  serializedItem: z.infer<typeof itemSchema>,
  agentMap: Map<string, Agent<any, any>>,
): RunItem {
  switch (serializedItem.type) {
    case 'message_output_item':
      return new RunMessageOutputItem(
        serializedItem.rawItem,
        resolveSerializedAgent(serializedItem.agent, agentMap),
      );
    case 'tool_search_call_item':
      return new RunToolSearchCallItem(
        serializedItem.rawItem,
        resolveSerializedAgent(serializedItem.agent, agentMap),
      );
    case 'tool_search_output_item':
      return new RunToolSearchOutputItem(
        serializedItem.rawItem,
        resolveSerializedAgent(serializedItem.agent, agentMap),
      );
    case 'tool_call_item':
      return new RunToolCallItem(
        serializedItem.rawItem,
        resolveSerializedAgent(serializedItem.agent, agentMap),
      );
    case 'tool_call_output_item':
      return new RunToolCallOutputItem(
        serializedItem.rawItem,
        resolveSerializedAgent(serializedItem.agent, agentMap),
        serializedItem.output,
        serializedItem.customData,
        serializedItem.executionStatus,
      );
    case 'reasoning_item':
      return new RunReasoningItem(
        serializedItem.rawItem,
        resolveSerializedAgent(serializedItem.agent, agentMap),
      );
    case 'compaction_item':
      return new RunCompactionItem(
        serializedItem.rawItem,
        resolveSerializedAgent(serializedItem.agent, agentMap),
      );
    case 'handoff_call_item':
      return new RunHandoffCallItem(
        serializedItem.rawItem,
        resolveSerializedAgent(serializedItem.agent, agentMap),
      );
    case 'handoff_output_item':
      return new RunHandoffOutputItem(
        serializedItem.rawItem,
        resolveSerializedAgent(serializedItem.sourceAgent, agentMap),
        resolveSerializedAgent(serializedItem.targetAgent, agentMap),
      );
    case 'tool_approval_item':
      return new RunToolApprovalItem(
        serializedItem.rawItem,
        resolveSerializedAgent(serializedItem.agent, agentMap),
        serializedItem.toolName,
        serializedItem.functionToolStateKey,
      );
  }
}

function deserializeInterruptionItem(
  serializedItem: unknown,
  agentMap: Map<string, Agent<any, any>>,
  currentAgent: Agent<any, any>,
): RunToolApprovalItem | undefined {
  if (serializedItem instanceof RunToolApprovalItem) {
    return serializedItem;
  }

  const parsed = itemSchema.safeParse(serializedItem);
  if (parsed.success) {
    if (parsed.data.type === 'tool_approval_item') {
      const mappedAgent = resolveSerializedAgent(
        parsed.data.agent,
        agentMap,
        currentAgent,
      );
      return new RunToolApprovalItem(
        parsed.data.rawItem,
        mappedAgent,
        parsed.data.toolName,
        parsed.data.functionToolStateKey,
      );
    }

    const item = deserializeItem(parsed.data, agentMap);
    return item instanceof RunToolApprovalItem ? item : undefined;
  }

  if (!serializedItem || typeof serializedItem !== 'object') {
    return undefined;
  }

  const value = serializedItem as {
    rawItem?: unknown;
    toolName?: unknown;
    functionToolStateKey?: unknown;
    agent?: { name?: unknown; identity?: unknown };
  };

  if (!value.rawItem || typeof value.rawItem !== 'object') {
    return undefined;
  }

  const rawItem = value.rawItem as { type?: unknown; name?: unknown };
  if (
    rawItem.type !== 'function_call' &&
    rawItem.type !== 'hosted_tool_call' &&
    rawItem.type !== 'computer_call' &&
    rawItem.type !== 'shell_call' &&
    rawItem.type !== 'apply_patch_call'
  ) {
    return undefined;
  }

  const agentName =
    value.agent && typeof value.agent.name === 'string'
      ? value.agent.name
      : undefined;
  const agentIdentity =
    value.agent && typeof value.agent.identity === 'string'
      ? value.agent.identity
      : undefined;
  const mappedAgent =
    agentName || agentIdentity
      ? resolveSerializedAgent(
          {
            name: agentName ?? currentAgent.name,
            identity: agentIdentity,
          },
          agentMap,
          currentAgent,
        )
      : currentAgent;
  const toolName =
    typeof value.toolName === 'string'
      ? value.toolName
      : typeof rawItem.name === 'string'
        ? rawItem.name
        : undefined;
  const functionToolStateKey =
    typeof value.functionToolStateKey === 'string'
      ? value.functionToolStateKey
      : undefined;

  return new RunToolApprovalItem(
    value.rawItem as RunToolApprovalItem['rawItem'],
    mappedAgent,
    toolName,
    functionToolStateKey,
  );
}

function deserializeInterruptions(
  serializedInterruptions: unknown,
  agentMap: Map<string, Agent<any, any>>,
  currentAgent: Agent<any, any>,
): RunToolApprovalItem[] {
  if (!Array.isArray(serializedInterruptions)) {
    return [];
  }

  return serializedInterruptions
    .map((item) => deserializeInterruptionItem(item, agentMap, currentAgent))
    .filter(
      (item): item is RunToolApprovalItem =>
        item instanceof RunToolApprovalItem,
    );
}

function rebindInterruptionFunctionToolStateKeys<TContext>(
  interruptions: RunToolApprovalItem[],
  processedResponse: ProcessedResponse<TContext> | undefined,
  processedAgent: Agent<any, any>,
  state: RunState<TContext, Agent<any, any>>,
  schemaVersion: SupportedSchemaVersion,
): void {
  if (!processedResponse) {
    for (const interruption of interruptions) {
      if (
        interruption.rawItem.type !== 'function_call' ||
        !interruption.functionToolStateKey
      ) {
        continue;
      }
      const rawStateKey = getFunctionToolStateKeyForCall(interruption.rawItem);
      if (rawStateKey && interruption.functionToolStateKey !== rawStateKey) {
        throwAmbiguousFunctionCallId(
          interruption.agent,
          interruption.rawItem.callId,
          [rawStateKey, interruption.functionToolStateKey],
        );
      }
    }
    return;
  }

  const functionsByCallId = new Map(
    processedResponse.functions.map((functionCall) => [
      functionCall.toolCall.callId,
      functionCall,
    ]),
  );
  for (const interruption of interruptions) {
    if (interruption.rawItem.type !== 'function_call') {
      continue;
    }
    let stateKey: string | undefined;
    if (interruption.agent === processedAgent) {
      stateKey = getFunctionToolStateKey(
        functionsByCallId.get(interruption.rawItem.callId)?.tool,
      );
    } else {
      stateKey = findNestedInterruptionFunctionToolStateKey(
        state,
        interruption,
      );
      if (schemaVersionSupportsV116State(schemaVersion)) {
        const rawStateKey = getFunctionToolStateKeyForCall(
          interruption.rawItem,
        );
        const serializedStateKey = interruption.functionToolStateKey;
        const expectedStateKey = stateKey ?? rawStateKey;
        if (
          serializedStateKey &&
          expectedStateKey &&
          serializedStateKey !== expectedStateKey
        ) {
          throwAmbiguousFunctionCallId(
            interruption.agent,
            interruption.rawItem.callId,
            [expectedStateKey, serializedStateKey],
          );
        }
      }
    }
    if (stateKey) {
      interruption.functionToolStateKey = stateKey;
    }
  }
}

function findNestedInterruptionFunctionToolStateKey<TContext>(
  state: RunState<TContext, Agent<any, any>>,
  interruption: RunToolApprovalItem,
): string | undefined {
  if (interruption.rawItem.type !== 'function_call') {
    return undefined;
  }

  const serializedPendingStates = new Set<string>();
  for (const functionCall of state._lastProcessedResponse?.functions ?? []) {
    if (getAgentToolSourceAgent(functionCall.tool) !== interruption.agent) {
      continue;
    }
    const stateKeys = getFunctionToolStateKeys(
      functionCall.tool,
      functionCall.availableFunctionTools ?? [functionCall.tool],
    );
    for (const stateKey of stateKeys) {
      const serializedState = state.getPendingAgentToolRun(
        stateKey,
        functionCall.toolCall.callId,
      );
      if (serializedState) {
        serializedPendingStates.add(serializedState);
      }
    }
  }

  const resolvedStateKeys = new Set<string>();
  for (const serializedState of serializedPendingStates) {
    const resolvedStateKey =
      getSerializedNestedInterruptionFunctionToolStateKey(
        serializedState,
        interruption.rawItem,
      );
    if (resolvedStateKey) {
      resolvedStateKeys.add(resolvedStateKey);
    }
  }
  if (resolvedStateKeys.size > 1) {
    throwAmbiguousFunctionCallId(
      interruption.agent,
      interruption.rawItem.callId,
      [...resolvedStateKeys],
    );
  }
  return resolvedStateKeys.values().next().value;
}

function getSerializedNestedInterruptionFunctionToolStateKey(
  serializedState: string,
  interruptionRawItem: protocol.FunctionCallItem,
): string | undefined {
  let nestedState: unknown;
  try {
    nestedState = JSON.parse(serializedState);
  } catch {
    return undefined;
  }
  if (!nestedState || typeof nestedState !== 'object') {
    return undefined;
  }

  const candidate = nestedState as {
    currentStep?: {
      type?: unknown;
      data?: { interruptions?: unknown };
    };
    lastProcessedResponse?: {
      functions?: unknown;
    };
  };
  if (
    candidate.currentStep?.type !== 'next_step_interruption' ||
    !Array.isArray(candidate.currentStep.data?.interruptions) ||
    !candidate.currentStep.data.interruptions.some((value) => {
      if (!value || typeof value !== 'object') {
        return false;
      }
      const rawItem = (value as { rawItem?: unknown }).rawItem;
      return (
        rawItem != null &&
        typeof rawItem === 'object' &&
        (rawItem as { type?: unknown }).type === 'function_call' &&
        (rawItem as { callId?: unknown }).callId ===
          interruptionRawItem.callId &&
        getFunctionToolStateKeyForCall(rawItem as protocol.FunctionCallItem) ===
          getFunctionToolStateKeyForCall(interruptionRawItem)
      );
    }) ||
    !Array.isArray(candidate.lastProcessedResponse?.functions)
  ) {
    return undefined;
  }

  const stateKeys = new Set<string>();
  for (const value of candidate.lastProcessedResponse.functions) {
    if (!value || typeof value !== 'object') {
      continue;
    }
    const functionCall = value as { toolCall?: unknown; tool?: unknown };
    if (
      !functionCall.toolCall ||
      typeof functionCall.toolCall !== 'object' ||
      (functionCall.toolCall as { callId?: unknown }).callId !==
        interruptionRawItem.callId
    ) {
      continue;
    }
    const stateKey = getFunctionToolStateKey(functionCall.tool);
    if (
      stateKey &&
      getFunctionToolStateKeyForResolvedCall(
        interruptionRawItem,
        functionCall.tool,
        stateKey,
      ) === stateKey
    ) {
      stateKeys.add(stateKey);
    }
  }
  if (stateKeys.size !== 1) {
    return undefined;
  }
  return stateKeys.values().next().value;
}

function restorePendingAgentToolRunAliases<TContext>(
  state: RunState<TContext, Agent<any, any>>,
  serializedAliases: Record<string, string>,
): void {
  const aliasEntries = Object.entries(serializedAliases);
  if (aliasEntries.length === 0) {
    return;
  }

  const validAliases = new Map<string, string>();
  for (const functionCall of state._lastProcessedResponse?.functions ?? []) {
    const [canonicalToolName, ...aliases] = getFunctionToolStateKeys(
      functionCall.tool,
      functionCall.availableFunctionTools ?? [functionCall.tool],
    );
    if (!canonicalToolName) {
      continue;
    }
    const callId = functionCall.toolCall.callId;
    const canonicalKey = `${canonicalToolName}:${callId}`;
    for (const alias of aliases) {
      validAliases.set(`${alias}:${callId}`, canonicalKey);
    }
  }

  for (const [aliasKey, canonicalKey] of aliasEntries) {
    if (
      validAliases.get(aliasKey) !== canonicalKey ||
      !state._pendingAgentToolRuns.has(canonicalKey)
    ) {
      throw new UserError(
        'Run state pending agent tool aliases do not match the reconstructed pending function calls.',
      );
    }
  }

  state._pendingAgentToolRunAliases = new Map(aliasEntries);
}

function migrateLegacyFunctionToolState<TContext>(
  state: RunState<TContext, Agent<any, any>>,
  schemaVersion: SupportedSchemaVersion,
  migrateApprovals: boolean,
  approvalContext: RunContext<TContext> = state._context,
  availableToolsByAgent: ReadonlyMap<
    Agent<any, any>,
    readonly Tool<TContext>[]
  > = new Map(),
): Set<string> {
  if (schemaVersionSupportsV116State(schemaVersion)) {
    return new Set();
  }

  const approvalCallsByLegacyKey = new Map<
    string,
    Map<Agent<any, any>, Map<string, Set<string>>>
  >();
  const approvalOwnersByLegacyKey = new Map<
    string,
    Map<Agent<any, any>, Set<string>>
  >();
  const addApprovalOwner = (
    legacyKey: string,
    agent: Agent<any, any>,
    canonicalKey: string,
  ) => {
    const ownersByAgent =
      approvalOwnersByLegacyKey.get(legacyKey) ??
      new Map<Agent<any, any>, Set<string>>();
    const ownerKeys = ownersByAgent.get(agent) ?? new Set<string>();
    ownerKeys.add(canonicalKey);
    ownersByAgent.set(agent, ownerKeys);
    approvalOwnersByLegacyKey.set(legacyKey, ownersByAgent);
  };
  const addApprovalCall = (
    legacyKey: string,
    agent: Agent<any, any>,
    canonicalKey: string,
    callId: string,
  ) => {
    addApprovalOwner(legacyKey, agent, canonicalKey);
    const callsByAgent =
      approvalCallsByLegacyKey.get(legacyKey) ??
      new Map<Agent<any, any>, Map<string, Set<string>>>();
    const callsByCanonicalKey =
      callsByAgent.get(agent) ?? new Map<string, Set<string>>();
    const callIds = callsByCanonicalKey.get(canonicalKey) ?? new Set<string>();
    callIds.add(callId);
    callsByCanonicalKey.set(canonicalKey, callIds);
    callsByAgent.set(agent, callsByCanonicalKey);
    approvalCallsByLegacyKey.set(legacyKey, callsByAgent);
  };
  for (const [agent, availableTools] of availableToolsByAgent) {
    for (const tool of availableTools) {
      if (tool.type !== 'function') {
        continue;
      }
      const canonicalKey = getFunctionToolStateKey(tool);
      const legacyKey = getFunctionToolQualifiedName(tool) ?? tool.name;
      if (!canonicalKey || canonicalKey === legacyKey) {
        continue;
      }
      addApprovalOwner(legacyKey, agent, canonicalKey);
    }
  }

  for (const functionCall of state._lastProcessedResponse?.functions ?? []) {
    const canonicalKey = getFunctionToolStateKey(functionCall.tool);
    const legacyKey =
      getFunctionToolQualifiedName(functionCall.tool) ?? functionCall.tool.name;
    if (!canonicalKey || canonicalKey === legacyKey) {
      continue;
    }
    const callId = functionCall.toolCall.callId;
    const pendingState = state.getPendingAgentToolRun(legacyKey, callId);
    if (pendingState !== undefined) {
      state.setPendingAgentToolRun(canonicalKey, callId, pendingState, [
        legacyKey,
      ]);
    }
    if (!migrateApprovals) {
      continue;
    }
    addApprovalCall(legacyKey, state._currentAgent, canonicalKey, callId);
  }

  if (state._currentStep?.type === 'next_step_interruption') {
    for (const interruption of state._currentStep.data.interruptions) {
      if (
        interruption.rawItem.type !== 'function_call' ||
        !interruption.functionToolStateKey
      ) {
        continue;
      }
      const legacyKey = getFunctionToolLegacyStateKeyFromStateKey(
        interruption.functionToolStateKey,
      );
      if (!legacyKey) {
        continue;
      }
      addApprovalCall(
        legacyKey,
        interruption.agent,
        interruption.functionToolStateKey,
        interruption.rawItem.callId,
      );
    }
  }

  if (migrateApprovals) {
    for (const [legacyKey, ownersByAgent] of approvalOwnersByLegacyKey) {
      const ownerEntries = [...ownersByAgent].flatMap(
        ([agent, canonicalKeys]) =>
          [...canonicalKeys].map((canonicalKey) => ({ agent, canonicalKey })),
      );
      if (ownerEntries.length !== 1) {
        continue;
      }
      const [{ agent, canonicalKey }] = ownerEntries;
      approvalContext._migrateToolApproval(
        agent,
        legacyKey,
        canonicalKey,
        [],
        true,
      );
    }
  }

  for (const [legacyKey, callsByAgent] of approvalCallsByLegacyKey) {
    const callOwners = new Map<string, number>();
    for (const callsByCanonicalKey of callsByAgent.values()) {
      for (const callIds of callsByCanonicalKey.values()) {
        for (const callId of callIds) {
          callOwners.set(callId, (callOwners.get(callId) ?? 0) + 1);
        }
      }
    }
    for (const [agent, callsByCanonicalKey] of callsByAgent) {
      for (const [canonicalKey, callIds] of callsByCanonicalKey) {
        for (const callId of callIds) {
          const remainingOwners = (callOwners.get(callId) ?? 1) - 1;
          callOwners.set(callId, remainingOwners);
          approvalContext._migrateToolApproval(
            agent,
            legacyKey,
            canonicalKey,
            [callId],
            false,
            remainingOwners > 0,
          );
        }
      }
    }
  }
  return new Set(approvalOwnersByLegacyKey.keys());
}

type DeserializeProcessedResponseOptions<TContext> = {
  executionTools?: Tool<TContext>[];
  executionHandoffs?: Handoff<any, any>[];
  executionFunctionToolsByCallId?: Map<string, FunctionTool<TContext>>;
  allowSerializedExecutionToolPlaceholder?: boolean;
};

/**
 * @internal
 */
async function deserializeProcessedResponse<TContext = UnknownContext>(
  agentMap: Map<string, Agent<any, any>>,
  state: RunState<TContext, Agent<any, any>>,
  serializedProcessedResponse: z.infer<
    typeof serializedProcessedResponseSchema
  >,
  options: DeserializeProcessedResponseOptions<TContext> = {},
): Promise<ProcessedResponse<TContext>> {
  const currentAgent = state._currentAgent;
  const allTools = options.executionTools
    ? options.executionTools
    : [
        ...((await currentAgent.getAllTools(
          state._context,
        )) as Tool<TContext>[]),
        ...(await getEnabledToolSearchRuntimeTools(state, currentAgent)),
      ];
  const baseAgentTools = currentAgent.tools as Tool<TContext>[];
  const allowSerializedExecutionToolPlaceholder =
    options.allowSerializedExecutionToolPlaceholder ?? true;
  const tools = buildFunctionToolLookupMap(
    allTools.filter((tool) => tool.type === 'function'),
  );
  const computerTools = new Map(
    allTools
      .filter((tool) => tool.type === 'computer')
      .map((tool) => [tool.name, tool] as const),
  );
  const resolveComputerTool = (toolName: string) => {
    const exactMatch = computerTools.get(toolName);
    if (exactMatch) {
      return exactMatch;
    }

    if (toolName === 'computer') {
      return computerTools.get('computer_use_preview');
    }

    if (toolName === 'computer_use_preview') {
      return computerTools.get('computer');
    }

    return undefined;
  };
  const shellTools = new Map(
    allTools
      .filter((tool): tool is ShellTool => tool.type === 'shell')
      .map((tool) => [tool.name, tool]),
  );
  const applyPatchTools = new Map(
    allTools
      .filter((tool): tool is ApplyPatchTool => tool.type === 'apply_patch')
      .map((tool) => [tool.name, tool]),
  );
  const mcpTools = new Map(
    allTools
      .filter(
        (tool): tool is HostedMCPTool =>
          tool.type === 'hosted_tool' &&
          tool.name === 'hosted_mcp' &&
          tool.providerData?.type === 'mcp',
      )
      .map((tool) => [tool.providerData.server_label, tool]),
  );
  const enabledHandoffs = options.executionHandoffs
    ? options.executionHandoffs
    : await currentAgent.getEnabledHandoffs(state._context);
  const handoffs = new Map(
    enabledHandoffs.map((entry) => [entry.toolName, entry]),
  );

  const result = {
    newItems: serializedProcessedResponse.newItems.map((item) =>
      deserializeItem(item, agentMap),
    ),
    toolsUsed: serializedProcessedResponse.toolsUsed,
    handoffs: serializedProcessedResponse.handoffs.map((serializedHandoff) => {
      const toolName = serializedHandoff.handoff.toolName;
      const resolvedHandoff = handoffs.get(toolName);
      const serializedTargetAgent = serializedHandoff.targetAgent
        ? resolveSerializedAgent(serializedHandoff.targetAgent, agentMap)
        : undefined;
      const targetMatches = serializedTargetAgent
        ? resolvedHandoff?.agent === serializedTargetAgent
        : resolvedHandoff?.agentName === serializedHandoff.handoff.agentName;
      if (!resolvedHandoff || !targetMatches) {
        throw new UserError(`Handoff ${toolName} not found`);
      }
      ensureToolCallerAllowed(
        serializedHandoff.toolCall as protocol.FunctionCallItem,
        undefined,
        resolvedHandoff.toolName,
        currentAgent,
      );

      return {
        toolCall: serializedHandoff.toolCall,
        handoff: resolvedHandoff,
      };
    }),
    functions: await Promise.all(
      serializedProcessedResponse.functions.map(async (functionCall) => {
        const toolIdentity =
          getToolCallDisplayName(functionCall.toolCall) ??
          functionCall.tool.name;
        const exactRuntimeTool = options.executionFunctionToolsByCallId?.get(
          functionCall.toolCall.callId,
        );
        if (
          exactRuntimeTool &&
          !getFunctionToolStateKeyForResolvedCall(
            functionCall.toolCall as protocol.FunctionCallItem,
            exactRuntimeTool,
          )
        ) {
          throwAmbiguousFunctionCallId(
            currentAgent,
            functionCall.toolCall.callId,
            [
              getFunctionToolStateKey(exactRuntimeTool) ??
                exactRuntimeTool.name,
              getFunctionToolStateKeyForCall(
                functionCall.toolCall as protocol.FunctionCallItem,
              ) ?? functionCall.tool.name,
            ],
          );
        }
        const resolvedTool =
          exactRuntimeTool ??
          resolveFunctionToolCall(functionCall.toolCall, tools) ??
          getSerializedFunctionToolPlaceholder({
            agent: currentAgent,
            baseAgentTools,
            serializedTool: functionCall.tool,
            toolCall: functionCall.toolCall,
            toolIdentity,
            allowSerializedExecutionToolPlaceholder,
          });
        if (!resolvedTool) {
          throw new UserError(`Tool ${toolIdentity} not found`);
        }

        ensureToolCallerAllowed(
          functionCall.toolCall as protocol.FunctionCallItem,
          resolvedTool.allowedCallers,
          getFunctionToolQualifiedName(resolvedTool) ?? resolvedTool.name,
          currentAgent,
        );

        return createToolRunFunction({
          toolCall: functionCall.toolCall,
          tool: resolvedTool,
          availableFunctionTools: [
            ...new Set([...tools.values(), resolvedTool]),
          ],
          preserveToolOnExecutionRehydration: Boolean(exactRuntimeTool),
        });
      }),
    ),
    functionToolsNotFound:
      serializedProcessedResponse.functionToolsNotFound ?? [],
    computerActions: serializedProcessedResponse.computerActions.map(
      (computerAction) => {
        const toolName = computerAction.computer.name;
        const computerTool =
          resolveComputerTool(toolName) ??
          getSerializedComputerToolPlaceholder({
            agent: currentAgent,
            baseAgentTools,
            serializedTool: computerAction.computer,
            toolName,
            allowSerializedExecutionToolPlaceholder,
          });
        if (!computerTool) {
          throw new UserError(`Computer tool ${toolName} not found`);
        }

        return {
          toolCall: computerAction.toolCall,
          computer: computerTool,
        };
      },
    ),
    shellActions: (serializedProcessedResponse.shellActions ?? []).map(
      (shellAction) => {
        const toolName = shellAction.shell.name;
        const shellTool =
          shellTools.get(toolName) ??
          getSerializedShellToolPlaceholder({
            agent: currentAgent,
            baseAgentTools,
            serializedTool: shellAction.shell,
            toolName,
            allowSerializedExecutionToolPlaceholder,
          });
        if (!shellTool) {
          throw new UserError(`Shell tool ${toolName} not found`);
        }

        ensureToolCallerAllowed(
          shellAction.toolCall as protocol.ShellCallItem,
          shellTool.allowedCallers,
          shellTool.name,
          currentAgent,
        );

        return {
          toolCall: shellAction.toolCall,
          shell: shellTool,
        };
      },
    ),
    applyPatchActions: (
      serializedProcessedResponse.applyPatchActions ?? []
    ).map((applyPatchAction) => {
      const toolName = applyPatchAction.applyPatch.name;
      const applyPatchTool =
        applyPatchTools.get(toolName) ??
        getSerializedApplyPatchToolPlaceholder({
          agent: currentAgent,
          baseAgentTools,
          serializedTool: applyPatchAction.applyPatch,
          toolName,
          allowSerializedExecutionToolPlaceholder,
        });
      if (!applyPatchTool) {
        throw new UserError(`Apply patch tool ${toolName} not found`);
      }

      ensureToolCallerAllowed(
        applyPatchAction.toolCall as protocol.ApplyPatchCallItem,
        applyPatchTool.allowedCallers,
        applyPatchTool.name,
        currentAgent,
      );

      return {
        toolCall: applyPatchAction.toolCall,
        applyPatch: applyPatchTool,
      };
    }),
    mcpApprovalRequests: (
      serializedProcessedResponse.mcpApprovalRequests ?? []
    ).map((approvalRequest) => {
      const rawItem = approvalRequest.requestItem
        .rawItem as unknown as protocol.HostedToolCallItem;
      const rawServerLabel = rawItem.providerData?.server_label;
      const serializedServerLabel =
        approvalRequest.mcpTool.providerData.server_label;
      const serverLabel =
        typeof rawServerLabel === 'string'
          ? rawServerLabel
          : typeof serializedServerLabel === 'string'
            ? serializedServerLabel
            : undefined;
      if (!serverLabel) {
        throw new UserError('MCP approval request is missing a server label');
      }

      const mcpTool = mcpTools.get(serverLabel);
      if (!mcpTool) {
        throw new UserError(`MCP tool ${serverLabel} not found`);
      }

      ensureToolCallerAllowed(
        rawItem,
        mcpTool.providerData.allowed_callers,
        serverLabel,
        currentAgent,
      );

      return {
        requestItem: new RunToolApprovalItem(rawItem, currentAgent),
        mcpTool,
      };
    }),
  };

  return {
    ...result,
    hasToolsOrApprovalsToRun(): boolean {
      return (
        result.handoffs.length > 0 ||
        result.functions.length > 0 ||
        result.functionToolsNotFound.length > 0 ||
        result.mcpApprovalRequests.length > 0 ||
        result.computerActions.length > 0 ||
        result.shellActions.length > 0 ||
        result.applyPatchActions.length > 0
      );
    },
  };
}

async function getEnabledToolSearchRuntimeTools<TContext>(
  state: RunState<TContext, Agent<any, any>>,
  agent: Agent<any, any>,
): Promise<Tool<TContext>[]> {
  return filterEnabledToolSearchRuntimeTools({
    runtimeTools: state.getToolSearchRuntimeTools(agent),
    runContext: state._context,
    agent,
  });
}
