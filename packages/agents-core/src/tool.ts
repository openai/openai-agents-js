import type { Agent } from './agent';
import type { Computer } from './computer';
import type { Shell, ShellAction } from './shell';
import type { Editor, ApplyPatchOperation } from './editor';
import {
  JsonObjectSchema,
  JsonObjectSchemaNonStrict,
  JsonObjectSchemaStrict,
  UnknownContext,
} from './types';
import { safeExecute } from './utils/safeExecute';
import { toFunctionToolName } from './utils/tools';
import { getSchemaAndParserFromInputType } from './utils/tools';
import { isZodObject } from './utils/typeGuards';
import { RunContext } from './runContext';
import type { RunResult } from './result';
import { InvalidToolInputError, UserError } from './errors';
import logger from './logger';
import { getCurrentSpan } from './tracing';
import { RunToolApprovalItem, RunToolCallOutputItem } from './items';
import { toSmartString } from './utils/smartString';
import * as ProviderData from './types/providerData';
import * as protocol from './types/protocol';
import type { ZodInfer, ZodObjectLike } from './utils/zodCompat';
import {
  resolveToolInputGuardrails,
  resolveToolOutputGuardrails,
  ToolInputGuardrailDefinition,
  ToolOutputGuardrailDefinition,
  ToolInputGuardrailFunction,
  ToolOutputGuardrailFunction,
} from './toolGuardrail';

export type {
  ToolOutputText,
  ToolOutputImage,
  ToolOutputFileContent,
  ToolCallStructuredOutput,
  ToolCallOutputContent,
} from './types/protocol';

/**
 * A function that determines if a tool call should be approved.
 *
 * @param runContext The current run context
 * @param input The input to the tool
 * @param callId The ID of the tool call
 * @returns True if the tool call should be approved, false otherwise
 */
export type ToolApprovalFunction<TParameters extends ToolInputParameters> = (
  runContext: RunContext,
  input: ToolExecuteArgument<TParameters>,
  callId?: string,
) => Promise<boolean>;

export type ShellApprovalFunction = (
  runContext: RunContext,
  action: ShellAction,
  callId?: string,
) => Promise<boolean>;

export type ShellOnApprovalFunction = (
  runContext: RunContext,
  approvalItem: RunToolApprovalItem,
) => Promise<{ approve: boolean; reason?: string }>;

export type ApplyPatchApprovalFunction = (
  runContext: RunContext,
  operation: ApplyPatchOperation,
  callId?: string,
) => Promise<boolean>;

export type ApplyPatchOnApprovalFunction = (
  runContext: RunContext,
  approvalItem: RunToolApprovalItem,
) => Promise<{ approve: boolean; reason?: string }>;

export type ToolEnabledFunction<Context = UnknownContext> = (
  runContext: RunContext<Context>,
  agent: Agent<any, any>,
) => Promise<boolean>;

type ToolEnabledPredicate<Context = UnknownContext> = (args: {
  runContext: RunContext<Context>;
  agent: Agent<any, any>;
}) => boolean | Promise<boolean>;

type ToolEnabledOption<Context = UnknownContext> =
  | boolean
  | ToolEnabledPredicate<Context>;

/**
 * Exposes a function to the agent as a tool to be called
 *
 * @param Context The context of the tool
 * @param Result The result of the tool
 */
export type FunctionTool<
  Context = UnknownContext,
  TParameters extends ToolInputParameters = undefined,
  Result = unknown,
> = {
  type: 'function';
  /**
   * The name of the tool.
   */
  name: string;
  /**
   * The description of the tool that helps the model to understand when to use the tool
   */
  description: string;
  /**
   * A JSON schema describing the parameters of the tool.
   */
  parameters: JsonObjectSchema<any>;
  /**
   * Whether the tool is strict. If true, the model must try to strictly follow the schema (might result in slower response times).
   */
  strict: boolean;

  /**
   * The function to invoke when the tool is called.
   */
  invoke: (
    runContext: RunContext<Context>,
    input: string,
    details?: { toolCall: protocol.FunctionCallItem },
  ) => Promise<string | Result>;

  /**
   * Whether the tool needs human approval before it can be called. If this is true, the run will result in an `interruption` that the
   * program has to resolve by approving or rejecting the tool call.
   */
  needsApproval: ToolApprovalFunction<TParameters>;

  /**
   * Determines whether the tool should be made available to the model for the current run.
   */
  isEnabled: ToolEnabledFunction<Context>;
  /**
   * Guardrails that run before the tool executes.
   */
  inputGuardrails?: ToolInputGuardrailDefinition<Context>[];
  /**
   * Guardrails that run after the tool executes.
   */
  outputGuardrails?: ToolOutputGuardrailDefinition<Context>[];
};

