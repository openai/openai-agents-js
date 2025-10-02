import type { Agent } from './agent';
import type { Computer } from './computer';
import type { infer as zInfer, ZodObject } from 'zod';
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
import { ModelBehaviorError, UserError } from './errors';
import logger from './logger';
import { getCurrentSpan } from './tracing';
import { RunToolApprovalItem, RunToolCallOutputItem } from './items';
import { toSmartString } from './utils/smartString';
import * as ProviderData from './types/providerData';
import * as protocol from './types/protocol';

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
};

/**
 * Exposes a computer to the model as a tool to be called
 *
 * @param Context The context of the tool
 * @param Result The result of the tool
 */
export type ComputerTool = {
  type: 'computer';
  /**
   * The name of the tool.
   */
  name: 'computer_use_preview' | string;

  /**
   * The computer to use.
   */
  computer: Computer;
};

/**
 * Exposes a computer to the agent as a tool to be called
 *
 * @param options Additional configuration for the computer tool like specifying the location of your agent
 * @returns a computer tool definition
 */
export function computerTool(
  options: Partial<Omit<ComputerTool, 'type'>> & { computer: Computer },
): ComputerTool {
  return {
    type: 'computer',
    name: options.name ?? 'computer_use_preview',
    computer: options.computer,
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
            require_approval: 'never',
            allowed_tools: toMcpAllowedToolsFilter(options.allowedTools),
            headers: options.headers,
          }
        : {
            type: 'mcp',
            server_label: options.serverLabel,
            server_url: options.serverUrl,
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
  | ComputerTool
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
  | ZodObject<any>
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
  | ZodObject<any>
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
  TParameters extends ZodObject<any>
    ? zInfer<TParameters>
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
> = {
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
> = {
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
      throw new ModelBehaviorError('Invalid JSON input for tool');
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
