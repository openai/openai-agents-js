import { randomUUID } from '@openai/agents-core/_shims';

import type { AgentInputItem } from '../types';
import type {
  Session,
  SessionHistoryRewriteArgs,
  SessionHistoryRewriteAwareSession,
} from './session';
import { logger, Logger } from '../logger';
import { applySessionHistoryMutations } from './historyMutations';

export type MemorySessionOptions = {
  sessionId?: string;
  initialItems?: AgentInputItem[];
  logger?: Logger;
};

/**
 * Simple in-memory session store intended for demos or tests. Not recommended for production use.
 */
export class MemorySession
  implements Session, SessionHistoryRewriteAwareSession
{
  private readonly sessionId: string;
  private readonly logger: Logger;

  private items: AgentInputItem[];

  constructor(options: MemorySessionOptions = {}) {
    this.sessionId = options.sessionId ?? randomUUID();
    this.items = options.initialItems
      ? options.initialItems.map(cloneAgentItem)
      : [];
    this.logger = options.logger ?? logger;
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

  async applyHistoryMutations(args: SessionHistoryRewriteArgs): Promise<void> {
    if (args.mutations.length === 0) {
      return;
    }

    this.logger.debug(
      `Applying history mutations to memory session (${this.sessionId}): ${JSON.stringify(args.mutations)}`,
    );
    this.items = applySessionHistoryMutations(this.items, args.mutations);
  }
}

function cloneAgentItem<T extends AgentInputItem>(item: T): T {
  return structuredClone(item);
}
