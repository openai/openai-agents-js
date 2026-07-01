import { Agent } from './agent';
import { getAgentToolSourceAgent } from './agentToolSourceRegistry';
import type { Tool } from './tool';

export type AgentIdentityMap = {
  byIdentity: Map<string, Agent<any, any>>;
  byAgent: Map<Agent<any, any>, string>;
};

type TraversedAgent = {
  agent: Agent<any, any>;
  index: number;
};

export function buildAgentIdentityMap(
  initialAgent: Agent<any, any>,
): AgentIdentityMap {
  const agents = collectAgentGraph(initialAgent);
  const groups = new Map<string, TraversedAgent[]>();
  const literalNames = new Set<string>();

  for (const entry of agents) {
    literalNames.add(entry.agent.name);
    const group = groups.get(entry.agent.name) ?? [];
    group.push(entry);
    groups.set(entry.agent.name, group);
  }

  const byIdentity = new Map<string, Agent<any, any>>();
  const byAgent = new Map<Agent<any, any>, string>();
  const usedIdentities = new Set<string>();

  for (const [agentName, group] of groups) {
    const sortedGroup =
      group.length === 1
        ? group
        : [...group].sort((left, right) => {
            if (left.agent === initialAgent) return -1;
            if (right.agent === initialAgent) return 1;

            const leftSignature = getAgentIdentitySignature(left.agent);
            const rightSignature = getAgentIdentitySignature(right.agent);
            if (leftSignature !== rightSignature) {
              return leftSignature < rightSignature ? -1 : 1;
            }
            return left.index - right.index;
          });

    let nextSuffix = 0;
    for (const { agent } of sortedGroup) {
      let identity: string;
      do {
        identity =
          nextSuffix === 0 ? agentName : `${agentName}#${nextSuffix + 1}`;
        nextSuffix += 1;
      } while (
        usedIdentities.has(identity) ||
        (identity !== agent.name && literalNames.has(identity))
      );

      usedIdentities.add(identity);
      byIdentity.set(identity, agent);
      byAgent.set(agent, identity);
    }
  }

  return { byIdentity, byAgent };
}

function collectAgentGraph(initialAgent: Agent<any, any>): TraversedAgent[] {
  const agents: TraversedAgent[] = [];
  const visitedAgents = new Set<Agent<any, any>>();
  const queue: Agent<any, any>[] = [initialAgent];

  while (queue.length > 0) {
    const currentAgent = queue.shift()!;
    if (visitedAgents.has(currentAgent)) continue;
    visitedAgents.add(currentAgent);
    agents.push({ agent: currentAgent, index: agents.length });

    for (const handoff of currentAgent.handoffs) {
      if (handoff instanceof Agent) queue.push(handoff);
      else if (handoff.agent) queue.push(handoff.agent);
    }

    for (const tool of currentAgent.tools) {
      const sourceAgent = getAgentToolSourceAgent(tool);
      if (sourceAgent) queue.push(sourceAgent);
    }
  }
  return agents;
}

function getAgentIdentitySignature(agent: Agent<any, any>): string {
  const sandboxAgent = agent as Agent<any, any> & {
    defaultManifest?: unknown;
    baseInstructions?: unknown;
    capabilities?: unknown[];
    runAs?: unknown;
  };
  return stableStringify({
    type: agent.constructor?.name,
    name: agent.name,
    handoffDescription: agent.handoffDescription,
    instructions: summarizeIdentityValue(agent.instructions),
    prompt: summarizeIdentityValue(agent.prompt),
    model: summarizeIdentityValue(agent.model),
    modelSettings: summarizeIdentityValue(agent.modelSettings),
    tools: agent.tools.map(summarizeToolIdentity),
    handoffs: agent.handoffs.map((entry) =>
      entry instanceof Agent
        ? { type: 'agent', name: entry.name }
        : {
            type: 'handoff',
            toolName: entry.toolName,
            agentName: entry.agentName,
            targetName: entry.agent?.name,
          },
    ),
    mcpServers: agent.mcpServers.map(summarizeIdentityValue),
    mcpConfig: summarizeIdentityValue(agent.mcpConfig),
    inputGuardrails: agent.inputGuardrails.map(summarizeIdentityValue),
    outputGuardrails: agent.outputGuardrails.map(summarizeIdentityValue),
    outputType: summarizeIdentityValue(agent.outputType),
    toolUseBehavior: summarizeIdentityValue(agent.toolUseBehavior),
    resetToolChoice: agent.resetToolChoice,
    defaultManifest: summarizeIdentityValue(sandboxAgent.defaultManifest),
    baseInstructions: summarizeIdentityValue(sandboxAgent.baseInstructions),
    capabilities: sandboxAgent.capabilities?.map(summarizeIdentityValue),
    runAs: summarizeIdentityValue(sandboxAgent.runAs),
  });
}

function summarizeToolIdentity(tool: Tool<any>): unknown {
  return {
    type: tool.type,
    name: (tool as { name?: unknown }).name,
    namespace: (tool as { namespace?: unknown }).namespace,
    strict: (tool as { strict?: unknown }).strict,
    parameters: summarizeIdentityValue(
      (tool as { parameters?: unknown }).parameters,
    ),
  };
}

function summarizeIdentityValue(value: unknown): unknown {
  return normalizeForIdentity(value, new WeakSet(), 0);
}

function normalizeForIdentity(
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (value === null || typeof value === 'undefined') return value;
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'function') {
    return `[function:${value.name || 'anonymous'}]`;
  }
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[circular]';
  if (depth >= 4) return `[${value.constructor?.name ?? 'Object'}]`;

  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => normalizeForIdentity(item, seen, depth + 1));
  }
  if (value instanceof Map) {
    return [...value.entries()]
      .map(([key, entryValue]) => [
        normalizeForIdentity(key, seen, depth + 1),
        normalizeForIdentity(entryValue, seen, depth + 1),
      ])
      .sort((left, right) =>
        stableStringify(left).localeCompare(stableStringify(right)),
      );
  }
  if (value instanceof Set) {
    return [...value.values()]
      .map((entry) => normalizeForIdentity(entry, seen, depth + 1))
      .sort((left, right) =>
        stableStringify(left).localeCompare(stableStringify(right)),
      );
  }

  const record = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {
    constructor: value.constructor?.name,
  };
  for (const key of Object.keys(record).sort()) {
    normalized[key] = normalizeForIdentity(record[key], seen, depth + 1);
  }
  return normalized;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, currentValue) => {
    if (
      !currentValue ||
      typeof currentValue !== 'object' ||
      Array.isArray(currentValue)
    ) {
      return currentValue;
    }
    return Object.fromEntries(
      Object.entries(currentValue as Record<string, unknown>).sort(
        ([left], [right]) => left.localeCompare(right),
      ),
    );
  });
}
