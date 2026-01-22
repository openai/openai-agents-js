import { z } from 'zod';

import type { InputGuardrail, OutputGuardrail } from './guardrail';
import { AgentHooks } from './lifecycle';
import { getAllMcpTools, type MCPServer } from './mcp';
import type { Model, ModelSettings, Prompt } from './model';
import {
  getDefaultModelSettings,
  gpt5ReasoningSettingsRequired,
  isGpt5Default,
} from './defaultModel';
import type { RunContext } from './runContext';
import {
  type FunctionTool,
  type FunctionToolResult,
  tool,
  type Tool,
  type ToolApprovalFunction,
  type ToolEnabledFunction,
} from './tool';
import type {
  ResolvedAgentOutput,
  JsonSchemaDefinition,
  HandoffsOutput,
  Expand,
} from './types';
import type { RunResult, StreamedRunResult } from './result';
import { getHandoff, type Handoff } from './handoff';
import { StreamRunOptions, RunConfig, Runner } from './run';
import { toFunctionToolName } from './utils/tools';
import { getOutputText } from './utils/messages';
import { isAgentToolInput } from './utils/typeGuards';
import { isZodObject } from './utils/typeGuards';
import { ModelBehaviorError, UserError } from './errors';
import { RunToolApprovalItem } from './items';
import logger from './logger';
import { UnknownContext, TextOutput } from './types';
import type * as protocol from './types/protocol';
import type { ZodObjectLike } from './utils/zodCompat';
import type { RunStreamEvent } from './events';

type AnyAgentRunResult =
  | RunResult<any, Agent<any, any>>
  | StreamedRunResult<any, Agent<any, any>>;
type CompletedRunResult<TContext, TAgent extends Agent<TContext, any>> = (
  | RunResult<TContext, TAgent>
  | StreamedRunResult<TContext, TAgent>
) & {
  finalOutput: ResolvedAgentOutput<TAgent['outputType']>;
};

type AgentToolRunOptions<TContext, TAgent extends Agent<TContext, any>> = Omit<
  StreamRunOptions<TContext, TAgent>,
  'stream'
>;

type AgentToolStreamEvent<TAgent extends Agent<any, any>> = {
  // Raw stream event emitted by the nested agent run.
  event: RunStreamEvent;
  // The agent instance being executed as a tool.
  agent: TAgent;
  // The tool call item that triggered this nested run (when available).
  toolCall?: protocol.FunctionCallItem;
};
type AgentToolEventName = RunStreamEvent['type'] | '*';
type AgentToolEventHandler<TAgent extends Agent<any, any>> = (
  event: AgentToolStreamEvent<TAgent>,
) => void | Promise<void>;
type AgentTool<TContext, TAgent extends Agent<TContext, any>> = FunctionTool<
  TContext,
  typeof AgentAsToolNeedApprovalSchame
> & {
  on: (
    name: AgentToolEventName,
    handler: AgentToolEventHandler<TAgent>,
  ) => AgentTool<TContext, TAgent>;
};

// Per-process, ephemeral map linking a function tool call to its nested
// Agent run result within the same run; entry is removed after consumption.
const agentToolRunResults = new WeakMap<
  protocol.FunctionCallItem,
  AnyAgentRunResult
>();

export function saveAgentToolRunResult(
  toolCall: protocol.FunctionCallItem | undefined,
  runResult: AnyAgentRunResult,
): void {
  if (toolCall) {
    agentToolRunResults.set(toolCall, runResult);
  }
}

export function consumeAgentToolRunResult(
  toolCall: protocol.FunctionCallItem,
): AnyAgentRunResult | undefined {
  const runResult = agentToolRunResults.get(toolCall);
  if (runResult) {
    agentToolRunResults.delete(toolCall);
  }

  return runResult;
}

export type ToolUseBehaviorFlags = 'run_llm_again' | 'stop_on_first_tool';