/**
 * Arguments provided to computer initializers.
 */
export type ComputerInitializerArgs<Context = UnknownContext> = {
  runContext: RunContext<Context>;
};

/**
 * A function that initializes a computer for the current run.
 */
type BivariantComputerCreate<
  Context = UnknownContext,
  TComputer extends Computer = Computer,
> = {
  // Use the conventional "bivarianceHack" pattern so user callbacks can accept
  // narrower Computer types without contravariant parameter errors in TS.
  // See: https://www.typescriptlang.org/docs/handbook/type-compatibility.html#function-parameter-bivariance
  bivarianceHack: (
    args: ComputerInitializerArgs<Context>,
  ) => TComputer | Promise<TComputer>;
}['bivarianceHack'];

// Keep initializer/disposer bivariant so user code can specify narrower Computer types without
// forcing contravariant function argument types downstream.
export type ComputerCreate<
  Context = UnknownContext,
  TComputer extends Computer = Computer,
> = BivariantComputerCreate<Context, TComputer>;

/**
 * Optional cleanup invoked after a run finishes when the computer was created via an initializer.
 */
type BivariantComputerDispose<
  Context = UnknownContext,
  TComputer extends Computer = Computer,
> = {
  // Apply the same bivariance pattern to cleanup callbacks for consistent ergonomics.
  bivarianceHack: (
    args: ComputerInitializerArgs<Context> & { computer: TComputer },
  ) => void | Promise<void>;
}['bivarianceHack'];

export type ComputerDispose<
  Context = UnknownContext,
  TComputer extends Computer = Computer,
> = BivariantComputerDispose<Context, TComputer>;

/**
 * Initializes a computer for the current run and optionally tears it down after the run.
 */
export type ComputerProvider<
  Context = UnknownContext,
  TComputer extends Computer = Computer,
> = {
  create: ComputerCreate<Context, TComputer>;
  dispose?: ComputerDispose<Context, TComputer>;
};

type ComputerInitializer<
  Context = UnknownContext,
  TComputer extends Computer = Computer,
> = ComputerCreate<Context, TComputer> | ComputerProvider<Context, TComputer>;

export type ComputerConfig<
  Context = UnknownContext,
  TComputer extends Computer = Computer,
> = Computer | ComputerInitializer<Context, TComputer>;

function isComputerProvider<Context, TComputer extends Computer>(
  candidate: unknown,
): candidate is ComputerProvider<Context, TComputer> {
  return (
    !!candidate &&
    typeof candidate === 'object' &&
    typeof (candidate as { create?: unknown }).create === 'function'
  );
}

/**
 * Exposes a computer to the model as a tool to be called
 *
 * @param Context The context of the tool
 * @param Result The result of the tool
 */
export type ComputerTool<
  Context = UnknownContext,
  TComputer extends Computer = Computer,
> = {
  type: 'computer';
  /**
   * The name of the tool.
   */
  name: 'computer_use_preview' | (string & {});

  /**
   * The computer to use.
   */
  computer: ComputerConfig<Context, TComputer>;
};

/**
 * Exposes a computer to the agent as a tool to be called.
 *
 * @param options Additional configuration for the computer tool like specifying the location of your agent
 * @returns a computer tool definition
 */
export function computerTool<
  Context = UnknownContext,
  TComputer extends Computer = Computer,
>(options: {
  name?: string;
  computer: ComputerConfig<Context, TComputer>;
}): ComputerTool<Context, TComputer> {
  if (!options.computer) {
    throw new UserError(
      'computerTool requires a computer instance or an initializer function.',
    );
  }

  const tool: ComputerTool<Context, TComputer> = {
    type: 'computer',
    name: options.name ?? 'computer_use_preview',
    computer: options.computer,
  };

  if (
    typeof options.computer === 'function' ||
    isComputerProvider(options.computer)
  ) {
    computerInitializerMap.set(
      tool as AnyComputerTool,
      options.computer as ComputerInitializer<Context, any>,
    );
  }

  return tool;
}

