import { Agent, run } from '@openai/agents';
import { randomUUID } from '@openai/agents-core/_shims';
import { getLogger } from '@openai/agents-core';
import type { AgentInputItem, Session } from '@openai/agents-core';

/**
 * Minimal example of a Session implementation; swap this class for any storage-backed version.
 */
export class CustomMemorySession implements Session {
  private readonly sessionId: string;
  private readonly logger: ReturnType<typeof getLogger>;

  private items: AgentInputItem[];

  constructor(
    options: {
      sessionId?: string;
      initialItems?: AgentInputItem[];
      logger?: ReturnType<typeof getLogger>;
    } = {},
  ) {
    this.sessionId = options.sessionId ?? randomUUID();
    this.items = options.initialItems
      ? options.initialItems.map(cloneAgentItem)
      : [];
    this.logger = options.logger ?? getLogger('openai-agents:memory-session');
  }

  async getSessionId(): Promise<string> {
    return this.sessionId;
  }

  async getItems(limit?: number): Promise<AgentInputItem[]> {
    if (limit === undefined) {
      const cloned = this.items.map(cloneAgentItem);
      this.logger.debug(
        `Getting items from memory session (${this.sessionId}): ${JSON.stringify(cloned)}`,
      );
      return cloned;
    }
    if (limit <= 0) {
      return [];
    }
    const start = Math.max(this.items.length - limit, 0);
    const items = this.items.slice(start).map(cloneAgentItem);
    this.logger.debug(
      `Getting items from memory session (${this.sessionId}): ${JSON.stringify(items)}`,
    );
    return items;
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    if (items.length === 0) {
      return;
    }
    const cloned = items.map(cloneAgentItem);
    this.logger.debug(
      `Adding items to memory session (${this.sessionId}): ${JSON.stringify(cloned)}`,
    );
    this.items = [...this.items, ...cloned];
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    if (this.items.length === 0) {
      return undefined;
    }
    const item = this.items[this.items.length - 1];
    const cloned = cloneAgentItem(item);
    this.logger.debug(
      `Popping item from memory session (${this.sessionId}): ${JSON.stringify(cloned)}`,
    );
    this.items = this.items.slice(0, -1);
    return cloned;
  }

  async clearSession(): Promise<void> {
    this.logger.debug(`Clearing memory session (${this.sessionId})`);
    this.items = [];
  }
}

function cloneAgentItem<T extends AgentInputItem>(item: T): T {
  return structuredClone(item);
}

const agent = new Agent({
  name: 'MemoryDemo',
  instructions: 'Remember the running total.',
});

// Using the above custom memory session implementation here
const session = new CustomMemorySession({
  sessionId: 'session-123-4567',
});

const first = await run(agent, 'Add 3 to the total.', { session });
console.log(first.finalOutput);

const second = await run(agent, 'Add 4 more.', { session });
console.log(second.finalOutput);
