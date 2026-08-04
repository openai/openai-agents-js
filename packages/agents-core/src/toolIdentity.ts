import type { FunctionTool } from './tool';
import { UserError } from './errors';
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

declare const FUNCTION_TOOL_LOOKUP_KEY: unique symbol;

/** @internal */
export type FunctionToolLookupKey = string & {
  readonly [FUNCTION_TOOL_LOOKUP_KEY]: true;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function encodeFunctionToolLookupKey(parts: string[]): FunctionToolLookupKey {
  return JSON.stringify(parts) as FunctionToolLookupKey;
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

/** @internal */
export function getFunctionToolLookupKey(
  name: string | undefined,
  namespace?: string,
): FunctionToolLookupKey | undefined {
  if (!isNonEmptyString(name)) {
    return undefined;
  }
  if (namespace === name) {
    return encodeFunctionToolLookupKey(['deferred_top_level', name]);
  }
  if (isNonEmptyString(namespace)) {
    return encodeFunctionToolLookupKey(['namespaced', namespace, name]);
  }
  return encodeFunctionToolLookupKey(['bare', name]);
}

/** @internal */
export function getFunctionToolLookupKeyForCall(
  toolCall: MaybeToolCallWithNamespace,
): FunctionToolLookupKey | undefined {
  return getFunctionToolLookupKey(
    getToolCallName(toolCall),
    getToolCallNamespace(toolCall),
  );
}

/** @internal */
export function isDeferredTopLevelFunctionTool(tool: unknown): boolean {
  const candidate = tool as MaybeFunctionToolWithNamespaceMetadata;
  return (
    candidate?.deferLoading === true &&
    !getExplicitFunctionToolNamespace(tool) &&
    isNonEmptyString(candidate?.name)
  );
}

/** @internal */
export function getBareTopLevelFunctionToolName(
  tool: unknown,
): string | undefined {
  const name = getFunctionToolName(tool);
  if (
    !name ||
    getExplicitFunctionToolNamespace(tool) ||
    isDeferredTopLevelFunctionTool(tool)
  ) {
    return undefined;
  }
  return name;
}

/** @internal */
export function getFunctionToolLookupKeyForTool(
  tool: Pick<FunctionTool<any, any, any>, 'name'> | unknown,
): FunctionToolLookupKey | undefined {
  const name = getFunctionToolName(tool);
  if (isDeferredTopLevelFunctionTool(tool)) {
    return encodeFunctionToolLookupKey(['deferred_top_level', name!]);
  }
  return getFunctionToolLookupKey(name, getExplicitFunctionToolNamespace(tool));
}

/** @internal */
export function assertFunctionToolLookupConfiguration(
  tools: readonly unknown[],
): void {
  const strictOwners = new Map<FunctionToolLookupKey, unknown>();
  for (const tool of tools) {
    const name = getFunctionToolName(tool);
    const namespace = getExplicitFunctionToolNamespace(tool);
    if (name && namespace === name) {
      throw new UserError(
        'Responses tool search reserves same-name namespaces for deferred top-level function tools. Rename the namespace or tool name to avoid ambiguous dispatch.',
      );
    }

    if (!namespace && !isDeferredTopLevelFunctionTool(tool)) {
      continue;
    }
    const key = getFunctionToolLookupKeyForTool(tool);
    if (!key) {
      continue;
    }
    if (strictOwners.has(key)) {
      throw new UserError(
        'Ambiguous function tool configuration. Assign unique names within each namespace and for deferred top-level tools.',
      );
    }
    strictOwners.set(key, tool);
  }
}

/** @internal */
export function buildFunctionToolLookupMap<TTool>(
  tools: readonly TTool[],
): Map<FunctionToolLookupKey, TTool> {
  assertFunctionToolLookupConfiguration(tools);
  const lookup = new Map<FunctionToolLookupKey, TTool>();
  for (const tool of tools) {
    const key = getFunctionToolLookupKeyForTool(tool);
    if (key) {
      lookup.set(key, tool);
    }
  }
  return lookup;
}

/** @internal */
export function resolveFunctionToolCall<TTool>(
  toolCall: MaybeToolCallWithNamespace,
  availableTools: ReadonlyMap<FunctionToolLookupKey, TTool>,
): TTool | undefined {
  const key = getFunctionToolLookupKeyForCall(toolCall);
  const directMatch = key ? availableTools.get(key) : undefined;
  if (directMatch || getToolCallNamespace(toolCall)) {
    return directMatch;
  }

  const name = getToolCallName(toolCall);
  const deferredKey = name
    ? encodeFunctionToolLookupKey(['deferred_top_level', name])
    : undefined;
  const deferredMatch = deferredKey
    ? availableTools.get(deferredKey)
    : undefined;
  if (deferredMatch || !name) {
    return deferredMatch;
  }

  let flattenedNamespaceMatch: TTool | undefined;
  for (const tool of availableTools.values()) {
    if (
      !getExplicitFunctionToolNamespace(tool) ||
      getFunctionToolQualifiedName(tool) !== name
    ) {
      continue;
    }
    if (flattenedNamespaceMatch && flattenedNamespaceMatch !== tool) {
      return undefined;
    }
    flattenedNamespaceMatch = tool;
  }
  return flattenedNamespaceMatch;
}

/** @internal */
export function getFunctionToolStateKey(
  tool: Pick<FunctionTool<any, any, any>, 'name'> | unknown,
): string | undefined {
  const name = getFunctionToolName(tool);
  if (!name) {
    return undefined;
  }
  return getFunctionToolLookupKeyForTool(tool);
}

/** @internal */
export function getFunctionToolLegacyStateKeyFromStateKey(
  stateKey: string,
): string | undefined {
  let parts: unknown;
  try {
    parts = JSON.parse(stateKey);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parts)) {
    return undefined;
  }
  if (
    (parts[0] === 'bare' || parts[0] === 'deferred_top_level') &&
    parts.length === 2 &&
    isNonEmptyString(parts[1])
  ) {
    return parts[1];
  }
  if (
    parts[0] === 'namespaced' &&
    parts.length === 3 &&
    isNonEmptyString(parts[1]) &&
    isNonEmptyString(parts[2])
  ) {
    return toolQualifiedName(parts[2], parts[1]);
  }
  return undefined;
}

/** @internal */
export function getFunctionToolStateKeyForCall(
  toolCall: MaybeToolCallWithNamespace,
  fallbackName?: string,
): string | undefined {
  const name = getToolCallName(toolCall);
  const namespace = getToolCallNamespace(toolCall);
  return (
    getFunctionToolLookupKey(name ?? fallbackName, namespace) ?? fallbackName
  );
}

/** @internal */
export function getFunctionToolStateKeyForResolvedCall(
  toolCall: MaybeToolCallWithNamespace,
  tool: Pick<FunctionTool<any, any, any>, 'name'> | unknown,
  resolvedToolStateKey = getFunctionToolStateKey(tool),
): string | undefined {
  const callStateKey = getFunctionToolStateKeyForCall(toolCall);
  if (!callStateKey || !resolvedToolStateKey) {
    return undefined;
  }
  if (callStateKey === resolvedToolStateKey) {
    return resolvedToolStateKey;
  }

  return !getToolCallNamespace(toolCall) &&
    isDeferredTopLevelFunctionTool(tool) &&
    getToolCallName(toolCall) === getFunctionToolName(tool)
    ? resolvedToolStateKey
    : undefined;
}

/** @internal */
export function getFunctionToolStateKeys(
  tool: Pick<FunctionTool<any, any, any>, 'name'> | unknown,
  availableTools: readonly unknown[] = [],
): string[] {
  const primary = getFunctionToolStateKey(tool);
  if (!primary) {
    return [];
  }
  const name = getFunctionToolName(tool);
  if (!name) {
    return [primary];
  }
  const legacyKey = getFunctionToolLegacyStateKey(tool);
  if (!legacyKey || legacyKey === primary) {
    return [primary];
  }
  const hasLegacyCollision = availableTools.some(
    (candidate) =>
      candidate !== tool &&
      getFunctionToolLegacyStateKey(candidate) === legacyKey &&
      getFunctionToolStateKey(candidate) !== primary,
  );
  return hasLegacyCollision ? [primary] : [primary, legacyKey];
}

function getFunctionToolLegacyStateKey(tool: unknown): string | undefined {
  const name = getFunctionToolName(tool);
  if (!name) {
    return undefined;
  }
  const namespace = getExplicitFunctionToolNamespace(tool);
  return namespace ? toolQualifiedName(name, namespace) : name;
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