type ResolvedComputer<Context> = {
  computer: Computer;
  dispose?: ComputerDispose<Context, Computer>;
};

type AnyComputerTool = ComputerTool<any, Computer>;

// Keeps per-tool cache of computer instances keyed by RunContext so each run gets its own instance.
const computerCache = new WeakMap<
  AnyComputerTool,
  WeakMap<RunContext<any>, ResolvedComputer<any>>
>();
// Tracks the initializer so we do not overwrite the callable on the tool when we memoize the resolved instance.
const computerInitializerMap = new WeakMap<
  AnyComputerTool,
  ComputerInitializer<any, any>
>();
// Allows cleanup routines to find all resolved computer instances for a given run context.
const computersByRunContext = new WeakMap<
  RunContext<any>,
  Map<AnyComputerTool, ResolvedComputer<any>>
>();

function getComputerInitializer<Context>(
  tool: ComputerTool<Context, any>,
): ComputerInitializer<Context, any> | undefined {
  const initializer = computerInitializerMap.get(tool as AnyComputerTool);
  if (initializer) {
    return initializer as ComputerInitializer<Context, any>;
  }
  if (
    typeof tool.computer === 'function' ||
    isComputerProvider(tool.computer)
  ) {
    return tool.computer as ComputerInitializer<Context, any>;
  }
  return undefined;
}

function trackResolvedComputer<Context>(
  tool: ComputerTool<Context, any>,
  runContext: RunContext<Context>,
  resolved: ResolvedComputer<Context>,
) {
  let resolvedByRun = computersByRunContext.get(runContext);
  if (!resolvedByRun) {
    resolvedByRun = new Map();
    computersByRunContext.set(runContext, resolvedByRun);
  }
  resolvedByRun.set(tool as AnyComputerTool, resolved);
}

/**
 * Returns a computer instance for the provided run context. Caches per run to avoid sharing across runs.
 * @internal
 */
export async function resolveComputer<
  Context,
  TComputer extends Computer = Computer,
>(args: {
  tool: ComputerTool<Context, TComputer>;
  runContext: RunContext<Context>;
}): Promise<TComputer> {
  const { tool, runContext } = args;
  // Cache instances per RunContext so a single Computer is not shared across simultaneous runs.
  const toolKey = tool as AnyComputerTool;
  let perContext = computerCache.get(toolKey);
  if (!perContext) {
    perContext = new WeakMap();
    computerCache.set(toolKey, perContext);
  }

  const cached = perContext.get(runContext);
  if (cached) {
    trackResolvedComputer(tool, runContext, cached);
    return cached.computer as TComputer;
  }

  const initializerConfig = getComputerInitializer(tool);
  const lifecycle =
    initializerConfig && isComputerProvider(initializerConfig)
      ? initializerConfig
      : isComputerProvider(tool.computer)
        ? (tool.computer as ComputerProvider<Context, any>)
        : undefined;
  const initializer =
    typeof initializerConfig === 'function'
      ? initializerConfig
      : (lifecycle?.create ??
        (typeof tool.computer === 'function'
          ? (tool.computer as ComputerCreate<Context, TComputer>)
          : undefined));
  const disposer = lifecycle?.dispose;

  const computer =
    initializer && typeof initializer === 'function'
      ? await initializer({ runContext })
      : (tool.computer as Computer);

  if (!computer) {
    throw new UserError(
      'The computer tool did not provide a computer instance.',
    );
  }

  const resolved: ResolvedComputer<Context> = {
    computer,
    dispose: disposer,
  };
  perContext.set(runContext, resolved);
  trackResolvedComputer(tool, runContext, resolved);
  tool.computer = computer as ComputerConfig<Context, TComputer>;
  return computer as TComputer;
}

/**
 * Disposes any computer instances created for the provided run context.
 * @internal
 */
export async function disposeResolvedComputers<Context>({
  runContext,
}: {
  runContext: RunContext<Context>;
}): Promise<void> {
  const resolvedByRun = computersByRunContext.get(runContext);
  if (!resolvedByRun) {
    return;
  }
  computersByRunContext.delete(runContext);

  const disposers: Array<() => Promise<void>> = [];

  for (const [tool, resolved] of resolvedByRun.entries()) {
    const perContext = computerCache.get(tool);
    perContext?.delete(runContext);

    const storedInitializer = getComputerInitializer(tool);
    if (storedInitializer) {
      tool.computer = storedInitializer;
    }

    if (resolved.dispose) {
      disposers.push(async () => {
        await resolved.dispose?.({ runContext, computer: resolved.computer });
      });
    }
  }

  for (const dispose of disposers) {
    try {
      await dispose();
    } catch (error) {
      logger.warn(`Failed to dispose computer for run context: ${error}`);
    }
  }
}

