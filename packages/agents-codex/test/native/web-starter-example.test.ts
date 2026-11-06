import { chmod, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { Agent } from '@openai/agents';
import { startWebStarter } from '../../../../examples/codex/web-starter/server';
import { TaskStore } from '../../../../examples/codex/web-starter/store';
import {
  scriptedPresentation,
  type WorkerOptions,
} from '../../../../examples/codex/web-starter/worker';
import {
  terminal,
  type Owner,
  type Phase,
  type Snapshot,
} from '../../../../examples/codex/web-starter/protocol';

const timeout = 25_000;
type App = Awaited<ReturnType<typeof startWebStarter>>;
async function withApp(
  options: WorkerOptions,
  run: (app: App) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'agents-web-starter-'));
  try {
    const app = await startWebStarter({ directory, ...options });
    await using _cleanup = {
      async [Symbol.asyncDispose]() {
        await app.close();
      },
    };
    await run(app);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
async function api(
  app: App,
  owner: Owner,
  path: string,
  value?: unknown,
): Promise<Response> {
  return fetch(`${app.url}${path}?owner=${owner}`, {
    signal: AbortSignal.timeout(5000),
    ...(value === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(value),
        }),
  });
}
async function submit(
  app: App,
  owner: Owner,
  requestKey: string,
): Promise<Snapshot> {
  const response = await api(app, owner, '/tasks', {
    requestKey,
    task: 'Create my synthetic report',
  });
  expect(response.status).toBe(202);
  return response.json() as Promise<Snapshot>;
}
async function waitFor(
  app: App,
  owner: Owner,
  receipt: string,
  phase: Phase,
): Promise<Snapshot> {
  const deadline = Date.now() + 12_000;
  for (;;) {
    const state = app.worker.snapshot(owner, receipt);
    if (state.phase === phase) return state;
    if (terminal(state.phase) || Date.now() >= deadline)
      throw new Error(`Expected ${phase}: ${JSON.stringify(state)}`);
    await delay(10);
  }
}
async function publish(
  app: App,
  owner: Owner,
  requestKey: string,
): Promise<Snapshot> {
  const admitted = await submit(app, owner, requestKey);
  const pending = await waitFor(app, owner, admitted.receipt, 'approval');
  expect(pending.result).toBeUndefined();
  expect(pending.artifact).toBeUndefined();
  expect(pending.approval?.token).toBeTruthy();
  expect(
    app.store.get(owner, pending.receipt).snapshot.approval,
  ).toBeUndefined();
  const response = await api(app, owner, `/tasks/${pending.receipt}/approval`, {
    token: pending.approval!.token,
    approve: true,
  });
  expect(response.status).toBe(202);
  return waitFor(app, owner, pending.receipt, 'completed');
}

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'native web starter',
  () => {
    it(
      'publishes only after a real manual reply, stores the selected MCP report privately, and downloads exact bytes',
      async () => {
        await withApp({}, async (app) => {
          const done = await publish(app, 'alice', 'publish');
          expect(done.result).toEqual({ summary: 'Synthetic task settled.' });
          const download = await api(
            app,
            'alice',
            `/artifacts/${done.artifact!.handle}`,
          );
          expect(download.status).toBe(200);
          expect(download.headers.get('content-disposition')).toBe(
            'attachment; filename="presentation.json"',
          );
          expect(await download.text()).toBe(scriptedPresentation);
          expect(scriptedPresentation.endsWith('\n')).toBe(true);
          expect(JSON.parse(scriptedPresentation).slides).toHaveLength(1);
          const references = app.store.reportReferences('alice');
          expect(references).toHaveLength(1);
          const report = app.store.report('alice', references[0]);
          expect(report.text).toContain('Synthetic report for alice.');
          expect(Buffer.byteLength(report.text)).toBeGreaterThan(4096);
          expect(JSON.stringify(done)).not.toContain(report.text);
          expect(() => app.store.report('bob', references[0])).toThrow(
            'Report unavailable',
          );
          expect(
            (await api(app, 'bob', `/artifacts/${done.artifact!.handle}`))
              .status,
          ).toBe(404);
          expect((await api(app, 'bob', `/tasks/${done.receipt}`)).status).toBe(
            404,
          );
        });
      },
      timeout,
    );

    it(
      'recovers identical requests, refuses changed payloads, and scopes keys and live authority to their owner',
      async () => {
        await withApp({}, async (app) => {
          const first = await submit(app, 'alice', 'same-key');
          const pending = await waitFor(
            app,
            'alice',
            first.receipt,
            'approval',
          );
          const same = await api(app, 'alice', '/tasks', {
            requestKey: 'same-key',
            task: 'Create my synthetic report',
          });
          expect(same.status).toBe(200);
          expect((await same.json()).receipt).toBe(first.receipt);
          expect(
            (
              await api(app, 'alice', '/tasks', {
                requestKey: 'same-key',
                task: ' Create my synthetic report ',
              })
            ).status,
          ).toBe(409);
          expect(
            (
              await api(app, 'alice', '/tasks', {
                requestKey: 'blank',
                task: '   ',
              })
            ).status,
          ).toBe(400);
          expect(app.store.get('alice', first.receipt).task).toBe(
            'Create my synthetic report',
          );
          expect(
            (
              await api(app, 'alice', '/tasks', {
                requestKey: 'same-key',
                task: 'Different task',
              })
            ).status,
          ).toBe(409);
          expect(
            (
              await api(app, 'bob', `/tasks/${first.receipt}/approval`, {
                token: pending.approval!.token,
                approve: true,
              })
            ).status,
          ).toBe(404);
          const other = await submit(app, 'bob', 'same-key');
          expect(other.receipt).not.toBe(first.receipt);
          expect(app.worker.stop('bob', other.receipt).phase).toBe('stopped');
          const response = await api(
            app,
            'alice',
            `/tasks/${first.receipt}/approval`,
            { token: pending.approval!.token, approve: false },
          );
          expect(response.status).toBe(202);
          expect(
            (
              await api(app, 'alice', `/tasks/${first.receipt}/approval`, {
                token: pending.approval!.token,
                approve: true,
              })
            ).status,
          ).toBe(409);
          const denied = await waitFor(app, 'alice', first.receipt, 'denied');
          expect(denied.artifact).toBeUndefined();
          expect(denied.result).toEqual({ summary: 'Synthetic task settled.' });
        });
      },
      timeout,
    );

    it(
      'rejects invalid presentation JSON without offering publication authority or committing an artifact',
      async () => {
        await withApp({ candidate: '{"slides":[]}' }, async (app) => {
          const task = await submit(app, 'alice', 'invalid');
          const failed = await waitFor(app, 'alice', task.receipt, 'failed');
          expect(failed.approval).toBeUndefined();
          expect(failed.artifact).toBeUndefined();
          expect(failed.result).toBeUndefined();
          expect(
            app.store.get('alice', task.receipt).checkpoint,
          ).toBeUndefined();
          // Validation failed, but disposal succeeded: the next task must run.
          const next = await submit(app, 'bob', 'after-validation');
          await waitFor(app, 'bob', next.receipt, 'failed');
          expect(app.store.reportReferences('bob')).toHaveLength(1);
        });
      },
      timeout,
    );

    it(
      'retains failed Session cleanup, fences the queue, and retries the public owner on shutdown',
      async () => {
        const directory = await mkdtemp(join(tmpdir(), 'agents-web-cleanup-'));
        const cleanupFailure = new Error(
          'controlled public Session.close failure',
        );
        const originalOpen = Agent.prototype.session;
        const opening = vi.spyOn(Agent.prototype, 'session');
        let closing: { mockRestore(): void } | undefined;
        let retainedSession: { close(): Promise<void> } | undefined;
        let app: App | undefined;
        const containsFailure = (error: unknown): boolean => {
          if (error === cleanupFailure) return true;
          if (!(error instanceof Error)) return false;
          if (
            error instanceof AggregateError &&
            error.errors.some(containsFailure)
          )
            return true;
          const chain = error as Error & {
            error?: unknown;
            suppressed?: unknown;
            cause?: unknown;
          };
          return (
            containsFailure(chain.error) ||
            containsFailure(chain.suppressed) ||
            containsFailure(chain.cause)
          );
        };
        opening.mockImplementationOnce(async function (this: Agent, ...args) {
          const session = await originalOpen.apply(this, args);
          retainedSession = session;
          closing = vi
            .spyOn(session, 'close')
            .mockRejectedValue(cleanupFailure);
          return session;
        });
        try {
          app = await startWebStarter({ directory });
          const first = await submit(app, 'alice', 'cleanup-failure');
          const pending = await waitFor(
            app,
            'alice',
            first.receipt,
            'approval',
          );
          const queued = await submit(app, 'bob', 'must-not-start');
          expect(
            (
              await api(app, 'alice', `/tasks/${first.receipt}/approval`, {
                token: pending.approval!.token,
                approve: true,
              })
            ).status,
          ).toBe(202);
          const failed = await waitFor(app, 'alice', first.receipt, 'failed');
          expect(failed.artifact).toBeTruthy(); // A later cleanup failure preserves the effect.
          const stoppedFailure = await api(
            app,
            'alice',
            `/tasks/${first.receipt}/stop`,
            {},
          );
          expect(stoppedFailure.status).toBe(202);
          expect((await stoppedFailure.json()).phase).toBe('failed');
          expect(
            containsFailure(app.worker.diagnostic('alice', first.receipt)),
          ).toBe(true);
          expect(app.worker.snapshot('bob', queued.receipt).phase).toBe(
            'queued',
          );
          expect(app.store.reportReferences('bob')).toHaveLength(0);
          expect(opening).toHaveBeenCalledTimes(1);
          expect(
            (
              await api(app, 'alice', '/tasks', {
                requestKey: 'fenced',
                task: 'No new owner',
              })
            ).status,
          ).toBe(503);
          // Restore the real public method. Shutdown must retry that retained Session.
          closing!.mockRestore();
          closing = vi.spyOn(retainedSession!, 'close');
          const failure = await app.close().then(
            () => undefined,
            (error: unknown) => error,
          );
          expect(closing).toHaveBeenCalledTimes(1);
          expect(containsFailure(failure)).toBe(true);
          // This lock can be reacquired only after shutdown joined its retry.
          const reopened = new TaskStore(directory);
          try {
            expect(reopened.get('alice', first.receipt).snapshot.phase).toBe(
              'failed',
            );
            expect(
              reopened.get('alice', first.receipt).snapshot.artifact,
            ).toEqual(failed.artifact);
            expect(reopened.get('bob', queued.receipt).snapshot.phase).toBe(
              'stopped',
            );
          } finally {
            reopened.close();
          }
        } finally {
          closing?.mockRestore();
          opening.mockRestore();
          await app?.close().catch(() => {});
          await rm(directory, { recursive: true, force: true });
        }
      },
      timeout,
    );

    it(
      'detaches SSE readers without stopping work and replaces the snapshot on reconnect',
      async () => {
        await withApp({}, async (app) => {
          const task = await submit(app, 'alice', 'disconnect');
          await waitFor(app, 'alice', task.receipt, 'approval');
          const controller = new AbortController();
          const response = await fetch(
            `${app.url}/tasks/${task.receipt}/events?owner=alice`,
            { signal: controller.signal },
          );
          const reader = response.body!.getReader();
          const first = await reader.read();
          expect(new TextDecoder().decode(first.value)).toContain(
            'event: snapshot',
          );
          controller.abort();
          await reader.cancel().catch(() => {});
          const pending = app.worker.snapshot('alice', task.receipt);
          expect(pending.phase).toBe('approval');
          const recovered = await api(app, 'alice', `/tasks/${task.receipt}`);
          expect(await recovered.json()).toEqual(pending);
          const reconnect = await api(
            app,
            'alice',
            `/tasks/${task.receipt}/events`,
          );
          const reconnectedReader = reconnect.body!.getReader();
          expect(
            new TextDecoder().decode((await reconnectedReader.read()).value),
          ).toContain(`"revision":${pending.revision}`);
          await reconnectedReader.cancel();
          app.worker.stop('alice', task.receipt);
          expect(
            (await waitFor(app, 'alice', task.receipt, 'stopped')).artifact,
          ).toBeUndefined();
        });
      },
      timeout,
    );

    it(
      'bounds admission, stops the exact active Turn, rejects cancelled tokens, and joins cleanup before shutdown',
      async () => {
        await withApp({ queueCapacity: 1 }, async (app) => {
          const task = await submit(app, 'alice', 'active');
          const pending = await waitFor(app, 'alice', task.receipt, 'approval');
          const queued = await submit(app, 'bob', 'queued');
          expect(queued.phase).toBe('queued');
          expect(
            (
              await api(app, 'alice', '/tasks', {
                requestKey: 'overflow',
                task: 'No room',
              })
            ).status,
          ).toBe(429);
          expect(app.worker.stop('bob', queued.receipt).phase).toBe('stopped');
          expect(app.worker.stop('alice', task.receipt).phase).toBe('stopping');
          expect(() =>
            app.worker.approve(
              'alice',
              task.receipt,
              pending.approval!.token,
              true,
            ),
          ).toThrow('Approval is expired');
          expect(
            (await waitFor(app, 'alice', task.receipt, 'stopped')).artifact,
          ).toBeUndefined();
          await app.close();
          // A new store acquires the process lock only after shutdown joined owners.
          const reopened = new TaskStore(app.store.directory);
          try {
            expect(reopened.get('alice', task.receipt).snapshot.phase).toBe(
              'stopped',
            );
          } finally {
            reopened.close();
          }
        });
      },
      timeout,
    );

    it(
      'starts deadlines at admission and expires queued work without replay or publication',
      async () => {
        await withApp({ deadlineMs: 1000 }, async (app) => {
          const active = await submit(app, 'alice', 'deadline-active');
          const queued = await submit(app, 'bob', 'deadline-queued');
          expect(queued.deadlineAt - active.deadlineAt).toBeLessThan(500);
          const expired = await waitFor(app, 'bob', queued.receipt, 'expired');
          expect(expired.artifact).toBeUndefined();
          expect(expired.result).toBeUndefined();
          expect(
            (await waitFor(app, 'alice', active.receipt, 'expired')).approval,
          ).toBeUndefined();
        });
      },
      timeout,
    );

    it(
      'restores only settled checkpoints with current context and newly issued MCP credentials',
      async () => {
        await withApp({}, async (app) => {
          const done = await publish(app, 'alice', 'restore');
          await delay(0); // Let the completed worker release its slot.
          const checkpoint = app.store.get('alice', done.receipt).checkpoint;
          expect(checkpoint).toBeTruthy();
          expect(checkpoint).not.toContain('Bearer ');
          expect(await app.worker.restore('alice', done.receipt)).toEqual({
            summary: 'Restored for alice.',
          });
          expect(app.store.reportReferences('alice')).toHaveLength(2);
          expect(() => app.worker.restore('bob', done.receipt)).toThrow(
            'Task unavailable',
          );
          expect(app.store.artifact('alice', done.artifact!.handle)).toBe(
            scriptedPresentation,
          );
        });
      },
      timeout,
    );
  },
);

