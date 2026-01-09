import { Agent } from '../agent';

export class AgentToolUseTracker {
  #agentToTools = new Map<Agent<any, any>, string[]>();

  addToolUse(agent: Agent<any, any>, toolNames: string[]): void {
    if (toolNames.length === 0 && !this.#agentToTools.has(agent)) {
      return;
    }
    this.#agentToTools.set(agent, toolNames);
  }

  hasUsedTools(agent: Agent<any, any>): boolean {
    return this.#agentToTools.has(agent);
  }

  toJSON(): Record<string, string[]> {
    return Object.fromEntries(
      Array.from(this.#agentToTools.entries()).map(([agent, toolNames]) => {
        return [agent.name, toolNames];
      }),
    );
  }
}