export type ShellTool = {
  type: 'shell';
  /**
   * Public name exposed to the model. Defaults to `shell`.
   */
  name: string;
  /**
   * The shell implementation to execute commands.
   */
  shell: Shell;
  /**
   * Predicate determining whether this shell action requires approval.
   */
  needsApproval: ShellApprovalFunction;
  /**
   * Optional handler to auto-approve or reject when approval is required.
   * If provided, it will be invoked immediately when an approval is needed.
   */
  onApproval?: ShellOnApprovalFunction;
};

export function shellTool(
  options: Partial<Omit<ShellTool, 'type' | 'shell' | 'needsApproval'>> & {
    shell: Shell;
    needsApproval?: boolean | ShellApprovalFunction;
    onApproval?: ShellOnApprovalFunction;
  },
): ShellTool {
  const needsApproval: ShellApprovalFunction =
    typeof options.needsApproval === 'function'
      ? options.needsApproval
      : async () =>
          typeof options.needsApproval === 'boolean'
            ? options.needsApproval
            : false;

  return {
    type: 'shell',
    name: options.name ?? 'shell',
    shell: options.shell,
    needsApproval,
    onApproval: options.onApproval,
  };
}

export type ApplyPatchTool = {
  type: 'apply_patch';
  /**
   * Public name exposed to the model. Defaults to `apply_patch`.
   */
  name: string;
  /**
   * Diff applier invoked when the tool is called.
   */
  editor: Editor;
  /**
   * Predicate determining whether this apply_patch operation requires approval.
   */
  needsApproval: ApplyPatchApprovalFunction;
  /**
   * Optional handler to auto-approve or reject when approval is required.
   */
  onApproval?: ApplyPatchOnApprovalFunction;
};

export function applyPatchTool(
  options: Partial<
    Omit<ApplyPatchTool, 'type' | 'editor' | 'needsApproval'>
  > & {
    editor: Editor;
    needsApproval?: boolean | ApplyPatchApprovalFunction;
    onApproval?: ApplyPatchOnApprovalFunction;
  },
): ApplyPatchTool {
  const needsApproval: ApplyPatchApprovalFunction =
    typeof options.needsApproval === 'function'
      ? options.needsApproval
      : async () =>
          typeof options.needsApproval === 'boolean'
            ? options.needsApproval
            : false;

  return {
    type: 'apply_patch',
    name: options.name ?? 'apply_patch',
    editor: options.editor,
    needsApproval,
    onApproval: options.onApproval,
  };
}

export type HostedMCPApprovalFunction<Context = UnknownContext> = (
  context: RunContext<Context>,
  data: RunToolApprovalItem,
) => Promise<{ approve: boolean; reason?: string }>;

/**
 * A hosted MCP tool that lets the model call a remote MCP server directly
 * without a round trip back to your code.
 */
export type HostedMCPTool<Context = UnknownContext> = HostedTool & {
  name: 'hosted_mcp';
  providerData: ProviderData.HostedMCPTool<Context>;
};

/**
 * Creates a hosted MCP tool definition.
 *
 * @param options - Configuration for the hosted MCP tool, including server connection details
 * and approval requirements.
 */