export type ToolsToFinalOutputResult =
  | {
      /**
       * Whether this is the final output. If `false`, the LLM will run again and receive the tool call output
       */
      isFinalOutput: false;
      /**
       * Whether the agent was interrupted by a tool approval. If `true`, the LLM will run again and receive the tool call output
       */
      isInterrupted: undefined;
    }
  | {
      isFinalOutput: false;
      /**
       * Whether the agent was interrupted by a tool approval. If `true`, the LLM will run again and receive the tool call output
       */
      isInterrupted: true;
      interruptions: RunToolApprovalItem[];
    }
  | {
      /**
       * Whether this is the final output. If `false`, the LLM will run again and receive the tool call output
       */
      isFinalOutput: true;

      /**
       * Whether the agent was interrupted by a tool approval. If `true`, the LLM will run again and receive the tool call output
       */
      isInterrupted: undefined;

      /**
       * The final output. Can be undefined if `isFinalOutput` is `false`, otherwise it must be a string
       * that will be processed based on the `outputType` of the agent.
       */
      finalOutput: string;
    };

/**
 * The type of the output object. If not provided, the output will be a string.
 * 'text' is a special type that indicates the output will be a string.
 *
 * @template HandoffOutputType The type of the output of the handoff.
 */
export type AgentOutputType<HandoffOutputType = UnknownContext> =
  | TextOutput
  | ZodObjectLike
  | JsonSchemaDefinition
  | HandoffsOutput<HandoffOutputType>;

/**
 * A function that takes a run context and a list of tool results and returns a `ToolsToFinalOutputResult`.
 */
export type ToolToFinalOutputFunction = (
  context: RunContext,
  toolResults: FunctionToolResult[],
) => ToolsToFinalOutputResult | Promise<ToolsToFinalOutputResult>;

/**
 * The behavior of the agent when a tool is called.
 */
export type ToolUseBehavior =
  | ToolUseBehaviorFlags
  | {
      /**
       * List of tool names that will stop the agent from running further. The final output will be
       * the output of the first tool in the list that was called.
       */
      stopAtToolNames: string[];
    }
  | ToolToFinalOutputFunction;

/**
 * Configuration for an agent.
 *
 * @template TContext The type of the context object.
 * @template TOutput The type of the output object.
 */
export interface AgentConfiguration<
  TContext = UnknownContext,
  TOutput extends AgentOutputType = TextOutput,
