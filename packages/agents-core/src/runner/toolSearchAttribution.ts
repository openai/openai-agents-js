import type { Agent } from '../agent';
import type * as protocol from '../types/protocol';

/** Returns a durable name only when it identifies one Agent in the run graph. */
export function getToolSearchAgentName(
  agent: Agent<any, any>,
  agents: Iterable<Agent<any, any>>,
): string | undefined {
  const matchingAgents = new Set(
    [...agents].filter((candidate) => candidate.name === agent.name),
  );
  return matchingAgents.size === 1 && matchingAgents.has(agent)
    ? agent.name
    : undefined;
}

/** Records SDK-owned discovery attribution without changing the provider payload. */
export function attributeToolSearchOutput(
  output: protocol.ToolSearchOutputItem,
  agentName: string | undefined,
): protocol.ToolSearchOutputItem {
  const { toolSearchAgentName: _suppliedOwner, ...rawOutput } = output;
  return typeof agentName === 'string'
    ? { ...rawOutput, toolSearchAgentName: agentName }
    : rawOutput;
}