export function hostedMcpTool<Context = UnknownContext>(
  options: {
    allowedTools?: string[] | { toolNames?: string[] };
  } &
    // MCP server
    (| {
          serverLabel: string;
          serverUrl?: string;
          authorization?: string;
          headers?: Record<string, string>;
        }
      // OpenAI Connector
      | {
          serverLabel: string;
          connectorId: string;
          authorization?: string;
          headers?: Record<string, string>;
        }
    ) &
    (
      | { requireApproval?: never }
      | { requireApproval: 'never' }
      | {
          requireApproval:
            | 'always'
            | {
                never?: { toolNames: string[] };
                always?: { toolNames: string[] };
              };
          onApproval?: HostedMCPApprovalFunction<Context>;
        }
    ),
): HostedMCPTool<Context> {
  if ('serverUrl' in options) {
    // the MCP servers comaptible with the specification
    const providerData: ProviderData.HostedMCPTool<Context> =
      typeof options.requireApproval === 'undefined' ||
      options.requireApproval === 'never'
        ? {
            type: 'mcp',
            server_label: options.serverLabel,
            server_url: options.serverUrl,
            authorization: options.authorization,
            require_approval: 'never',
            allowed_tools: toMcpAllowedToolsFilter(options.allowedTools),
            headers: options.headers,
          }
        : {
            type: 'mcp',
            server_label: options.serverLabel,
            server_url: options.serverUrl,
            authorization: options.authorization,
            allowed_tools: toMcpAllowedToolsFilter(options.allowedTools),
            headers: options.headers,
            require_approval:
              typeof options.requireApproval === 'string'
                ? 'always'
                : buildRequireApproval(options.requireApproval),
            on_approval: options.onApproval,
          };
    return {
      type: 'hosted_tool',
      name: 'hosted_mcp',
      providerData,
    };
  } else if ('connectorId' in options) {
    // OpenAI's connectors
    const providerData: ProviderData.HostedMCPTool<Context> =
      typeof options.requireApproval === 'undefined' ||
      options.requireApproval === 'never'
        ? {
            type: 'mcp',
            server_label: options.serverLabel,
            connector_id: options.connectorId,
            authorization: options.authorization,
            require_approval: 'never',
            allowed_tools: toMcpAllowedToolsFilter(options.allowedTools),
            headers: options.headers,
          }
        : {
            type: 'mcp',
            server_label: options.serverLabel,
            connector_id: options.connectorId,
            authorization: options.authorization,
            allowed_tools: toMcpAllowedToolsFilter(options.allowedTools),
            headers: options.headers,
            require_approval:
              typeof options.requireApproval === 'string'
                ? 'always'
                : buildRequireApproval(options.requireApproval),
            on_approval: options.onApproval,
          };
    return {
      type: 'hosted_tool',
      name: 'hosted_mcp',
      providerData,
    };
  } else {
    // the MCP servers comaptible with the specification
    const providerData: ProviderData.HostedMCPTool<Context> =
      typeof options.requireApproval === 'undefined' ||
      options.requireApproval === 'never'
        ? {
            type: 'mcp',
            server_label: options.serverLabel,
            require_approval: 'never',
            allowed_tools: toMcpAllowedToolsFilter(options.allowedTools),
          }
        : {
            type: 'mcp',
            server_label: options.serverLabel,
            allowed_tools: toMcpAllowedToolsFilter(options.allowedTools),
            require_approval:
              typeof options.requireApproval === 'string'
                ? 'always'
                : buildRequireApproval(options.requireApproval),
            on_approval: options.onApproval,
          };
    return {
      type: 'hosted_tool',
      name: 'hosted_mcp',
      providerData,
    };
  }
}

/**
 * A built-in hosted tool that will be executed directly by the model during the request and won't result in local code executions.
 * Examples of these are `web_search_call` or `file_search_call`.
 *
 * @param Context The context of the tool
 * @param Result The result of the tool
 */
export type HostedTool = {
  type: 'hosted_tool';
  /**
   * A unique name for the tool.
   */
  name: string;
  /**
   * Additional configuration data that gets passed to the tool
   */
  providerData?: Record<string, any>;
};

/**
 * A tool that can be called by the model.
 * @template Context The context passed to the tool
 */
export type Tool<Context = unknown> =
  | FunctionTool<Context, any, any>
  | ComputerTool<Context, any>
  | ShellTool
  | ApplyPatchTool
  | HostedTool;

/**
 * The result of invoking a function tool. Either the actual output of the execution or a tool
 * approval request.
 *
 * These get passed for example to the `toolUseBehavior` option of the `Agent` constructor.
 */
export type FunctionToolResult<
  Context = UnknownContext,
  TParameters extends ToolInputParameters = any,
  Result = any,
