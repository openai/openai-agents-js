import {
  protocol,
  type AgentInputItem,
  type Session,
} from '@openai/agents/classic';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const schemaUrl = new URL('../prisma/schema.sql', import.meta.url);

export type SQLiteSessionOptions = {
  /** An open connection owned by the caller. Use it outside caller transactions. */
  database: DatabaseSync;
  sessionId?: string;
};

export class SQLiteSession implements Session {
  readonly #database: DatabaseSync;
  #sessionId?: string;

  constructor({ database, sessionId }: SQLiteSessionOptions) {
    if (database.isTransaction) {
      throw new Error(
        'SQLiteSession requires a connection outside a transaction.',
      );
    }
    database.exec('PRAGMA foreign_keys = ON');
    database.exec(readFileSync(schemaUrl, 'utf8'));
    this.#database = database;
    this.#sessionId = sessionId;
  }

  async getSessionId(): Promise<string> {
    return this.#ensureSessionId();
  }

  async getItems(limit?: number): Promise<AgentInputItem[]> {
    const sessionId = this.#ensureSessionId();
    const records = this.#database
      .prepare(
        'SELECT item FROM SessionItem WHERE sessionId = ? ORDER BY position DESC LIMIT ?',
      )
      .all(sessionId, limit !== undefined && limit >= 0 ? limit : -1);
    const result: AgentInputItem[] = [];
    for (const record of records.reverse()) {
      const item = parseStoredAgentItem(record.item);
      if (item) {
        result.push(item);
      }
    }
    return result;
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    if (items.length === 0) {
      return;
    }
    this.#transaction(() => {
      const sessionId = this.#ensureSessionId();
      const last = this.#database
        .prepare(
          'SELECT max(position) AS position FROM SessionItem WHERE sessionId = ?',
        )
        .get(sessionId);
      let position = Number(last?.position ?? 0);
      const insert = this.#database.prepare(
        'INSERT INTO SessionItem (sessionId, position, item, createdAt) VALUES (?, ?, ?, ?)',
      );
      const now = Date.now();
      for (const raw of items) {
        const item = coerceAgentItem(raw);
        if (item) {
          // The legacy Json column stores the serialized item as a JSON string.
          insert.run(
            sessionId,
            ++position,
            JSON.stringify(JSON.stringify(item)),
            now,
          );
        }
      }
    });
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    return this.#transaction(() => {
      const sessionId = this.#ensureSessionId();
      const latest = this.#database.prepare(
        'SELECT id, item FROM SessionItem WHERE sessionId = ? ORDER BY position DESC LIMIT 1',
      );
      const remove = this.#database.prepare(
        'DELETE FROM SessionItem WHERE id = ?',
      );
      for (let row = latest.get(sessionId); row; row = latest.get(sessionId)) {
        remove.run(row.id);
        const item = parseStoredAgentItem(row.item);
        if (item) {
          return item;
        }
      }
      return undefined;
    });
  }

  async clearSession(): Promise<void> {
    if (!this.#sessionId) {
      return;
    }
    this.#database
      .prepare('DELETE FROM Session WHERE id = ?')
      .run(this.#sessionId);
    this.#sessionId = undefined;
  }

  #ensureSessionId(): string {
    this.#sessionId ||= randomUUID().replace(/-/g, '').slice(0, 24);
    const sessionId = this.#sessionId;
    // Existing sessions can be read while another connection holds a write lock.
    const existing = this.#database
      .prepare('SELECT 1 FROM Session WHERE id = ?')
      .get(sessionId);
    if (!existing) {
      const now = Date.now();
      this.#database
        .prepare(
          'INSERT INTO Session (id, createdAt, updatedAt) VALUES (?, ?, ?) ON CONFLICT (id) DO NOTHING',
        )
        .run(sessionId, now, now);
    }
    return sessionId;
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.#database.exec('COMMIT');
      return result;
    } catch (error) {
      // A failed COMMIT can leave the transaction and its write lock active.
      if (this.#database.isTransaction) {
        try {
          this.#database.exec('ROLLBACK');
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            'SQLite transaction and rollback failed.',
          );
        }
      }
      throw error;
    }
  }
}

/** Open a database and session. The caller closes the returned database. */
export async function createSQLiteSession(
  options: { sessionId?: string; databaseUrl?: string } = {},
): Promise<{ session: SQLiteSession; database: DatabaseSync }> {
  const databaseUrl =
    process.env.DATABASE_URL || options.databaseUrl || 'file:./dev.db';
  const [path, query] = databaseUrl.split('?');
  // Keep file URLs relative to the previous schema directory.
  const databasePath = path.startsWith('file:')
    ? resolve(
        fileURLToPath(new URL('.', schemaUrl)),
        path.slice('file:'.length),
      )
    : path;
  const socketTimeout = new URLSearchParams(query).get('socket_timeout');
  const timeout = socketTimeout === null ? 5000 : Number(socketTimeout) * 1000;
  if (!Number.isInteger(timeout) || timeout < 0 || timeout > 2_147_483_647) {
    throw new Error('Invalid SQLite socket_timeout in database URL.');
  }

  // FileSession shares the barrel exports and never needs to load node:sqlite.
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`PRAGMA busy_timeout = ${timeout}`);
    const session = new SQLiteSession({
      database,
      sessionId: options.sessionId,
    });
    return { session, database };
  } catch (error) {
    database.close();
    throw error;
  }
}

function coerceAgentItem(raw: unknown): AgentInputItem | undefined {
  const parsed = protocol.ModelItem.safeParse(raw);
  if (!parsed.success) {
    return undefined;
  }
  return parsed.data as AgentInputItem;
}

function parseStoredAgentItem(raw: unknown): AgentInputItem | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  try {
    const decoded: unknown = JSON.parse(raw);
    return coerceAgentItem(
      typeof decoded === 'string' ? JSON.parse(decoded) : decoded,
    );
  } catch {
    return undefined;
  }
}
