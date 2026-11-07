import { randomUUID } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Agent,
  Environment,
  NativeProvider,
  type ApprovalRequest,
  type Session,
  type Turn,
} from '@openai/agents';
import { TurnAborted } from '../../src/runtime/session';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(() => ModelServer.closeAll());

// Each fixture owns process CA settings, so these cases deliberately run serially.
type Route = 'exec' | 'patch';
type Step = 'first' | 'successor' | 'finished';

async function withApproval(
  route: Route,
  steps: Step[],
  run: (fixture: {
    session: Session;
    model: ModelServer;
    targets: Record<'first' | 'successor', string>;
  }) => Promise<void>,
) {
  const executor = await startPublicExecutor();
  const targets = {
    first: resolve(
      executor.cwd,
      route === 'patch' ? '..' : '.',
      `c7-first-${randomUUID()}`,
    ),
    successor: resolve(
      executor.cwd,
      route === 'patch' ? '..' : '.',
      `c7-next-${randomUUID()}`,
    ),
  };
  const model = new ModelServer(
    steps.map((step) => {
      if (step === 'finished') return [message('finished')];
      const target = targets[step];
      return [
        route === 'exec'
          ? call(
              'exec_command',
              {
                cmd: `printf proof > '${target.replaceAll("'", "'\\''")}'`,
                sandbox_permissions: 'require_escalated',
                justification: 'One fixture-owned command',
              },
              { callId: 'reused-model-id' },
            )
          : {
              type: 'custom_tool_call',
              name: 'apply_patch',
              call_id: 'reused-model-id',
              input: `*** Begin Patch\n*** Add File: ${target}\n+proof\n*** End Patch`,
            },
      ];
    }),
  );
  let provider: NativeProvider | undefined;
  try {
    const config = await model.config();
    provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'fixture',
    });
    const environment = new Environment({
      url: executor.url,
      cwd: executor.cwd,
      headers: executor.headers,
      // These cases exercise the explicit legacy escalation approval flow.
      writePolicy: 'legacy',
      tools: ['exec_command', 'write_stdin', 'apply_patch'],
    });
    await using session = await new Agent({
      instructions: 'Use the selected native tool.',
      model: route === 'patch' ? 'gpt-5.5' : 'gpt-5',
      provider,
    }).session({ environment });
    await run({ session, model, targets });
    model.assertExhausted();
  } finally {
    try {
      await provider?.close();
    } finally {
      await executor.close();
    }
  }
}