> =
  | {
      type: 'function_output';
      /**
       * The tool that was called.
       */
      tool: FunctionTool<Context, TParameters, Result>;
      /**
       * The output of the tool call. This can be a string or a stringifable item.
       */
      output: string | unknown;
      /**
       * The run item representing the tool call output.
       */
      runItem: RunToolCallOutputItem;
      /**
       * The result returned when the tool execution runs another agent. Populated when the
       * invocation originated from {@link Agent.asTool} and the nested agent completed a run.
       */
      agentRunResult?: RunResult<Context, Agent<Context, any>>;
      /**
       * Any interruptions collected while the nested agent executed. These are surfaced to allow
       * callers to pause and resume workflows that require approvals.
       */
      interruptions?: RunToolApprovalItem[];
    }
  | {
      /**
       * Indicates that the tool requires approval before it can be called.
       */
      type: 'function_approval';
      /**
       * The tool that is requiring to be approved.
       */
      tool: FunctionTool<Context, TParameters, Result>;
      /**
       * The item representing the tool call that is requiring approval.
       */
      runItem: RunToolApprovalItem;
    }
  | {
      /**
       * Indicates that the tool requires approval before it can be called.
       */
      type: 'hosted_mcp_tool_approval';
      /**
       * The tool that is requiring to be approved.
       */
      tool: HostedMCPTool<Context>;
      /**
       * The item representing the tool call that is requiring approval.
       */
      runItem: RunToolApprovalItem;
    };

/**
 * The parameters of a tool.
 *
 * This can be a Zod schema, a JSON schema or undefined.
 *
 * If a Zod schema is provided, the arguments to the tool will automatically be parsed and validated
 * against the schema.
 *
 * If a JSON schema is provided, the arguments to the tool will be passed as is.
 *
 * If undefined is provided, the arguments to the tool will be passed as a string.
 */
export type ToolInputParameters =
  | undefined
  | ZodObjectLike
  | JsonObjectSchema<any>;

/**
 * The parameters of a tool that has strict mode enabled.
 *
 * This can be a Zod schema, a JSON schema or undefined.
 *
 * If a Zod schema is provided, the arguments to the tool will automatically be parsed and validated
 * against the schema.
 *
 * If a JSON schema is provided, the arguments to the tool will be parsed as JSON but not validated.
 *
 * If undefined is provided, the arguments to the tool will be passed as a string.
 */
export type ToolInputParametersStrict =
  | undefined
  | ZodObjectLike
  | JsonObjectSchemaStrict<any>;

/**
 * The parameters of a tool that has strict mode disabled.
 *
 * If a JSON schema is provided, the arguments to the tool will be parsed as JSON but not validated.
 *
 * Zod schemas are not supported without strict: true.
 */
export type ToolInputParametersNonStrict =
  | undefined
  | JsonObjectSchemaNonStrict<any>;

/**
 * The arguments to a tool.
 *
 * The type of the arguments are derived from the parameters passed to the tool definition.
 *
 * If the parameters are passed as a JSON schema the type is `unknown`. For Zod schemas it will
 * match the inferred Zod type. Otherwise the type is `string`
 */
export type ToolExecuteArgument<TParameters extends ToolInputParameters> =
  TParameters extends ZodObjectLike
    ? ZodInfer<TParameters>
    : TParameters extends JsonObjectSchema<any>
      ? unknown
      : string;

/**
 * The function to invoke when the tool is called.
 *
 * @param input The arguments to the tool (see ToolExecuteArgument)
 * @param context An instance of the current RunContext
 */
type ToolExecuteFunction<
  TParameters extends ToolInputParameters,
  Context = UnknownContext,
> = (
  input: ToolExecuteArgument<TParameters>,
  context?: RunContext<Context>,
  details?: { toolCall: protocol.FunctionCallItem },
) => Promise<unknown> | unknown;

/**
 * The function to invoke when an error occurs while running the tool. This can be used to define
 * what the model should receive as tool output in case of an error. It can be used to provide
 * for example additional context or a fallback value.
 *
 * @param context An instance of the current RunContext
 * @param error The error that occurred
 */
type ToolErrorFunction = (
  context: RunContext,
  error: Error | unknown,
) => Promise<string> | string;

type ToolGuardrailOptions<Context = UnknownContext> = {
  /**
   * Guardrails that validate or block tool invocation before it runs.
   */
  inputGuardrails?:
    | ToolInputGuardrailDefinition<Context>[]
    | {
        name: string;
        run: ToolInputGuardrailFunction<Context>;
      }[];
  /**
   * Guardrails that validate or alter tool output after it runs.
   */
  outputGuardrails?:
    | ToolOutputGuardrailDefinition<Context>[]
    | {
        name: string;
        run: ToolOutputGuardrailFunction<Context>;
      }[];
};

