import type { AgentInputItem, Session } from '@openai/agents';
import { protocol } from '@openai/agents';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export type FileSessionOptions = {
  /**
   * Directory where session files are stored. Defaults to `./.agents-sessions`.
   */
  dir?: string;
  /**
   * Optional pre-existing session id to bind to.
   */
  sessionId?: string;
};

/**
 * A simple filesystem-backed Session implementation that stores history as a JSON array.
 */
export class FileSession implements Session {
  #dir: string;
  #sessionId?: string;

  constructor(options: FileSessionOptions = {}) {
    this.#dir = options.dir ?? path.resolve(process.cwd(), '.agents-sessions');
    this.#sessionId = options.sessionId;
  }

  /**
   * Get the current session id, creating one if necessary.
   */
  async getSessionId(): Promise<string> {
    if (!this.#sessionId) {
      // Compact, URL-safe-ish id without dashes.
      this.#sessionId = randomUUID().replace(/-/g, '').slice(0, 24);
    }
    await this.#ensureDir();
    // Ensure the file exists.
    const file = this.#filePath(this.#sessionId);
    try {
      await fs.access(file);
    } catch {
      await fs.writeFile(file, '[]', 'utf8');
    }
    return this.#sessionId;
  }

  /**
   * Retrieve items from the conversation history.
   */
  async getItems(limit?: number): Promise<AgentInputItem[]> {
    const sessionId = await this.getSessionId();
    const items = await this.#readItems(sessionId);
    if (typeof limit === 'number' && limit >= 0) {
      return items.slice(-limit);
    }
    return items;
  }

  /**
   * Append new items to the conversation history.
   */
  async addItems(items: AgentInputItem[]): Promise<void> {
    if (!items.length) return;
    const sessionId = await this.getSessionId();
    const current = await this.#readItems(sessionId);
    const next = current.concat(items);
    await this.#writeItems(sessionId, next);
  }

  /**
   * Remove and return the most recent item, if any.
   */
  async popItem(): Promise<AgentInputItem | undefined> {
    const sessionId = await this.getSessionId();
    const items = await this.#readItems(sessionId);
    if (items.length === 0) return undefined;
    const popped = items.pop();
    await this.#writeItems(sessionId, items);
    return popped;
  }

  /**
   * Delete all stored items and reset the session state.
   */
  async clearSession(): Promise<void> {
    if (!this.#sessionId) return; // Nothing to clear.
    const file = this.#filePath(this.#sessionId);
    try {
      await fs.unlink(file);
    } catch {
      // Ignore if already removed or inaccessible.
    }
    this.#sessionId = undefined;
  }

  // Internal helpers
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
      if (!Array.isArray(parsed)) return [];
      // Validate and coerce items to the protocol shape where possible.
      const result: AgentInputItem[] = [];
      for (const raw of parsed) {
        const check = protocol.ModelItem.safeParse(raw);
        if (check.success) {
          result.push(check.data as AgentInputItem);
        }
        // Silently skip invalid entries.
      }
      return result;
    } catch (err: any) {
      // On missing file, return empty list.
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return [];
      // For other errors, rethrow.
      throw err;
    }
  }

  async #writeItems(sessionId: string, items: AgentInputItem[]): Promise<void> {
    await this.#ensureDir();
    const file = this.#filePath(sessionId);
    // Keep JSON compact but deterministic.
    await fs.writeFile(file, JSON.stringify(items, null, 2), 'utf8');
  }
}

import { Agent, run } from '@openai/agents';

async function main() {
  const agent = new Agent({
    name: 'Assistant',
    instructions: 'You are a helpful assistant. be VERY concise.',
  });

  const session = new FileSession({ dir: './tmp/' });
  let result = await run(
    agent,
    'What is the largest country in South America?',
    { session },
  );
  console.log(result.finalOutput); // e.g., Brazil

  result = await run(agent, 'What is the capital of that country?', {
    session,
  });
  console.log(result.finalOutput); // e.g., Brasilia
}

async function mainStream() {
  const agent = new Agent({
    name: 'Assistant',
    instructions: 'You are a helpful assistant. be VERY concise.',
  });

  const session = new FileSession({ dir: './tmp/' });
  let result = await run(
    agent,
    'What is the largest country in South America?',
    {
      stream: true,
      session,
    },
  );

  for await (const event of result) {
    if (
      event.type === 'raw_model_stream_event' &&
      event.data.type === 'output_text_delta'
    )
      process.stdout.write(event.data.delta);
  }
  console.log();

  result = await run(agent, 'What is the capital of that country?', {
    stream: true,
    session,
  });

  // toTextStream() automatically returns a readable stream of strings intended to be displayed
  // to the user
  for await (const event of result.toTextStream()) {
    process.stdout.write(event);
  }
  console.log();
}

async function promptAndRun() {
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const isStream = await rl.question('Run in stream mode? (y/n): ');
  rl.close();
  if (isStream.trim().toLowerCase() === 'y') {
    await mainStream();
  } else {
    await main();
  }
}

promptAndRun().catch((error) => {
  console.error(error);
  process.exit(1);
});
