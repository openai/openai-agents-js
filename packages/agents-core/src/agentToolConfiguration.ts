import type { Agent, AgentOutputType } from './agent';
import type { Tool } from './tool';

// Only SDK-created execution agents have a binding; public clones stay independent.
const preparedAgentTools = new WeakMap<
  Agent<any, any>,
  { source: Agent<any, any>; capabilityTools: Tool<any>[] }
>();

export function registerPreparedAgentTools<
  TContext,
  TOutput extends AgentOutputType,
>(
  prepared: Agent<TContext, TOutput>,
  source: Agent<TContext, TOutput>,
  capabilityTools: Tool<TContext>[],
): void {
  preparedAgentTools.set(prepared, { source, capabilityTools });
  refreshPreparedAgentTools(prepared);
}

export function getPublicAgent<TContext, TOutput extends AgentOutputType>(
  agent: Agent<TContext, TOutput>,
): Agent<TContext, TOutput> {
  return preparedAgentTools.get(agent)?.source ?? agent;
}

export function refreshPreparedAgentTools(agent: Agent<any, any>): void {
  const binding = preparedAgentTools.get(agent);
  if (!binding) {
    return;
  }
  agent.tools = [...binding.source.tools, ...binding.capabilityTools];
  // An empty synthesized array must not suppress prompt-supplied tools unless
  // the application explicitly configured tools on the public agent.
  (
    agent as unknown as { _toolsExplicitlyConfigured: boolean }
  )._toolsExplicitlyConfigured =
    agent.tools.length > 0 || binding.source.hasExplicitToolConfig();
}