async function approval(
  turn: Turn,
  session: Session,
  target: string,
): Promise<ApprovalRequest> {
  const outcome = await turn.wait({
    until: 'interaction',
    signal: AbortSignal.timeout(10_000),
  });
  if (
    !('requests' in outcome) ||
    outcome.requests.length !== 1 ||
    outcome.requests[0]?.type !== 'approval_request'
  ) {
    throw new Error('Expected one real Environment approval');
  }
  const request = outcome.requests[0];
  expect(request.turnId).toBe(turn.turnId);
  expect(request.sessionId).toBe(session.id);
  expect(request.subagentId).toBeNull();
  expect(request.call).toBeNull();
  expect(request.description).toContain(target);
  return request;
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Owned approval witness exceeded deadline')),
          10_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const native = describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');
native('real Environment approval boundaries', () => {
  for (const route of ['exec', 'patch'] as const) {
    it(`${route}: observer deadline leaves approval pending until deny and revokes prepared allow`, async () => {
      await withApproval(
        route,
        ['first', 'finished'],
        async ({ session, targets }) => {
          const turn = await session.submit('Write the first proof.');
          const request = await approval(turn, session, targets.first);
          const prepared = request.reply('allow_once');
          await expect(access(targets.first)).rejects.toMatchObject({
            code: 'ENOENT',
          });
          const observer = new AbortController();
          const reason = new Error('Application observation deadline');
          const timer = setTimeout(() => observer.abort(reason), 10);
          try {
            await expect(
              turn.wait({ until: 'manual_tool', signal: observer.signal }),
            ).rejects.toBe(reason);
            expect(await session.pendingInteractions()).toEqual([request]);
            await expect(access(targets.first)).rejects.toMatchObject({
              code: 'ENOENT',
            });
            await session.respond(request.reply('deny'));
            await expect(session.respond(prepared)).rejects.toThrow('expired');
            expect(() => request.reply('allow_once')).toThrow('expired');
            expect((await bounded(turn.wait())).finalOutput).toBe('finished');
            await expect(access(targets.first)).rejects.toMatchObject({
              code: 'ENOENT',
            });
          } finally {
            clearTimeout(timer);
          }
        },
      );
    }, 30_000);

    it(`${route}: exact Turn cancellation rejects late allows and an old timer preserves a successor`, async () => {
      await withApproval(
        route,
        ['first', 'successor', 'finished'],
        async ({ session, targets }) => {
          const original = await session.submit('Write the first proof.');
          const request = await approval(original, session, targets.first);
          const prepared = request.reply('allow_once');
          const terminal = original.wait();
          terminal.catch(() => {});
          await bounded(original.cancel({ mode: 'force' }));
          await expect(terminal).rejects.toBeInstanceOf(TurnAborted);
          expect(() => request.reply('allow_once')).toThrow('expired');
          await expect(session.respond(prepared)).rejects.toThrow('expired');
          await expect(access(targets.first)).rejects.toMatchObject({
            code: 'ENOENT',
          });
          const successor = await session.submit('Write the next proof.');
          const nextRequest = await approval(
            successor,
            session,
            targets.successor,
          );
          expect(successor).not.toBe(original);
          const fired = Promise.withResolvers<void>();
          let timerWork: Promise<void> | undefined;
          const timer = setTimeout(() => {
            timerWork = original.cancel();
            timerWork.then(fired.resolve, fired.reject);
          }, 10);
          try {
            await bounded(fired.promise);
            expect(await session.pendingInteractions()).toEqual([nextRequest]);
            await expect(access(targets.first)).rejects.toMatchObject({
              code: 'ENOENT',
            });
            await expect(access(targets.successor)).rejects.toMatchObject({
              code: 'ENOENT',
            });
            await session.respond(nextRequest.reply('deny'));
            expect((await bounded(successor.wait())).finalOutput).toBe(
              'finished',
            );
            await expect(access(targets.first)).rejects.toMatchObject({
              code: 'ENOENT',
            });
            await expect(access(targets.successor)).rejects.toMatchObject({
              code: 'ENOENT',
            });
          } finally {
            clearTimeout(timer);
            await timerWork;
          }
        },
      );
    }, 30_000);
  }
});

native('one-time Environment approval scope', () => {
  it('exec: repeating the identical command requires a fresh approval', async () => {
    await withApproval(
      'exec',
      ['first', 'finished', 'first', 'finished'],
      async ({ session, targets }) => {
        const first = await session.submit('Write the first proof.');
        const firstRequest = await approval(first, session, targets.first);
        await session.respond(firstRequest.reply('allow_once'));
        expect((await bounded(first.wait())).finalOutput).toBe('finished');
        expect(await readFile(targets.first, 'utf8')).toBe('proof');

        // An unintended repeat of the exact command would overwrite this marker.
        await writeFile(targets.first, 'retained');
        const repeated = await session.submit('Repeat the same command.');
        const request = await approval(repeated, session, targets.first);
        expect(request).not.toBe(firstRequest);
        expect(request.turnId).not.toBe(firstRequest.turnId);
        expect(await session.pendingInteractions()).toEqual([request]);
        expect(await readFile(targets.first, 'utf8')).toBe('retained');
        await session.respond(request.reply('deny'));
        expect((await bounded(repeated.wait())).finalOutput).toBe('finished');
        expect(await readFile(targets.first, 'utf8')).toBe('retained');
      },
    );
  }, 30_000);

  for (const route of ['exec', 'patch'] as const) {
    it(`${route}: accepting one operation leaves a later operation pending`, async () => {
      await withApproval(
        route,
        ['first', 'finished', 'successor', 'finished'],
        async ({ session, targets }) => {
          const first = await session.submit('Write the first proof.');
          const firstRequest = await approval(first, session, targets.first);
          const accepted = firstRequest.reply('allow_once');
          await session.respond(accepted);
          expect((await bounded(first.wait())).finalOutput).toBe('finished');
          expect(await readFile(targets.first, 'utf8')).toBe(
            route === 'exec' ? 'proof' : 'proof\n',
          );
          const second = await session.submit('Write the next proof.');
          const secondRequest = await approval(
            second,
            session,
            targets.successor,
          );
          expect(secondRequest).not.toBe(firstRequest);
          expect(secondRequest.turnId).not.toBe(firstRequest.turnId);
          await expect(access(targets.successor)).rejects.toMatchObject({
            code: 'ENOENT',
          });
          await expect(session.respond(accepted)).rejects.toThrow('expired');
          expect(await session.pendingInteractions()).toEqual([secondRequest]);
          await session.respond(secondRequest.reply('deny'));
          expect((await bounded(second.wait())).finalOutput).toBe('finished');
          await expect(access(targets.successor)).rejects.toMatchObject({
            code: 'ENOENT',
          });
          expect(await readFile(targets.first, 'utf8')).toBe(
            route === 'exec' ? 'proof' : 'proof\n',
          );
        },
      );
    }, 30_000);
  }
});
