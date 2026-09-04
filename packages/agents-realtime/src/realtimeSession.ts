import {
  Agent,
  getTransferMessage,
  Handoff,
  ModelBehaviorError,
  OutputGuardrailFunctionArgs,
  OutputGuardrailTripwireTriggered,
  RunContext,
  Usage,
  RunToolApprovalItem,
  UserError,
  invokeFunctionTool,
  type FunctionTool,
  type ToolErrorFormatterArgs,
  type ToolErrorFormatter,
} from '@openai/agents-core';
import { RuntimeEventEmitter } from '@openai/agents-core/_shims';
import { isZodObject, toSmartString } from '@openai/agents-core/utils';
import {
  getSafeErrorType,
  getBoundToolInvocationRejectionMessage,
  getHostedMcpApprovalToolName,
  hasDynamicFunctionToolApprovalPolicy,
  hasInspectableFunctionToolArguments,
  getToolInvocationApproval,
  getToolInvocationRejectionMessage,
  logToolActionError,
  validateHandoffToolInvocation,
  validateToolInvocationApproval,
  validateToolInvocationName,
  requireBooleanApprovalResult,
} from '@openai/agents-core/utils/internal';
import type {
  RealtimeSessionConfig,
  RealtimeSessionConfigDefinition,
  RealtimeToolDefinition,
  RealtimeTracingConfig,
  RealtimeUserInput,
  HostedMCPToolDefinition,
  RealtimeMcpToolInfo,
} from './clientMessages';
import {
  defineRealtimeOutputGuardrail,
  getRealtimeGuardrailFeedbackMessage,
  getRealtimeGuardrailSettings,
  RealtimeOutputGuardrail,
  RealtimeOutputGuardrailDefinition,
  RealtimeOutputGuardrailSettings,
} from './guardrail';
import { RealtimeItem } from './items';
import {
  DEFAULT_OPENAI_REALTIME_SESSION_CONFIG,
  OpenAIRealtimeModels,
} from './openaiRealtimeBase';
import { OpenAIRealtimeWebRTC } from './openaiRealtimeWebRtc';
import { OpenAIRealtimeWebSocket } from './openaiRealtimeWebsocket';
import { RealtimeAgent } from './realtimeAgent';
import { RealtimeSessionEventTypes } from './realtimeSessionEvents';
import type { ApiKey, RealtimeTransportLayer } from './transportLayer';
import type {
  TransportLayerOutputTextDelta,
  TransportLayerResponseStarted,
  TransportLayerTranscriptDelta,
  TransportToolCallEvent,
} from './transportLayerEvents';
import type { InputAudioTranscriptionCompletedEvent } from './transportLayerEvents';
import {
  approvalItemToRealtimeApprovalItem,
  getLastTextFromAudioOutputMessage,
  hasWebRTCSupport,
  realtimeApprovalItemToApprovalItem,
  updateRealtimeHistory,
} from './utils';
import logger from './logger';
import {
  isBackgroundResult,
  isValidRealtimeTool,
  toRealtimeToolDefinition,
  validateRealtimeToolNames,
} from './tool';
import {
  runToolInputGuardrails,
  runToolOutputGuardrails,
} from '@openai/agents-core';

/**
 * The context data for a realtime session. This is the context data that is passed to the agent.
 * The RealtimeSession will automatically add the current snapshot of the history to the context.
 */
export type RealtimeContextData<TContext = unknown> = TContext & {
  history: RealtimeItem[];
};

export type RealtimeToolExecutionConfig = {
  /**
   * Runs function tool input guardrails before emitting a pending human approval interruption.
   * The same guardrails still run again immediately before tool execution after approval.
   */
  preApprovalInputGuardrails?: boolean;
};

export type RealtimeSessionOptions<TContext = unknown> = {
  /**
   * The API key to use for the connection. Pass a function to lazily load the API key
   */
  apiKey: ApiKey;

  /**
   * The transport layer to use.
   */
  transport: 'webrtc' | 'websocket' | RealtimeTransportLayer;

  /**
   * The model to use.
   */
  model?: OpenAIRealtimeModels | (string & {});

  /**
   * Additional context to pass to the agent
   */
  context?: TContext;

  /**
   * Any output guardrails to apply to agent output in parallel
   */
  outputGuardrails?: RealtimeOutputGuardrail[];

  /**
   * Configure the behavior of your guardrails
   */
  outputGuardrailSettings?: RealtimeOutputGuardrailSettings;

  /**
   * Additional session config options. Overrides default client options.
   */
  config?: Partial<RealtimeSessionConfig>;

  /**
   * SDK-side execution settings for local realtime tool calls.
   */
  toolExecution?: RealtimeToolExecutionConfig;

  /**
   * Whether the history copy should include a local copy of the audio data. By default it is not
   * included in the history to save runtime memory on the client. If you wish to keep this data
   * you can enable this option.
   */
  historyStoreAudio?: boolean;

  /**
   * Whether tracing is disabled for this session. If disabled, we will not trace the agent run.
   */
  tracingDisabled?: boolean;

  /**
   * A group identifier to use for tracing, to link multiple traces together. For example, if you
   * want to connect your RealtimeSession traces with those of a backend text-based agent run.
   */
  groupId?: string;

  /**
   * An optional dictionary of additional metadata to include with the trace.
   */
  traceMetadata?: Record<string, any>;

  /**
   * The workflow name to use for tracing.
   */
  workflowName?: string;

  /**
   * Whether to automatically trigger a response for MCP tool calls.
   */
  automaticallyTriggerResponseForMcpToolCalls?: boolean;

  /**
   * Formats tool error messages that are returned to the model.
   * Returning `undefined` falls back to the SDK default message.
   */
  toolErrorFormatter?: ToolErrorFormatter<RealtimeContextData<TContext>>;
};

export type RealtimeSessionConnectOptions = {
  /**
   * The API key to use for the connection. Pass a function to lazily load the API key. Overrides
   * default client options.
   */
  apiKey: string | (() => string | Promise<string>);

  /**
   * The model to use for the connection.
   */
  model?: OpenAIRealtimeModels | (string & {});

  /**
   * The URL to use for the connection.
   */
  url?: string;

  /**
   * The call ID to attach to when connecting to a SIP-initiated session.
   */
  callId?: string;
};

function cloneDefaultSessionConfig(): Partial<RealtimeSessionConfig> {
  return JSON.parse(
    JSON.stringify(DEFAULT_OPENAI_REALTIME_SESSION_CONFIG),
  ) as Partial<RealtimeSessionConfig>;
}

function validateRealtimeToolExecutionConfig(
  config: RealtimeToolExecutionConfig | undefined,
): RealtimeToolExecutionConfig | undefined {
  if (
    typeof config?.preApprovalInputGuardrails !== 'undefined' &&
    typeof config.preApprovalInputGuardrails !== 'boolean'
  ) {
    throw new UserError(
      'toolExecution.preApprovalInputGuardrails must be a boolean when provided.',
    );
  }
  return config;
}

const TOOL_APPROVAL_REJECTION_MESSAGE = 'Tool execution was not approved.';

type SessionRealtimeAgent<TBaseContext> =
  | RealtimeAgent<TBaseContext>
  | RealtimeAgent<RealtimeContextData<TBaseContext>>;

type RealtimeFunctionTool<TBaseContext> = FunctionTool<
  RealtimeContextData<TBaseContext>,
  any,
  unknown
>;

type RealtimeDispatchSnapshot<TBaseContext> = {
  agent: SessionRealtimeAgent<TBaseContext>;
  functionTools: RealtimeFunctionTool<TBaseContext>[];
  handoffs: Handoff[];
};

type PreparedRealtimeAgentState<TBaseContext> = {
  agent: SessionRealtimeAgent<TBaseContext>;
  toolDefinitions?: RealtimeToolDefinition[];
  dispatchSnapshot: RealtimeDispatchSnapshot<TBaseContext>;
};

type PendingRealtimeFunctionCall<TBaseContext> = {
  toolCall: TransportToolCallEvent;
  tool: RealtimeFunctionTool<TBaseContext>;
  agent: SessionRealtimeAgent<TBaseContext>;
  dispatchSnapshot: RealtimeDispatchSnapshot<TBaseContext>;
  approvalItem: RunToolApprovalItem;
  fingerprint: string;
  connectionGeneration: number;
};

type CompletedRealtimeToolCall = {
  fingerprint: string;
  output: string;
  startResponse: boolean;
};

type ActiveRealtimeToolCall = {
  fingerprint: string;
  completion: Promise<CompletedRealtimeToolCall | undefined>;
  resolve: (outcome: CompletedRealtimeToolCall | undefined) => void;
};

type CanonicalRealtimeToolInvocation = {
  callId: string;
  fingerprint: string;
  connectionGeneration: number;
};

type IssuedRealtimeApproval<TBaseContext> = {
  kind: 'function' | 'mcp';
  connectionGeneration: number;
  agent: SessionRealtimeAgent<TBaseContext>;
  callId: string;
  fingerprint: string;
  toolName: string;
  rawName: string;
  tool?: RealtimeFunctionTool<TBaseContext>;
  trustedApprovalItem: RunToolApprovalItem;
  decisionState: 'pending' | 'sending' | 'decided';
};

type OutputGuardrailDeltaSource = 'audio' | 'text';

type OutputGuardrailDeltaState = {
  text: string;
  lastRunIndex: number;
};

