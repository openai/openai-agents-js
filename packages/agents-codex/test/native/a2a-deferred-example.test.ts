import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';

const example = fileURLToPath(
  new URL(
    '../../../../examples/codex/a2a/deferred-thumbnail.ts',
    import.meta.url,
  ),
);
const env = { ...process.env, OPENAI_API_KEY: '', CODEX_API_KEY: '' };
const argv = ['--import', 'tsx', example];

async function coordinator(
  directory: string,
  origin: string,
  ...args: string[]
) {
  const child = spawn(
    process.execPath,
    [...argv, 'run', directory, origin, ...args],
    { env },
  );
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const timer = setTimeout(() => child.kill('SIGKILL'), 25_000);
  try {
    const [code] = await once(child, 'exit');
    expect(code, stderr).toBe(0);
    return JSON.parse(stdout.trim()) as {
      status: string;
      remote?: { taskId: string; contextId: string };
    };
  } finally {
    clearTimeout(timer);
  }
}

async function withPeer(
  hold: boolean,
  use: (directory: string, origin: string) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), 'a2a-deferred-example-'));
  const child = spawn(
    process.execPath,
    [...argv, 'serve', ...(hold ? ['hold'] : [])],
    { env },
  );
  const exited = once(child, 'exit');
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
  let completed = false;
  try {
    const deadline = Date.now() + 15_000;
    while (!stdout.includes('A2A peer: ')) {
      if (child.exitCode !== null || Date.now() >= deadline)
        throw new Error(`Peer startup failed: ${stderr}`);
      await delay(20);
    }
    const origin = stdout.match(/A2A peer: (http:\/\/127\.0\.0\.1:\d+)/)![1];
    await use(directory, origin);
    completed = true;
  } finally {
    child.kill('SIGTERM');
    const [code] = await exited;
    clearTimeout(timer);
    await rm(directory, { recursive: true, force: true });
    if (completed) expect(code, stderr).toBe(0);
  }
}

async function stats(origin: string) {
  const response = await fetch(`${origin}/stats`, {
    headers: { Authorization: 'Bearer local-thumbnail-example' },
    signal: AbortSignal.timeout(5000),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    creates: number;
    replies: number;
    effects: number;
    taskId: string;
    contextId: string;
  }>;
}

async function observeUntil(
  directory: string,
  origin: string,
  status: 'inputRequired' | 'completed',
) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const current = await coordinator(directory, origin, 'observe');
    if (current.status === status) return current;
    expect(current.status).toBe('pending');
    if (Date.now() >= deadline)
      throw new Error(`Still pending while waiting for ${status}`);
  }
}

function saved(directory: string) {
  const db = new DatabaseSync(join(directory, 'orders.sqlite3'), {
    readOnly: true,
  });
  try {
    const row = db
      .prepare('SELECT binding,receipt_update,finished FROM orders')
      .get()!;
    const binding = JSON.parse(row.binding as string);
    return {
      binding,
      update: JSON.parse(row.receipt_update as string),
      finished: row.finished !== null,
      mutations: db
        .prepare('SELECT operation,state FROM mutations ORDER BY operation')
        .all(),
    };
  } finally {
    db.close();
  }
}

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'A2A deferred thumbnail CLI',
  () => {
    it('reopens the same native and remote calls, consumes one authorized reply, and delivers once', async () => {
      await withPeer(false, async (directory, origin) => {
        const first = await coordinator(directory, origin);
        expect(['pending', 'inputRequired']).toContain(first.status);
        const before = saved(directory);
        const observed = await observeUntil(directory, origin, 'inputRequired');
        expect(observed.remote).toEqual(first.remote);
        expect(saved(directory).update.receipt).toBe(before.update.receipt);
        expect(saved(directory).binding).toEqual(before.binding);
        expect(await stats(origin)).toMatchObject({
          creates: 1,
          replies: 0,
          effects: 0,
          ...first.remote,
        });
        const approved = await coordinator(directory, origin, 'approve');
        expect(['pending', 'completed']).toContain(approved.status);
        if (approved.status === 'pending')
          await observeUntil(directory, origin, 'completed');
        const after = saved(directory);
        expect(after.binding).toEqual(before.binding);
        expect(after.finished).toBe(true);
        expect(after.mutations).toEqual([
          { operation: 'respond', state: 'spent' },
          { operation: 'start', state: 'spent' },
        ]);
        expect(await coordinator(directory, origin, 'approve')).toEqual({
          status: 'completed',
        });
        expect(await stats(origin)).toMatchObject({
          creates: 1,
          replies: 1,
          effects: 1,
          ...first.remote,
        });
      });
    }, 60_000);

    it('retains an unknown create without a receipt and never dispatches another create', async () => {
      await withPeer(true, async (directory, origin) => {
        expect(
          await coordinator(directory, origin, 'observe', 'lose-create'),
        ).toEqual({ status: 'unknown' });
        expect(saved(directory).update).toEqual({ status: 'unknown' });
        expect(await coordinator(directory, origin, 'observe')).toEqual({
          status: 'unknown',
        });
        expect(await stats(origin)).toMatchObject({
          creates: 1,
          replies: 0,
          effects: 0,
        });
        expect(saved(directory).mutations).toEqual([
          { operation: 'start', state: 'spent' },
        ]);
      });
    }, 60_000);

    it('retains a known receipt after an uncertain reply and observes completion without replay', async () => {
      await withPeer(false, async (directory, origin) => {
        const first = await coordinator(directory, origin);
        await observeUntil(directory, origin, 'inputRequired');
        const uncertain = await coordinator(
          directory,
          origin,
          'approve',
          'lose-reply',
        );
        expect(uncertain).toEqual({ status: 'unknown', remote: first.remote });
        expect(saved(directory).finished).toBe(false);
        expect(saved(directory).update.status).toBe('unknown');
        expect(await observeUntil(directory, origin, 'completed')).toEqual({
          status: 'completed',
        });
        expect(await stats(origin)).toMatchObject({
          creates: 1,
          replies: 1,
          effects: 1,
          ...first.remote,
        });
        expect(saved(directory).finished).toBe(true);
      });
    }, 60_000);
  },
);