> {
  name: string;

  /**
   * The instructions for the agent. Will be used as the "system prompt" when this agent is
   * invoked. Describes what the agent should do, and how it responds.
   *
   * Can either be a string, or a function that dynamically generates instructions for the agent.
   * If you provide a function, it will be called with the context and the agent instance. It
   * must return a string.
   */
  instructions:
    | string
    | ((
        runContext: RunContext<TContext>,
        agent: Agent<TContext, TOutput>,
      ) => Promise<string> | string);

  /**
   * The prompt template to use for the agent (OpenAI Responses API only).
   *
   * Can either be a prompt template object, or a function that returns a prompt
   * template object. If a function is provided, it will be called with the run
   * context and the agent instance. It must return a prompt template object.
   */
  prompt?:
    | Prompt
    | ((
        runContext: RunContext<TContext>,
        agent: Agent<TContext, TOutput>,
      ) => Promise<Prompt> | Prompt);

  /**
   * A description of the agent. This is used when the agent is used as a handoff, so that an LLM
   * knows what it does and when to invoke it.
   */
  handoffDescription: string;

  /**
   * Handoffs are sub-agents that the agent can delegate to. You can provide a list of handoffs,
   * and the agent can choose to delegate to them if relevant. Allows for separation of concerns
   * and modularity.
   */
  handoffs: (Agent<any, any> | Handoff<any, TOutput>)[];

  /**
   * The warning log would be enabled when multiple output types by handoff agents are detected.
   */
  handoffOutputTypeWarningEnabled?: boolean;

  /**
   * The model implementation to use when invoking the LLM.
   *
   * By default, if not set, the agent will use the default model returned by
   * getDefaultModel (currently "gpt-4.1").
   */
  model: string | Model;

  /**
   * Configures model-specific tuning parameters (e.g. temperature, top_p, etc.)
   */
  modelSettings: ModelSettings;

  /**
   * A list of tools the agent can use.
   */
  tools: Tool<TContext>[];

  /**
   * A list of [Model Context Protocol](https://modelcontextprotocol.io/) servers the agent can use.
   * Every time the agent runs, it will include tools from these servers in the list of available
   * tools.
   *
   * NOTE: You are expected to manage the lifecycle of these servers. Specifically, you must call
   * `server.connect()` before passing it to the agent, and `server.close()` when the server is
   * no longer needed. Consider using `connectMcpServers` or `MCPServers` to keep open/close in
   * the same place.
   */
  mcpServers: MCPServer[];

  /**
   * A list of checks that run in parallel to the agent by default; set `runInParallel` to false to
   * block LLM/tool calls until the guardrail completes. Runs only if the agent is the first agent
   * in the chain.
   */
  inputGuardrails: InputGuardrail[];

  /**
   * A list of checks that run on the final output of the agent, after generating a response. Runs
   * only if the agent produces a final output.
   */
  outputGuardrails: OutputGuardrail<TOutput>[];

  /**
   * The type of the output object. If not provided, the output will be a string.
   */
  outputType: TOutput;

  /**
   * This lets you configure how tool use is handled.
   * - run_llm_again: The default behavior. Tools are run, and then the LLM receives the results
   *   and gets to respond.
   * - stop_on_first_tool: The output of the first tool call is used as the final output. This means
   *   that the LLM does not process the result of the tool call.
   * - A list of tool names: The agent will stop running if any of the tools in the list are called.
   *   The final output will be the output of the first matching tool call. The LLM does not process
   *   the result of the tool call.
   * - A function: if you pass a function, it will be called with the run context and the list of
   *   tool results. It must return a `ToolsToFinalOutputResult`, which determines whether the tool
   *   call resulted in a final output.
   *
   * NOTE: This configuration is specific to `FunctionTools`. Hosted tools, such as file search, web
   * search, etc. are always processed by the LLM
   */
  toolUseBehavior: ToolUseBehavior;

  /**
   * Whether to reset the tool choice to the default value after a tool has been called. Defaults
   * to `true`. This ensures that the agent doesn't enter an infinite loop of tool usage.
   */
  resetToolChoice: boolean;
}

export type AgentOptions<
  TContext = UnknownContext,
  TOutput extends AgentOutputType = TextOutput,
> = Expand<
  Pick<AgentConfiguration<TContext, TOutput>, 'name'> &
    Partial<AgentConfiguration<TContext, TOutput>>
>;

/**
 * An agent is an AI model configured with instructions, tools, guardrails, handoffs and more.
 *
 * We strongly recommend passing `instructions`, which is the "system prompt" for the agent. In
 * addition, you can pass `handoffDescription`, which is a human-readable description of the
 * agent, used when the agent is used inside tools/handoffs.
 *
 * Agents are generic on the context type. The context is a (mutable) object you create. It is
 * passed to tool functions, handoffs, guardrails, etc.
 */
// --- Type utilities for inferring output type from handoffs ---
type ExtractAgentOutput<T> = T extends Agent<any, infer O> ? O : never;
type ExtractHandoffOutput<T> = T extends Handoff<any, infer O> ? O : never;
export type HandoffsOutputUnion<
  Handoffs extends readonly (Agent<any, any> | Handoff<any, any>)[],
> =
  | ExtractAgentOutput<Handoffs[number]>
  | ExtractHandoffOutput<Handoffs[number]>;

/**
 * Helper type for config with handoffs
 *
 * @template TOutput The type of the output object.
 * @template Handoffs The type of the handoffs.
 */
export type AgentConfigWithHandoffs<
  TOutput extends AgentOutputType,
  Handoffs extends readonly (Agent<any, any> | Handoff<any, any>)[],
> = { name: string; handoffs?: Handoffs; outputType?: TOutput } & Partial<
  Omit<
    AgentConfiguration<UnknownContext, TOutput | HandoffsOutputUnion<Handoffs>>,
    'name' | 'handoffs' | 'outputType'
  >
>;

// The parameter type fo needApproval function for the tool created by Agent.asTool() method
const AgentAsToolNeedApprovalSchame = z.object({ input: z.string() });