/**
 * The default function to invoke when an error occurs while running the tool.
 *
 * Always returns `An error occurred while running the tool. Please try again. Error: <error details>`
 *
 * @param context An instance of the current RunContext
 * @param error The error that occurred
 */
function defaultToolErrorFunction(context: RunContext, error: Error | unknown) {
  const details = error instanceof Error ? error.toString() : String(error);
  return `An error occurred while running the tool. Please try again. Error: ${details}`;
}

/**
 * The options for a tool that has strict mode enabled.
 *
 * @param TParameters The parameters of the tool
 * @param Context The context of the tool
 */
type StrictToolOptions<
  TParameters extends ToolInputParametersStrict,
  Context = UnknownContext,
> = ToolGuardrailOptions<Context> & {
  /**
   * The name of the tool. Must be unique within the agent.
   */
  name?: string;

  /**
   * The description of the tool. This is used to help the model understand when to use the tool.
   */
  description: string;

  /**
   * A Zod schema or JSON schema describing the parameters of the tool.
   * If a Zod schema is provided, the arguments to the tool will automatically be parsed and validated
   * against the schema.
   */
  parameters: TParameters;

  /**
   * Whether the tool is strict. If true, the model must try to strictly follow the schema (might result in slower response times).
   */
  strict?: true;

  /**
   * The function to invoke when the tool is called.
   */
  execute: ToolExecuteFunction<TParameters, Context>;

  /**
   * The function to invoke when an error occurs while running the tool.
   */
  errorFunction?: ToolErrorFunction | null;

  /**
   * Whether the tool needs human approval before it can be called. If this is true, the run will result in an `interruption` that the
   * program has to resolve by approving or rejecting the tool call.
   */
  needsApproval?: boolean | ToolApprovalFunction<TParameters>;

  /**
   * Determines whether the tool should be exposed to the model for the current run.
   */
  isEnabled?: ToolEnabledOption<Context>;
};

/**
 * The options for a tool that has strict mode disabled.
 *
 * @param TParameters The parameters of the tool
 * @param Context The context of the tool
 */
type NonStrictToolOptions<
  TParameters extends ToolInputParametersNonStrict,
  Context = UnknownContext,
> = ToolGuardrailOptions<Context> & {
  /**
   * The name of the tool. Must be unique within the agent.
   */
  name?: string;

  /**
   * The description of the tool. This is used to help the model understand when to use the tool.
   */
  description: string;

  /**
   * A JSON schema of the tool. To use a Zod schema, you need to use a `strict` schema.
   */
  parameters: TParameters;

  /**
   * Whether the tool is strict  If true, the model must try to strictly follow the schema (might result in slower response times).
   */
  strict: false;

  /**
   * The function to invoke when the tool is called.
   */
  execute: ToolExecuteFunction<TParameters, Context>;

  /**
   * The function to invoke when an error occurs while running the tool.
   */
  errorFunction?: ToolErrorFunction | null;

  /**
   * Whether the tool needs human approval before it can be called. If this is true, the run will result in an `interruption` that the
   * program has to resolve by approving or rejecting the tool call.
   */
  needsApproval?: boolean | ToolApprovalFunction<TParameters>;

  /**
   * Determines whether the tool should be exposed to the model for the current run.
   */
  isEnabled?: ToolEnabledOption<Context>;
};

/**
 * The options for a tool.
 *
 * @param TParameters The parameters of the tool
 * @param Context The context of the tool
 */
export type ToolOptions<
  TParameters extends ToolInputParameters,
  Context = UnknownContext,
> =
  | StrictToolOptions<Extract<TParameters, ToolInputParametersStrict>, Context>
  | NonStrictToolOptions<
      Extract<TParameters, ToolInputParametersNonStrict>,
      Context
    >;

export type ToolOptionsWithGuardrails<
  TParameters extends ToolInputParameters,
  Context = UnknownContext,
> = ToolOptions<TParameters, Context>;

/**
 * Exposes a function to the agent as a tool to be called
 *
 * @param options The options for the tool
 * @returns A new tool
 */
export function tool<
  TParameters extends ToolInputParameters = undefined,
  Context = UnknownContext,
  Result = string,