function normalizeRealtimeFunctionCallId(
  toolCall: TransportToolCallEvent,
): TransportToolCallEvent {
  const callId = toolCall.callId || toolCall.id || '';
  return callId === toolCall.callId ? toolCall : { ...toolCall, callId };
}

function getStartedResponseId(
  event: TransportLayerResponseStarted,
): string | undefined {
  const response = event.providerData?.response;
  if (typeof response !== 'object' || response === null) {
    return undefined;
  }
  const responseId = (response as { id?: unknown }).id;
  return typeof responseId === 'string' ? responseId : undefined;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A `RealtimeSession` is the cornerstone of building Voice Agents. It's the equivalent of a
 * Runner in text-based agents except that it automatically handles multiple turns by maintaining a
 * connection with the underlying transport layer.
 *
 * The session handles managing the local history copy, executes tools, runs output guardrails, and
 * facilitates handoffs.
 *
 * The actual audio handling and generation of model responses is handled by the underlying
 * transport layer. By default if you are using a browser with WebRTC support, the session will
 * automatically use the WebRTC version of the OpenAI Realtime API. On the server or if you pass
 * `websocket` as the transport layer, the session will establish a connection using WebSockets.
 *
 * In the case of WebRTC, in the browser, the transport layer will also automatically configure the
 * microphone and audio output to be used by the session.
 *
 * You can also create a transport layer instance yourself and pass it in to have more control over
 * the configuration or even extend the existing ones. Check out the `TwilioRealtimeTransportLayer`
 * for an example of how to create a custom transport layer.
 *
 * @example
 * ```ts
 * const agent = new RealtimeAgent({
 *   name: 'my-agent',
 *   instructions: 'You are a helpful assistant that can answer questions and help with tasks.',
 * })
 *
 * const session = new RealtimeSession(agent);
 * session.connect({
 *   apiKey: 'your-api-key',
 * });
 * ```
 */
export class RealtimeSession<
  TBaseContext = unknown,
> extends RuntimeEventEmitter<RealtimeSessionEventTypes<TBaseContext>> {
  #transport: RealtimeTransportLayer;
  #currentAgent: SessionRealtimeAgent<TBaseContext>;
  #currentTools?: RealtimeToolDefinition[];
  #currentDispatchSnapshot?: RealtimeDispatchSnapshot<TBaseContext>;
  #responseDispatchSnapshots = new Map<
    string,
    RealtimeDispatchSnapshot<TBaseContext>
  >();
  #pendingResponseDispatchSnapshot:
    RealtimeDispatchSnapshot<TBaseContext> | undefined;
  #pendingFunctionCalls = new Map<
    SessionRealtimeAgent<TBaseContext>,
    Map<string, PendingRealtimeFunctionCall<TBaseContext>>
  >();
  #issuedApprovals = new WeakMap<
    RunToolApprovalItem,
    IssuedRealtimeApproval<TBaseContext>
  >();
  #mcpApprovalInvocations = new Map<
    SessionRealtimeAgent<TBaseContext>,
    Map<string, IssuedRealtimeApproval<TBaseContext>>
  >();
  #completedToolCalls = new Map<
    SessionRealtimeAgent<TBaseContext>,
    Map<string, CompletedRealtimeToolCall>
  >();
  #sendingToolCallOutputs = new Map<
    SessionRealtimeAgent<TBaseContext>,
    Set<string>
  >();
  #activeToolCalls = new Map<
    SessionRealtimeAgent<TBaseContext>,
    Map<string, ActiveRealtimeToolCall>
  >();
  #context: RunContext<RealtimeContextData<TBaseContext>>;
  #outputGuardrails: RealtimeOutputGuardrailDefinition[] = [];
  #outputGuardrailSettings: RealtimeOutputGuardrailSettings;
  #outputGuardrailDeltaState = new Map<
    string,
    Map<string, OutputGuardrailDeltaState>
  >();
  #history: RealtimeItem[] = [];
  #shouldIncludeAudioData: boolean;
  #interruptedByGuardrail: Record<string, boolean> = {};
  #activeResponseId: string | undefined;
  #responseGeneration = 0;
  #connectionGeneration = 0;
  #connectedGeneration: number | undefined;
  #audioStarted = false;
  // Tracks all MCP tools fetched per server label (from mcp_list_tools results).
  #allMcpToolsByServer: Map<string, RealtimeMcpToolInfo[]> = new Map();
  // Tracks currently available MCP tools based on the active agent's configured server_labels.
  #availableMcpTools: RealtimeMcpToolInfo[] = [];
  // Keeps track of the last full session config we sent (camelCase keys) so that
  // subsequent updates (e.g. during agent handoffs) preserve properties that are
  // not explicitly recalculated here (such as inputAudioFormat, outputAudioFormat,
  // modalities, speed, toolChoice, turnDetection, etc.). Without this, updating
  // the agent would drop audio format overrides (e.g. g711_ulaw) and revert to
  // transport defaults causing issues for integrations like Twilio.
  #lastSessionConfig: Partial<RealtimeSessionConfig> | null =
    cloneDefaultSessionConfig();
  #automaticallyTriggerResponseForMcpToolCalls: boolean = true;
  #toolExecution: RealtimeToolExecutionConfig | undefined;
  #eventListenersAttached = false;

  constructor(
    public readonly initialAgent:
      | RealtimeAgent<TBaseContext>
      | RealtimeAgent<RealtimeContextData<TBaseContext>>,
    public readonly options: Partial<RealtimeSessionOptions<TBaseContext>> = {},
  ) {
    super();

    if (
      (typeof options.transport === 'undefined' && hasWebRTCSupport()) ||
      options.transport === 'webrtc'
    ) {
      this.#transport = new OpenAIRealtimeWebRTC();
    } else if (
      options.transport === 'websocket' ||
      typeof options.transport === 'undefined'
    ) {
      this.#transport = new OpenAIRealtimeWebSocket();
    } else {
      this.#transport = options.transport;
    }

    this.#currentAgent = initialAgent;
    this.#context = new RunContext<RealtimeContextData<TBaseContext>>({
      ...(options.context ?? {}),
      history: this.#history,
    } as RealtimeContextData<TBaseContext>);
    this.#outputGuardrails = (options.outputGuardrails ?? []).map(
      defineRealtimeOutputGuardrail,
    );
    this.#outputGuardrailSettings = getRealtimeGuardrailSettings(
      options.outputGuardrailSettings ?? {},
    );
    this.#shouldIncludeAudioData = options.historyStoreAudio ?? false;
    this.#automaticallyTriggerResponseForMcpToolCalls =
      options.automaticallyTriggerResponseForMcpToolCalls ?? true;
    this.#toolExecution = validateRealtimeToolExecutionConfig(
      options.toolExecution,
    );
  }

  /**
   * The transport layer used by the session.
   */
  get transport(): RealtimeTransportLayer {
    return this.#transport;
  }

  /**
   * The current agent in the session.
   */
  get currentAgent():
    | RealtimeAgent<TBaseContext>
    | RealtimeAgent<RealtimeContextData<TBaseContext>> {
    return this.#currentAgent;
  }

  /**
   * The current usage of the session.
   */
  get usage(): Usage {
    return this.#context.usage;
  }

  /**
   * The current context of the session.
   */
  get context(): RunContext<RealtimeContextData<TBaseContext>> {
    return this.#context;
  }

  /**
   * Whether the session is muted. Might be `null` if the underlying transport layer does not
   * support muting.
   */
  get muted(): boolean | null {
    return this.#transport.muted;
  }

  /**
   * The history of the session.
   */
  get history(): RealtimeItem[] {
    return this.#history;
  }

  get availableMcpTools(): RealtimeMcpToolInfo[] {
    return this.#availableMcpTools;
  }

  async #prepareAgent(
    agent: SessionRealtimeAgent<TBaseContext>,
  ): Promise<PreparedRealtimeAgentState<TBaseContext>> {
    const [handoffs, agentTools] = await Promise.all([
      (agent as RealtimeAgent<TBaseContext>).getEnabledHandoffs(this.#context),
      (agent as RealtimeAgent<TBaseContext>).getAllTools(this.#context),
    ]);
    const handoffTools = handoffs.map((handoff) =>
      handoff.getHandoffAsFunctionTool(),
    );
    const realtimeTools = agentTools.filter(isValidRealtimeTool);
    const functionTools = realtimeTools.filter(
      (tool): tool is RealtimeFunctionTool<TBaseContext> =>
        tool.type === 'function',
    );

    validateRealtimeToolNames(functionTools, handoffs);

    const hasToolsDefined =
      typeof agent.tools !== 'undefined' ||
      typeof agent.mcpServers !== 'undefined';
    const hasHandoffsDefined = handoffs.length > 0;
    return {
      agent,
      toolDefinitions:
        hasToolsDefined || hasHandoffsDefined
          ? [...realtimeTools.map(toRealtimeToolDefinition), ...handoffTools]
          : undefined,
      dispatchSnapshot: {
        agent,
        functionTools,
        handoffs,
      },
    };
  }

  #applyPreparedAgent(
    prepared: PreparedRealtimeAgentState<TBaseContext>,
  ): void {
    this.#currentAgent = prepared.agent;
    this.#currentTools = prepared.toolDefinitions;
    this.#currentDispatchSnapshot = prepared.dispatchSnapshot;

    // Recompute currently available MCP tools based on the new agent's active server labels.
    this.#updateAvailableMcpTools();
  }

  async #setCurrentAgent(agent: SessionRealtimeAgent<TBaseContext>) {
    const prepared = await this.#prepareAgent(agent);
    this.#applyPreparedAgent(prepared);
  }

  #captureResponseDispatchSnapshot(
    responseId: string,
  ): RealtimeDispatchSnapshot<TBaseContext> | undefined {
    const existingSnapshot = this.#responseDispatchSnapshots.get(responseId);
    if (existingSnapshot) {
      return existingSnapshot;
    }

    const snapshot =
      this.#pendingResponseDispatchSnapshot ?? this.#currentDispatchSnapshot;
    this.#pendingResponseDispatchSnapshot = undefined;
    if (snapshot) {
      this.#responseDispatchSnapshots.set(responseId, snapshot);
    }
    return snapshot;
  }

  async #getSessionConfig(
    additionalConfig: Partial<RealtimeSessionConfig> = {},
    preparedAgent?: PreparedRealtimeAgentState<TBaseContext>,
    connectionGeneration?: number,
  ): Promise<Partial<RealtimeSessionConfig>> {
    const configAgent = preparedAgent?.agent ?? this.#currentAgent;
    const configTools = preparedAgent?.toolDefinitions ?? this.#currentTools;
    const overridesConfig: Partial<RealtimeSessionConfig> =
      additionalConfig ?? {};
    const optionsConfig: Partial<RealtimeSessionConfig> =
      this.options.config ?? {};
    const instructions = await configAgent.getSystemPrompt(this.#context);
    const getAudioOutputVoiceOverride = (
      config: Partial<RealtimeSessionConfig>,
    ): string | undefined => {
      const audioConfig = (config as Partial<RealtimeSessionConfigDefinition>)
        .audio;
      return audioConfig?.output?.voice;
    };

    // Realtime expects tracing to be explicitly null to disable it; leaving the previous config
    // in place would otherwise continue emitting spans.
    const tracingConfig: RealtimeTracingConfig | null = this.options
      .tracingDisabled
      ? null
      : this.options.workflowName
        ? {
            workflow_name: this.options.workflowName,
          }
        : 'auto';

    if (tracingConfig !== null && tracingConfig !== 'auto') {
      if (this.options.groupId) {
        tracingConfig.group_id = this.options.groupId;
      }
      if (this.options.traceMetadata) {
        tracingConfig.metadata = this.options.traceMetadata;
      }
    } else if (this.options.groupId || this.options.traceMetadata) {
      logger.warn(
        'In order to set traceMetadata or a groupId you need to specify a workflowName.',
      );
    }

    const audioOutputVoiceOverride =
      getAudioOutputVoiceOverride(overridesConfig) ??
      getAudioOutputVoiceOverride(optionsConfig);
    const topLevelVoiceOverride = overridesConfig.voice ?? optionsConfig.voice;
    const resolvedVoice =
      typeof audioOutputVoiceOverride !== 'undefined'
        ? audioOutputVoiceOverride
        : typeof topLevelVoiceOverride !== 'undefined'
          ? topLevelVoiceOverride
          : configAgent.voice;

    // Start from any previously-sent config (so we preserve values like audio formats)
    // and the original options.config provided by the user. Preference order:
    // 1. Last session config we sent (#lastSessionConfig)
    // 2. Original options.config
    // 3. Additional config passed into this invocation (explicit overrides)
    // Finally we overwrite dynamic fields (instructions, voice, model, tools, tracing)
    // to ensure they always reflect the current agent & runtime state.
    const base: Partial<RealtimeSessionConfig> = {
      ...(this.#lastSessionConfig ?? {}),
      ...optionsConfig,
      ...overridesConfig,
    };

    // Note: Certain fields cannot be updated after the session begins, such as voice and model
    const fullConfig: Partial<RealtimeSessionConfig> = {
      ...base,
      instructions,
      voice: resolvedVoice,
      model: this.options.model,
      tools: configTools,
      tracing: tracingConfig,
      prompt:
        typeof configAgent.prompt === 'function'
          ? await configAgent.prompt(this.#context, configAgent)
          : configAgent.prompt,
    };

    // Update our cache so subsequent updates inherit the full set including any
    // dynamic fields we just overwrote.
    if (
      connectionGeneration === undefined ||
      connectionGeneration === this.#connectionGeneration
    ) {
      this.#lastSessionConfig = fullConfig;
    }

    return fullConfig;
  }

  /**
   * Compute the initial session config that the current session will use when connecting.
   *
   * This mirrors the configuration payload we send during `connect`, including dynamic values
   * such as the upstream agent instructions, tool definitions, and prompt content generated at
   * runtime. Keeping this helper exposed allows transports or orchestration layers to precompute
   * a CallAccept-compatible payload without opening a socket.
   *
   * @param overrides - Additional config overrides applied on top of the session options.
   */
  async getInitialSessionConfig(
    overrides: Partial<RealtimeSessionConfig> = {},
  ): Promise<Partial<RealtimeSessionConfig>> {
    await this.#setCurrentAgent(this.initialAgent);
    return this.#getSessionConfig({
      ...(this.options.config ?? {}),
      ...(overrides ?? {}),
    });
  }

  /**
   * Convenience helper to compute the initial session config without manually instantiating and connecting a session.
   *
   * This is primarily useful for integrations that must provide the session configuration to a
   * third party (for example the SIP `calls.accept` endpoint) before the actual realtime session
   * is attached. The helper instantiates a throwaway session so all agent-driven dynamic fields
   * resolve in exactly the same way as the live session path.
   *
   * @param agent - The starting agent for the session.
   * @param options - Session options used to seed the config calculation.
   * @param overrides - Additional config overrides applied on top of the provided options.
   */
  static async computeInitialSessionConfig<TBaseContext = unknown>(
    agent:
      | RealtimeAgent<TBaseContext>
      | RealtimeAgent<RealtimeContextData<TBaseContext>>,
    options: Partial<RealtimeSessionOptions<TBaseContext>> = {},
    overrides: Partial<RealtimeSessionConfig> = {},
  ): Promise<Partial<RealtimeSessionConfig>> {
    const session = new RealtimeSession(agent, options);
    try {
      return await session.getInitialSessionConfig(overrides);
    } finally {
      session.close();
    }
  }

  async updateAgent(newAgent: RealtimeAgent<TBaseContext>) {
    const prepared = await this.#prepareAgent(newAgent);
    this.#currentAgent.emit('agent_handoff', this.#context, newAgent);
    this.emit('agent_handoff', this.#context, this.#currentAgent, newAgent);

    this.#applyPreparedAgent(prepared);
    await this.#transport.updateSessionConfig(await this.#getSessionConfig());

    return newAgent;
  }

  async #handleHandoff(
    toolCall: TransportToolCallEvent,
    handoff: Handoff,
    sourceAgent: SessionRealtimeAgent<TBaseContext>,
    invocation: CanonicalRealtimeToolInvocation,
  ) {
    if (!this.#isCurrentRealtimeInvocation(invocation)) {
      return undefined;
    }
    const newAgent = (await handoff.onInvokeHandoff(
      this.#context,
      toolCall.arguments,
    )) as RealtimeAgent<TBaseContext>;
    if (!this.#isCurrentRealtimeInvocation(invocation)) {
      return undefined;
    }
    const prepared = await this.#prepareAgent(newAgent);
    if (!this.#isCurrentRealtimeInvocation(invocation)) {
      return undefined;
    }
    const sessionConfig = await this.#getSessionConfig(
      {},
      prepared,
      invocation.connectionGeneration,
    );
    if (!this.#isCurrentRealtimeInvocation(invocation)) {
      return undefined;
    }
    await this.#transport.updateSessionConfig(sessionConfig);
    if (!this.#isCurrentRealtimeInvocation(invocation)) {
      return undefined;
    }

    sourceAgent.emit('agent_handoff', this.#context, newAgent);
    if (!this.#isCurrentRealtimeInvocation(invocation)) {
      return undefined;
    }
    this.emit('agent_handoff', this.#context, sourceAgent, newAgent);
    if (!this.#isCurrentRealtimeInvocation(invocation)) {
      return undefined;
    }

    // update session with new agent
    this.#applyPreparedAgent(prepared);
    const output = getTransferMessage(newAgent);
    this.#sendCommittedFunctionCallOutput(
      sourceAgent,
      invocation,
      toolCall,
      output,
      true,
    );

    return newAgent;
  }

  #getPendingFunctionCalls(
    agent: SessionRealtimeAgent<TBaseContext>,
  ): Map<string, PendingRealtimeFunctionCall<TBaseContext>> {
    let calls = this.#pendingFunctionCalls.get(agent);
    if (!calls) {
      calls = new Map();
      this.#pendingFunctionCalls.set(agent, calls);
    }
    return calls;
  }

  #getMcpApprovalInvocations(
    agent: SessionRealtimeAgent<TBaseContext>,
  ): Map<string, IssuedRealtimeApproval<TBaseContext>> {
    let invocations = this.#mcpApprovalInvocations.get(agent);
    if (!invocations) {
      invocations = new Map();
      this.#mcpApprovalInvocations.set(agent, invocations);
    }
    return invocations;
  }

  #deletePendingFunctionCall(
    agent: SessionRealtimeAgent<TBaseContext>,
    callId: string,
  ): void {
    const calls = this.#pendingFunctionCalls.get(agent);
    calls?.delete(callId);
    if (calls?.size === 0) {
      this.#pendingFunctionCalls.delete(agent);
    }
  }

  #sendCommittedFunctionCallOutput(
    agent: SessionRealtimeAgent<TBaseContext>,
    invocation: CanonicalRealtimeToolInvocation,
    toolCall: TransportToolCallEvent,
    output: string,
    startResponse: boolean,
  ): void {
    if (!this.#isCurrentRealtimeInvocation(invocation)) {
      return;
    }
    let sending = this.#sendingToolCallOutputs.get(agent);
    if (!sending) {
      sending = new Set();
      this.#sendingToolCallOutputs.set(agent, sending);
    }
    if (sending.has(invocation.callId)) {
      return;
    }
    let calls = this.#completedToolCalls.get(agent);
    if (!calls) {
      calls = new Map();
      this.#completedToolCalls.set(agent, calls);
    }
    calls.set(invocation.callId, {
      fingerprint: invocation.fingerprint,
      output,
      startResponse,
    });
    sending.add(invocation.callId);
    try {
      this.#transport.sendFunctionCallOutput(toolCall, output, startResponse);
    } finally {
      sending.delete(invocation.callId);
      if (sending.size === 0) {
        this.#sendingToolCallOutputs.delete(agent);
      }
    }
  }

  #isCurrentRealtimeInvocation(
    invocation: CanonicalRealtimeToolInvocation,
  ): boolean {
    return (
      invocation.connectionGeneration === this.#connectionGeneration &&
      invocation.connectionGeneration === this.#connectedGeneration
    );
  }

  async #runRealtimeToolInvocation(
    agent: SessionRealtimeAgent<TBaseContext>,
    invocation: CanonicalRealtimeToolInvocation,
    toolCall: TransportToolCallEvent,
    execute: () => Promise<unknown>,
  ): Promise<void> {
    if (!this.#isCurrentRealtimeInvocation(invocation)) {
      return;
    }
    const completed = this.#completedToolCalls
      .get(agent)
      ?.get(invocation.callId);
    if (completed) {
      if (completed.fingerprint !== invocation.fingerprint) {
        throw new ModelBehaviorError(
          `Tool call ID ${invocation.callId} was reused for a different realtime invocation after completion.`,
        );
      }
      this.#sendCommittedFunctionCallOutput(
        agent,
        invocation,
        toolCall,
        completed.output,
        completed.startResponse,
      );
      return;
    }

    const activeCalls = this.#getActiveToolCalls(agent);
    const active = activeCalls.get(invocation.callId);
    if (active) {
      if (active.fingerprint !== invocation.fingerprint) {
        throw new ModelBehaviorError(
          `Tool call ID ${invocation.callId} was reused for a different realtime invocation while execution was active.`,
        );
      }
      const activeOutcome = await active.completion;
      if (
        activeOutcome &&
        invocation.connectionGeneration === this.#connectionGeneration
      ) {
        this.#sendCommittedFunctionCallOutput(
          agent,
          invocation,
          toolCall,
          activeOutcome.output,
          activeOutcome.startResponse,
        );
      }
      return;
    }

    let resolveCompletion: (
      outcome: CompletedRealtimeToolCall | undefined,
    ) => void = () => {};
    const completion = new Promise<CompletedRealtimeToolCall | undefined>(
      (resolve) => {
        resolveCompletion = resolve;
      },
    );
    const activeCall = {
      fingerprint: invocation.fingerprint,
      completion,
      resolve: resolveCompletion,
    };
    activeCalls.set(invocation.callId, activeCall);
    try {
      if (this.#isCurrentRealtimeInvocation(invocation)) {
        await execute();
      }
    } finally {
      resolveCompletion(
        this.#completedToolCalls.get(agent)?.get(invocation.callId),
      );
      if (activeCalls.get(invocation.callId) === activeCall) {
        activeCalls.delete(invocation.callId);
      }
      if (
        activeCalls.size === 0 &&
        this.#activeToolCalls.get(agent) === activeCalls
      ) {
        this.#activeToolCalls.delete(agent);
      }
    }
  }

  #transferActiveToolCallToPendingApproval(
    agent: SessionRealtimeAgent<TBaseContext>,
    invocation: CanonicalRealtimeToolInvocation,
  ): void {
    const activeCalls = this.#activeToolCalls.get(agent);
    const active = activeCalls?.get(invocation.callId);
    if (!active) {
      return;
    }
    if (active.fingerprint !== invocation.fingerprint) {
      throw new ModelBehaviorError(
        `Tool call ID ${invocation.callId} changed while transferring realtime approval ownership.`,
      );
    }
    active.resolve(undefined);
    activeCalls?.delete(invocation.callId);
    if (
      activeCalls?.size === 0 &&
      this.#activeToolCalls.get(agent) === activeCalls
    ) {
      this.#activeToolCalls.delete(agent);
    }
  }

  #getActiveToolCalls(
    agent: SessionRealtimeAgent<TBaseContext>,
  ): Map<string, ActiveRealtimeToolCall> {
    let calls = this.#activeToolCalls.get(agent);
    if (!calls) {
      calls = new Map();
      this.#activeToolCalls.set(agent, calls);
    }
    return calls;
  }

  #resetToolInvocationState(): void {
    for (const calls of this.#activeToolCalls.values()) {
      for (const active of calls.values()) {
        active.resolve(undefined);
      }
    }
    this.#pendingFunctionCalls.clear();
    this.#mcpApprovalInvocations.clear();
    this.#completedToolCalls.clear();
    this.#sendingToolCallOutputs.clear();
    this.#activeToolCalls.clear();
  }

  async #resolveApprovalRejectionMessage(
    tool: RealtimeFunctionTool<TBaseContext>,
    toolCall: TransportToolCallEvent,
    agent: SessionRealtimeAgent<TBaseContext>,
    toolType: ToolErrorFormatterArgs['toolType'] = 'function',
  ): Promise<string> {
    // Per-call message from state.reject(item, { message }) takes precedence.
    const perCallMessage = getToolInvocationRejectionMessage(
      this.#context,
      agent,
      tool,
      toolCall,
    );
    if (typeof perCallMessage === 'string') {
      return perCallMessage;
    }

    const { toolErrorFormatter } = this.options;
    if (!toolErrorFormatter) {
      return TOOL_APPROVAL_REJECTION_MESSAGE;
    }

    try {
      const formattedMessage = await toolErrorFormatter({
        kind: 'approval_rejected',
        toolType,
        toolName: tool.name,
        callId: toolCall.callId,
        defaultMessage: TOOL_APPROVAL_REJECTION_MESSAGE,
        runContext: this.#context,
      });

      if (typeof formattedMessage === 'string') {
        return formattedMessage;
      }
      if (typeof formattedMessage !== 'undefined') {
        logger.warn(
          'toolErrorFormatter returned a non-string value. Falling back to the default tool approval rejection message.',
        );
      }
    } catch (error) {
      const errorDetails = logger.dontLogToolData
        ? getSafeErrorType(error)
        : toErrorMessage(error);
      logger.warn(
        `toolErrorFormatter threw while formatting approval rejection: ${errorDetails}`,
      );
    }

    return TOOL_APPROVAL_REJECTION_MESSAGE;
  }

  async #handleFunctionToolCall(
    incomingToolCall: TransportToolCallEvent,
    tool: RealtimeFunctionTool<TBaseContext>,
    agent: SessionRealtimeAgent<TBaseContext>,
    dispatchSnapshot: RealtimeDispatchSnapshot<TBaseContext>,
  ) {
    const toolCall = normalizeRealtimeFunctionCallId(incomingToolCall);
    const invocation = {
      ...validateToolInvocationApproval(this.#context, agent, tool, toolCall),
      connectionGeneration: this.#connectionGeneration,
    };
    const pending = this.#pendingFunctionCalls
      .get(agent)
      ?.get(invocation.callId);
    if (pending) {
      if (pending.fingerprint !== invocation.fingerprint) {
        throw new ModelBehaviorError(
          `Tool call ID ${invocation.callId} was reused for a different realtime invocation while approval was pending.`,
        );
      }
      return;
    }
    await this.#runRealtimeToolInvocation(agent, invocation, toolCall, () =>
      this.#executeFunctionToolCall(
        toolCall,
        tool,
        agent,
        dispatchSnapshot,
        invocation,
      ),
    );
  }

  async #executeFunctionToolCall(
    toolCall: TransportToolCallEvent,
    tool: RealtimeFunctionTool<TBaseContext>,
    agent: SessionRealtimeAgent<TBaseContext>,
    dispatchSnapshot: RealtimeDispatchSnapshot<TBaseContext>,
    invocation: CanonicalRealtimeToolInvocation,
  ) {
    if (!this.#isCurrentRealtimeInvocation(invocation)) {
      return;
    }
    this.#context.context.history = JSON.parse(JSON.stringify(this.#history)); // deep copy of the history
    let parsedArgs: any = toolCall.arguments;
    const dynamicApprovalPolicy = hasDynamicFunctionToolApprovalPolicy(tool);
    let argumentParseError: unknown;
    try {
      if (tool.parameters) {
        if (isZodObject(tool.parameters)) {
          parsedArgs = tool.parameters.parse(parsedArgs);
        } else {
          parsedArgs = JSON.parse(parsedArgs);
        }
      }
    } catch (error) {
      if (!dynamicApprovalPolicy) {
        throw error;
      }
      argumentParseError = error;
    }
    const forceApproval =
      dynamicApprovalPolicy &&
      (argumentParseError !== undefined ||
        !hasInspectableFunctionToolArguments(parsedArgs));
    const existingApproval = dynamicApprovalPolicy
      ? getToolInvocationApproval(this.context, agent, tool, toolCall)
      : undefined;
    let needsApproval = forceApproval || existingApproval !== undefined;
    if (!needsApproval) {
      let approvalResult: unknown;
      try {
        approvalResult = await tool.needsApproval(
          this.#context,
          parsedArgs,
          toolCall.callId,
        );
      } catch (error) {
        if (!this.#isCurrentRealtimeInvocation(invocation)) {
          return;
        }
        throw error;
      }
      if (!this.#isCurrentRealtimeInvocation(invocation)) {
        return;
      }
      needsApproval = requireBooleanApprovalResult(tool.name, approvalResult);
    }
    if (!this.#isCurrentRealtimeInvocation(invocation)) {
      return;
    }
    if (needsApproval) {
      const approval =
        existingApproval ??
        getToolInvocationApproval(this.context, agent, tool, toolCall);
      if (approval === false) {
        this.#deletePendingFunctionCall(agent, toolCall.callId);
        this.emit('agent_tool_start', this.#context, agent, tool, {
          toolCall,
        });
        if (!this.#isCurrentRealtimeInvocation(invocation)) {
          return;
        }
        agent.emit('agent_tool_start', this.#context, tool, {
          toolCall,
        });
        if (!this.#isCurrentRealtimeInvocation(invocation)) {
          return;
        }

        const result = await this.#resolveApprovalRejectionMessage(
          tool,
          toolCall,
          agent,
        );
        if (!this.#isCurrentRealtimeInvocation(invocation)) {
          return;
        }
        this.#sendCommittedFunctionCallOutput(
          agent,
          invocation,
          toolCall,
          result,
          true,
        );
        this.emit('agent_tool_end', this.#context, agent, tool, result, {
          toolCall,
        });
        agent.emit('agent_tool_end', this.#context, tool, result, {
          toolCall,
        });
        return;
      } else if (typeof approval === 'undefined') {
        if (this.#toolExecution?.preApprovalInputGuardrails === true) {
          const inputGuardrailResult = await runToolInputGuardrails({
            guardrails: tool.inputGuardrails,
            context: this.#context,
            agent,
            toolCall: toolCall as any,
          });
          if (!this.#isCurrentRealtimeInvocation(invocation)) {
            return;
          }

          if (inputGuardrailResult.type === 'reject') {
            this.#sendCommittedFunctionCallOutput(
              agent,
              invocation,
              toolCall,
              inputGuardrailResult.message,
              true,
            );
            return;
          }
        }
        const trustedToolCall = { ...toolCall };
        const trustedApprovalItem = new RunToolApprovalItem(
          trustedToolCall,
          agent,
        );
        const approvalItem = new RunToolApprovalItem(
          { ...trustedToolCall },
          agent,
        );
        this.#getPendingFunctionCalls(agent).set(toolCall.callId, {
          toolCall: trustedToolCall,
          tool,
          agent,
          dispatchSnapshot,
          approvalItem: trustedApprovalItem,
          fingerprint: invocation.fingerprint,
          connectionGeneration: invocation.connectionGeneration,
        });
        this.#issuedApprovals.set(approvalItem, {
          kind: 'function',
          connectionGeneration: invocation.connectionGeneration,
          agent,
          callId: invocation.callId,
          fingerprint: invocation.fingerprint,
          toolName: tool.name,
          rawName: trustedToolCall.name,
          tool,
          trustedApprovalItem,
          decisionState: 'pending',
        });
        this.#transferActiveToolCallToPendingApproval(agent, invocation);
        this.emit('tool_approval_requested', this.#context, agent, {
          type: 'function_approval' as const,
          tool,
          approvalItem,
        });
        return;
      }
    }

    this.#deletePendingFunctionCall(agent, toolCall.callId);
    if (argumentParseError !== undefined) {
      const errorMessage = `An error occurred while parsing tool arguments. Please try again with valid JSON. Error: ${toErrorMessage(argumentParseError)}`;
      this.#sendCommittedFunctionCallOutput(
        agent,
        invocation,
        toolCall,
        errorMessage,
        true,
      );
      return;
    }

    const inputGuardrailResult = await runToolInputGuardrails({
      guardrails: tool.inputGuardrails,
      context: this.#context,
      agent,
      toolCall: toolCall as any,
    });
    if (!this.#isCurrentRealtimeInvocation(invocation)) {
      return;
    }

    this.emit('agent_tool_start', this.#context, agent, tool, {
      toolCall,
    });
    if (!this.#isCurrentRealtimeInvocation(invocation)) {
      return;
    }
    agent.emit('agent_tool_start', this.#context, tool, {
      toolCall,
    });
    if (!this.#isCurrentRealtimeInvocation(invocation)) {
      return;
    }

    this.#context.context.history = JSON.parse(JSON.stringify(this.#history)); // deep copy of the history
    const result =
      inputGuardrailResult.type === 'reject'
        ? inputGuardrailResult.message
        : await invokeFunctionTool({
            tool,
            runContext: this.#context,
            input: toolCall.arguments,
            details: {
              toolCall,
            },
          });
    if (!this.#isCurrentRealtimeInvocation(invocation)) {
      return;
    }
    const guardedResult =
      inputGuardrailResult.type === 'reject'
        ? result
        : await runToolOutputGuardrails({
            guardrails: tool.outputGuardrails,
            context: this.#context,
            agent,
            toolCall: toolCall as any,
            toolOutput: result,
          });
    if (!this.#isCurrentRealtimeInvocation(invocation)) {
      return;
    }
    let stringResult: string;
    if (isBackgroundResult(guardedResult)) {
      // Don't generate a new response, just send the result
      stringResult = toSmartString(guardedResult.content);
      this.#sendCommittedFunctionCallOutput(
        agent,
        invocation,
        toolCall,
        stringResult,
        false,
      );
    } else {
      stringResult = toSmartString(guardedResult);
      this.#sendCommittedFunctionCallOutput(
        agent,
        invocation,
        toolCall,
        stringResult,
        true,
      );
    }
    this.emit('agent_tool_end', this.#context, agent, tool, stringResult, {
      toolCall,
    });
    agent.emit('agent_tool_end', this.#context, tool, stringResult, {
      toolCall,
    });
  }

  async #handleFunctionCall(
    incomingToolCall: TransportToolCallEvent,
    dispatchSnapshot: RealtimeDispatchSnapshot<TBaseContext>,
  ) {
    const toolCall = normalizeRealtimeFunctionCallId(incomingToolCall);
    const candidateFunctionTool = dispatchSnapshot.functionTools.find(
      (tool) => tool.name === toolCall.name,
    );
    const candidateHandoff = dispatchSnapshot.handoffs.find(
      (handoff) => handoff.toolName === toolCall.name,
    );
    const validatedInvocation = candidateFunctionTool
      ? validateToolInvocationApproval(
          this.#context,
          dispatchSnapshot.agent,
          candidateFunctionTool,
          toolCall,
        )
      : candidateHandoff
        ? validateHandoffToolInvocation(
            this.#context,
            dispatchSnapshot.agent,
            candidateHandoff.toolName,
            toolCall,
          )
        : validateToolInvocationName(
            this.#context,
            dispatchSnapshot.agent,
            toolCall.name,
            toolCall,
          );
    const invocation = {
      ...validatedInvocation,
      connectionGeneration: this.#connectionGeneration,
    };
    const pending = this.#pendingFunctionCalls
      .get(dispatchSnapshot.agent)
      ?.get(invocation.callId);
    if (pending) {
      if (pending.fingerprint !== invocation.fingerprint) {
        throw new ModelBehaviorError(
          `Tool call ID ${invocation.callId} was reused for a different realtime invocation while approval was pending.`,
        );
      }
      return;
    }

    await this.#runRealtimeToolInvocation(
      dispatchSnapshot.agent,
      invocation,
      toolCall,
      async () => {
        const [toolEnabled, handoffEnabled] = await Promise.all([
          Promise.all(
            dispatchSnapshot.functionTools.map((tool) =>
              tool.isEnabled(this.#context, dispatchSnapshot.agent),
            ),
          ),
          Promise.all(
            dispatchSnapshot.handoffs.map((handoff) =>
              handoff.isEnabled({
                runContext: this.#context,
                agent: dispatchSnapshot.agent,
              }),
            ),
          ),
        ]);
        if (!this.#isCurrentRealtimeInvocation(invocation)) {
          return;
        }
        const filteredSnapshot: RealtimeDispatchSnapshot<TBaseContext> = {
          agent: dispatchSnapshot.agent,
          functionTools: dispatchSnapshot.functionTools.filter(
            (_tool, index) => toolEnabled[index],
          ),
          handoffs: dispatchSnapshot.handoffs.filter(
            (_handoff, index) => handoffEnabled[index],
          ),
        };
        validateRealtimeToolNames(
          filteredSnapshot.functionTools,
          filteredSnapshot.handoffs,
        );

        const functionToolMap = new Map(
          filteredSnapshot.functionTools.map((tool) => [tool.name, tool]),
        );
        const handoffMap = new Map(
          filteredSnapshot.handoffs.map((handoff) => [
            handoff.toolName,
            handoff,
          ]),
        );

        const functionTool = functionToolMap.get(toolCall.name);
        if (functionTool) {
          await this.#executeFunctionToolCall(
            toolCall,
            functionTool,
            filteredSnapshot.agent,
            filteredSnapshot,
            invocation,
          );
          return;
        }

        const possibleHandoff = handoffMap.get(toolCall.name);
        if (possibleHandoff) {
          await this.#handleHandoff(
            toolCall,
            possibleHandoff,
            filteredSnapshot.agent,
            invocation,
          );
          return;
        }

        const message = `Tool ${toolCall.name} not found`;
        this.#sendCommittedFunctionCallOutput(
          filteredSnapshot.agent,
          invocation,
          toolCall,
          message,
          false,
        );
        this.emit('error', {
          type: 'error',
          error: new ModelBehaviorError(message),
        });
      },
    );
  }

  async #runOutputGuardrails(
    output: string,
    responseId: string,
    itemId: string,
    sourceAgent: SessionRealtimeAgent<TBaseContext>,
    source: OutputGuardrailDeltaSource | 'final',
    responseGeneration: number,
    connectionGeneration: number,
  ) {
    if (this.#outputGuardrails.length === 0) {
      return;
    }

    const guardrailArgs: OutputGuardrailFunctionArgs<unknown, 'text'> = {
      agent: sourceAgent as Agent<unknown, 'text'>,
      agentOutput: output,
      context: this.#context,
    };
    const results = await Promise.all(
      this.#outputGuardrails.map((guardrail) => guardrail.run(guardrailArgs)),
    );

    const firstTripwireTriggered = results.find(
      (result) => result.output.tripwireTriggered,
    );
    if (firstTripwireTriggered) {
      if (connectionGeneration !== this.#connectionGeneration) {
        return;
      }
      // this ensures that if one guardrail already trips and we are in the middle of another
      // guardrail run, we don't trip again
      if (this.#interruptedByGuardrail[responseId]) {
        return;
      }
      this.#interruptedByGuardrail[responseId] = true;
      const error = new OutputGuardrailTripwireTriggered(
        `Output guardrail triggered: ${JSON.stringify(firstTripwireTriggered.output.outputInfo)}`,
        firstTripwireTriggered,
      );
      this.emit('guardrail_tripped', this.#context, sourceAgent, error, {
        itemId,
      });

      if (
        responseGeneration !== this.#responseGeneration ||
        (this.#activeResponseId !== undefined &&
          this.#activeResponseId !== responseId)
      ) {
        return;
      }

      if (source === 'text' && this.#activeResponseId === responseId) {
        this.#transport.sendEvent({
          type: 'response.cancel',
          response_id: responseId,
        });
      } else if (source !== 'text') {
        this.interrupt();
      }

      const feedbackText = getRealtimeGuardrailFeedbackMessage(
        firstTripwireTriggered,
      );
      this.sendMessage(feedbackText);
      return;
    }
  }

  #scheduleOutputGuardrails(
    output: string,
    responseId: string,
    itemId: string,
    source: OutputGuardrailDeltaSource | 'final',
    sourceAgent: SessionRealtimeAgent<TBaseContext>,
    responseGeneration = this.#responseGeneration,
    connectionGeneration = this.#connectionGeneration,
  ) {
    void this.#runOutputGuardrails(
      output,
      responseId,
      itemId,
      sourceAgent,
      source,
      responseGeneration,
      connectionGeneration,
    ).catch((error) => {
      this.emit('error', { type: 'error', error });
    });
  }

  #handleOutputGuardrailDelta(
    event: TransportLayerTranscriptDelta | TransportLayerOutputTextDelta,
    source: OutputGuardrailDeltaSource,
  ) {
    const { delta, itemId, responseId } = event;
    if (this.#activeResponseId === undefined) {
      this.#activeResponseId = responseId;
      this.#captureResponseDispatchSnapshot(responseId);
    }
    let responseState = this.#outputGuardrailDeltaState.get(responseId);
    if (!responseState) {
      responseState = new Map();
      this.#outputGuardrailDeltaState.set(responseId, responseState);
    }

    const state = responseState.get(itemId) ?? {
      text: '',
      lastRunIndex: 0,
    };
    state.text += delta;
    responseState.set(itemId, state);

    if (this.#outputGuardrailSettings.debounceTextLength < 0) {
      return;
    }

    const newRunIndex = Math.floor(
      state.text.length / this.#outputGuardrailSettings.debounceTextLength,
    );
    if (newRunIndex <= state.lastRunIndex) {
      return;
    }

    state.lastRunIndex = newRunIndex;
    const sourceAgent =
      this.#responseDispatchSnapshots.get(responseId)?.agent ??
      this.#currentAgent;
    this.#scheduleOutputGuardrails(
      state.text,
      responseId,
      itemId,
      source,
      sourceAgent,
    );
  }

  #setEventListeners() {
    this.#transport.on('*', (event) => {
      this.emit('transport_event', event);
      // Handle completed user transcription events
      if (
        event.type === 'conversation.item.input_audio_transcription.completed'
      ) {
        try {
          const completedEvent = event as InputAudioTranscriptionCompletedEvent;
          this.#history = updateRealtimeHistory(
            this.#history,
            completedEvent,
            this.#shouldIncludeAudioData,
          );
          this.#context.context.history = this.#history;
          this.emit('history_updated', this.#history);
        } catch (err) {
          this.emit('error', {
            type: 'error',
            error: err,
          });
        }
      }
    });
    this.#transport.on('mcp_tools_listed', ({ serverLabel, tools }) => {
      try {
        this.#allMcpToolsByServer.set(serverLabel, tools ?? []);
        this.#updateAvailableMcpTools();
      } catch (err) {
        this.emit('error', { type: 'error', error: err });
      }
    });
    this.#transport.on('audio', (event) => {
      if (!this.#audioStarted) {
        this.#audioStarted = true;
        this.emit('audio_start', this.#context, this.#currentAgent);
      }
      this.emit('audio', event);
    });
    this.#transport.on('turn_started', (event) => {
      this.#audioStarted = false;
      const responseId = getStartedResponseId(event);
      this.#activeResponseId = responseId;
      this.#responseGeneration += 1;
      this.#pendingResponseDispatchSnapshot = this.#currentDispatchSnapshot;
      if (responseId) {
        this.#captureResponseDispatchSnapshot(responseId);
      }
      this.emit('agent_start', this.#context, this.#currentAgent);
      this.#currentAgent.emit('agent_start', this.#context, this.#currentAgent);
    });
    this.#transport.on('turn_done', (event) => {
      const responseId = event.response.id;
      const sourceAgent =
        this.#captureResponseDispatchSnapshot(responseId)?.agent ??
        this.#currentAgent;
      const responseGeneration = this.#responseGeneration;
      const connectionGeneration = this.#connectionGeneration;
      if (this.#activeResponseId === responseId) {
        this.#activeResponseId = undefined;
      }
      const outputItems = event.response.output ?? [];
      let textOutput = '';
      let itemId = '';

      for (let idx = outputItems.length - 1; idx >= 0; idx--) {
        const candidate = outputItems[idx];
        const candidateText = getLastTextFromAudioOutputMessage(candidate);
        if (typeof candidateText === 'string') {
          textOutput = candidateText;
          const candidateId = (candidate as { id?: unknown })?.id;
          itemId = typeof candidateId === 'string' ? candidateId : '';
          break;
        }
      }

      if (!itemId && outputItems.length > 0) {
        const lastItem = outputItems[outputItems.length - 1] as {
          id?: unknown;
        };
        itemId = typeof lastItem?.id === 'string' ? lastItem.id : '';
      }
      this.emit('agent_end', this.#context, this.#currentAgent, textOutput);
      this.#currentAgent.emit('agent_end', this.#context, textOutput);

      this.#scheduleOutputGuardrails(
        textOutput,
        responseId,
        itemId,
        'final',
        sourceAgent,
        responseGeneration,
        connectionGeneration,
      );
      this.#outputGuardrailDeltaState.delete(responseId);
      this.#responseDispatchSnapshots.delete(responseId);
    });

    this.#transport.on('audio_done', () => {
      if (this.#audioStarted) {
        this.#audioStarted = false;
      }
      this.emit('audio_stopped', this.#context, this.#currentAgent);
    });

    this.#transport.on('audio_transcript_delta', (event) => {
      try {
        this.#handleOutputGuardrailDelta(event, 'audio');
      } catch (err) {
        this.emit('error', {
          type: 'error',
          error: err,
        });
      }
    });

    this.#transport.on('output_text_delta', (event) => {
      try {
        this.#handleOutputGuardrailDelta(event, 'text');
      } catch (err) {
        this.emit('error', {
          type: 'error',
          error: err,
        });
      }
    });

    this.#transport.on('item_update', (event) => {
      try {
        const isNew = !this.#history.some(
          (item) => item.itemId === event.itemId,
        );
        this.#history = updateRealtimeHistory(
          this.#history,
          event,
          this.#shouldIncludeAudioData,
        );
        this.#context.context.history = this.#history;
        if (isNew) {
          const addedItem = this.#history.find(
            (item) => item.itemId === event.itemId,
          );
          if (addedItem) {
            this.emit('history_added', addedItem);
          }
        }
        this.emit('history_updated', this.#history);
      } catch (err) {
        this.emit('error', {
          type: 'error',
          error: err,
        });
      }
    });

    this.#transport.on('item_deleted', (event) => {
      try {
        this.#history = this.#history.filter(
          (item) => item.itemId !== event.itemId,
        );
        this.#context.context.history = this.#history;
        this.emit('history_updated', this.#history);
      } catch (err) {
        this.emit('error', {
          type: 'error',
          error: err,
        });
      }
    });

    this.#transport.on('function_call', async (event) => {
      try {
        if (this.#connectedGeneration !== this.#connectionGeneration) {
          return;
        }
        if (!event.responseId) {
          throw new ModelBehaviorError(
            'Realtime function call is missing a responseId and cannot be dispatched safely.',
          );
        }
        const dispatchSnapshot = this.#captureResponseDispatchSnapshot(
          event.responseId,
        );
        if (!dispatchSnapshot) {
          throw new ModelBehaviorError(
            'Realtime tool dispatch is unavailable before the session tool configuration is resolved.',
          );
        }
        await this.#handleFunctionCall(event, dispatchSnapshot);
      } catch (error) {
        logToolActionError(logger, 'Error handling function call', error);
        this.emit('error', {
          type: 'error',
          error,
        });
      }
    });

    this.#transport.on('usage_update', (usage) => {
      this.#context.usage.add(usage);
    });

    this.#transport.on('audio_interrupted', () => {
      if (this.#audioStarted) {
        this.#audioStarted = false;
      }
      this.emit('audio_interrupted', this.#context, this.#currentAgent);
    });

    this.#transport.on('error', (error) => {
      this.emit('error', error);
    });

    this.#transport.on('mcp_tool_call_completed', (toolCall) => {
      this.emit(
        'mcp_tool_call_completed',
        this.#context,
        this.#currentAgent,
        toolCall,
      );

      if (this.#automaticallyTriggerResponseForMcpToolCalls) {
        if (this.#transport.requestResponse) {
          this.#transport.requestResponse();
        } else {
          this.#transport.sendEvent({
            type: 'response.create',
          });
        }
      }
    });

    this.#transport.on('mcp_approval_request', (approvalRequest) => {
      try {
        if (this.#connectedGeneration !== this.#connectionGeneration) {
          return;
        }
        const agent = this.#currentAgent;
        const trustedApprovalItem = realtimeApprovalItemToApprovalItem(
          agent,
          approvalRequest,
        );
        if (trustedApprovalItem.rawItem.type !== 'hosted_tool_call') {
          throw new ModelBehaviorError(
            'Realtime MCP approval could not be normalized safely.',
          );
        }
        const toolName = trustedApprovalItem.rawItem.name;
        const invocation = validateToolInvocationName(
          this.#context,
          agent,
          toolName,
          trustedApprovalItem.rawItem,
        );
        const agentInvocations = this.#getMcpApprovalInvocations(agent);
        const existing = agentInvocations.get(invocation.callId);
        if (existing) {
          if (existing.fingerprint !== invocation.fingerprint) {
            throw new ModelBehaviorError(
              `Tool call ID ${invocation.callId} was reused for a different realtime MCP approval invocation.`,
            );
          }
          return;
        }
        const approvalItem = realtimeApprovalItemToApprovalItem(
          agent,
          approvalRequest,
        );
        const issued: IssuedRealtimeApproval<TBaseContext> = {
          kind: 'mcp',
          connectionGeneration: this.#connectionGeneration,
          agent,
          callId: invocation.callId,
          fingerprint: invocation.fingerprint,
          toolName,
          rawName: trustedApprovalItem.rawItem.name,
          trustedApprovalItem,
          decisionState: 'pending',
        };
        this.#issuedApprovals.set(approvalItem, issued);
        agentInvocations.set(invocation.callId, issued);
        this.emit('tool_approval_requested', this.#context, agent, {
          type: 'mcp_approval_request' as const,
          approvalItem,
        });
      } catch (error) {
        logToolActionError(
          logger,
          'Error handling MCP approval request',
          error,
        );
        this.emit('error', {
          type: 'error',
          error,
        });
      }
    });
  }

  /**
   * Recomputes the currently available MCP tools based on the current agent's active
   * MCP server configurations and the cached per-server tool listings. Emits
   * `mcp_tools_changed` if the set changed.
   */
  #updateAvailableMcpTools() {
    // Collect active MCP server labels and optional allowed filters from the current agent
    const activeMcpConfigs = this.#currentTools?.filter(
      (t): t is HostedMCPToolDefinition => (t as any).type === 'mcp',
    ) as HostedMCPToolDefinition[];

    const allowedFromConfig = (cfg: HostedMCPToolDefinition) => {
      const allowed = cfg.allowed_tools;
      if (!allowed) return undefined;
      if (Array.isArray(allowed)) return allowed;
      if (allowed && Array.isArray(allowed.tool_names))
        return allowed.tool_names;
      return undefined;
    };

    const dedupByName = new Map<string, RealtimeMcpToolInfo>();
    for (const cfg of activeMcpConfigs) {
      const tools = this.#allMcpToolsByServer.get(cfg.server_label) ?? [];
      const allowed = allowedFromConfig(cfg);
      for (const tool of tools) {
        if (allowed && !allowed.includes(tool.name)) continue;
        if (!dedupByName.has(tool.name)) {
          dedupByName.set(tool.name, tool);
        }
      }
    }

    const next = Array.from(dedupByName.values());
    const prev = this.#availableMcpTools;
    const changed =
      prev.length !== next.length ||
      JSON.stringify(prev.map((t) => t.name).sort()) !==
        JSON.stringify(next.map((t) => t.name).sort());
    if (changed) {
      this.#availableMcpTools = next;
      this.emit('mcp_tools_changed', this.#availableMcpTools);
    }
  }

  /**
   * Connect to the session. This will establish the connection to the underlying transport layer
   * and start the session.
   *
   * After connecting, the session will also emit a `history_updated` event with an empty history.
   *
   * @param options - The options for the connection.
   */
  async connect(options: RealtimeSessionConnectOptions) {
    this.#connectionGeneration += 1;
    const connectionGeneration = this.#connectionGeneration;
    this.#connectedGeneration = undefined;
    this.#resetToolInvocationState();
    this.#responseGeneration = 0;
    this.#activeResponseId = undefined;
    this.#outputGuardrailDeltaState.clear();
    this.#interruptedByGuardrail = {};
    this.#pendingResponseDispatchSnapshot = undefined;
    this.#responseDispatchSnapshots.clear();
    // makes sure the current agent is correctly set and loads the tools
    await this.#setCurrentAgent(this.initialAgent);
    if (connectionGeneration !== this.#connectionGeneration) {
      return;
    }

    if (!this.#eventListenersAttached) {
      this.#setEventListeners();
      this.#eventListenersAttached = true;
    }
    const initialSessionConfig = await this.#getSessionConfig(
      this.options.config,
    );
    if (connectionGeneration !== this.#connectionGeneration) {
      return;
    }
    await this.#transport.connect({
      apiKey: options.apiKey ?? this.options.apiKey,
      model: this.options.model,
      url: options.url,
      callId: options.callId,
      initialSessionConfig,
    });
    if (connectionGeneration !== this.#connectionGeneration) {
      return;
    }
    this.#connectedGeneration = connectionGeneration;
    // Ensure the cached lastSessionConfig includes everything passed as the initial session config
    // (the call above already set it via #getSessionConfig but in case additional overrides were
    // passed directly here in the future we could merge them). For now it's a no-op.

    this.#history = [];
    this.emit('history_updated', this.#history);
  }

  /**
   * Update the history of the session.
   * @param newHistory - The new history to set.
   */
  updateHistory(
    newHistory: RealtimeItem[] | ((history: RealtimeItem[]) => RealtimeItem[]),
  ) {
    let updatedHistory;
    if (typeof newHistory === 'function') {
      updatedHistory = newHistory(this.#history);
    } else {
      updatedHistory = newHistory;
    }
    this.#transport.resetHistory(this.#history, updatedHistory);
  }

  /**
   * Send a message to the session.
   * @param message - The message to send.
   * @param otherEventData - Additional event data to send.
   */
  sendMessage(
    message: RealtimeUserInput,
    otherEventData: Record<string, any> = {},
  ) {
    this.#transport.sendMessage(message, otherEventData);
  }

  /**
   * Add image to the session
   * @param image - The image to add.
   */
  addImage(
    image: string,
    { triggerResponse = true }: { triggerResponse?: boolean } = {},
  ) {
    this.#transport.addImage(image, { triggerResponse });
  }

  /**
   * Mute the session.
   * @param muted - Whether to mute the session.
   */
  mute(muted: boolean) {
    this.#transport.mute(muted);
  }

  /**
   * Disconnect from the session.
   */
  close() {
    this.#connectedGeneration = undefined;
    this.#connectionGeneration += 1;
    this.#responseGeneration = 0;
    this.#activeResponseId = undefined;
    this.#outputGuardrailDeltaState.clear();
    this.#interruptedByGuardrail = {};
    this.#pendingResponseDispatchSnapshot = undefined;
    this.#resetToolInvocationState();
    this.#responseDispatchSnapshots.clear();
    this.#transport.close();
  }

  /**
   * Send audio to the session.
   * @param audio - The audio to send.
   * @param options - Additional options.
   * @param options.commit - Whether to finish the turn with this audio.
   */
  sendAudio(audio: ArrayBuffer, options: { commit?: boolean } = {}) {
    this.#transport.sendAudio(audio, options);
  }

  /**
   * Interrupt the session artificially for example if you want to build a "stop talking"
   * button.
   */
  interrupt() {
    this.#transport.interrupt();
  }

  #validateIssuedApproval(
    approvalItem: RunToolApprovalItem,
  ): IssuedRealtimeApproval<TBaseContext> | undefined {
    let issued = this.#issuedApprovals.get(approvalItem);
    if (
      !issued &&
      approvalItem.rawItem.type === 'hosted_tool_call' &&
      approvalItem.agent instanceof RealtimeAgent
    ) {
      const agent = approvalItem.agent as SessionRealtimeAgent<TBaseContext>;
      const { callId } = validateToolInvocationName(
        this.#context,
        agent,
        approvalItem.rawItem.name,
        approvalItem.rawItem,
      );
      issued = this.#mcpApprovalInvocations.get(agent)?.get(callId);
    }
    if (
      issued !== undefined &&
      (issued.connectionGeneration !== this.#connectionGeneration ||
        issued.connectionGeneration !== this.#connectedGeneration)
    ) {
      throw new ModelBehaviorError(
        'Tool approval belongs to a closed realtime connection.',
      );
    }
    if (!issued) {
      return undefined;
    }
    if (approvalItem.agent !== issued.agent) {
      throw new ModelBehaviorError(
        `Tool call ID ${issued.callId} approval does not belong to its issuing realtime agent.`,
      );
    }
    if (
      !('name' in approvalItem.rawItem) ||
      approvalItem.rawItem.name !== issued.rawName
    ) {
      throw new ModelBehaviorError(
        `Tool call ID ${issued.callId} approval changed its issued realtime tool name.`,
      );
    }
    const supplied = issued.tool
      ? validateToolInvocationApproval(
          this.#context,
          issued.agent,
          issued.tool,
          approvalItem.rawItem,
        )
      : validateToolInvocationName(
          this.#context,
          issued.agent,
          issued.toolName,
          approvalItem.rawItem,
        );
    if (
      supplied.callId !== issued.callId ||
      supplied.fingerprint !== issued.fingerprint
    ) {
      throw new ModelBehaviorError(
        `Tool call ID ${issued.callId} approval does not match its issued realtime invocation.`,
      );
    }
    return issued;
  }

  #resolvePendingFunctionCall(
    approvalItem: RunToolApprovalItem,
  ): PendingRealtimeFunctionCall<TBaseContext> | undefined {
    if (approvalItem.rawItem.type !== 'function_call') {
      return undefined;
    }

    const rawToolCall = approvalItem.rawItem as typeof approvalItem.rawItem & {
      responseId?: unknown;
    };
    if (typeof rawToolCall.responseId !== 'string') {
      return undefined;
    }
    const toolCall = normalizeRealtimeFunctionCallId(
      rawToolCall as TransportToolCallEvent,
    );
    const agent =
      approvalItem.agent instanceof RealtimeAgent
        ? (approvalItem.agent as SessionRealtimeAgent<TBaseContext>)
        : this.#currentAgent;
    const pending = this.#pendingFunctionCalls.get(agent)?.get(toolCall.callId);
    if (pending) {
      if (pending.connectionGeneration !== this.#connectionGeneration) {
        throw new ModelBehaviorError(
          `Tool call ID ${toolCall.callId} approval belongs to a closed realtime connection.`,
        );
      }
      const suppliedInvocation = validateToolInvocationApproval(
        this.#context,
        agent,
        pending.tool,
        toolCall,
      );
      if (
        toolCall.name !== pending.toolCall.name ||
        suppliedInvocation.fingerprint !== pending.fingerprint
      ) {
        throw new ModelBehaviorError(
          `Tool call ID ${toolCall.callId} approval does not match the pending realtime invocation.`,
        );
      }
      return pending;
    }
    const toolName = approvalItem.toolName ?? approvalItem.rawItem.name;
    const tool = agent.tools.find(
      (candidate): candidate is RealtimeFunctionTool<TBaseContext> =>
        candidate.type === 'function' && candidate.name === toolName,
    );
    if (!tool) {
      return undefined;
    }

    const dispatchSnapshot =
      this.#currentDispatchSnapshot?.agent === agent
        ? this.#currentDispatchSnapshot
        : { agent, functionTools: [tool], handoffs: [] };
    const invocation = {
      ...validateToolInvocationApproval(this.#context, agent, tool, toolCall),
      connectionGeneration: this.#connectionGeneration,
    };
    return {
      toolCall,
      tool,
      agent,
      dispatchSnapshot,
      fingerprint: invocation.fingerprint,
      connectionGeneration: invocation.connectionGeneration,
      approvalItem:
        toolCall === approvalItem.rawItem
          ? approvalItem
          : new RunToolApprovalItem(
              toolCall,
              approvalItem.agent,
              approvalItem.toolName,
            ),
    };
  }

  /**
   * Approve a tool call. This will also trigger the tool call to the agent.
   * @param approvalItem - The approval item to approve.
   * @param options - Additional options.
   * @param options.alwaysApprove - Whether to always approve the tool call.
   */
  async approve(
    approvalItem: RunToolApprovalItem,
    options: { alwaysApprove?: boolean } = { alwaysApprove: false },
  ) {
    const issued = this.#validateIssuedApproval(approvalItem);
    if (issued && issued.decisionState !== 'pending') {
      return;
    }
    const pending = this.#resolvePendingFunctionCall(approvalItem);
    if (issued?.kind === 'function' && !pending) {
      throw new ModelBehaviorError(
        `Tool call ID ${issued.callId} no longer has a pending realtime invocation.`,
      );
    }
    if (issued?.kind === 'function') {
      issued.decisionState = 'decided';
    }
    const effectiveApprovalItem =
      pending?.approvalItem ?? issued?.trustedApprovalItem ?? approvalItem;
    this.#context.approveTool(effectiveApprovalItem, options);
    const toolName =
      effectiveApprovalItem.toolName ??
      ('name' in effectiveApprovalItem.rawItem
        ? effectiveApprovalItem.rawItem.name
        : undefined);
    if (pending) {
      this.#deletePendingFunctionCall(pending.agent, pending.toolCall.callId);
      await this.#handleFunctionToolCall(
        pending.toolCall,
        pending.tool,
        pending.agent,
        pending.dispatchSnapshot,
      );
    } else if (effectiveApprovalItem.rawItem.type === 'hosted_tool_call') {
      if (options.alwaysApprove) {
        logger.warn(
          'Always approving MCP tools is not supported. Use the allowed tools configuration instead.',
        );
      }
      const mcpApprovalRequest = approvalItemToRealtimeApprovalItem(
        effectiveApprovalItem,
      );
      if (issued) {
        issued.decisionState = 'sending';
      }
      try {
        this.#transport.sendMcpResponse(mcpApprovalRequest, true);
      } catch (error) {
        if (issued) {
          issued.decisionState = 'pending';
        }
        throw error;
      }
      if (issued) {
        issued.decisionState = 'decided';
      }
    } else {
      throw new ModelBehaviorError(`Tool ${toolName ?? 'unknown'} not found`);
    }
  }

  /**
   * Reject a tool call. This will also trigger the tool call to the agent.
   * @param approvalItem - The approval item to reject.
   * @param options - Additional options.
   * @param options.alwaysReject - Whether to always reject the tool call.
   * @param options.message - The rejection text sent to the model.
   *   If not provided, `toolErrorFormatter` (if configured) or the SDK default is used.
   */
  async reject(
    approvalItem: RunToolApprovalItem,
    options: { alwaysReject?: boolean; message?: string } = {
      alwaysReject: false,
    },
  ) {
    const issued = this.#validateIssuedApproval(approvalItem);
    if (issued && issued.decisionState !== 'pending') {
      return;
    }
    const pending = this.#resolvePendingFunctionCall(approvalItem);
    if (issued?.kind === 'function' && !pending) {
      throw new ModelBehaviorError(
        `Tool call ID ${issued.callId} no longer has a pending realtime invocation.`,
      );
    }
    if (issued?.kind === 'function') {
      issued.decisionState = 'decided';
    }
    const effectiveApprovalItem =
      pending?.approvalItem ?? issued?.trustedApprovalItem ?? approvalItem;
    this.#context.rejectTool(effectiveApprovalItem, options);

    // we still need to simulate a tool call to the agent to let the agent know
    const toolName =
      effectiveApprovalItem.toolName ??
      ('name' in effectiveApprovalItem.rawItem
        ? effectiveApprovalItem.rawItem.name
        : undefined);
    if (pending) {
      this.#deletePendingFunctionCall(pending.agent, pending.toolCall.callId);
      await this.#handleFunctionToolCall(
        pending.toolCall,
        pending.tool,
        pending.agent,
        pending.dispatchSnapshot,
      );
    } else if (effectiveApprovalItem.rawItem.type === 'hosted_tool_call') {
      if (options.alwaysReject) {
        logger.warn(
          'Always rejecting MCP tools is not supported. Use the allowed tools configuration instead.',
        );
      }
      const mcpApprovalRequest = approvalItemToRealtimeApprovalItem(
        effectiveApprovalItem,
      );
      const rejectionReason = getBoundToolInvocationRejectionMessage(
        this.#context,
        effectiveApprovalItem.agent,
        getHostedMcpApprovalToolName(
          effectiveApprovalItem.toolName ?? effectiveApprovalItem.rawItem.name,
          effectiveApprovalItem.rawItem,
        ),
        effectiveApprovalItem.rawItem,
      );
      if (issued) {
        issued.decisionState = 'sending';
      }
      try {
        this.#transport.sendMcpResponse(
          mcpApprovalRequest,
          false,
          rejectionReason,
        );
      } catch (error) {
        if (issued) {
          issued.decisionState = 'pending';
        }
        throw error;
      }
      if (issued) {
        issued.decisionState = 'decided';
      }
    } else {
      throw new ModelBehaviorError(`Tool ${toolName ?? 'unknown'} not found`);
    }
  }
}
