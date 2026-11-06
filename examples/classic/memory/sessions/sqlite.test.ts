import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SQLiteSession, createSQLiteSession } from './sqlite';

const schemaRoot = fileURLToPath(new URL('../prisma', import.meta.url));
const connections: DatabaseSync[] = [];
const userItem = (content: string) => ({ role: 'user' as const, content });
let directory: string;
let databasePath: string;

async function openSession(
  options: Parameters<typeof createSQLiteSession>[0] = {},
) {
  const result = await createSQLiteSession(options);
  connections.push(result.database);
  return result;
}

async function holdLock(mode: 'reader' | 'writer', milliseconds?: number) {
  // A separate process lets the lock outlive a synchronous operation in this one.
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
        const { DatabaseSync } = require('node:sqlite');
        const { once } = require('node:events');
        const { writeSync } = require('node:fs');
        const { setTimeout } = require('node:timers/promises');
        async function holdLock() {
          const database = new DatabaseSync(process.argv[1]);
          try {
            database.exec(process.argv[2] === 'writer' ? 'BEGIN IMMEDIATE' : 'BEGIN');
            database.prepare('SELECT * FROM SessionItem').all();
            writeSync(1, 'locked\\n');
            if (process.argv[3]) {
              await setTimeout(Number(process.argv[3]));
            } else {
              process.stdin.resume();
              await once(process.stdin, 'end');
            }
            database.exec('ROLLBACK');
          } finally {
            database.close();
          }
        }
        holdLock().catch((error) => {
          console.error(error);
          process.exitCode = 1;
        });
      `,
      databasePath,
      mode,
      milliseconds === undefined ? '' : String(milliseconds),
    ],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  );
  const exited = once(child, 'exit');
  await Promise.race([
    once(child.stdout, 'data'),
    exited.then(([code]) => {
      throw new Error(
        `Lock process exited before acquiring the lock (${code}).`,
      );
    }),
  ]);
  return async () => {
    child.stdin.end();
    await exited;
  };
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'agents-sqlite-'));
  databasePath = join(directory, 'session.db');
  vi.stubEnv('DATABASE_URL', `file:${databasePath}`);
});

afterEach(async () => {
  for (const database of connections.splice(0)) {
    if (database.isOpen) {
      database.close();
    }
  }
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe('SQLiteSession', () => {
  it('reopens saved history, returns the latest window, and clears only its own session', async () => {
    const { session, database } = await openSession({ sessionId: 'first' });
    const items = ['one', 'two', 'three'].map(userItem);
    await session.addItems(items);
    database.close();

    const resumed = await openSession({ sessionId: 'first' });
    expect(await resumed.session.getItems(0)).toEqual([]);
    expect(await resumed.session.getItems(2)).toEqual(items.slice(-2));
    expect(await resumed.session.popItem()).toEqual(items[2]);
    expect(await resumed.session.getItems()).toEqual(items.slice(0, 2));

    const other = new SQLiteSession({
      database: resumed.database,
      sessionId: 'other',
    });
    await other.addItems([items[2]]);
    await resumed.session.clearSession();
    expect(await resumed.session.getSessionId()).not.toBe('first');
    expect(await resumed.session.getItems()).toEqual([]);
    expect(await other.getItems()).toEqual([items[2]]);
    expect(
      resumed.database
        .prepare(
          'SELECT count(*) AS count FROM SessionItem WHERE sessionId = ?',
        )
        .get('first'),
    ).toEqual({ count: 0 });
  });

  it('skips invalid rows in the selected window and deletes corrupt trailing rows during pop', async () => {
    const { session, database } = await openSession({ sessionId: 'corrupt' });
    const original = userItem('original');
    await session.addItems([original]);

    const insert = database.prepare(
      'INSERT INTO SessionItem (sessionId, position, item, createdAt) VALUES (?, ?, ?, ?)',
    );
    insert.run('corrupt', 2, 'invalid JSON', Date.now());
    insert.run('corrupt', 3, '{"unexpected":"shape"}', Date.now());

    expect(await session.getItems()).toEqual([original]);
    expect(await session.getItems(2)).toEqual([]);

    const added = userItem('appended after the corrupt rows');
    await session.addItems([added]);
    expect(await session.getItems(1)).toEqual([added]);
    expect(await session.popItem()).toEqual(added);
    expect(await session.popItem()).toEqual(original);
    expect(await session.popItem()).toBeUndefined();
    expect(database.prepare('SELECT item FROM SessionItem').all()).toEqual([]);
  });

  it('deletes all rows when the session contains only corrupt items', async () => {
    const { session, database } = await openSession({ sessionId: 'corrupt' });
    const sessionId = await session.getSessionId();
    const insert = database.prepare(
      'INSERT INTO SessionItem (sessionId, position, item, createdAt) VALUES (?, ?, ?, ?)',
    );
    insert.run(sessionId, 1, 'invalid JSON', Date.now());
    insert.run(sessionId, 2, 42, Date.now());

    expect(await session.popItem()).toBeUndefined();
    expect(database.prepare('SELECT item FROM SessionItem').all()).toEqual([]);
  });

  it('leaves an injected connection open and enables cascading deletes', async () => {
    const database = new DatabaseSync(':memory:', {
      enableForeignKeyConstraints: false,
    });
    connections.push(database);
    database.exec('PRAGMA busy_timeout = 250');
    const session = new SQLiteSession({ database, sessionId: 'injected' });
    await session.addItems([userItem('injected history')]);
    await session.clearSession();

    expect(database.prepare('SELECT item FROM SessionItem').all()).toEqual([]);
    expect(database.prepare('PRAGMA busy_timeout').get()).toEqual({
      timeout: 250,
    });
  });

  it('does not take over an active caller transaction', () => {
    const database = new DatabaseSync(':memory:');
    connections.push(database);
    database.exec('BEGIN');

    expect(() => new SQLiteSession({ database })).toThrow(/transaction/);
    expect(database.isTransaction).toBe(true);
    database.exec('ROLLBACK');
  });

  it('reads and appends to a Prisma 6 database using the same stored format', async () => {
    const legacy = new DatabaseSync(databasePath);
    try {
      legacy.exec(
        await readFile(
          new URL('fixtures/prisma6.sql', import.meta.url),
          'utf8',
        ),
      );
    } finally {
      legacy.close();
    }

    vi.stubEnv(
      'DATABASE_URL',
      `file:${relative(schemaRoot, databasePath)}?socket_timeout=7`,
    );
    const { session, database } = await openSession({
      sessionId: 'prisma6-session',
    });
    const original = userItem('Retained Prisma 6 history');
    const added = userItem('Added with SQLiteSession');
    expect(await session.getItems()).toEqual([original]);
    expect(database.prepare('PRAGMA busy_timeout').get()).toEqual({
      timeout: 7000,
    });
    await session.addItems([added]);
    database.close();

    const resumed = await openSession({ sessionId: 'prisma6-session' });
    expect(await resumed.session.getItems()).toEqual([original, added]);
    expect(
      resumed.database
        .prepare('SELECT createdAt, updatedAt FROM Session')
        .get(),
    ).toEqual({ createdAt: 1759322096789, updatedAt: 1759322096789 });
    const records = resumed.database
      .prepare(
        `
        SELECT id, position, typeof(createdAt) AS timestampType, createdAt,
               json_type(item) AS encoding, json_extract(item, '$') AS payload
        FROM SessionItem
        ORDER BY position
      `,
      )
      .all();
    expect(records).toEqual([
      {
        id: 1,
        position: 1,
        timestampType: 'integer',
        createdAt: 1759322096789,
        encoding: 'text',
        payload: expect.any(String),
      },
      {
        id: 2,
        position: 2,
        timestampType: 'integer',
        createdAt: expect.any(Number),
        encoding: 'text',
        payload: expect.any(String),
      },
    ]);
    expect(records.map(({ payload }) => JSON.parse(String(payload)))).toEqual([
      original,
      added,
    ]);
    expect(records[1].createdAt).toBeGreaterThan(1759322096789);
  });

  it('creates a missing database at the legacy schema-relative path', async () => {
    vi.stubEnv('DATABASE_URL', `file:${relative(schemaRoot, databasePath)}`);
    const { session } = await openSession({ sessionId: 'relative' });
    await session.addItems([userItem('relative URL')]);
    const database = new DatabaseSync(databasePath);
    connections.push(database);
    expect(
      database.prepare('SELECT count(*) AS count FROM SessionItem').get(),
    ).toEqual({ count: 1 });
  });

  it('prefers the environment URL and accepts databaseUrl when the environment is unset', async () => {
    const first = await openSession({
      databaseUrl: `file:${join(directory, 'unused.db')}`,
      sessionId: 'env',
    });
    const item = userItem('environment URL');
    await first.session.addItems([item]);

    vi.stubEnv('DATABASE_URL', '');
    const second = await openSession({
      databaseUrl: `file:${databasePath}`,
      sessionId: 'env',
    });
    expect(await second.session.getItems()).toEqual([item]);
    expect(process.env.DATABASE_URL).toBe('');
  });

  it('rolls back an append when SQLite rejects a later item in the batch', async () => {
    const { session, database } = await openSession();
    const original = userItem('retained history');
    const added = userItem('first item in failed append');
    await session.addItems([original]);
    database.exec(`
      CREATE TEMP TRIGGER reject_item BEFORE INSERT ON SessionItem
      WHEN NEW.position = 3
      BEGIN
        SELECT RAISE(ABORT, 'rejected item');
      END;
    `);

    await expect(
      session.addItems([added, userItem('rejected item')]),
    ).rejects.toThrow('rejected item');
    expect(await session.getItems()).toEqual([original]);
    await session.addItems([added]);
    expect(await session.getItems()).toEqual([original, added]);
  });

  it.each(['append', 'pop'] as const)(
    'waits for another writer before transactional %s',
    async (operation) => {
      vi.stubEnv('DATABASE_URL', `file:${databasePath}?socket_timeout=1`);
      const { session } = await openSession();
      const original = userItem('before lock');
      const added = userItem('after lock');
      await session.addItems([original]);

      const release = await holdLock('writer', 300);
      try {
        if (operation === 'append') {
          await session.addItems([added]);
          expect(await session.getItems()).toEqual([original, added]);
        } else {
          expect(await session.popItem()).toEqual(original);
          expect(await session.getItems()).toEqual([]);
        }
      } finally {
        await release();
      }
    },
  );

  it.each(['append', 'pop'] as const)(
    'keeps history readable and recovers after transactional %s times out waiting for a writer',
    async (operation) => {
      vi.stubEnv('DATABASE_URL', `file:${databasePath}?socket_timeout=1`);
      const { session } = await openSession();
      const original = userItem('retained history');
      const added = userItem('after recovery');
      await session.addItems([original]);

      const release = await holdLock('writer');
      try {
        expect(await session.getItems()).toEqual([original]);
        await expect(
          operation === 'append'
            ? session.addItems([added])
            : session.popItem(),
        ).rejects.toMatchObject({ code: 'ERR_SQLITE_ERROR', errcode: 5 });
      } finally {
        await release();
      }

      expect(await session.getItems()).toEqual([original]);
      await session.addItems([added]);
      expect(await session.popItem()).toEqual(added);
      expect(await session.getItems()).toEqual([original]);
    },
    10_000,
  );

  it.each(['append', 'pop'] as const)(
    'rolls back and recovers when a reader blocks %s COMMIT',
    async (operation) => {
      vi.stubEnv('DATABASE_URL', `file:${databasePath}?socket_timeout=1`);
      const sessionId = 'commit-timeout';
      const { session, database } = await openSession({ sessionId });
      const original = userItem('retained history');
      const added = userItem('after recovery');
      await session.addItems([original]);

      // In rollback journal mode a reader permits the write but blocks COMMIT.
      // Observe the row change to distinguish a failed COMMIT from a failed BEGIN.
      const observeWrite = vi.fn(() => 0);
      database.function('observe_session_write', observeWrite);
      database.exec(`
        PRAGMA journal_mode = DELETE;
        CREATE TEMP TRIGGER observe_write
        AFTER ${operation === 'append' ? 'INSERT' : 'DELETE'} ON SessionItem
        BEGIN
          SELECT observe_session_write();
        END;
      `);

      const release = await holdLock('reader');
      try {
        await expect(
          operation === 'append'
            ? session.addItems([added])
            : session.popItem(),
        ).rejects.toMatchObject({ code: 'ERR_SQLITE_ERROR', errcode: 5 });
        expect(observeWrite).toHaveBeenCalledOnce();
      } finally {
        await release();
      }

      // The failed connection must release its write lock before it is reused.
      const other = await openSession({ sessionId });
      expect(await other.session.getItems()).toEqual([original]);
      await other.session.addItems([added]);
      expect(await other.session.popItem()).toEqual(added);

      expect(await session.getItems()).toEqual([original]);
      await session.addItems([added]);
      expect(await session.popItem()).toEqual(added);
      expect(await session.getItems()).toEqual([original]);
    },
    10_000,
  );
});
