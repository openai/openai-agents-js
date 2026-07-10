export type HostedAgentMetadata = Readonly<{
  agentName: string;
  phase?: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function unwrapHostedValue(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  if (isRecord(value.toolCall)) {
    return unwrapHostedValue(value.toolCall);
  }

  if (isRecord(value.providerData) && isRecord(value.providerData.agent)) {
    return value.providerData;
  }

  return value;
}

/**
 * Reads hosted-agent attribution without affecting local tool routing.
 */
export function getHostedAgentMetadata(
  value: unknown,
): HostedAgentMetadata | undefined {
  const item = unwrapHostedValue(value);
  if (!item || !isRecord(item.agent)) {
    return undefined;
  }

  const agentName = item.agent.agent_name;
  if (typeof agentName !== 'string' || agentName.length === 0) {
    return undefined;
  }

  return {
    agentName,
    ...(typeof item.phase === 'string' ? { phase: item.phase } : {}),
  };
}
