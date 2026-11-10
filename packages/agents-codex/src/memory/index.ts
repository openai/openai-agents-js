import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { tool, type FunctionTool } from '../runtime/tools';

const textSchema = z.string().refine((value) => value.isWellFormed(), {
  message: 'Memory text must contain well-formed Unicode.',
});
function boundedTextSchema(maxLength: number) {
  // Zod's built-in maximum counts UTF-16 code units; JSON Schema counts code points.
  return textSchema
    .refine((value) => [...value].length <= maxLength, {
      message: `Memory text must contain at most ${maxLength} Unicode code points.`,
    })
    .meta({ maxLength });
}
const keySchema = boundedTextSchema(256)
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: 'Scope and key cannot be blank.',
  });
const valueSchema = boundedTextSchema(65_536);

/**
 * Explicit string facts for one trusted application-selected scope.
 * Requires Node.js 22+ with built-in `node:sqlite` and a private
 * application-owned SQLite path.
 * Keys/scopes contain 1–256 Unicode code points; values contain at most 65,536
 * code points and may be empty. All text must contain well-formed Unicode;
 * lone surrogates fail before database access. Applications authorize writes
 * and treat recalled text as data.
 * No extraction, expiry, encryption, or identity provider is included.
 * Deletion does not erase model history, checkpoints, or exported telemetry.
 * Close only after native Sessions using this store have joined.
 */
export class SQLiteMemory {
  readonly #scope: string;
  #database: DatabaseSync | undefined;

  constructor(path: string, options: { scope: string }) {
    this.#scope = keySchema.parse(options.scope);
    const database = new DatabaseSync(path);
    try {
      database.exec('PRAGMA busy_timeout = 5000');
      database.exec(
        'CREATE TABLE IF NOT EXISTS agents_memory (scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (scope, key))',
      );
    } catch (error) {
      database.close();
      throw error;
    }
    this.#database = database;
  }

  /** Application-selected identity; never a model tool argument. */
  get scope(): string {
    return this.#scope;
  }

  #connection(): DatabaseSync {
    if (this.#database === undefined) throw new Error('SQLiteMemory is closed');
    return this.#database;
  }

  /** Read a scoped value, or null if the key does not exist. */
  get(key: string): string | null {
    const selected = keySchema.parse(key);
    const row = this.#connection()
      .prepare(
        'SELECT json_quote(value) AS value FROM agents_memory WHERE scope = ? AND key = ?',
      )
      .get(this.#scope, selected);
    // Node 22 truncates raw SQLite TEXT at NUL; JSON retains the full text
    // without assuming the database uses UTF-8 storage.
    return row === undefined
      ? null
      : valueSchema.parse(JSON.parse(z.string().parse(row.value)));
  }

  /** Replace one scoped value and commit before returning. */
  set(key: string, value: string): void {
    const selected = keySchema.parse(key);
    const captured = valueSchema.parse(value);
    this.#connection()
      .prepare(
        'INSERT INTO agents_memory (scope, key, value) VALUES (?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value',
      )
      .run(this.#scope, selected, captured);
  }

  /** Delete one scoped value; deleting an absent key succeeds. */
  delete(key: string): void {
    const selected = keySchema.parse(key);
    this.#connection()
      .prepare('DELETE FROM agents_memory WHERE scope = ? AND key = ?')
      .run(this.#scope, selected);
  }

  /** Capture ordinary native tools without exposing scope, path, or SQL. */
  tools(): FunctionTool[] {
    this.#connection();
    return [
      tool({
        name: 'memory_get',
        description:
          'Read an explicit saved fact for the current application scope.',
        parameters: z.strictObject({ key: keySchema }),
        execute: ({ key }) => this.get(key),
      }),
      tool({
        name: 'memory_set',
        description:
          'Save an explicit fact for the current scope when authorized by the user.',
        parameters: z.strictObject({ key: keySchema, value: valueSchema }),
        execute: ({ key, value }) => {
          this.set(key, value);
          return 'Saved';
        },
      }),
      tool({
        name: 'memory_delete',
        description:
          'Delete a fact for the current scope when authorized by the user.',
        parameters: z.strictObject({ key: keySchema }),
        execute: ({ key }) => {
          this.delete(key);
          return 'Deleted';
        },
      }),
    ];
  }

  /** Close after native work joins; safe to repeat. */
  close(): void {
    this.#database?.close();
    this.#database = undefined;
  }

  [Symbol.dispose](): void {
    this.close();
  }
}
