import type { Agent, AgentOutputType } from '../../agent';
import { Handoff } from '../../handoff';
import type { SandboxAgent } from '../agent';
import { SANDBOX_AGENT_BRAND } from '../brand';

type SandboxConcurrencyGuard = {
  activeRuns: number;
};

const sandboxConcurrencyGuards = new WeakMap<object, SandboxConcurrencyGuard>();
const objectIds = new WeakMap<object, number>();
let nextObjectId = 1;

export function allocateAgentKeys<TContext>(
  startingAgent: Agent<TContext, AgentOutputType>,
): Map<number, string> {
  const keys = new Map<number, string>();
  const counts = new Map<string, number>();
  const usedKeys = new Set<string>();
  const queue: Agent<TContext, AgentOutputType>[] = [startingAgent];
  const visited = new Set<Agent<TContext, AgentOutputType>>();

  while (queue.length > 0) {
    const agent = queue.shift()!;
    if (visited.has(agent)) {
      continue;
    }
    visited.add(agent);

    keys.set(
      getObjectId(agent),
      allocateUniqueAgentKey(agent.name, counts, usedKeys),
    );

    for (const handoff of agent.handoffs) {
      queue.push(
        handoff instanceof Handoff
          ? (handoff.agent as Agent<TContext, AgentOutputType>)
          : (handoff as Agent<TContext, AgentOutputType>),
      );
    }
  }

  return keys;
}

function allocateUniqueAgentKey(
  agentName: string,
  counts: Map<string, number>,
  usedKeys: Set<string>,
): string {
  while (true) {
    const count = counts.get(agentName) ?? 0;
    counts.set(agentName, count + 1);
    const candidate = count === 0 ? agentName : `${agentName}_${count + 1}`;
    if (!usedKeys.has(candidate)) {
      usedKeys.add(candidate);
      return candidate;
    }
  }
}

export function acquireSandboxAgent<TContext>(
  agent: SandboxAgent<TContext, AgentOutputType>,
): number {
  const agentId = getObjectId(agent);
  const guard = sandboxConcurrencyGuards.get(agent) ?? { activeRuns: 0 };
  sandboxConcurrencyGuards.set(agent, guard);
  if (guard.activeRuns > 0) {
    throw new Error(
      `SandboxAgent '${agent.name}' cannot be reused concurrently across runs`,
    );
  }

  guard.activeRuns += 1;
  return agentId;
}

export function releaseSandboxAgents<TContext>(
  agents: Iterable<SandboxAgent<TContext, AgentOutputType>>,
): void {
  for (const agent of agents) {
    const guard = sandboxConcurrencyGuards.get(agent);
    if (guard) {
      guard.activeRuns = Math.max(0, guard.activeRuns - 1);
    }
  }
}

export function isSandboxAgent<TContext>(
  agent: Agent<TContext, AgentOutputType>,
): agent is SandboxAgent<TContext, AgentOutputType> {
  return (
    Object.prototype.hasOwnProperty.call(agent, SANDBOX_AGENT_BRAND) &&
    (agent as unknown as Record<symbol, unknown>)[SANDBOX_AGENT_BRAND] === true
  );
}

export function getObjectId(value: object): number {
  const existing = objectIds.get(value);
  if (existing) {
    return existing;
  }

  const assigned = nextObjectId++;
  objectIds.set(value, assigned);
  return assigned;
}