it('requires a private POSIX directory and an exclusive process lock, and marks restart effects unknown', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'agents-web-store-'));
  try {
    await chmod(parent, 0o755);
    expect(() => new TaskStore(parent)).toThrow('private, owned POSIX');
    await chmod(parent, 0o700);
    const link = `${parent}-link`;
    await symlink(parent, link);
    try {
      expect(() => new TaskStore(link)).toThrow('private, owned POSIX');
    } finally {
      await rm(link);
    }
    const store = new TaskStore(parent);
    const task = store.admit(
      'alice',
      'restart',
      'Do not replay',
      Date.now() + 30_000,
    );
    expect(() => new TaskStore(parent)).toThrow();
    const committed = store.publish(
      'alice',
      task.snapshot.receipt,
      scriptedPresentation,
    );
    store.close();
    const restarted = new TaskStore(parent);
    try {
      const unknown = restarted.get('alice', task.snapshot.receipt);
      expect(unknown.snapshot.phase).toBe('unknown');
      expect(unknown.snapshot.artifact).toEqual(committed.artifact);
      expect(unknown.checkpoint).toBeUndefined();
      expect(
        restarted.recover('alice', 'restart', 'Do not replay')!.snapshot
          .receipt,
      ).toBe(task.snapshot.receipt);
      expect(restarted.artifact('alice', committed.artifact!.handle)).toBe(
        scriptedPresentation,
      );
      const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_600_001);
      try {
        expect(() => restarted.get('alice', task.snapshot.receipt)).toThrow(
          'Task unavailable',
        );
        expect(() =>
          restarted.artifact('alice', committed.artifact!.handle),
        ).toThrow('Task unavailable');
      } finally {
        now.mockRestore();
      }
    } finally {
      restarted.close();
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
