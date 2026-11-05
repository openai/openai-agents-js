import { createHash } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Journal } from '../../examples/external-job-journal';
import { Busy, ThumbnailStore } from '../../examples/external-job-store';
import type {
  JobBinding,
  JobClaim,
  JobContext,
} from '../../src/experimental/deferred';

// Node 22 warns when SQLite is first imported. Expect only that import diagnostic;
// restore normal warning handling before any test executes.
const restoreSqliteWarning = vi.hoisted(() => {
  const emitWarning = process.emitWarning;
  const warning = vi
    .spyOn(process, 'emitWarning')
    .mockImplementation((...args: unknown[]) => {
      if (
        args[0] ===
          'SQLite is an experimental feature and might change at any time' &&
        args[1] === 'ExperimentalWarning' &&
        args.slice(2).every((argument) => argument === undefined)
      )
        return;
      Reflect.apply(emitWarning, process, args);
    });
  return () => warning.mockRestore();
});
restoreSqliteWarning();

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const context = (): JobContext => ({ signal: new AbortController().signal });
const checkpoint =
  '{"source_session_id":"original-session","opaque":"exact bytes"}';
const binding: JobBinding = {
  tenant: 'studio',
  runId: 'one',
  providerId: 'sqlite-thumbnail-v1',
  sessionId: 'original-session',
  turnId: 'original-turn',
  callId: 'original-call',
  toolName: 'render_thumbnail',
  requestDigest: hash('{"color":"blue"}'),
  checkpointDigest: hash(checkpoint),
};
const temporary: string[] = [];
const children = new Set<ChildProcess>();
function home() {
  const directory = mkdtempSync(join(tmpdir(), 'deferred-journal-'));
  temporary.push(directory);
  return directory;
}
function journal(directory = home()) {
  return new Journal(new ThumbnailStore(directory, 'studio'), 'one');
}
async function prepare(app: Journal) {
  await app.prepare(checkpoint, [binding], context());
}
// Child fixtures run the actual TS example through the repository's existing tsx loader.
function worker(directory: string, body: string): ChildProcess {
  const script = join(directory, 'worker.mjs');
  const store = resolve('packages/agents-codex/examples/external-job-store.ts');
  const journals = resolve(
    'packages/agents-codex/examples/external-job-journal.ts',
  );
  writeFileSync(
    script,
    `import { ThumbnailStore } from ${JSON.stringify(store)};
    import { Journal } from ${JSON.stringify(journals)};
    const app = new Journal(new ThumbnailStore(${JSON.stringify(directory)}, 'studio'), 'one');
    const binding = ${JSON.stringify(binding)};
    const checkpoint = ${JSON.stringify(checkpoint)};
    const context = { signal: new AbortController().signal };
    ${body}`,
    { mode: 0o600 },
  );
  const child = fork(script, [], {
    execArgv: ['--import', 'tsx'],
    env: {
      ...process.env,
      TSX_TSCONFIG_PATH: resolve('packages/agents-codex/tsconfig.test.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    cwd: resolve('.'),
  });
  children.add(child);
  return child;
}
async function ready(child: ChildProcess): Promise<unknown> {
  let stderr = '';
  child.stderr?.on('data', (data) => {
    stderr += String(data);
  });
  return new Promise((accept, reject) => {
    const died = (code: number | null) =>
      reject(new Error(`Child exited ${code}: ${stderr}`));
    child.once('exit', died);
    child.once('error', reject);
    child.once('message', (message) => {
      child.off('exit', died);
      accept(message);
    });
  });
}
async function kill(child: ChildProcess) {
  if (child.exitCode === null && child.signalCode === null) {
    const ended = once(child, 'exit');
    child.kill('SIGKILL');
    await ended;
  }
  children.delete(child);
}
afterEach(async () => {
  for (const child of children) await kill(child);
  for (const directory of temporary.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')(
  'real private SQLite job journal (Node24/POSIX)',
  () => {
    it('prepares exact bytes atomically and refuses a different scope or binding', async () => {
      const app = journal();
      await app.owner(async () => {
        await expect(
          app.prepare(checkpoint, [binding, binding], context()),
        ).rejects.toThrow();
        expect(app.load()).toEqual({ checkpoint: null, finished: false });
        await expect(
          app.prepare(
            checkpoint,
            [{ ...binding, checkpointDigest: hash('different') }],
            context(),
          ),
        ).rejects.toThrow();
        await prepare(app);
        await prepare(app);
        expect(app.load()).toEqual({ checkpoint, finished: false });
        for (const key of Object.keys(binding) as (keyof JobBinding)[])
          await expect(
            app.claim(
              { ...binding, [key]: `changed-${binding[key]}` },
              'advance',
              context(),
            ),
          ).rejects.toThrow();
        await expect(
          app.prepare(
            checkpoint,
            [{ ...binding, sessionId: 'fresh-restored-session' }],
            context(),
          ),
        ).rejects.toThrow();
        expect(app.load().checkpoint).toBe(checkpoint);
      });
    });

    it.each([false, true])(
      'recovers process death after creating reservation, external effect=%s',
      async (created) => {
        const directory = home();
        const child = worker(
          directory,
          `await app.owner(async () => {
      await app.prepare(checkpoint, [binding], context);
      const claim = await app.claim(binding, 'advance', context);
      ${created ? `app.authorized(claim, db => db.prepare('INSERT INTO thumbnails VALUES (?,?,?,?,NULL)').run('studio','one','blue','private-original-receipt'), context);` : ''}
      process.send({ action: claim.action, generation: claim.generation });
      await new Promise(resolve => process.once('message', resolve));
    });`,
        );
        expect(await ready(child)).toEqual({
          action: 'start',
          generation: '1',
        });
        const contender = journal(directory);
        await expect(contender.owner(async () => {})).rejects.toBeInstanceOf(
          Busy,
        );
        await kill(child);
        const app = journal(directory);
        await app.owner(async () => {
          expect(app.load().checkpoint).toBe(checkpoint);
          const claim = await app.claim(binding, 'advance', context());
          expect(claim.action).toBe('reconcileCreation');
          expect(claim.generation).toBe('2');
          const target = app.authorized(
            claim,
            (db) => {
              db.prepare(
                `INSERT INTO thumbnails VALUES (?,?,?,?,NULL)
          ON CONFLICT (tenant,order_id) DO NOTHING`,
              ).run('studio', 'one', 'blue', 'private-recovered-receipt');
              return db
                .prepare(
                  'SELECT color,receipt FROM thumbnails WHERE tenant=? AND order_id=?',
                )
                .get(...app.scope)!;
            },
            context(),
          );
          expect(target).toEqual({
            color: 'blue',
            receipt: created
              ? 'private-original-receipt'
              : 'private-recovered-receipt',
          });
          await app.record(
            claim,
            { status: 'pending', receipt: target.receipt as string },
            context(),
          );
        });
        const work = worker(
          directory,
          `process.send({ first: app.store.work('one'), second: app.store.work('one') });`,
        );
        expect(await ready(work)).toEqual({ first: true, second: false });
        expect(await once(work, 'exit')).toEqual([0, null]);
        children.delete(work);
        await app.owner(async () => {
          const claim = await app.claim(binding, 'advance', context());
          const target = app.authorized(
            claim,
            (db) =>
              db
                .prepare('SELECT receipt,length(image) AS size FROM thumbnails')
                .get()!,
            context(),
          );
          expect(target.size).toBe(3085);
          await app.record(
            claim,
            {
              status: 'completed',
              receipt: target.receipt as string,
              value: { byteCount: target.size },
            },
            context(),
          );
          await app.saveResult(claim, '{"byteCount":3085}', context());
          app.finish('{"continued":true}');
          expect(app.load()).toEqual({ checkpoint, finished: true });
          expect(checkpoint).not.toContain(target.receipt);
          expect(
            app.store.transaction(
              (db) =>
                db.prepare('SELECT COUNT(*) AS count FROM thumbnails').get()!
                  .count,
            ),
          ).toBe(1);
        });
      },
      15_000,
    );

    it('fences stale claims, keeps exact generations beyond JS integer precision, and refuses overflow', async () => {
      const app = journal();
      let stale!: JobClaim;
      await app.owner(async () => {
        await prepare(app);
        stale = await app.claim(binding, 'advance', context());
      });
      app.store.transaction((db) =>
        db.exec('UPDATE orders SET generation=9007199254740992'),
      );
      await app.owner(async () => {
        const current = await app.claim(binding, 'advance', context());
        expect(current.generation).toBe('9007199254740993');
        await expect(
          app.authorize(stale, 'start', context()),
        ).rejects.toThrow();
        await expect(
          app.record(
            stale,
            { status: 'pending', receipt: 'private' },
            context(),
          ),
        ).rejects.toThrow();
      });
      app.store.transaction((db) =>
        db.exec('UPDATE orders SET generation=9223372036854775807'),
      );
      await expect(app.owner(async () => {})).rejects.toThrow();
      expect(
        app.store.transaction(
          (db) =>
            db
              .prepare('SELECT CAST(generation AS TEXT) AS fence FROM orders')
              .get()!.fence,
        ),
      ).toBe('9223372036854775807');
    });

    it('retains a spent approved mutation after process death without another response', async () => {
      const directory = home();
      const child = worker(
        directory,
        `await app.owner(async () => {
      await app.prepare(checkpoint, [binding], context);
      const start = await app.claim(binding, 'advance', context);
      await app.record(start, { status:'inputRequired', receipt:'private-receipt' }, context);
      const claim = await app.claim(binding, 'respond', context);
      const before = app.store.transaction(db => db.prepare('SELECT COUNT(*) AS count FROM mutations').get().count);
      app.reserveMutation(claim, 'respond', 'approved-response-v1', context);
      app.spendMutation(claim, 'respond', 'approved-response-v1', context);
      process.send({ before, action: claim.action });
      await new Promise(resolve => process.once('message', resolve));
    });`,
      );
      expect(await ready(child)).toEqual({ before: 0, action: 'respond' });
      await kill(child);
      const app = journal(directory);
      await app.owner(async () => {
        expect((await app.claim(binding, 'respond', context())).action).toBe(
          'unknown',
        );
        const observe = await app.claim(binding, 'advance', context());
        expect(observe.action).toBe('observe');
        expect(() =>
          app.reserveMutation(
            observe,
            'respond',
            'approved-response-v1',
            context(),
          ),
        ).toThrow();
        expect(() =>
          app.spendMutation(
            observe,
            'respond',
            'approved-response-v1',
            context(),
          ),
        ).toThrow();
        expect(
          app.store.transaction(
            (db) => db.prepare('SELECT state FROM mutations').get()!.state,
          ),
        ).toBe('spent');
      });
    }, 15_000);

    it.each(['respond', 'cancel'] as const)(
      'observes an uncertain %s after reopening without renewing its spent grant',
      async (operation) => {
        const directory = home();
        const first = journal(directory);
        await first.owner(async () => {
          await prepare(first);
          const start = await first.claim(binding, 'advance', context());
          await first.record(
            start,
            { status: 'inputRequired', receipt: 'private-receipt' },
            context(),
          );
          const claim = await first.claim(binding, operation, context());
          first.reserveMutation(claim, operation, 'approved-once', context());
          first.spendMutation(claim, operation, 'approved-once', context());
          await first.record(
            claim,
            { status: 'unknown', receipt: 'private-receipt' },
            context(),
          );
        });
        const restored = journal(directory);
        await restored.owner(async () => {
          const claim = await restored.claim(binding, 'advance', context());
          expect(claim).toMatchObject({
            action: 'observe',
            update: { status: 'unknown', receipt: 'private-receipt' },
          });
          await restored.authorize(claim, 'observe', context());
          await expect(
            restored.record(
              claim,
              { status: 'pending', receipt: 'another-receipt' },
              context(),
            ),
          ).rejects.toThrow();
          await restored.record(
            claim,
            { status: 'inputRequired', receipt: 'private-receipt' },
            context(),
          );
          expect(
            (await restored.claim(binding, operation, context())).action,
          ).toBe('unknown');
          expect(() =>
            restored.reserveMutation(
              claim,
              operation,
              'approved-once',
              context(),
            ),
          ).toThrow();
          expect(
            restored.store.transaction(
              (db) => db.prepare('SELECT state FROM mutations').get()!.state,
            ),
          ).toBe('spent');
          expect(restored.load().checkpoint).toBe(checkpoint);
        });
      },
    );

    it('does not turn an unknown job without a receipt into an observation grant', async () => {
      const app = journal();
      await app.owner(async () => {
        await prepare(app);
        const start = await app.claim(binding, 'advance', context());
        await app.record(start, { status: 'unknown' }, context());
        const claim = await app.claim(binding, 'advance', context());
        expect(claim.action).toBe('unknown');
        await expect(
          app.authorize(claim, 'observe', context()),
        ).rejects.toThrow();
        await expect(
          app.record(claim, { status: 'pending', receipt: 'new' }, context()),
        ).rejects.toThrow();
      });
    });

    it('can adopt an unsent reservation but cannot replace its approval or spend twice', async () => {
      const app = journal();
      await app.owner(async () => {
        await prepare(app);
        const start = await app.claim(binding, 'advance', context());
        await app.record(
          start,
          { status: 'pending', receipt: 'private-receipt' },
          context(),
        );
        const claim = await app.claim(binding, 'cancel', context());
        app.reserveMutation(claim, 'cancel', 'approved-cancel', context());
      });
      await app.owner(async () => {
        const claim = await app.claim(binding, 'cancel', context());
        expect(() =>
          app.reserveMutation(claim, 'cancel', 'another-approval', context()),
        ).toThrow();
        app.reserveMutation(claim, 'cancel', 'approved-cancel', context());
        app.spendMutation(claim, 'cancel', 'approved-cancel', context());
        expect(() =>
          app.spendMutation(claim, 'cancel', 'approved-cancel', context()),
        ).toThrow();
      });
    });

    it('retains saved public bytes across reopen and conditionally publishes only under a current authorized owner', async () => {
      const directory = home();
      const first = journal(directory);
      await first.owner(async () => {
        await prepare(first);
        expect(() => first.finish('{"premature":true}')).toThrow();
        const claim = await first.claim(binding, 'advance', context());
        await first.record(
          claim,
          { status: 'completed', value: { byteCount: 3085 } },
          context(),
        );
        await first.saveResult(claim, '{"byteCount":3085}', context());
      });
      expect(() => first.finish('{"stale":true}')).toThrow();
      const restored = journal(directory);
      await restored.owner(async () => {
        const claim = await restored.claim(binding, 'advance', context());
        expect(claim).toMatchObject({
          action: 'deliver',
          resultJson: '{"byteCount":3085}',
          binding: { sessionId: 'original-session' },
        });
        restored.finish('{"continued":true}');
        restored.finish('{"continued":true}');
        expect(() => restored.finish('{"replacement":true}')).toThrow();
        restored.store.transaction((db) =>
          db.exec('UPDATE orders SET allowed=0'),
        );
        await expect(
          restored.authorize(claim, 'deliver', context()),
        ).rejects.toThrow();
        expect(() => restored.finish('{"continued":true}')).toThrow();
        expect(restored.store.work('one')).toBe(false);
      });
    });

    it('refuses unsafe state directories, database/sidecar leaves and hardlinks without exposing private paths', () => {
      const parent = home();
      const outside = join(parent, 'outside');
      writeFileSync(outside, '', { mode: 0o600 });
      for (const directory of ['relative', join(parent, 'missing', 'state')])
        expect(() => journal(directory)).toThrow('private state');
      const link = join(parent, 'synthetic-private-state');
      symlinkSync(parent, link);
      try {
        journal(link);
        throw new Error('Accepted symlink');
      } catch (error) {
        expect(String(error)).not.toContain('synthetic-private');
      }
      const exposed = join(parent, 'exposed');
      new ThumbnailStore(exposed, 'studio');
      chmodSync(exposed, 0o755);
      expect(() => journal(exposed)).toThrow('private state');
      for (const name of [
        'orders.sqlite3',
        'orders.sqlite3-journal',
        'orders.sqlite3-wal',
        'orders.sqlite3-shm',
      ]) {
        const directory = home();
        const leaf = join(directory, name);
        linkSync(outside, leaf);
        expect(() => journal(directory)).toThrow('private state');
        expect(readFileSync(outside)).toHaveLength(0);
        rmSync(leaf);
      }
    });

    it('creates private database/lock/sidecar files even with an open umask in a separate process', async () => {
      const directory = join(home(), 'private ?mode=ro & receipts#100%');
      // The worker script needs an existing parent; SQLite state itself is created by the child.
      const parent = home();
      const script = join(parent, 'permissions.mjs');
      writeFileSync(
        script,
        `import { lstatSync } from 'node:fs';
      import { ThumbnailStore } from ${JSON.stringify(resolve('packages/agents-codex/examples/external-job-store.ts'))};
      import { Journal } from ${JSON.stringify(resolve('packages/agents-codex/examples/external-job-journal.ts'))};
      process.umask(0); const app = new Journal(new ThumbnailStore(${JSON.stringify(directory)},'studio'),'one');
      await app.owner(async () => { app.store.transaction(db => {
        db.exec("UPDATE orders SET phase='changed'");
        process.send([${JSON.stringify(directory)},${JSON.stringify(join(directory, 'orders.sqlite3'))},
          ${JSON.stringify(join(directory, 'orders.sqlite3-journal'))},
          ${JSON.stringify(directory)}+'/'+app.key+'.lock.sqlite3'].map(p => lstatSync(p).mode & 0o777));
      }); });`,
        { mode: 0o600 },
      );
      const child = fork(script, [], {
        execArgv: ['--import', 'tsx'],
        env: {
          ...process.env,
          TSX_TSCONFIG_PATH: resolve(
            'packages/agents-codex/tsconfig.test.json',
          ),
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        cwd: resolve('.'),
      });
      children.add(child);
      expect(await ready(child)).toEqual([0o700, 0o600, 0o600, 0o600]);
      expect(await once(child, 'exit')).toEqual([0, null]);
      children.delete(child);
      expect(lstatSync(join(directory, 'orders.sqlite3')).nlink).toBe(1);
    }, 15_000);
  },
);
