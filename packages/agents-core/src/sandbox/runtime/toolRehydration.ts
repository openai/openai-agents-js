import type { Agent } from '../../agent';
import { UserError } from '../../errors';
import type { ProcessedResponse } from '../../runner/types';
import type {
  ApplyPatchTool,
  ComputerTool,
  FunctionTool,
  ShellTool,
  Tool,
} from '../../tool';
import {
  FUNCTION_TOOL_NAMESPACE,
  FUNCTION_TOOL_NAMESPACE_DESCRIPTION,
  getFunctionToolQualifiedName,
  resolveFunctionToolCallName,
} from '../../toolIdentity';
import * as protocol from '../../types/protocol';
import { isSandboxAgent } from './agentKeys';

const SERIALIZED_EXECUTION_TOOL_PLACEHOLDER = Symbol(
  'serializedExecutionToolPlaceholder',
);

function markSerializedExecutionToolPlaceholder<T extends object>(tool: T): T {
  Object.defineProperty(tool, SERIALIZED_EXECUTION_TOOL_PLACEHOLDER, {
    value: true,
    enumerable: false,
  });
  return tool;
}

function isSerializedExecutionToolPlaceholder(tool: unknown): boolean {
  return Boolean(
    tool &&
    typeof tool === 'object' &&
    (tool as { [SERIALIZED_EXECUTION_TOOL_PLACEHOLDER]?: unknown })[
      SERIALIZED_EXECUTION_TOOL_PLACEHOLDER
    ] === true,
  );
}

export function processedResponseRequiresExecutionToolRehydration(
  processedResponse: ProcessedResponse<any> | undefined,
): boolean {
  if (!processedResponse) {
    return false;
  }

  return (
    (processedResponse.functions ?? []).some((item) =>
      isSerializedExecutionToolPlaceholder(item.tool),
    ) ||
    (processedResponse.computerActions ?? []).some((item) =>
      isSerializedExecutionToolPlaceholder(item.computer),
    ) ||
    (processedResponse.shellActions ?? []).some((item) =>
      isSerializedExecutionToolPlaceholder(item.shell),
    ) ||
    (processedResponse.applyPatchActions ?? []).some((item) =>
      isSerializedExecutionToolPlaceholder(item.applyPatch),
    )
  );
}

function hasConfiguredFunctionTool(
  tools: Tool<any>[],
  toolCall: protocol.FunctionCallItem,
  toolIdentity: string,
): boolean {
  const configuredFunctionTools = new Map(
    tools
      .filter((tool) => tool.type === 'function')
      .map((tool) => [getFunctionToolQualifiedName(tool) ?? tool.name, tool]),
  );
  const configuredIdentity =
    resolveFunctionToolCallName(toolCall, configuredFunctionTools) ??
    toolIdentity;
  return configuredFunctionTools.has(configuredIdentity);
}

function hasConfiguredTool(
  tools: Tool<any>[],
  type: Tool['type'],
  name: string,
): boolean {
  return tools.some(
    (tool) =>
      tool.type === type &&
      'name' in tool &&
      typeof tool.name === 'string' &&
      tool.name === name,
  );
}

function canUseSerializedExecutionToolPlaceholder(args: {
  agent: Agent<any, any>;
  allowSerializedExecutionToolPlaceholder: boolean;
  configuredToolExists: boolean;
  serializedTool: unknown;
  type: Tool['type'];
}): boolean {
  const {
    agent,
    allowSerializedExecutionToolPlaceholder,
    configuredToolExists,
    serializedTool,
    type,
  } = args;
  return (
    allowSerializedExecutionToolPlaceholder &&
    isSandboxAgent(agent) &&
    !configuredToolExists &&
    Boolean(serializedTool) &&
    typeof serializedTool === 'object' &&
    (serializedTool as { type?: unknown }).type === type
  );
}

function getSerializedToolName(
  serializedTool: unknown,
  fallbackName: string,
): string {
  const name =
    serializedTool &&
    typeof serializedTool === 'object' &&
    typeof (serializedTool as { name?: unknown }).name === 'string'
      ? (serializedTool as { name: string }).name
      : fallbackName;
  return name;
}

function createSerializedExecutionToolError(
  type: string,
  name: string,
): UserError {
  return new UserError(
    `${type} tool ${name} was restored from serialized execution-time metadata without an executable handler. Resume the RunState through Runner.run() with the matching execution-time tool configuration before executing it.`,
  );
}