/**
 * The class representing an AI agent configured with instructions, tools, guardrails, handoffs and more.
 *
 * We strongly recommend passing `instructions`, which is the "system prompt" for the agent. In
 * addition, you can pass `handoffDescription`, which is a human-readable description of the
 * agent, used when the agent is used inside tools/handoffs.
 *
 * Agents are generic on the context type. The context is a (mutable) object you create. It is
 * passed to tool functions, handoffs, guardrails, etc.
 */
export class Agent<
  TContext = UnknownContext,
  TOutput extends AgentOutputType = TextOutput,
>
  extends AgentHooks<TContext, TOutput>
  implements AgentConfiguration<TContext, TOutput>
{
  /**
   * Create an Agent with handoffs and automatically infer the union type for TOutput from the handoff agents' output types.
   */
  static create<
    TOutput extends AgentOutputType = TextOutput,
    Handoffs extends readonly (Agent<any, any> | Handoff<any, any>)[] = [],
  >(
    config: AgentConfigWithHandoffs<TOutput, Handoffs>,
  ): Agent<UnknownContext, TOutput | HandoffsOutputUnion<Handoffs>> {
    return new Agent<UnknownContext, TOutput | HandoffsOutputUnion<Handoffs>>({
      ...config,
      handoffs: config.handoffs as any,
      outputType: config.outputType,
      handoffOutputTypeWarningEnabled: false,
    });
  }

  static DEFAULT_MODEL_PLACEHOLDER = '';

  name: string;
  instructions:
    | string
    | ((
        runContext: RunContext<TContext>,
        agent: Agent<TContext, TOutput>,
      ) => Promise<string> | string);
  prompt?:
    | Prompt
    | ((
        runContext: RunContext<TContext>,
        agent: Agent<TContext, TOutput>,
      ) => Promise<Prompt> | Prompt);
  handoffDescription: string;
  handoffs: (Agent<any, TOutput> | Handoff<any, TOutput>)[];
  model: string | Model;
  modelSettings: ModelSettings;
  tools: Tool<TContext>[];
  mcpServers: MCPServer[];
  inputGuardrails: InputGuardrail[];
  outputGuardrails: OutputGuardrail<AgentOutputType>[];
  outputType: TOutput = 'text' as TOutput;
  toolUseBehavior: ToolUseBehavior;
  resetToolChoice: boolean;
  private readonly _toolsExplicitlyConfigured: boolean;

  constructor(config: AgentOptions<TContext, TOutput>) {
    super();
    if (typeof config.name !== 'string' || config.name.trim() === '') {
      throw new UserError('Agent must have a name.');
    }
    this.name = config.name;
    this.instructions = config.instructions ?? Agent.DEFAULT_MODEL_PLACEHOLDER;
    this.prompt = config.prompt;
    this.handoffDescription = config.handoffDescription ?? '';
    this.handoffs = config.handoffs ?? [];
    this.model = config.model ?? '';
    this.modelSettings = config.modelSettings ?? getDefaultModelSettings();
    this.tools = config.tools ?? [];
    this._toolsExplicitlyConfigured = config.tools !== undefined;
    this.mcpServers = config.mcpServers ?? [];
    this.inputGuardrails = config.inputGuardrails ?? [];
    this.outputGuardrails = config.outputGuardrails ?? [];
    if (config.outputType) {
      this.outputType = config.outputType;
    }
    this.toolUseBehavior = config.toolUseBehavior ?? 'run_llm_again';
    this.resetToolChoice = config.resetToolChoice ?? true;

    if (
      // The user sets a non-default model
      config.model !== undefined &&
      // The default model is gpt-5
      isGpt5Default() &&
      // However, the specified model is not a gpt-5 model
      (typeof config.model !== 'string' ||
        !gpt5ReasoningSettingsRequired(config.model)) &&
      // The model settings are not customized for the specified model
      config.modelSettings === undefined
    ) {
      // In this scenario, we should use a generic model settings
      // because non-gpt-5 models are not compatible with the default gpt-5 model settings.
      // This is a best-effort attempt to make the agent work with non-gpt-5 models.
      this.modelSettings = {};
    }

    // --- Runtime warning for handoff output type compatibility ---
    if (
      config.handoffOutputTypeWarningEnabled === undefined ||
      config.handoffOutputTypeWarningEnabled
    ) {
      if (this.handoffs && this.outputType) {
        const outputTypes = new Set<string>([JSON.stringify(this.outputType)]);
        for (const h of this.handoffs) {
          if ('outputType' in h && h.outputType) {
            outputTypes.add(JSON.stringify(h.outputType));
          } else if ('agent' in h && h.agent.outputType) {
            outputTypes.add(JSON.stringify(h.agent.outputType));
          }
        }
        if (outputTypes.size > 1) {
          logger.warn(
            `[Agent] Warning: Handoff agents have different output types: ${Array.from(outputTypes).join(', ')}. You can make it type-safe by using Agent.create({ ... }) method instead.`,
          );
        }
      }
    }
  }

  /**
   * Output schema name.
   */
  get outputSchemaName(): string {
    if (this.outputType === 'text') {
      return 'text';
    } else if (isZodObject(this.outputType)) {
      return 'ZodOutput';
    } else if (typeof this.outputType === 'object') {
      return this.outputType.name;
    }

    throw new Error(`Unknown output type: ${this.outputType}`);
  }

  /**
   * Makes a copy of the agent, with the given arguments changed. For example, you could do:
   *
   * ```
   * const newAgent = agent.clone({ instructions: 'New instructions' })
   * ```
   *
   * @param config - A partial configuration to change.
   * @returns A new agent with the given changes.
   */
  clone(
    config: Partial<AgentConfiguration<TContext, TOutput>>,
  ): Agent<TContext, TOutput> {
    return new Agent({
      ...this,
      ...config,
    });
  }

  /**
   * Transform this agent into a tool, callable by other agents.
   *
   * This is different from handoffs in two ways:
   * 1. In handoffs, the new agent receives the conversation history. In this tool, the new agent
   *    receives generated input.
   * 2. In handoffs, the new agent takes over the conversation. In this tool, the new agent is
   *    called as a tool, and the conversation is continued by the original agent.
   *
   * @param options - Options for the tool.
   * @returns A tool that runs the agent and returns the output text.
   */
  asTool<TAgent extends Agent<TContext, TOutput> = Agent<TContext, TOutput>>(
    this: TAgent,
    options: {
      /**
       * The name of the tool. If not provided, the name of the agent will be used.
       */
      toolName?: string;
      /**
       * The description of the tool, which should indicate what the tool does and when to use it.
       */
      toolDescription?: string;
      /**
       * A function that extracts the output text from the agent. If not provided, the last message
       * from the agent will be used.
       */
      customOutputExtractor?: (
        output: CompletedRunResult<TContext, TAgent>,
      ) => string | Promise<string>;
      /**
       * Whether invoking this tool requires approval, matching the behavior of {@link tool} helpers.
       * When provided as a function it receives the tool arguments and can implement custom approval
       * logic.
       */
      needsApproval?:
        | boolean
        | ToolApprovalFunction<typeof AgentAsToolNeedApprovalSchame>;
      /**
       * Run configuration for initializing the internal agent runner.
       */
      runConfig?: Partial<RunConfig>;
      /**
       * Additional run options for the agent (as tool) execution.
       */
      runOptions?: AgentToolRunOptions<TContext, TAgent>;
      /**
       * Determines whether this tool should be exposed to the model for the current run.
       */
      isEnabled?:
        | boolean
        | ((args: {
            runContext: RunContext<TContext>;
            agent: Agent<TContext, TOutput>;
          }) => boolean | Promise<boolean>);
      /**
       * Optional hook to receive streamed events from the nested agent run.
       */
      onStream?: (event: AgentToolStreamEvent<TAgent>) => void | Promise<void>;
    },
  ): AgentTool<TContext, TAgent> {
    const {
      toolName,
      toolDescription,
      customOutputExtractor,
      needsApproval,
      runConfig,
      runOptions,
      isEnabled,
      onStream,
    } = options;
    // Event handlers are scoped to this agent tool instance and are not shared; we only support registration (no removal) to keep the API surface small.
    const eventHandlers = new Map<
      AgentToolEventName,
      Set<AgentToolEventHandler<TAgent>>
    >();
    const emitEvent = async (event: AgentToolStreamEvent<TAgent>) => {
      // We intentionally keep only add semantics (no off) to reduce surface area; handlers are scoped to this agent tool instance.
      const specific = eventHandlers.get(event.event.type);
      const wildcard = eventHandlers.get('*');
      const candidates = [
        ...(onStream ? [onStream] : []),
        ...(specific ? Array.from(specific) : []),
        ...(wildcard ? Array.from(wildcard) : []),
      ];
      // Run all handlers in parallel so a slow onStream callback does not block on(...) handlers (and vice versa).
      await Promise.allSettled(
        candidates.map((handler) =>
          Promise.resolve().then(() => handler(event)),
        ),
      );
    };
    const baseTool = tool({
      name: toolName ?? toFunctionToolName(this.name),
      description: toolDescription ?? '',
      parameters: AgentAsToolNeedApprovalSchame,
      strict: true,
      needsApproval,
      isEnabled,
      execute: async (data, context, details) => {
        if (!isAgentToolInput(data)) {
          throw new ModelBehaviorError('Agent tool called with invalid input');
        }
        const runner = new Runner(runConfig ?? {});
        // Only flip to streaming mode when a handler is provided to avoid extra overhead for callers that do not need events.
        // Flip to streaming if either a legacy onStream callback or event handlers are registered; otherwise stay on the non-stream path to avoid extra overhead.
        const shouldStream =
          typeof onStream === 'function' || eventHandlers.size > 0;
        const result = shouldStream
          ? await runner.run(this, data.input, {
              context,
              ...(runOptions ?? {}),
              stream: true,
            })
          : await runner.run(this, data.input, {
              context,
              ...(runOptions ?? {}),
            });
        const streamPayload = {
          agent: this,
          toolCall: details?.toolCall,
        };

        if (shouldStream) {
          // Cast through unknown: the async iterator shape matches and we want to drain the stream for side effects while keeping the public API stable.
          const streamResult = result as unknown as StreamedRunResult<
            TContext,
            Agent<TContext, AgentOutputType>
          >;
          // Drain the stream to deliver every event to registered handlers; ensure completion awaited so the nested run finishes before returning.
          for await (const event of streamResult) {
            await emitEvent({
              event,
              ...streamPayload,
            });
          }
          await streamResult.completed;
        }

        const completedResult = result as CompletedRunResult<TContext, TAgent>;

        const usesStopAtToolNames =
          typeof this.toolUseBehavior === 'object' &&
          this.toolUseBehavior !== null &&
          'stopAtToolNames' in this.toolUseBehavior;

        if (
          typeof customOutputExtractor !== 'function' &&
          usesStopAtToolNames
        ) {
          logger.debug(
            `You're passing the agent (name: ${this.name}) with toolUseBehavior.stopAtToolNames configured as a tool to a different agent; this may not work as you expect. You may want to have a wrapper function tool to consistently return the final output.`,
          );
        }
        let outputText: string;
        if (typeof customOutputExtractor === 'function') {
          outputText = await customOutputExtractor(completedResult);
        } else {
          const finalOutputText =
            typeof completedResult.finalOutput !== 'undefined'
              ? this.outputType === 'text'
                ? String(completedResult.finalOutput)
                : JSON.stringify(completedResult.finalOutput)
              : undefined;
          const rawResponses = completedResult.rawResponses;
          const rawOutputText =
            rawResponses && rawResponses.length > 0
              ? getOutputText(rawResponses[rawResponses.length - 1])
              : undefined;
          const normalizedRawOutputText =
            typeof rawOutputText === 'string' && rawOutputText.trim() === ''
              ? undefined
              : rawOutputText;
          const prefersFinalOutput =
            completedResult.state?._finalOutputSource === 'error_handler';
          outputText = prefersFinalOutput
            ? (finalOutputText ?? normalizedRawOutputText ?? '')
            : (normalizedRawOutputText ?? finalOutputText ?? '');
        }

        if (details?.toolCall) {
          saveAgentToolRunResult(
            details.toolCall,
            completedResult as AnyAgentRunResult,
          );
        }
        return outputText;
      },
    });

    const agentTool: AgentTool<TContext, TAgent> = {
      ...baseTool,
      on: (name, handler) => {
        const set =
          eventHandlers.get(name) ?? new Set<AgentToolEventHandler<TAgent>>();
        set.add(handler);
        eventHandlers.set(name, set);
        return agentTool;
      },
    };

    return agentTool;
  }

  /**
   * Returns the system prompt for the agent.
   *
   * If the agent has a function as its instructions, this function will be called with the
   * runContext and the agent instance.
   */
  async getSystemPrompt(
    runContext: RunContext<TContext>,
  ): Promise<string | undefined> {
    if (typeof this.instructions === 'function') {
      return await this.instructions(runContext, this);
    }

    return this.instructions;
  }

  /**
   * Returns the prompt template for the agent, if defined.
   *
   * If the agent has a function as its prompt, this function will be called with the
   * runContext and the agent instance.
   */
  async getPrompt(
    runContext: RunContext<TContext>,
  ): Promise<Prompt | undefined> {
    if (typeof this.prompt === 'function') {
      return await this.prompt(runContext, this);
    }
    return this.prompt;
  }

  /**
   * Fetches the available tools from the MCP servers.
   * @returns the MCP powered tools
   */
  async getMcpTools(
    runContext: RunContext<TContext>,
  ): Promise<Tool<TContext>[]> {
    if (this.mcpServers.length > 0) {
      return getAllMcpTools({
        mcpServers: this.mcpServers,
        runContext,
        agent: this,
        convertSchemasToStrict: false,
      });
    }

    return [];
  }

  /**
   * ALl agent tools, including the MCPl and function tools.
   *
   * @returns all configured tools
   */
  async getAllTools(
    runContext: RunContext<TContext>,
  ): Promise<Tool<TContext>[]> {
    const mcpTools = await this.getMcpTools(runContext);
    const enabledTools: Tool<TContext>[] = [];

    for (const candidate of this.tools) {
      if (candidate.type === 'function') {
        const maybeIsEnabled = (
          candidate as { isEnabled?: ToolEnabledFunction<TContext> | boolean }
        ).isEnabled;

        const enabled =
          typeof maybeIsEnabled === 'function'
            ? await maybeIsEnabled(runContext, this)
            : typeof maybeIsEnabled === 'boolean'
              ? maybeIsEnabled
              : true;
        if (!enabled) {
          continue;
        }
      }
      enabledTools.push(candidate);
    }

    return [...mcpTools, ...enabledTools];
  }

  hasExplicitToolConfig(): boolean {
    return this._toolsExplicitlyConfigured;
  }

  /**
   * Returns the handoffs that should be exposed to the model for the current run.
   *
   * Handoffs that provide an `isEnabled` function returning `false` are omitted.
   */
  async getEnabledHandoffs(
    runContext: RunContext<TContext>,
  ): Promise<Handoff<any, any>[]> {
    const handoffs = this.handoffs?.map((h) => getHandoff(h)) ?? [];
    const enabled: Handoff<any, any>[] = [];
    for (const handoff of handoffs) {
      if (await handoff.isEnabled({ runContext, agent: this })) {
        enabled.push(handoff);
      }
    }
    return enabled;
  }

  /**
   * Processes the final output of the agent.
   *
   * @param output - The output of the agent.
   * @returns The parsed out.
   */
  processFinalOutput(output: string): ResolvedAgentOutput<TOutput> {
    if (this.outputType === 'text') {
      return output as ResolvedAgentOutput<TOutput>;
    }

    if (typeof this.outputType === 'object') {
      const parsed = JSON.parse(output);

      if (isZodObject(this.outputType)) {
        return this.outputType.parse(parsed) as ResolvedAgentOutput<TOutput>;
      }

      return parsed as ResolvedAgentOutput<TOutput>;
    }

    throw new Error(`Unknown output type: ${this.outputType}`);
  }

  /**
   * Returns a JSON representation of the agent, which is serializable.
   *
   * @returns A JSON object containing the agent's name.
   */
  toJSON() {
    return {
      name: this.name,
    };
  }
}
