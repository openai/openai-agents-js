import { Agent } from '../agent';

export class AgentToolUseTracker {
  #agentToTools = new Map<Agent<any, any>, string[]>();

  addToolUse(
    agent: Agent<any, any>,
    toolNames: string[],
    options: { allowEmpty?: boolean } = {},
  ): void {
    const allowEmpty = options.allowEmpty ?? false;
    if (toolNames.length === 0 && !allowEmpty) {
      // Skip initial empty writes and avoid overwriting non-empty history.
      const existing = this.#agentToTools.get(agent);
      if (!existing || existing.length > 0) {
        return;
      }
    }
    // Preserve prior non-empty history when not explicitly allowed to downgrade.
    if (!allowEmpty) {
      const existing = this.#agentToTools.get(agent);
      if (existing && existing.length > 0 && toolNames.length === 0) {
        return;
      }
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
