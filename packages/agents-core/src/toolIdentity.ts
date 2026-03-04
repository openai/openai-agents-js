import type { FunctionTool } from './tool';
import { toolDisplayName, toolQualifiedName } from './tooling';
export { toolDisplayName, toolQualifiedName } from './tooling';

export const FUNCTION_TOOL_NAMESPACE = Symbol('functionToolNamespace');
export const FUNCTION_TOOL_NAMESPACE_DESCRIPTION = Symbol(
  'functionToolNamespaceDescription',
);

type MaybeFunctionToolWithNamespaceMetadata = {
  name?: unknown;
  deferLoading?: unknown;
  [FUNCTION_TOOL_NAMESPACE]?: unknown;
  [FUNCTION_TOOL_NAMESPACE_DESCRIPTION]?: unknown;
};

type MaybeToolCallWithNamespace = {
  name?: unknown;
  namespace?: unknown;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function getToolCallNamespace(
  toolCall: MaybeToolCallWithNamespace,
): string | undefined {
  return isNonEmptyString(toolCall.namespace) ? toolCall.namespace : undefined;
}

export function getToolCallName(
  toolCall: MaybeToolCallWithNamespace,
): string | undefined {
  return isNonEmptyString(toolCall.name) ? toolCall.name : undefined;
}

export function getToolCallQualifiedName(
  toolCall: MaybeToolCallWithNamespace,
): string | undefined {
  return toolQualifiedName(
    getToolCallName(toolCall),
    getToolCallNamespace(toolCall),
  );
}

export function getToolCallDisplayName(
  toolCall: MaybeToolCallWithNamespace,
): string | undefined {
  return toolDisplayName(
    getToolCallName(toolCall),
    getToolCallNamespace(toolCall),
  );
}

type ToolNameLookup = {
  has(name: string): boolean;
  get?(name: string): unknown;
};

function isTopLevelDeferredFunctionTool(
  candidate: unknown,
  bareName: string,
): boolean {
  const tool = candidate as MaybeFunctionToolWithNamespaceMetadata & {
    type?: unknown;
    name?: unknown;
  };
  return (
    tool?.type === 'function' &&
    tool.name === bareName &&
    tool.deferLoading === true &&
    !isNonEmptyString(tool?.[FUNCTION_TOOL_NAMESPACE])
  );
}

export function resolveFunctionToolCallName(
  toolCall: MaybeToolCallWithNamespace,
  availableToolNames: ToolNameLookup,
): string | undefined {
  const bareName = getToolCallName(toolCall);
  const namespace = getToolCallNamespace(toolCall);
  if (bareName && !namespace && availableToolNames.has(bareName)) {
    return bareName;
  }

  const qualifiedName = getToolCallQualifiedName(toolCall);
  const bareTool =
    bareName && typeof availableToolNames.get === 'function'
      ? availableToolNames.get(bareName)
      : undefined;
  const preferBareSelfNamespacedDeferredTool =
    bareName &&
    namespace === bareName &&
    availableToolNames.has(bareName) &&
    isTopLevelDeferredFunctionTool(bareTool, bareName);

  if (qualifiedName && availableToolNames.has(qualifiedName)) {
    if (preferBareSelfNamespacedDeferredTool) {
      return bareName;
    }
    return qualifiedName;
  }

  if (bareName && namespace === bareName && availableToolNames.has(bareName)) {
    return bareName;
  }

  return qualifiedName ?? bareName;
}

export function getExplicitFunctionToolNamespace(
  tool: unknown,
): string | undefined {
  const candidate = tool as MaybeFunctionToolWithNamespaceMetadata;
  return isNonEmptyString(candidate?.[FUNCTION_TOOL_NAMESPACE])
    ? candidate[FUNCTION_TOOL_NAMESPACE]
    : undefined;
}

export function getFunctionToolNamespace(tool: unknown): string | undefined {
  return getExplicitFunctionToolNamespace(tool);
}

export function getFunctionToolNamespaceDescription(
  tool: unknown,
): string | undefined {
  const candidate = tool as MaybeFunctionToolWithNamespaceMetadata;
  return isNonEmptyString(candidate?.[FUNCTION_TOOL_NAMESPACE_DESCRIPTION])
    ? candidate[FUNCTION_TOOL_NAMESPACE_DESCRIPTION]
    : undefined;
}

export function getFunctionToolQualifiedName(
  tool: Pick<FunctionTool<any, any, any>, 'name'> | unknown,
): string | undefined {
  const candidate = tool as MaybeFunctionToolWithNamespaceMetadata;
  return toolQualifiedName(
    isNonEmptyString(candidate?.name) ? candidate.name : undefined,
    getFunctionToolNamespace(tool),
  );
}

export function getFunctionToolDisplayName(
  tool: Pick<FunctionTool<any, any, any>, 'name'> | unknown,
): string | undefined {
  const candidate = tool as MaybeFunctionToolWithNamespaceMetadata;
  return toolDisplayName(
    isNonEmptyString(candidate?.name) ? candidate.name : undefined,
    getFunctionToolNamespace(tool),
  );
}

export function matchesFunctionToolName(
  tool: Pick<FunctionTool<any, any, any>, 'name'> | unknown,
  candidate: string | undefined,
): boolean {
  if (!isNonEmptyString(candidate)) {
    return false;
  }

  const bareName = getFunctionToolName(tool);
  if (bareName === candidate) {
    return true;
  }

  return getFunctionToolQualifiedName(tool) === candidate;
}

function getFunctionToolName(
  tool: Pick<FunctionTool<any, any, any>, 'name'> | unknown,
): string | undefined {
  const candidate = tool as MaybeFunctionToolWithNamespaceMetadata;
  return isNonEmptyString(candidate?.name) ? candidate.name : undefined;
}
