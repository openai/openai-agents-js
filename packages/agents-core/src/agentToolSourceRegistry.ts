import type { Agent } from './agent';
import type { FunctionTool, Tool } from './tool';

// Internal registry that links Agent.asTool() function tools back to their source
// Agent instances so RunState reconstruction can traverse nested agent-tools
// without storing hidden metadata on the tool object itself.
const agentToolSourceRegistry = new WeakMap<
  FunctionTool<any, any, any>,
  Agent<any, any>
>();

export function registerAgentToolSourceAgent(
  tool: FunctionTool<any, any, any>,
  agent: Agent<any, any>,
): void {
  agentToolSourceRegistry.set(tool, agent);
}

export function getAgentToolSourceAgent(
  tool: Tool<any>,
): Agent<any, any> | undefined {
  if (tool.type !== 'function') {
    return undefined;
  }
  return agentToolSourceRegistry.get(tool);
}
