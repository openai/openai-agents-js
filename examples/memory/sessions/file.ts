import type { AgentInputItem, Session } from '@openai/agents';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export type FileSessionOptions = {
  dir?: string;
  sessionId?: string;
};

export class FileSession implements Session {
  #dir: string;
  #sessionId?: string;

  constructor(options: FileSessionOptions = {}) {
    this.#dir = options.dir ?? path.resolve(process.cwd(), '.agents-sessions');
    this.#sessionId = options.sessionId;
  }

  async getSessionId(): Promise<string> {
    if (!this.#sessionId) {
      this.#sessionId = randomUUID().replace(/-/g, '').slice(0, 24);
    }
    await this.#ensureDir();
    const file = this.#filePath(this.#sessionId);
    try {
      await fs.access(file);
    } catch {
      await fs.writeFile(file, '[]', 'utf8');
    }
    return this.#sessionId;
  }

  async getItems(limit?: number): Promise<AgentInputItem[]> {
    const sessionId = await this.getSessionId();
    const items = await this.#readItems(sessionId);
    if (typeof limit === 'number' && limit >= 0) {
      return items.slice(-limit);
    }
    return items;
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    if (!items.length) {
      return;
    }
    const sessionId = await this.getSessionId();
    const current = await this.#readItems(sessionId);
    // Store a structured clone so we don't accidentally persist references that can mutate.
    const serialized = items.map((item) => JSON.parse(JSON.stringify(item)));
    const next = current.concat(serialized as AgentInputItem[]);
    await this.#writeItems(sessionId, next);
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    const sessionId = await this.getSessionId();
    const items = await this.#readItems(sessionId);
    if (items.length === 0) {
      return undefined;
    }
    const popped = items.pop();
    await this.#writeItems(sessionId, items);
    return popped;
  }

  async clearSession(): Promise<void> {
    if (!this.#sessionId) {
      return;
    }
    const file = this.#filePath(this.#sessionId);
    try {
      await fs.unlink(file);
    } catch {
      // ignore missing file
    }
    this.#sessionId = undefined;
  }

  async #ensureDir(): Promise<void> {
    await fs.mkdir(this.#dir, { recursive: true });
  }

  #filePath(sessionId: string): string {
    return path.join(this.#dir, `${sessionId}.json`);
  }

  async #readItems(sessionId: string): Promise<AgentInputItem[]> {
    const file = this.#filePath(sessionId);
    try {
      const data = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(data);
      return Array.isArray(parsed) ? (parsed as AgentInputItem[]) : [];
    } catch (err: any) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
        return [];
      }
      throw err;
    }
  }

  async #writeItems(sessionId: string, items: AgentInputItem[]): Promise<void> {
    await this.#ensureDir();
    const file = this.#filePath(sessionId);
    await fs.writeFile(file, JSON.stringify(items, null, 2), 'utf8');
  }
}

export type { AgentInputItem } from '@openai/agents';