>(
  options: ToolOptions<TParameters, Context>,
): FunctionTool<Context, TParameters, Result> {
  const name = options.name
    ? toFunctionToolName(options.name)
    : toFunctionToolName(options.execute.name);
  const toolErrorFunction: ToolErrorFunction | null =
    typeof options.errorFunction === 'undefined'
      ? defaultToolErrorFunction
      : options.errorFunction;

  if (!name) {
    throw new Error(
      'Tool name cannot be empty. Either name your function or provide a name in the options.',
    );
  }

  const strictMode = options.strict ?? true;
  if (!strictMode && isZodObject(options.parameters)) {
    throw new UserError('Strict mode is required for Zod parameters');
  }

  const { parser, schema: parameters } = getSchemaAndParserFromInputType(
    options.parameters,
    name,
  );

  async function _invoke(
    runContext: RunContext<Context>,
    input: string,
    details?: { toolCall: protocol.FunctionCallItem },
  ): Promise<Result> {
    const [error, parsed] = await safeExecute(() => parser(input));
    if (error !== null) {
      if (logger.dontLogToolData) {
        logger.debug(`Invalid JSON input for tool ${name}`);
      } else {
        logger.debug(`Invalid JSON input for tool ${name}: ${input}`);
      }

      // supply the same context as options.execute for consuming
      // downstream code to implement self-healing and/or tracing
      throw new InvalidToolInputError(
        'Invalid JSON input for tool',
        undefined, // no RunState available in this context
        error,
        { runContext, input, details },
      );
    }

    if (logger.dontLogToolData) {
      logger.debug(`Invoking tool ${name}`);
    } else {
      logger.debug(`Invoking tool ${name} with input ${input}`);
    }

    const result = await options.execute(parsed, runContext, details);
    const stringResult = toSmartString(result);

    if (logger.dontLogToolData) {
      logger.debug(`Tool ${name} completed`);
    } else {
      logger.debug(`Tool ${name} returned: ${stringResult}`);
    }

    return result as Result;
  }

  async function invoke(
    runContext: RunContext<Context>,
    input: string,
    details?: { toolCall: protocol.FunctionCallItem },
  ): Promise<string | Result> {
    return _invoke(runContext, input, details).catch<string>((error) => {
      if (toolErrorFunction) {
        const currentSpan = getCurrentSpan();
        currentSpan?.setError({
          message: 'Error running tool (non-fatal)',
          data: {
            tool_name: name,
            error: error.toString(),
          },
        });
        return toolErrorFunction(runContext, error);
      }

      throw error;
    });
  }

  const needsApproval: ToolApprovalFunction<TParameters> =
    typeof options.needsApproval === 'function'
      ? options.needsApproval
      : async () =>
          typeof options.needsApproval === 'boolean'
            ? options.needsApproval
            : false;

  const isEnabled: ToolEnabledFunction<Context> =
    typeof options.isEnabled === 'function'
      ? async (runContext, agent) => {
          const predicate = options.isEnabled as ToolEnabledPredicate<Context>;
          const result = await predicate({ runContext, agent });
          return Boolean(result);
        }
      : async () =>
          typeof options.isEnabled === 'boolean' ? options.isEnabled : true;

  return {
    type: 'function',
    name,
    description: options.description,
    parameters,
    strict: strictMode,
    invoke,
    needsApproval,
    isEnabled,
    inputGuardrails: resolveToolInputGuardrails(options.inputGuardrails),
    outputGuardrails: resolveToolOutputGuardrails(options.outputGuardrails),
  };
}

function buildRequireApproval(requireApproval: {
  never?: { toolNames: string[] };
  always?: { toolNames: string[] };
}): { never?: { tool_names: string[] }; always?: { tool_names: string[] } } {
  const result: {
    never?: { tool_names: string[] };
    always?: { tool_names: string[] };
  } = {};
  if (requireApproval.always) {
    result.always = { tool_names: requireApproval.always.toolNames };
  }
  if (requireApproval.never) {
    result.never = { tool_names: requireApproval.never.toolNames };
  }
  return result;
}

function toMcpAllowedToolsFilter(
  allowedTools: string[] | { toolNames?: string[] } | undefined,
): { tool_names: string[] } | undefined {
  if (typeof allowedTools === 'undefined') {
    return undefined;
  }
  if (Array.isArray(allowedTools)) {
    return { tool_names: allowedTools };
  }
  return { tool_names: allowedTools?.toolNames ?? [] };
}
