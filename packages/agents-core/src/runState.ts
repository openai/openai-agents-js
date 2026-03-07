import { z } from 'zod';
import { Agent } from './agent';
import { getAgentToolSourceAgent } from './agentToolSourceRegistry';
import {
  RunMessageOutputItem,
  RunItem,
  RunToolApprovalItem,
  RunToolCallItem,
  RunToolCallOutputItem,
  RunToolSearchCallItem,
  RunToolSearchOutputItem,
  RunReasoningItem,
  RunHandoffCallItem,
  RunHandoffOutputItem,
} from './items';
import type { ModelResponse, ModelSettings } from './model';
import { RunContext } from './runContext';
import { getTurnInput, type ReasoningItemIdPolicy } from './runner/items';
import { AgentToolUseTracker } from './runner/toolUseTracker';
import { nextStepSchema, NextStep } from './runner/steps';
import type { ProcessedResponse } from './runner/types';
import type { AgentSpanData, Span } from './tracing/spans';
import { SystemError, UserError } from './errors';
import { getGlobalTraceProvider } from './tracing/provider';
import { Usage } from './usage';
import { Trace } from './tracing/traces';
import { getCurrentTrace } from './tracing';
import logger from './logger';
import { handoff } from './handoff';
import * as protocol from './types/protocol';
import { AgentInputItem, UnknownContext } from './types';
import type { InputGuardrailResult, OutputGuardrailResult } from './guardrail';
import type {
  ToolInputGuardrailResult,
  ToolOutputGuardrailResult,
} from './toolGuardrail';
import { safeExecute } from './utils/safeExecute';
import {
  getClientToolSearchExecutor,
  getToolSearchRuntimeToolKey,
  HostedMCPTool,
  ShellTool,
  ApplyPatchTool,
  Tool,
} from './tool';
import type { AgentToolInvocation } from './agentToolInvocation';
import {
  getFunctionToolQualifiedName,
  toolQualifiedName,
  resolveFunctionToolCallName,
} from './toolIdentity';
import {
  getToolSearchExecution,
  getToolSearchOutputReplacementKey,
  resolveToolSearchCallId,
} from './utils/toolSearch';
import {
  executeCustomClientToolSearch,
  getClientToolSearchHelper,
} from './runner/toolSearch';

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
 * - 1.8: Adds tool search item variants to serialized run state payloads.
 * - 1.9: Adds batched computer actions and GA computer tool aliasing.
 */
export const CURRENT_SCHEMA_VERSION = '1.9' as const;
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
  CURRENT_SCHEMA_VERSION,
] as const;
type SupportedSchemaVersion = (typeof SUPPORTED_SCHEMA_VERSIONS)[number];
const $schemaVersion = z.enum(SUPPORTED_SCHEMA_VERSIONS);

type ContextOverrideStrategy = 'merge' | 'replace';

type RunStateContextOverrideOptions<TContext> = {
  contextOverride?: RunContext<TContext>;
  contextStrategy?: ContextOverrideStrategy;
};

