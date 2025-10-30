import { randomUUID } from '@openai/agents-core/_shims';

import type { AgentInputItem } from '../types';
import type { Session } from './session';

export type MemorySessionOptions = {
  sessionId?: string;
  initialItems?: AgentInputItem[];
};

/**
 * Simple in-memory session store intended for demos or tests. Not recommended for production use.
 */
export class MemorySession implements Session {
  private readonly sessionId: string;

  private items: AgentInputItem[];

  constructor(options: MemorySessionOptions = {}) {
    this.sessionId = options.sessionId ?? randomUUID();
    this.items = options.initialItems ? [...options.initialItems] : [];
  }

  async getSessionId(): Promise<string> {
    return this.sessionId;
  }

  async getItems(limit?: number): Promise<AgentInputItem[]> {
    if (limit === undefined) {
      return [...this.items];
    }
    if (limit <= 0) {
      return [];
    }
    const start = Math.max(this.items.length - limit, 0);
    return this.items.slice(start);
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    if (items.length === 0) {
      return;
    }
    this.items = [...this.items, ...items];
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    if (this.items.length === 0) {
      return undefined;
    }
    const item = this.items[this.items.length - 1];
    this.items = this.items.slice(0, -1);
    return item;
  }

  async clearSession(): Promise<void> {
    this.items = [];
  }
}
