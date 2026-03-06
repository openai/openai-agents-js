type ToolSearchExecution = 'client' | 'server';

type MaybeToolWithNamespace = {
  name?: unknown;
  namespace?: unknown;
};

type MaybeToolSearchItem = {
  id?: unknown;
  providerData?: unknown;
  call_id?: unknown;
  callId?: unknown;
  execution?: unknown;
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function getToolSearchProviderData(
  value: MaybeToolSearchItem,
): Record<string, unknown> | undefined {
  return typeof value.providerData === 'object' && value.providerData
    ? (value.providerData as Record<string, unknown>)
    : undefined;
}

export function toolQualifiedName(
  name: string | undefined,
  namespace?: string,
): string | undefined {
  if (!isNonEmptyString(name)) {
    return undefined;
  }
  if (isNonEmptyString(namespace)) {
    return `${namespace}.${name}`;
  }
  return name;
}

export function toolDisplayName(
  name: string | undefined,
  namespace?: string,
): string | undefined {
  if (!isNonEmptyString(name)) {
    return undefined;
  }

  if (!isNonEmptyString(namespace) || namespace === name) {
    return name;
  }

  return `${namespace}.${name}`;
}

export function getToolCallDisplayName(
  toolCall: MaybeToolWithNamespace,
): string | undefined {
  return toolDisplayName(
    isNonEmptyString(toolCall.name) ? toolCall.name : undefined,
    isNonEmptyString(toolCall.namespace) ? toolCall.namespace : undefined,
  );
}

export function getToolSearchProviderCallId(
  value: MaybeToolSearchItem,
): string | undefined {
  const providerData = getToolSearchProviderData(value);
  const providerCallId = providerData?.call_id ?? providerData?.callId;
  if (isNonEmptyString(providerCallId)) {
    return providerCallId;
  }

  if (isNonEmptyString(value.call_id)) {
    return value.call_id;
  }

  if (isNonEmptyString(value.callId)) {
    return value.callId;
  }

  return undefined;
}

export function getToolSearchMatchKey(
  value: MaybeToolSearchItem,
): string | undefined {
  if (isNonEmptyString(value.id)) {
    return getToolSearchProviderCallId(value) ?? value.id;
  }

  return getToolSearchProviderCallId(value);
}

export function getToolSearchOutputReplacementKey(
  value: MaybeToolSearchItem,
): string | undefined {
  const providerCallId = getToolSearchProviderCallId(value);
  if (providerCallId) {
    return `call:${providerCallId}`;
  }

  return isNonEmptyString(value.id) ? `item:${value.id}` : undefined;
}

export function getToolSearchExecution(
  value: MaybeToolSearchItem,
): ToolSearchExecution | undefined {
  if (value.execution === 'client' || value.execution === 'server') {
    return value.execution;
  }

  const providerData = getToolSearchProviderData(value);
  const execution = providerData?.execution;
  return execution === 'client' || execution === 'server'
    ? execution
    : undefined;
}

export function isClientToolSearchCall(value: MaybeToolSearchItem): boolean {
  return getToolSearchExecution(value) === 'client';
}

export function shouldQueuePendingToolSearchCall(
  value: MaybeToolSearchItem,
): boolean {
  return getToolSearchExecution(value) !== 'server';
}

export function resolveToolSearchCallId(
  value: MaybeToolSearchItem,
  generateFallbackId?: () => string,
): string {
  const explicitMatchKey = getToolSearchMatchKey(value);
  if (explicitMatchKey) {
    return explicitMatchKey;
  }

  if (generateFallbackId) {
    return generateFallbackId();
  }

  throw new Error(
    'Tool search item is missing both call_id and id. Provide a fallback generator when resolving client-side tool_search history.',
  );
}

export function takePendingToolSearchCallId(
  value: MaybeToolSearchItem,
  pendingCallIds: string[],
  generateFallbackId?: () => string,
): string {
  const explicitCallId = getToolSearchProviderCallId(value);
  if (explicitCallId) {
    const pendingIndex = pendingCallIds.indexOf(explicitCallId);
    if (pendingIndex >= 0) {
      pendingCallIds.splice(pendingIndex, 1);
    }
    return explicitCallId;
  }

  if (getToolSearchExecution(value) === 'server') {
    return resolveToolSearchCallId(value, generateFallbackId);
  }

  return (
    pendingCallIds.shift() ?? resolveToolSearchCallId(value, generateFallbackId)
  );
}
