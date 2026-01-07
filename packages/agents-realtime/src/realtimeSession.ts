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
  type FunctionTool,
} from '@openai/agents-core';
import { RuntimeEventEmitter } from '@openai/agents-core/_shims';
import { isZodObject, toSmartString } from '@openai/agents-core/utils';
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
import type { TransportToolCallEvent } from './transportLayerEvents';
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
  #currentAgent:
    | RealtimeAgent<TBaseContext>
    | RealtimeAgent<RealtimeContextData<TBaseContext>>;
  #currentTools?: RealtimeToolDefinition[];
  #context: RunContext<RealtimeContextData<TBaseContext>>;
  #outputGuardrails: RealtimeOutputGuardrailDefinition[] = [];
  #outputGuardrailSettings: RealtimeOutputGuardrailSettings;
  #transcribedTextDeltas: Record<string, string> = {};
  #history: RealtimeItem[] = [];
  #shouldIncludeAudioData: boolean;
  #interruptedByGuardrail: Record<string, boolean> = {};
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

  async #setCurrentAgent(
    agent:
      | RealtimeAgent<TBaseContext>
      | RealtimeAgent<RealtimeContextData<TBaseContext>>,
  ) {
    this.#currentAgent = agent;
    const handoffs = await (
      this.#currentAgent as RealtimeAgent<TBaseContext>
    ).getEnabledHandoffs(this.#context);
    const handoffTools = handoffs.map((handoff) =>
      handoff.getHandoffAsFunctionTool(),
    );
    const allTools = (
      await (this.#currentAgent as RealtimeAgent<TBaseContext>).getAllTools(
        this.#context,
      )
    )
      .filter(isValidRealtimeTool)
      .map(toRealtimeToolDefinition);
    const hasToolsDefined =
      typeof this.#currentAgent.tools !== 'undefined' ||
      typeof this.#currentAgent.mcpServers !== 'undefined';
    const hasHandoffsDefined = handoffs.length > 0;
    this.#currentTools =
      hasToolsDefined || hasHandoffsDefined
        ? [...allTools, ...handoffTools]
        : undefined;

    // Recompute currently available MCP tools based on the new agent's active server labels.
    this.#updateAvailableMcpTools();
  }

  async #getSessionConfig(
    additionalConfig: Partial<RealtimeSessionConfig> = {},
  ): Promise<Partial<RealtimeSessionConfig>> {
    const overridesConfig: Partial<RealtimeSessionConfig> =
      additionalConfig ?? {};
    const optionsConfig: Partial<RealtimeSessionConfig> =
      this.options.config ?? {};
    const instructions = await this.#currentAgent.getSystemPrompt(
      this.#context,
    );
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
          : this.#currentAgent.voice;

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
      tools: this.#currentTools,
      tracing: tracingConfig,
      prompt:
        typeof this.#currentAgent.prompt === 'function'
          ? await this.#currentAgent.prompt(this.#context, this.#currentAgent)
          : this.#currentAgent.prompt,
    };

    // Update our cache so subsequent updates inherit the full set including any
    // dynamic fields we just overwrote.
    this.#lastSessionConfig = fullConfig;

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
    this.#currentAgent.emit('agent_handoff', this.#context, newAgent);
    this.emit('agent_handoff', this.#context, this.#currentAgent, newAgent);

    await this.#setCurrentAgent(newAgent);
    await this.#transport.updateSessionConfig(await this.#getSessionConfig());

    return newAgent;
  }

  async #handleHandoff(toolCall: TransportToolCallEvent, handoff: Handoff) {
    const newAgent = (await handoff.onInvokeHandoff(
      this.#context,
      toolCall.arguments,
    )) as RealtimeAgent<TBaseContext>;

    this.#currentAgent.emit('agent_handoff', this.#context, newAgent);
    this.emit('agent_handoff', this.#context, this.#currentAgent, newAgent);

    // update session with new agent
    await this.#setCurrentAgent(newAgent);
    await this.#transport.updateSessionConfig(await this.#getSessionConfig());
    const output = getTransferMessage(newAgent);
    this.#transport.sendFunctionCallOutput(toolCall, output, true);

    return newAgent;
  }

  async #handleFunctionToolCall(
    toolCall: TransportToolCallEvent,
    tool: FunctionTool<RealtimeContextData<TBaseContext>, any, unknown>,
  ) {
    this.#context.context.history = JSON.parse(JSON.stringify(this.#history)); // deep copy of the history
    let parsedArgs: any = toolCall.arguments;
    if (tool.parameters) {
      if (isZodObject(tool.parameters)) {
        parsedArgs = tool.parameters.parse(parsedArgs);
      } else {
        parsedArgs = JSON.parse(parsedArgs);
      }
    }
    const needsApproval = await tool.needsApproval(
      this.#context,
      parsedArgs,
      toolCall.callId,
    );
    if (needsApproval) {
      const approval = this.context.isToolApproved({
        toolName: tool.name,
        callId: toolCall.callId,
      });
      if (approval === false) {
        this.emit('agent_tool_start', this.#context, this.#currentAgent, tool, {
          toolCall,
        });
        this.#currentAgent.emit('agent_tool_start', this.#context, tool, {
          toolCall,
        });

        const result = 'Tool execution was not approved.';
        this.#transport.sendFunctionCallOutput(toolCall, result, true);
        this.emit(
          'agent_tool_end',
          this.#context,
          this.#currentAgent,
          tool,
          result,
          { toolCall },
        );
        this.#currentAgent.emit('agent_tool_end', this.#context, tool, result, {
          toolCall,
        });
        return;
      } else if (typeof approval === 'undefined') {
        this.emit(
          'tool_approval_requested',
          this.#context,
          this.#currentAgent,
          {
            type: 'function_approval' as const,
            tool,
            approvalItem: new RunToolApprovalItem(toolCall, this.#currentAgent),
          },
        );
        return;
      }
    }

    const inputGuardrailResult = await runToolInputGuardrails({
      guardrails: tool.inputGuardrails,
      context: this.#context,
      agent: this.#currentAgent,
      toolCall: toolCall as any,
    });

    this.emit('agent_tool_start', this.#context, this.#currentAgent, tool, {
      toolCall,
    });
    this.#currentAgent.emit('agent_tool_start', this.#context, tool, {
      toolCall,
    });

    this.#context.context.history = JSON.parse(JSON.stringify(this.#history)); // deep copy of the history
    const result =
      inputGuardrailResult.type === 'reject'
        ? inputGuardrailResult.message
        : await tool.invoke(this.#context, toolCall.arguments, {
            toolCall,
          });
    const guardedResult =
      inputGuardrailResult.type === 'reject'
        ? result
        : await runToolOutputGuardrails({
            guardrails: tool.outputGuardrails,
            context: this.#context,
            agent: this.#currentAgent,
            toolCall: toolCall as any,
            toolOutput: result,
          });
    let stringResult: string;
    if (isBackgroundResult(guardedResult)) {
      // Don't generate a new response, just send the result
      stringResult = toSmartString(guardedResult.content);
      this.#transport.sendFunctionCallOutput(toolCall, stringResult, false);
    } else {
      stringResult = toSmartString(guardedResult);
      this.#transport.sendFunctionCallOutput(toolCall, stringResult, true);
    }
    this.emit(
      'agent_tool_end',
      this.#context,
      this.#currentAgent,
      tool,
      stringResult,
      { toolCall },
    );
    this.#currentAgent.emit(
      'agent_tool_end',
      this.#context,
      tool,
      stringResult,
      { toolCall },
    );
  }

  async #handleFunctionCall(toolCall: TransportToolCallEvent) {
    const enabledHandoffs = await (
      this.#currentAgent as RealtimeAgent<TBaseContext>
    ).getEnabledHandoffs(this.#context);
    const handoffMap = new Map(
      enabledHandoffs.map((handoff) => [handoff.toolName, handoff]),
    );

    const allTools = await (
      this.#currentAgent as RealtimeAgent<TBaseContext>
    ).getAllTools(this.#context);
    const functionToolMap = new Map(allTools.map((tool) => [tool.name, tool]));

    const possibleHandoff = handoffMap.get(toolCall.name);
    if (possibleHandoff) {
      await this.#handleHandoff(toolCall, possibleHandoff);
    } else {
      const functionTool = functionToolMap.get(toolCall.name);
      if (functionTool && functionTool.type === 'function') {
        await this.#handleFunctionToolCall(toolCall, functionTool);
      } else {
        throw new ModelBehaviorError(`Tool ${toolCall.name} not found`);
      }
    }
  }

  async #runOutputGuardrails(
    output: string,
    responseId: string,
    itemId: string,
  ) {
    if (this.#outputGuardrails.length === 0) {
      return;
    }

    const guardrailArgs: OutputGuardrailFunctionArgs<unknown, 'text'> = {
      agent: this.#currentAgent as Agent<unknown, 'text'>,
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
      this.emit('guardrail_tripped', this.#context, this.#currentAgent, error, {
        itemId,
      });
      this.interrupt();

      const feedbackText = getRealtimeGuardrailFeedbackMessage(
        firstTripwireTriggered,
      );
      this.sendMessage(feedbackText);
      return;
    }
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
    this.#transport.on('turn_started', () => {
      this.#audioStarted = false;
      this.emit('agent_start', this.#context, this.#currentAgent);
      this.#currentAgent.emit('agent_start', this.#context, this.#currentAgent);
    });
    this.#transport.on('turn_done', (event) => {
      const item = event.response.output[event.response.output.length - 1];
      const textOutput = getLastTextFromAudioOutputMessage(item) ?? '';
      const itemId = item?.id ?? '';
      this.emit('agent_end', this.#context, this.#currentAgent, textOutput);
      this.#currentAgent.emit('agent_end', this.#context, textOutput);

      this.#runOutputGuardrails(textOutput, event.response.id, itemId);
    });

    this.#transport.on('audio_done', () => {
      if (this.#audioStarted) {
        this.#audioStarted = false;
      }
      this.emit('audio_stopped', this.#context, this.#currentAgent);
    });

    let lastRunIndex = 0;
    let lastItemId: string | undefined;
    this.#transport.on('audio_transcript_delta', (event) => {
      try {
        const delta = event.delta;
        const itemId = event.itemId;
        const responseId = event.responseId;
        if (lastItemId !== itemId) {
          lastItemId = itemId;
          lastRunIndex = 0;
        }
        const currentText = this.#transcribedTextDeltas[itemId] ?? '';
        const newText = currentText + delta;
        this.#transcribedTextDeltas[itemId] = newText;

        if (this.#outputGuardrailSettings.debounceTextLength < 0) {
          return;
        }

        const newRunIndex = Math.floor(
          newText.length / this.#outputGuardrailSettings.debounceTextLength,
        );
        if (newRunIndex > lastRunIndex) {
          lastRunIndex = newRunIndex;
          // We don't cancel existing runs because we want the first one to fail to fail
          // The transport layer should upon failure handle the interruption and stop the model
          // from generating further
          this.#runOutputGuardrails(newText, responseId, itemId);
        }
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
        await this.#handleFunctionCall(event);
      } catch (error) {
        logger.error('Error handling function call', error);
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
        this.#transport.sendEvent({
          type: 'response.create',
        });
      }
    });

    this.#transport.on('mcp_approval_request', (approvalRequest) => {
      this.emit('tool_approval_requested', this.#context, this.#currentAgent, {
        type: 'mcp_approval_request' as const,
        approvalItem: realtimeApprovalItemToApprovalItem(
          this.#currentAgent,
          approvalRequest,
        ),
      });
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
    // makes sure the current agent is correctly set and loads the tools
    await this.#setCurrentAgent(this.initialAgent);

    this.#setEventListeners();
    await this.#transport.connect({
      apiKey: options.apiKey ?? this.options.apiKey,
      model: this.options.model,
      url: options.url,
      callId: options.callId,
      initialSessionConfig: await this.#getSessionConfig(this.options.config),
    });
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
    this.#interruptedByGuardrail = {};
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
    this.#context.approveTool(approvalItem, options);
    const toolName =
      approvalItem.toolName ?? (approvalItem.rawItem as any).name;
    const tool = this.#currentAgent.tools.find(
      (tool) => tool.name === toolName,
    );
    if (
      tool &&
      tool.type === 'function' &&
      approvalItem.rawItem.type === 'function_call'
    ) {
      await this.#handleFunctionToolCall(approvalItem.rawItem, tool);
    } else if (approvalItem.rawItem.type === 'hosted_tool_call') {
      if (options.alwaysApprove) {
        logger.warn(
          'Always approving MCP tools is not supported. Use the allowed tools configuration instead.',
        );
      }
      const mcpApprovalRequest =
        approvalItemToRealtimeApprovalItem(approvalItem);
      this.#transport.sendMcpResponse(mcpApprovalRequest, true);
    } else {
      throw new ModelBehaviorError(`Tool ${toolName ?? 'unknown'} not found`);
    }
  }

  /**
   * Reject a tool call. This will also trigger the tool call to the agent.
   * @param approvalItem - The approval item to reject.
   * @param options - Additional options.
   * @param options.alwaysReject - Whether to always reject the tool call.
   */
  async reject(
    approvalItem: RunToolApprovalItem,
    options: { alwaysReject?: boolean } = { alwaysReject: false },
  ) {
    this.#context.rejectTool(approvalItem, options);

    // we still need to simulate a tool call to the agent to let the agent know
    const toolName =
      approvalItem.toolName ?? (approvalItem.rawItem as any).name;
    const tool = this.#currentAgent.tools.find(
      (tool) => tool.name === toolName,
    );
    if (
      tool &&
      tool.type === 'function' &&
      approvalItem.rawItem.type === 'function_call'
    ) {
      await this.#handleFunctionToolCall(approvalItem.rawItem, tool);
    } else if (approvalItem.rawItem.type === 'hosted_tool_call') {
      if (options.alwaysReject) {
        logger.warn(
          'Always rejecting MCP tools is not supported. Use the allowed tools configuration instead.',
        );
      }
      const mcpApprovalRequest =
        approvalItemToRealtimeApprovalItem(approvalItem);
      this.#transport.sendMcpResponse(mcpApprovalRequest, false);
    } else {
      throw new ModelBehaviorError(`Tool ${toolName ?? 'unknown'} not found`);
    }
  }
}