export function getSerializedFunctionToolPlaceholder<TContext>(args: {
  agent: Agent<any, any>;
  baseAgentTools: Tool<any>[];
  serializedTool: unknown;
  toolCall: protocol.FunctionCallItem;
  toolIdentity: string;
  allowSerializedExecutionToolPlaceholder: boolean;
}): FunctionTool<TContext> | undefined {
  const {
    agent,
    baseAgentTools,
    serializedTool,
    toolCall,
    toolIdentity,
    allowSerializedExecutionToolPlaceholder,
  } = args;
  if (
    !canUseSerializedExecutionToolPlaceholder({
      agent,
      allowSerializedExecutionToolPlaceholder,
      configuredToolExists: hasConfiguredFunctionTool(
        baseAgentTools,
        toolCall,
        toolIdentity,
      ),
      serializedTool,
      type: 'function',
    })
  ) {
    return undefined;
  }

  const serialized = serializedTool as Partial<FunctionTool<TContext>>;
  const name = getSerializedToolName(serializedTool, toolCall.name);
  const placeholder = {
    ...serialized,
    type: 'function' as const,
    name,
    description:
      typeof serialized.description === 'string'
        ? serialized.description
        : `Serialized execution-time tool ${name}.`,
    parameters:
      serialized.parameters &&
      typeof serialized.parameters === 'object' &&
      !Array.isArray(serialized.parameters)
        ? serialized.parameters
        : {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
          },
    strict: typeof serialized.strict === 'boolean' ? serialized.strict : true,
    deferLoading:
      typeof serialized.deferLoading === 'boolean'
        ? serialized.deferLoading
        : false,
    invoke: async () => {
      throw createSerializedExecutionToolError('Function', toolIdentity);
    },
    needsApproval: async () => false,
    isEnabled: async () => true,
  } satisfies FunctionTool<TContext>;

  if (
    typeof toolCall.namespace === 'string' &&
    toolCall.namespace.length > 0 &&
    toolCall.namespace !== name
  ) {
    Object.assign(placeholder, {
      [FUNCTION_TOOL_NAMESPACE]: toolCall.namespace,
      [FUNCTION_TOOL_NAMESPACE_DESCRIPTION]: toolCall.namespace,
    });
  }

  return markSerializedExecutionToolPlaceholder(placeholder);
}

export function getSerializedComputerToolPlaceholder(args: {
  agent: Agent<any, any>;
  baseAgentTools: Tool<any>[];
  serializedTool: unknown;
  toolName: string;
  allowSerializedExecutionToolPlaceholder: boolean;
}): ComputerTool<any, any> | undefined {
  const {
    agent,
    baseAgentTools,
    serializedTool,
    toolName,
    allowSerializedExecutionToolPlaceholder,
  } = args;
  if (
    !canUseSerializedExecutionToolPlaceholder({
      agent,
      allowSerializedExecutionToolPlaceholder,
      configuredToolExists: hasConfiguredTool(
        baseAgentTools,
        'computer',
        toolName,
      ),
      serializedTool,
      type: 'computer',
    })
  ) {
    return undefined;
  }

  const serialized = serializedTool as Partial<ComputerTool<any, any>>;
  const name = getSerializedToolName(serializedTool, toolName);
  const throwComputerError = async () => {
    throw createSerializedExecutionToolError('Computer', name);
  };
  return markSerializedExecutionToolPlaceholder({
    ...serialized,
    type: 'computer' as const,
    name,
    computer: {
      environment: 'browser' as const,
      dimensions: [1, 1] as [number, number],
      screenshot: throwComputerError,
      click: throwComputerError,
      doubleClick: throwComputerError,
      scroll: throwComputerError,
      type: throwComputerError,
      wait: throwComputerError,
      move: throwComputerError,
      keypress: throwComputerError,
      drag: throwComputerError,
    },
    needsApproval: async () => false,
  });
}

export function getSerializedShellToolPlaceholder(args: {
  agent: Agent<any, any>;
  baseAgentTools: Tool<any>[];
  serializedTool: unknown;
  toolName: string;
  allowSerializedExecutionToolPlaceholder: boolean;
}): ShellTool | undefined {
  const {
    agent,
    baseAgentTools,
    serializedTool,
    toolName,
    allowSerializedExecutionToolPlaceholder,
  } = args;
  if (
    !canUseSerializedExecutionToolPlaceholder({
      agent,
      allowSerializedExecutionToolPlaceholder,
      configuredToolExists: hasConfiguredTool(
        baseAgentTools,
        'shell',
        toolName,
      ),
      serializedTool,
      type: 'shell',
    })
  ) {
    return undefined;
  }

  const serialized = serializedTool as Partial<ShellTool>;
  const name = getSerializedToolName(serializedTool, toolName);
  return markSerializedExecutionToolPlaceholder({
    ...serialized,
    type: 'shell' as const,
    name,
    environment: { type: 'local' as const },
    shell: {
      run: async () => {
        throw createSerializedExecutionToolError('Shell', name);
      },
    },
    needsApproval: async () => false,
  });
}

export function getSerializedApplyPatchToolPlaceholder(args: {
  agent: Agent<any, any>;
  baseAgentTools: Tool<any>[];
  serializedTool: unknown;
  toolName: string;
  allowSerializedExecutionToolPlaceholder: boolean;
}): ApplyPatchTool | undefined {
  const {
    agent,
    baseAgentTools,
    serializedTool,
    toolName,
    allowSerializedExecutionToolPlaceholder,
  } = args;
  if (
    !canUseSerializedExecutionToolPlaceholder({
      agent,
      allowSerializedExecutionToolPlaceholder,
      configuredToolExists: hasConfiguredTool(
        baseAgentTools,
        'apply_patch',
        toolName,
      ),
      serializedTool,
      type: 'apply_patch',
    })
  ) {
    return undefined;
  }

  const serialized = serializedTool as Partial<ApplyPatchTool>;
  const name = getSerializedToolName(serializedTool, toolName);
  const throwEditorError = async () => {
    throw createSerializedExecutionToolError('Apply patch', name);
  };
  return markSerializedExecutionToolPlaceholder({
    ...serialized,
    type: 'apply_patch' as const,
    name,
    editor: {
      createFile: throwEditorError,
      updateFile: throwEditorError,
      deleteFile: throwEditorError,
    },
    needsApproval: async () => false,
  });
}
