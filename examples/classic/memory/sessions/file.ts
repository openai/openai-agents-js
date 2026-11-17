import { protocol } from '@openai/agents/classic';
import type { AgentInputItem, Session } from '@openai/agents/classic';
import { constants } from 'node:fs';
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
    this.#dir = path.resolve(options.dir ?? '.agents-sessions');
    this.#sessionId = options.sessionId;
  }

  async getSessionId(): Promise<string> {
    if (!this.#sessionId) {
      this.#sessionId = randomUUID().replace(/-/g, '').slice(0, 24);
    }
    const handle = await this.#openFile(
      this.#sessionId,
      true,
      constants.O_RDONLY,
    );
    let needsInitialization: boolean;
    try {
      needsInitialization = (await handle.stat()).size === 0;
    } finally {
      await handle.close();
    }
    if (needsInitialization) {
      await this.#writeItems(this.#sessionId, []);
    }
    return this.#sessionId;
  }

  async getItems(limit?: number): Promise<AgentInputItem[]> {
    const sessionId = await this.getSessionId();
    const items = (await this.#readRawItems(sessionId)).flatMap((raw) => {
      const item = coerceAgentItem(raw);
      return item ? [item] : [];
    });
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
    const current = await this.#readRawItems(sessionId);
    // Store a structured clone so we don't accidentally persist references that can mutate.
    const serialized = items.flatMap((item) => {
      const parsed = coerceAgentItem(item);
      return parsed ? [JSON.parse(JSON.stringify(parsed))] : [];
    });
    const next = current.concat(serialized);
    await this.#writeItems(sessionId, next);
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    const sessionId = await this.getSessionId();
    const items = await this.#readRawItems(sessionId);
    while (items.length > 0) {
      const raw = items.pop();
      const item = coerceAgentItem(raw);
      if (item) {
        await this.#writeItems(sessionId, items);
        return item;
      }
    }

    await this.#writeItems(sessionId, items);
    return undefined;
  }

  async clearSession(): Promise<void> {
    if (!this.#sessionId) {
      return;
    }
    const file = this.#filePath(this.#sessionId);
    try {
      const handle = await this.#openFile(
        this.#sessionId,
        false,
        constants.O_RDONLY,
      );
      await handle.close();
      await fs.unlink(file);
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        throw err;
      }
    }
    this.#sessionId = undefined;
  }

  async #ensureDir(): Promise<void> {
    const uid = process.getuid?.();
    if (uid === undefined || !constants.O_NOFOLLOW) {
      throw new Error('FileSession requires POSIX owner-only permissions');
    }
    await fs.mkdir(this.#dir, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.#dir);
    if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
      throw new Error('FileSession directory must be owner-only');
    }
  }

  #filePath(sessionId: string): string {
    return path.join(this.#dir, `${sessionId}.json`);
  }

  async #openFile(
    sessionId: string,
    create = true,
    access = constants.O_RDWR,
  ): Promise<fs.FileHandle> {
    const file = this.#filePath(sessionId);
    await this.#ensureDir();
    const flags =
      access |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK |
      (create ? constants.O_CREAT : 0);
    const handle = await fs.open(file, flags, 0o600);
    try {
      const stat = await handle.stat();
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o077) !== 0
      ) {
        throw new Error('FileSession file must be owner-only');
      }
      return handle;
    } catch (err) {
      await handle.close();
      throw err;
    }
  }

  async #readRawItems(sessionId: string): Promise<unknown[]> {
    let handle: fs.FileHandle | undefined;
    try {
      handle = await this.#openFile(sessionId, true, constants.O_RDONLY);
      const data = await handle.readFile('utf8');
      const parsed = JSON.parse(data);
      return Array.isArray(parsed) ? parsed : [];
    } catch (err: any) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
        return [];
      }
      throw err;
    } finally {
      await handle?.close();
    }
  }

  async #writeItems(sessionId: string, items: unknown[]): Promise<void> {
    const handle = await this.#openFile(sessionId);
    try {
      await handle.truncate(0);
      await handle.writeFile(JSON.stringify(items, null, 2), 'utf8');
    } finally {
      await handle.close();
    }
  }
}

function coerceAgentItem(raw: unknown): AgentInputItem | undefined {
  const parsed = protocol.ModelItem.safeParse(raw);
  if (!parsed.success) {
    return undefined;
  }
  return parsed.data as AgentInputItem;
}

export type { AgentInputItem } from '@openai/agents/classic';
