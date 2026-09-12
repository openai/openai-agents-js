import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaSession, type PrismaClient } from './prisma';

const exampleRoot = resolve(__dirname, '..');
const schemaRoot = join(exampleRoot, 'prisma');
const prismaCli = require.resolve('prisma/build/index.js');
const clients: PrismaClient[] = [];
let directory: string;
let databasePath: string;

function pushSchema(databaseUrl: string) {
  execFileSync(process.execPath, [prismaCli, 'db', 'push'], {
    cwd: exampleRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });
}

async function openSession(
  options: Parameters<typeof createPrismaSession>[0] = {},
) {
  const result = await createPrismaSession(options);
  clients.push(result.prisma);
  return result;
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'agents-prisma-'));
  databasePath = join(directory, 'session.db');
  vi.stubEnv('DATABASE_URL', `file:${databasePath}`);
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.$disconnect()));
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe('Prisma 7 SQLite integration', () => {
  it.each([true, false])(
    'persists and isolates sessions with transactions=%s',
    async (useTransactions) => {
      pushSchema(process.env.DATABASE_URL!);
      const { session, prisma } = await openSession({
        sessionId: 'first',
        useTransactions,
      });
      const items = ['one', 'two', 'three'].map((content) => ({
        role: 'user' as const,
        content,
      }));
      await session.addItems(items);
      await prisma.$disconnect();
      const resumed = await openSession({
        sessionId: 'first',
        useTransactions,
      });
      expect(await resumed.session.getItems(2)).toEqual(items.slice(-2));
      expect(await resumed.session.popItem()).toEqual(items[2]);
      expect(await resumed.session.getItems()).toEqual(items.slice(0, 2));
      const other = await openSession({
        client: resumed.prisma,
        sessionId: 'other',
      });
      await other.session.addItems([items[2]]);
      await resumed.session.clearSession();
      expect(await other.session.getItems()).toEqual([items[2]]);
      expect(
        await resumed.prisma.sessionItem.count({
          where: { sessionId: 'first' },
        }),
      ).toBe(0);
    },
  );

  it('reads and appends to an existing Prisma 6 database without changing timestamps', async () => {
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(
        await readFile(join(__dirname, 'fixtures/prisma6.sql'), 'utf8'),
      );
    } finally {
      database.close();
    }
    pushSchema(process.env.DATABASE_URL!);
    const { session, prisma } = await openSession({
      sessionId: 'prisma6-session',
    });
    const original = {
      role: 'user' as const,
      content: 'Retained Prisma 6 history',
    };
    expect(await session.getItems()).toEqual([original]);
    const record = await prisma.session.findUniqueOrThrow({
      where: { id: 'prisma6-session' },
    });
    expect(record.createdAt.toISOString()).toBe('2025-10-01T12:34:56.789Z');
    const added = { role: 'user' as const, content: 'Added with Prisma 7' };
    await session.addItems([added]);
    await prisma.$disconnect();
    const resumed = await openSession({ sessionId: 'prisma6-session' });
    expect(await resumed.session.getItems()).toEqual([original, added]);
    const raw = new DatabaseSync(databasePath);
    try {
      expect(
        raw.prepare('SELECT typeof(createdAt) AS kind FROM SessionItem').all(),
      ).toEqual([{ kind: 'integer' }, { kind: 'integer' }]);
    } finally {
      raw.close();
    }
  });

  it('uses the same schema-relative file for the CLI and the adapter', async () => {
    const url = `file:${relative(schemaRoot, databasePath)}`;
    vi.stubEnv('DATABASE_URL', url);
    pushSchema(url);
    const { session } = await openSession({ sessionId: 'relative' });
    await session.addItems([{ role: 'user', content: 'relative URL' }]);
    const database = new DatabaseSync(databasePath);
    try {
      expect(
        database.prepare('SELECT count(*) AS count FROM SessionItem').get(),
      ).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it('keeps environment precedence and accepts databaseUrl when the environment is unset', async () => {
    pushSchema(process.env.DATABASE_URL!);
    const first = await openSession({
      databaseUrl: 'file:unused.db',
      sessionId: 'env',
    });
    await first.session.addItems([
      { role: 'user', content: 'environment URL' },
    ]);
    vi.stubEnv('DATABASE_URL', '');
    const second = await openSession({
      databaseUrl: `file:${databasePath}`,
      sessionId: 'env',
    });
    expect(await second.session.getItems()).toEqual([
      { role: 'user', content: 'environment URL' },
    ]);
  });
});
