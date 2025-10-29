import { Agent, run } from '@openai/agents';
import type { AgentInputItem, Session } from '@openai/agents-core';

// Minimal example of a Session implementation; swap this class for any storage-backed version.
class InMemorySession implements Session {
  #sessionId: string;
  #items: AgentInputItem[] = [];

  constructor(sessionId: string) {
    this.#sessionId = sessionId;
  }

  async getSessionId(): Promise<string> {
    return this.#sessionId;
  }

  async getItems(limit?: number): Promise<AgentInputItem[]> {
    const items = [...this.#items];
    if (limit === undefined) {
      return items;
    }
    return items.slice(-limit);
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    if (!items.length) {
      return;
    }
    this.#items.push(...items.map((item) => structuredClone(item)));
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    const popped = this.#items.pop();
    return popped ? structuredClone(popped) : undefined;
  }

  async clearSession(): Promise<void> {
    this.#items = [];
  }
}

const agent = new Agent({
  name: 'MemoryDemo',
  instructions: 'Remember the running total.',
});

// Using the above InMemorySession implementation here
const session = new InMemorySession('user-123');

const first = await run(agent, 'Add 3 to the total.', { session });
console.log(first.finalOutput);

const second = await run(agent, 'Add 4 more.', { session });
console.log(second.finalOutput);