const serializedAgentSchema = z.object({
  name: z.string(),
});

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
      .or(protocol.ApplyPatchCallResultItem),
    agent: serializedAgentSchema,
    output: z.string(),
  }),
  z.object({
    type: z.literal('reasoning_item'),
    rawItem: protocol.ReasoningItem,
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

const serializedProcessedResponseSchema = z.object({
  newItems: z.array(itemSchema),
  toolsUsed: z.array(z.string()),
  handoffs: z.array(
    z.object({
      toolCall: z.any(),
      handoff: z.any(),
    }),
  ),
  functions: z.array(
    z.object({
      toolCall: z.any(),
      tool: z.any(),
    }),
  ),
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

export const SerializedRunState = z.object({
  $schemaVersion,
  currentTurn: z.number(),
  currentAgent: serializedAgentSchema,
  originalInput: z.string().or(z.array(protocol.ModelItem)),
  modelResponses: z.array(modelResponseSchema),
  context: z.object({
    usage: usageSchema,
    approvals: z.record(
      z.string(),
      z.object({
        approved: z.array(z.string()).or(z.boolean()),
        rejected: z.array(z.string()).or(z.boolean()),
        messages: z.record(z.string(), z.string()).optional(),
        stickyRejectMessage: z.string().optional(),
      }),
    ),
    context: z.record(z.string(), z.any()),
    toolInput: z.any().optional(),
  }),
  toolUseTracker: z.record(z.string(), z.array(z.string())),
  maxTurns: z.number(),
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
  lastProcessedResponse: serializedProcessedResponseSchema.optional(),
  currentTurnPersistedItemCount: z.number().int().min(0).optional(),
  conversationId: z.string().optional(),
  previousResponseId: z.string().optional(),
  reasoningItemIdPolicy: z.enum(['preserve', 'omit']).optional(),
  trace: serializedTraceSchema.nullable(),
});

export type FinalOutputSource = 'error_handler' | 'turn_resolution';

type ToolSearchRuntimeToolEntry<TContext = UnknownContext> = {
  order: number;
  tools: Tool<TContext>[];
};

type ToolSearchRuntimeToolState<TContext = UnknownContext> = {
  anonymousEntries: ToolSearchRuntimeToolEntry<TContext>[];
  keyedEntries: Map<string, ToolSearchRuntimeToolEntry<TContext>>;
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
   * Maximum allowed turns before forcing termination.
   */
  public _maxTurns: number;
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
   * Runtime-only tool_search-loaded tools, scoped by agent name and preserved across turns for
   * the lifetime of this in-memory run.
   */
  public _toolSearchRuntimeToolsByAgentName = new Map<
    string,
    ToolSearchRuntimeToolState<TContext>
  >();

  constructor(
    context: RunContext<TContext>,
    originalInput: string | AgentInputItem[],
    startingAgent: TAgent,
    maxTurns: number,
  ) {
    this._context = context;
    this._agentToolInvocation = undefined;
    this._originalInput = structuredClone(originalInput);
    this._modelResponses = [];
    this._currentAgentSpan = undefined;
    this._currentAgent = startingAgent;
    this._reasoningItemIdPolicy = undefined;
    this._toolUseTracker = new AgentToolUseTracker();
    this._pendingAgentToolRuns = new Map();
    this._generatedItems = [];
    this._currentTurnPersistedItemCount = 0;
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

  private getOrCreateToolSearchRuntimeToolState(
    agentName: string,
  ): ToolSearchRuntimeToolState<TContext> {
    let state = this._toolSearchRuntimeToolsByAgentName.get(agentName);
    if (!state) {
      state = {
        anonymousEntries: [],
        keyedEntries: new Map(),
        nextOrder: 0,
      };
      this._toolSearchRuntimeToolsByAgentName.set(agentName, state);
    }
    return state;
  }

  public recordToolSearchRuntimeTools(
    agent: Agent<any, any>,
    toolSearchOutput: protocol.ToolSearchOutputItem,
    tools: Tool<TContext>[],
  ): void {
    const runtimeState = this.getOrCreateToolSearchRuntimeToolState(agent.name);
    const entry: ToolSearchRuntimeToolEntry<TContext> = {
      order: runtimeState.nextOrder++,
      tools,
    };
    const replacementKey = getToolSearchOutputReplacementKey(toolSearchOutput);
    if (replacementKey) {
      runtimeState.keyedEntries.set(replacementKey, entry);
      return;
    }

    runtimeState.anonymousEntries.push(entry);
  }

  public getToolSearchRuntimeTools(agent: Agent<any, any>): Tool<TContext>[] {
    const runtimeState = this._toolSearchRuntimeToolsByAgentName.get(
      agent.name,
    );
    if (!runtimeState) {
      return [];
    }

    const dedupedTools = new Map<string, Tool<TContext>>();
    const orderedEntries = [
      ...runtimeState.keyedEntries.values(),
      ...runtimeState.anonymousEntries,
    ].sort((a, b) => a.order - b.order);
    let anonymousCounter = 0;

    for (const entry of orderedEntries) {
      for (const tool of entry.tools) {
        const key =
          getToolSearchRuntimeToolKey(tool) ??
          `anonymous:${entry.order}:${anonymousCounter++}`;
        dedupedTools.set(key, tool);
      }
    }

    return [...dedupedTools.values()];
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

  getPendingAgentToolRun(toolName: string, callId: string): string | undefined {
    return this._pendingAgentToolRuns.get(
      this.getPendingAgentToolRunKey(toolName, callId),
    );
  }

  hasPendingAgentToolRun(toolName: string, callId: string): boolean {
    return this._pendingAgentToolRuns.has(
      this.getPendingAgentToolRunKey(toolName, callId),
    );
  }

  setPendingAgentToolRun(
    toolName: string,
    callId: string,
    serializedState: string,
  ) {
    this._pendingAgentToolRuns.set(
      this.getPendingAgentToolRunKey(toolName, callId),
      serializedState,
    );
  }

  clearPendingAgentToolRun(toolName: string, callId: string) {
    this._pendingAgentToolRuns.delete(
      this.getPendingAgentToolRunKey(toolName, callId),
    );
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
    const includeTracingApiKey = options.includeTracingApiKey === true;
    const contextJson = this._context.toJSON();
    const output = {
      $schemaVersion: CURRENT_SCHEMA_VERSION,
      currentTurn: this._currentTurn,
      currentAgent: {
        name: this._currentAgent.name,
      },
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
      toolUseTracker: this._toolUseTracker.toJSON(),
      maxTurns: this._maxTurns,
      currentAgentSpan: this._currentAgentSpan?.toJSON() as any,
      noActiveAgentRun: this._noActiveAgentRun,
      currentTurnInProgress: this._currentTurnInProgress,
      inputGuardrailResults: this._inputGuardrailResults,
      outputGuardrailResults: this._outputGuardrailResults.map((r) => ({
        ...r,
        agent: r.agent.toJSON(),
      })),
      toolInputGuardrailResults: this._toolInputGuardrailResults,
      toolOutputGuardrailResults: this._toolOutputGuardrailResults,
      currentStep: this._currentStep as any,
      lastModelResponse: this._lastTurnResponse as any,
      generatedItems: this._generatedItems.map((item) => item.toJSON() as any),
      pendingAgentToolRuns: Object.fromEntries(
        this._pendingAgentToolRuns.entries(),
      ),
      currentTurnPersistedItemCount: this._currentTurnPersistedItemCount,
      lastProcessedResponse: this._lastProcessedResponse as any,
      conversationId: this._conversationId,
      previousResponseId: this._previousResponseId,
      reasoningItemIdPolicy: this._reasoningItemIdPolicy,
      trace: this._trace
        ? (this._trace.toJSON({ includeTracingApiKey }) as any)
        : null,
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
  const stateJson = SerializedRunState.parse(jsonResult);
  assertSchemaVersionSupportsToolSearch(
    currentSchemaVersion as SupportedSchemaVersion,
    stateJson,
  );
  return buildRunStateFromJson(initialAgent, stateJson, options);
}

function assertSchemaVersionSupportsToolSearch(
  schemaVersion: SupportedSchemaVersion,
  stateJson: z.infer<typeof SerializedRunState>,
): void {
  if (schemaVersion === '1.8' || schemaVersion === '1.9') {
    return;
  }

  if (!containsSerializedToolSearchState(stateJson)) {
    return;
  }

  throw new UserError(
    `Run state schema version ${schemaVersion} does not support tool_search items. Please reserialize the run state with schema ${CURRENT_SCHEMA_VERSION}.`,
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
    | z.infer<typeof serializedProcessedResponseSchema>
    | undefined,
): boolean {
  return containsToolSearchRunItems(processedResponse?.newItems);
}

function isToolSearchProtocolType(type: unknown): boolean {
  return type === 'tool_search_call' || type === 'tool_search_output';
}

function collectSerializedRuntimeToolKeys(
  value: unknown,
  runtimeToolKeys: Set<string>,
  namespace?: string,
): void {
  if (!value || typeof value !== 'object') {
    return;
  }

  const candidate = value as {
    type?: unknown;
    name?: unknown;
    namespace?: unknown;
    tools?: unknown;
    server_label?: unknown;
    providerData?: unknown;
  };

  if (candidate.type === 'namespace' && Array.isArray(candidate.tools)) {
    const nestedNamespace =
      typeof candidate.name === 'string' && candidate.name.length > 0
        ? candidate.name
        : namespace;
    for (const nestedTool of candidate.tools) {
      collectSerializedRuntimeToolKeys(
        nestedTool,
        runtimeToolKeys,
        nestedNamespace,
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
      return;
    }

    runtimeToolKeys.add(
      toolQualifiedName(candidate.name, explicitNamespace) ?? candidate.name,
    );
    return;
  }

  if (
    candidate.type === 'mcp' &&
    typeof candidate.server_label === 'string' &&
    candidate.server_label.length > 0
  ) {
    runtimeToolKeys.add(`mcp:${candidate.server_label}`);
    return;
  }

  if (!candidate.providerData || typeof candidate.providerData !== 'object') {
    return;
  }

  collectSerializedRuntimeToolKeys(
    candidate.providerData,
    runtimeToolKeys,
    explicitNamespace,
  );
}

function getSerializedRuntimeToolKeys(
  toolSearchOutput: protocol.ToolSearchOutputItem,
): Set<string> {
  const runtimeToolKeys = new Set<string>();
  for (const tool of toolSearchOutput.tools) {
    collectSerializedRuntimeToolKeys(tool, runtimeToolKeys);
  }
  return runtimeToolKeys;
}

function getRuntimeToolKeys<TContext>(
  runtimeTools: Tool<TContext>[],
  options: { allowUnsupported?: boolean } = {},
): Set<string> {
  const runtimeToolKeys = new Set<string>();
  for (const tool of runtimeTools) {
    const runtimeToolKey = getToolSearchRuntimeToolKey(tool);
    if (!runtimeToolKey) {
      if (options.allowUnsupported) {
        continue;
      }
      throw new UserError(
        'Client tool_search execute() returned an unsupported runtime tool during RunState rehydration.',
      );
    }
    runtimeToolKeys.add(runtimeToolKey);
  }
  return runtimeToolKeys;
}

function formatRuntimeToolKeys(runtimeToolKeys: Set<string>): string {
  return [...runtimeToolKeys].sort().join(', ');
}

function assertRuntimeToolKeysMatch<TContext>(args: {
  agent: Agent<any, any>;
  toolSearchCall: protocol.ToolSearchCallItem;
  expectedRuntimeToolKeys: Set<string>;
  runtimeTools: Tool<TContext>[];
}): void {
  const { agent, toolSearchCall, expectedRuntimeToolKeys, runtimeTools } = args;
  if (expectedRuntimeToolKeys.size === 0) {
    return;
  }

  const actualRuntimeToolKeys = getRuntimeToolKeys(runtimeTools);
  const hasExpectedKeys = [...expectedRuntimeToolKeys].every((runtimeToolKey) =>
    actualRuntimeToolKeys.has(runtimeToolKey),
  );
  const hasActualKeys = [...actualRuntimeToolKeys].every((runtimeToolKey) =>
    expectedRuntimeToolKeys.has(runtimeToolKey),
  );
  if (hasExpectedKeys && hasActualKeys) {
    return;
  }

  const callId = resolveToolSearchCallId(toolSearchCall);
  throw new UserError(
    `RunState cannot resume custom client tool_search call ${callId} for agent ${agent.name} because the registered execute callback returned runtime tools [${formatRuntimeToolKeys(actualRuntimeToolKeys)}] but the serialized state expects [${formatRuntimeToolKeys(expectedRuntimeToolKeys)}].`,
  );
}

async function getConfiguredAgentTools<TContext>(args: {
  agent: Agent<TContext, any>;
  context: RunContext<TContext>;
  configuredToolsByAgentName: Map<string, Tool<TContext>[]>;
}): Promise<Tool<TContext>[]> {
  const { agent, context, configuredToolsByAgentName } = args;
  const existing = configuredToolsByAgentName.get(agent.name);
  if (existing) {
    return existing;
  }

  const configuredTools = (await agent.getAllTools(
    context,
  )) as Tool<TContext>[];
  configuredToolsByAgentName.set(agent.name, configuredTools);
  return configuredTools;
}

async function rehydrateToolSearchRuntimeTools<
  TContext,
  TAgent extends Agent<any, any>,
>(state: RunState<TContext, TAgent>): Promise<void> {
  const configuredToolsByAgentName = new Map<string, Tool<TContext>[]>();
  const pendingToolSearchCalls = new Map<
    string,
    {
      agent: Agent<TContext, any>;
      toolSearchCall: protocol.ToolSearchCallItem;
      runtimeTools?: Tool<TContext>[];
    }
  >();

  for (const item of state._generatedItems) {
    if (item instanceof RunToolSearchCallItem) {
      if (getToolSearchExecution(item.rawItem) === 'server') {
        continue;
      }

      const callId = resolveToolSearchCallId(item.rawItem);
      pendingToolSearchCalls.set(`${item.agent.name}:${callId}`, {
        agent: item.agent as Agent<TContext, any>,
        toolSearchCall: item.rawItem,
      });
      continue;
    }

    if (!(item instanceof RunToolSearchOutputItem)) {
      continue;
    }

    if (getToolSearchExecution(item.rawItem) === 'server') {
      continue;
    }

    const configuredTools = await getConfiguredAgentTools({
      agent: item.agent as Agent<TContext, any>,
      context: state._context,
      configuredToolsByAgentName,
    });
    const configuredToolKeys = getRuntimeToolKeys(configuredTools, {
      allowUnsupported: true,
    });
    const expectedRuntimeToolKeys = new Set(
      [...getSerializedRuntimeToolKeys(item.rawItem)].filter(
        (runtimeToolKey) => !configuredToolKeys.has(runtimeToolKey),
      ),
    );
    if (expectedRuntimeToolKeys.size === 0) {
      continue;
    }

    const callId = resolveToolSearchCallId(item.rawItem);
    const pendingCall = pendingToolSearchCalls.get(
      `${item.agent.name}:${callId}`,
    );
    if (!pendingCall) {
      throw new UserError(
        `RunState cannot resume custom client tool_search output ${callId} for agent ${item.agent.name} because the serialized state is missing the matching tool_search call item.`,
      );
    }

    if (!pendingCall.runtimeTools) {
      const availableTools = [
        ...configuredTools,
        ...state.getToolSearchRuntimeTools(pendingCall.agent),
      ];
      const toolSearchTool = getClientToolSearchHelper(configuredTools);
      if (!toolSearchTool || !getClientToolSearchExecutor(toolSearchTool)) {
        throw new UserError(
          `RunState cannot resume custom client tool_search call ${callId} for agent ${pendingCall.agent.name} because the agent no longer provides toolSearchTool({ execution: "client", execute }).`,
        );
      }

      const { runtimeTools } = await executeCustomClientToolSearch({
        agent: pendingCall.agent,
        runContext: state._context,
        toolSearchCall: pendingCall.toolSearchCall,
        toolSearchTool,
        tools: availableTools,
      });
      const rehydratedRuntimeTools = runtimeTools.filter((tool) => {
        const runtimeToolKey = getToolSearchRuntimeToolKey(tool);
        if (!runtimeToolKey) {
          throw new UserError(
            'Client tool_search execute() returned an unsupported runtime tool during RunState rehydration.',
          );
        }
        return !configuredToolKeys.has(runtimeToolKey);
      });
      assertRuntimeToolKeysMatch({
        agent: pendingCall.agent,
        toolSearchCall: pendingCall.toolSearchCall,
        expectedRuntimeToolKeys,
        runtimeTools: rehydratedRuntimeTools,
      });
      pendingCall.runtimeTools = rehydratedRuntimeTools;
    }

    const runtimeTools = pendingCall.runtimeTools;
    if (!runtimeTools) {
      throw new UserError(
        `RunState cannot resume custom client tool_search call ${callId} for agent ${pendingCall.agent.name} because no runtime tools were rehydrated.`,
      );
    }

    state.recordToolSearchRuntimeTools(
      pendingCall.agent,
      item.rawItem,
      runtimeTools,
    );
  }
}

async function buildRunStateFromJson<TContext, TAgent extends Agent<any, any>>(
  initialAgent: TAgent,
  stateJson: z.infer<typeof SerializedRunState>,
  options: RunStateContextOverrideOptions<TContext> = {},
): Promise<RunState<TContext, TAgent>> {
  const agentMap = buildAgentMap(initialAgent);
  const contextOverride = options.contextOverride;
  const contextStrategy = options.contextStrategy ?? 'merge';

  //
  // Rebuild the context
  //
  const context =
    contextOverride ??
    new RunContext<TContext>(stateJson.context.context as TContext);
  if (contextOverride) {
    if (contextStrategy === 'merge') {
      context._mergeApprovals(stateJson.context.approvals);
    }
  } else {
    context._rebuildApprovals(stateJson.context.approvals);
  }
  const shouldRestoreToolInput =
    !contextOverride || contextStrategy === 'merge';
  if (
    shouldRestoreToolInput &&
    typeof stateJson.context.toolInput !== 'undefined' &&
    typeof context.toolInput === 'undefined'
  ) {
    context.toolInput = stateJson.context.toolInput;
  }

  //
  // Find the current agent from the initial agent
  //
  const currentAgent = agentMap.get(stateJson.currentAgent.name);
  if (!currentAgent) {
    throw new UserError(`Agent ${stateJson.currentAgent.name} not found`);
  }

  const state = new RunState<TContext, TAgent>(
    context,
    '',
    currentAgent as TAgent,
    stateJson.maxTurns,
  );
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
    state._toolUseTracker.addToolUse(
      agentMap.get(agentName) as TAgent,
      toolNames,
      { allowEmpty: true },
    );
  }

  state._pendingAgentToolRuns = new Map(
    Object.entries(stateJson.pendingAgentToolRuns ?? {}),
  );

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
    agent: agentMap.get(r.agent.name) as Agent<any, any>,
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

  state._generatedItems = stateJson.generatedItems.map((item) =>
    deserializeItem(item, agentMap),
  );
  state._currentTurnPersistedItemCount =
    stateJson.currentTurnPersistedItemCount ?? 0;
  await rehydrateToolSearchRuntimeTools(state);
  state._lastProcessedResponse = stateJson.lastProcessedResponse
    ? await deserializeProcessedResponse(
        agentMap,
        state,
        stateJson.lastProcessedResponse,
      )
    : undefined;

  if (stateJson.currentStep?.type === 'next_step_handoff') {
    state._currentStep = {
      type: 'next_step_handoff',
      newAgent: agentMap.get(stateJson.currentStep.newAgent.name) as TAgent,
    };
  } else if (stateJson.currentStep?.type === 'next_step_interruption') {
    state._currentStep = {
      type: 'next_step_interruption',
      data: {
        ...stateJson.currentStep.data,
        interruptions: deserializeInterruptions(
          stateJson.currentStep.data?.interruptions,
          agentMap,
          state._currentAgent,
        ),
      },
    };
  }
  return state;
}

/**
 * @internal
 */
export function buildAgentMap(
  initialAgent: Agent<any, any>,
): Map<string, Agent<any, any>> {
  const map = new Map<string, Agent<any, any>>();
  const queue: Agent<any, any>[] = [initialAgent];

  while (queue.length > 0) {
    const currentAgent = queue.shift()!;
    if (map.has(currentAgent.name)) {
      continue;
    }
    map.set(currentAgent.name, currentAgent);

    for (const handoff of currentAgent.handoffs) {
      if (handoff instanceof Agent) {
        if (!map.has(handoff.name)) {
          queue.push(handoff);
        }
      } else if (handoff.agent) {
        if (!map.has(handoff.agent.name)) {
          queue.push(handoff.agent);
        }
      }
    }

    for (const tool of currentAgent.tools) {
      const sourceAgent = getAgentToolSourceAgent(tool);
      if (sourceAgent && !map.has(sourceAgent.name)) {
        queue.push(sourceAgent);
      }
    }
  }

  return map;
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
        agentMap.get(serializedItem.agent.name) as Agent<any, any>,
      );
    case 'tool_search_call_item':
      return new RunToolSearchCallItem(
        serializedItem.rawItem,
        agentMap.get(serializedItem.agent.name) as Agent<any, any>,
      );
    case 'tool_search_output_item':
      return new RunToolSearchOutputItem(
        serializedItem.rawItem,
        agentMap.get(serializedItem.agent.name) as Agent<any, any>,
      );
    case 'tool_call_item':
      return new RunToolCallItem(
        serializedItem.rawItem,
        agentMap.get(serializedItem.agent.name) as Agent<any, any>,
      );
    case 'tool_call_output_item':
      return new RunToolCallOutputItem(
        serializedItem.rawItem,
        agentMap.get(serializedItem.agent.name) as Agent<any, any>,
        serializedItem.output,
      );
    case 'reasoning_item':
      return new RunReasoningItem(
        serializedItem.rawItem,
        agentMap.get(serializedItem.agent.name) as Agent<any, any>,
      );
    case 'handoff_call_item':
      return new RunHandoffCallItem(
        serializedItem.rawItem,
        agentMap.get(serializedItem.agent.name) as Agent<any, any>,
      );
    case 'handoff_output_item':
      return new RunHandoffOutputItem(
        serializedItem.rawItem,
        agentMap.get(serializedItem.sourceAgent.name) as Agent<any, any>,
        agentMap.get(serializedItem.targetAgent.name) as Agent<any, any>,
      );
    case 'tool_approval_item':
      return new RunToolApprovalItem(
        serializedItem.rawItem,
        agentMap.get(serializedItem.agent.name) as Agent<any, any>,
        serializedItem.toolName,
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
      const mappedAgent = agentMap.get(parsed.data.agent.name) ?? currentAgent;
      return new RunToolApprovalItem(
        parsed.data.rawItem,
        mappedAgent,
        parsed.data.toolName,
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
    agent?: { name?: unknown };
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
  const mappedAgent =
    (agentName ? agentMap.get(agentName) : undefined) ?? currentAgent;
  const toolName =
    typeof value.toolName === 'string'
      ? value.toolName
      : typeof rawItem.name === 'string'
        ? rawItem.name
        : undefined;

  return new RunToolApprovalItem(
    value.rawItem as RunToolApprovalItem['rawItem'],
    mappedAgent,
    toolName,
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

/**
 * @internal
 */
async function deserializeProcessedResponse<TContext = UnknownContext>(
  agentMap: Map<string, Agent<any, any>>,
  state: RunState<TContext, Agent<any, any>>,
  serializedProcessedResponse: z.infer<
    typeof serializedProcessedResponseSchema
  >,
): Promise<ProcessedResponse<TContext>> {
  const currentAgent = state._currentAgent;
  const configuredTools = await currentAgent.getAllTools(state._context);
  const allTools = [
    ...(configuredTools as Tool<TContext>[]),
    ...state.getToolSearchRuntimeTools(currentAgent),
  ];
  const tools = new Map(
    allTools
      .filter((tool) => tool.type === 'function')
      .map((tool) => [getFunctionToolQualifiedName(tool) ?? tool.name, tool]),
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
  const handoffs = new Map(
    currentAgent.handoffs.map((entry) => {
      if (entry instanceof Agent) {
        return [entry.name, handoff(entry)];
      }

      return [entry.toolName, entry];
    }),
  );

  const result = {
    newItems: serializedProcessedResponse.newItems.map((item) =>
      deserializeItem(item, agentMap),
    ),
    toolsUsed: serializedProcessedResponse.toolsUsed,
    handoffs: serializedProcessedResponse.handoffs.map((handoff) => {
      if (!handoffs.has(handoff.handoff.toolName)) {
        throw new UserError(`Handoff ${handoff.handoff.toolName} not found`);
      }

      return {
        toolCall: handoff.toolCall,
        handoff: handoffs.get(handoff.handoff.toolName)!,
      };
    }),
    functions: await Promise.all(
      serializedProcessedResponse.functions.map(async (functionCall) => {
        const toolIdentity =
          resolveFunctionToolCallName(functionCall.toolCall, tools) ??
          functionCall.tool.name;
        if (!tools.has(toolIdentity)) {
          throw new UserError(`Tool ${toolIdentity} not found`);
        }

        return {
          toolCall: functionCall.toolCall,
          tool: tools.get(toolIdentity)!,
        };
      }),
    ),
    computerActions: serializedProcessedResponse.computerActions.map(
      (computerAction) => {
        const toolName = computerAction.computer.name;
        const computerTool = resolveComputerTool(toolName);
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
        if (!shellTools.has(toolName)) {
          throw new UserError(`Shell tool ${toolName} not found`);
        }

        return {
          toolCall: shellAction.toolCall,
          shell: shellTools.get(toolName)!,
        };
      },
    ),
    applyPatchActions: (
      serializedProcessedResponse.applyPatchActions ?? []
    ).map((applyPatchAction) => {
      const toolName = applyPatchAction.applyPatch.name;
      if (!applyPatchTools.has(toolName)) {
        throw new UserError(`Apply patch tool ${toolName} not found`);
      }

      return {
        toolCall: applyPatchAction.toolCall,
        applyPatch: applyPatchTools.get(toolName)!,
      };
    }),
    mcpApprovalRequests: (
      serializedProcessedResponse.mcpApprovalRequests ?? []
    ).map((approvalRequest) => ({
      requestItem: new RunToolApprovalItem(
        approvalRequest.requestItem
          .rawItem as unknown as protocol.HostedToolCallItem,
        currentAgent,
      ),
      mcpTool: approvalRequest.mcpTool as unknown as HostedMCPTool,
    })),
  };

  return {
    ...result,
    hasToolsOrApprovalsToRun(): boolean {
      return (
        result.handoffs.length > 0 ||
        result.functions.length > 0 ||
        result.mcpApprovalRequests.length > 0 ||
        result.computerActions.length > 0 ||
        result.shellActions.length > 0 ||
        result.applyPatchActions.length > 0
      );
    },
  };
}
