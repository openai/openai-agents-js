import { fork, type ChildProcess } from 'node:child_process';
import { appendFile, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate, setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Agent,
  NativeProvider,
  nativeGoals,
  localStorage,
  tool,
} from '../../src';
import { z } from 'zod';
import { binding, type NativeThread } from '../../src/runtime/binding';
import { captureTools } from '../../src/runtime/tools';
import { ModelServer, call, message } from './fixtures/model-server';

// Expect only Node's initial SQLite import warning; restore normal handling
// before the tests execute.
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

const homes: string[] = [];
const workers = new Map<ChildProcess, Promise<void>>();
afterEach(async () => {
  await Promise.all(
    [...workers].map(async ([child, closed]) => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
      await closed;
    }),
  );
  await ModelServer.closeAll();
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});
async function profile() {
  const home = await mkdtemp(join(tmpdir(), 'native-goals-'));
  homes.push(home);
  return join(home, 'profile');
}
async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-native-goals',
    supportsWebsockets: false,
  });
}
const usage = { input_tokens: 2, output_tokens: 1, total_tokens: 3 };
const agentFor = (provider: NativeProvider, managed = false) =>
  new Agent({
    instructions: 'Manage only the requested native goal.',
    model: 'gpt-5.1-codex',
    provider,
    tools: [
      nativeGoals(),
      ...(managed
        ? [
            tool({
              name: 'lookup',
              parameters: z.object({}),
              execute: () => 'current lookup',
            }),
          ]
        : []),
    ],
  });
async function worker(server: ModelServer, config: Record<string, unknown>) {
  const provider = await providerFor(server);
  const url = provider.baseUrl;
  await provider.close();
  const child = fork(
    fileURLToPath(
      new URL('./fixtures/native-goals-worker.ts', import.meta.url),
    ),
    [JSON.stringify({ ...config, url })],
    {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      serialization: 'advanced',
    },
  );
  let stderr = '';
  let value: any;
  let spawnError: Error | undefined;
  child.once('error', (error) => {
    spawnError = error;
  });
  const closed = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  workers.set(
    child,
    closed.then(() => undefined),
  );
  child.stderr?.on('data', (data) => {
    stderr += String(data);
  });
  child.on('message', (message) => {
    value = message;
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, 30_000);
  try {
    const { code, signal } = await closed;
    if (spawnError) throw spawnError;
    if (timedOut) throw new Error(`Goal worker timed out: ${stderr}`);
    return { code, signal, value, stderr };
  } finally {
    clearTimeout(timer);
    workers.delete(child);
  }
}

describe('current local native goals through Core', () => {
  it('sets and updates a goal without model work and reopens it in a fresh process', async () => {
    const server = new ModelServer([]);
    const path = await profile();
    await using provider = await providerFor(server);
    const agent = agentFor(provider);
    const session = await agent.session({ storage: localStorage(path) });
    let updated;
    try {
      expect(await session.goal()).toBeNull();
      expect(await session.checklist()).toBeNull();
      const created = await session.setPausedGoal('  Prepare a draft  ');
      expect(created).toMatchObject({
        threadId: session.id,
        objective: 'Prepare a draft',
        status: 'paused',
        tokensUsed: 0,
        timeUsedSeconds: 0,
      });
      expect(created).not.toHaveProperty('tokenBudget');
      expect(Object.isFrozen(created)).toBe(true);
      updated = await session.setPausedGoal('Prepare the final draft', {
        tokenBudget: 9223372036854775807n,
      });
      expect(updated).toMatchObject({
        threadId: created.threadId,
        createdAt: created.createdAt,
        objective: 'Prepare the final draft',
        status: 'paused',
        tokenBudget: 9223372036854775807n,
      });
      expect(await session.goal()).toEqual(updated);
      expect(await session.checklist()).toBeNull();
      await expect(session.setPausedGoal('   ')).rejects.toThrow(/objective/i);
      for (const tokenBudget of [0n, 9223372036854775808n])
        await expect(
          session.setPausedGoal('Invalid budget', { tokenBudget }),
        ).rejects.toThrow();
      for (const tokenBudget of [Number.MAX_SAFE_INTEGER + 1, 1.5])
        await expect(
          session.setPausedGoal('Inexact budget', { tokenBudget }),
        ).rejects.toThrow('safe integer or bigint');
      expect(await session.goal()).toEqual(updated);
    } finally {
      await session.close();
    }
    {
      await using denied = await agent.session({
        storage: localStorage(path),
        resume: session.id,
        tools: [],
      });
      await expect(denied.setPausedGoal('Unauthorized update')).rejects.toThrow(
        'current NativeGoals',
      );
    }
    const reopened = await worker(server, {
      profile: path,
      resume: session.id,
      mode: 'inspect',
    });
    expect(reopened.code, reopened.stderr).toBe(0);
    expect(reopened.value.pid).not.toBe(process.pid);
    expect(reopened.value.goal).toEqual(updated);
    expect(reopened.value.turnsBefore).toEqual([]);
    expect(reopened.value.turnsAfter).toEqual([]);
    expect(server.requests).toHaveLength(0);
  }, 60_000);

  it.each([false, true])(
    'admits goal-only or mixed managed opening: %s',
    async (managed) => {
      const replies = [
        ...(managed ? [[call('lookup', {}, { callId: 'lookup' })]] : []),
        [
          call(
            'create_goal',
            { objective: 'Complete the requested record', token_budget: 4000 },
            { callId: 'create' },
          ),
        ],
        [call('get_goal', {}, { callId: 'get' })],
        [call('update_goal', { status: 'complete' }, { callId: 'complete' })],
        [message('done')],
        [call('get_goal', {}, { callId: 'after-roster' })],
        [message('after roster')],
      ];
      const server = new ModelServer(replies, usage);
      await using provider = await providerFor(server);
      await using session = await agentFor(provider, managed).session({
        storage: localStorage(await profile()),
      });
      expect(await session.goal()).toBeNull();
      expect(
        (await (await session.submit('Complete the requested record.')).wait())
          .finalOutput,
      ).toBe('done');
      const goal = (await session.goal())!;
      expect(goal).toMatchObject({
        threadId: session.id,
        objective: 'Complete the requested record',
        status: 'complete',
        tokenBudget: 4000,
      });
      expect(goal.tokensUsed > 0).toBe(true);
      const before = server.requests.length;
      expect(await session.goal()).toEqual(goal);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(server.requests).toHaveLength(before);
      const advertised = JSON.stringify(server.requests[0].tools);
      for (const name of ['create_goal', 'get_goal', 'update_goal'])
        expect(advertised).toContain(name);
      expect(advertised).not.toContain('update_plan');
      await expect(session.update({ tools: [nativeGoals()] })).rejects.toThrow(
        'cannot change',
      );
      await session.update({ tools: [] });
      expect(await session.goal()).toEqual(goal);
      expect(
        (await (await session.submit('Read the current goal.')).wait())
          .finalOutput,
      ).toBe('after roster');
      const current = JSON.stringify(server.requests[before].tools);
      expect(current).toContain('get_goal');
      expect(current).not.toContain('lookup');
    },
  );

  it('preserves native identity, budget and budget-limited accounting across goal updates', async () => {
    const server = new ModelServer(
      [
        [
          call(
            'create_goal',
            { objective: 'Use the native budget', token_budget: 1 },
            { callId: 'budget' },
          ),
        ],
        async () => {
          await delay(1100);
          return [message('budget used')];
        },
      ],
      usage,
    );
    await using provider = await providerFor(server);
    const path = await profile();
    await using session = await agentFor(provider).session({
      storage: localStorage(path),
    });
    await (await session.submit('Create a small budget goal.')).wait();
    const goal = (await session.goal())!;
    expect(goal.status).toBe('budgetLimited');
    expect(goal.tokenBudget).toBe(1);
    expect(goal.tokensUsed >= 1).toBe(true);
    expect(goal.timeUsedSeconds >= 1).toBe(true);
    const filename = (await readdir(path)).find((name) =>
      /^goals_\d+\.sqlite$/.test(name),
    );
    if (!filename) throw new Error('The local profile has no goal database');
    const db = new DatabaseSync(join(path, filename));
    try {
      const identity = db.prepare(
        'SELECT goal_id FROM thread_goals WHERE thread_id = ?',
      );
      const original = identity.get(session.id);
      expect(original?.goal_id).toEqual(expect.any(String));
      const updated = await session.setPausedGoal('Keep the limited goal');
      expect(updated).toMatchObject({
        threadId: goal.threadId,
        objective: 'Keep the limited goal',
        status: 'budgetLimited',
        tokenBudget: goal.tokenBudget,
        tokensUsed: goal.tokensUsed,
        timeUsedSeconds: goal.timeUsedSeconds,
        createdAt: goal.createdAt,
      });
      expect(identity.get(session.id)).toEqual(original);

      db.exec(`CREATE TRIGGER reject_goal_update BEFORE UPDATE ON thread_goals
        BEGIN SELECT RAISE(ABORT, 'fixture goal storage failure'); END;`);
      await expect(session.setPausedGoal('Failed goal update')).rejects.toThrow(
        'fixture goal storage failure',
      );
      expect(await session.goal()).toEqual(updated);
      expect(identity.get(session.id)).toEqual(original);
    } finally {
      db.close();
    }
    expect(server.requests).toHaveLength(2);
  });

  it.each(['active', 'paused', 'complete'] as const)(
    'reopens an idle %s unbudgeted goal in a fresh process without model work or inherited grants',
    async (status) => {
      const server = new ModelServer(
        [
          [
            call(
              'create_goal',
              { objective: 'Stay active until explicitly asked' },
              { callId: 'create-active' },
            ),
          ],
          ...(status === 'active'
            ? []
            : [
                [
                  call(
                    'update_goal',
                    { status },
                    { callId: 'retained-status' },
                  ),
                ],
              ]),
          [message('settled')],
        ],
        usage,
      );
      const path = await profile();
      const source = await worker(server, { profile: path, mode: 'create' });
      expect(source.code, source.stderr).toBe(0);
      expect(source.value.goal.status).toBe(status);
      expect(source.value.goal).not.toHaveProperty('tokenBudget');
      const destination = await worker(server, {
        profile: path,
        resume: source.value.id,
        mode: 'inspect',
      });
      expect(destination.code, destination.stderr).toBe(0);
      expect(destination.value.pid).not.toBe(source.value.pid);
      expect(destination.value.id).toBe(source.value.id);
      expect(destination.value.goal).toEqual(source.value.goal);
      expect(destination.value.turnsBefore).toEqual(
        destination.value.turnsAfter,
      );
      const denied = await worker(server, {
        profile: path,
        resume: source.value.id,
        mode: 'denied',
      });
      expect(denied.code, denied.stderr).toBe(0);
      expect(denied.value.denied).toBe(true);
      const again = await worker(server, {
        profile: path,
        resume: source.value.id,
        mode: 'inspect',
      });
      expect(again.code, again.stderr).toBe(0);
      expect(again.value.goal).toEqual(source.value.goal);
      expect(server.requests).toHaveLength(status === 'active' ? 2 : 3);
    },
    120_000,
  );

  it('keeps one native writer and refuses stale goal access after actual close', async () => {
    const server = new ModelServer([]);
    await using provider = await providerFor(server);
    const agent = agentFor(provider);
    const storage = localStorage(await profile());
    const source = await agent.session({ storage });
    try {
      await expect(
        agent.session({ storage, resume: source.id }),
      ).rejects.toThrow();
      await source.setPausedGoal('Keep the current owner');
    } finally {
      await source.close();
    }
    await expect(source.goal()).rejects.toThrow('closed');
    await using next = await agent.session({ storage, resume: source.id });
    expect(next.id).toBe(source.id);
    await expect(source.setPausedGoal('Stale update')).rejects.toThrow(
      'settled open session',
    );
    expect(await next.goal()).toMatchObject({
      objective: 'Keep the current owner',
    });
    await using portable = await agent.session({ tools: [] });
    await expect(portable.setPausedGoal('Portable update')).rejects.toThrow(
      'requires LocalStorage',
    );
    expect(server.requests).toHaveLength(0);
  });

  it('joins an admitted goal mutation before closing its native writer', async () => {
    const server = new ModelServer([]);
    await using provider = await providerFor(server);
    const agent = agentFor(provider);
    const storage = localStorage(await profile());
    const session = await agent.session({ storage });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const thread = (await binding()).NativeThread.prototype;
    const setPaused = thread._set_paused_goal;
    const setter = vi
      .spyOn(thread, '_set_paused_goal')
      .mockImplementationOnce(async function (this: NativeThread, ...args) {
        entered.resolve();
        await release.promise;
        return setPaused.apply(this, args);
      });
    const closingNative = vi.spyOn(thread, '_close_report');
    const update = session.setPausedGoal('Write before closing', {
      tokenBudget: 4000,
    });
    try {
      await Promise.race([entered.promise, update]);
      const closing = session.close();
      await expect(session.setPausedGoal('Write during close')).rejects.toThrow(
        'settled open session',
      );
      await setImmediate();
      expect(closingNative).not.toHaveBeenCalled();
      release.resolve();
      const goal = await update;
      expect(goal.tokenBudget).toBe(4000);
      await closing;
      await using reopened = await agent.session({
        storage,
        resume: session.id,
      });
      expect(await reopened.goal()).toEqual(goal);
      expect(server.requests).toHaveLength(0);
    } finally {
      release.resolve();
      await update.catch(() => {});
      setter.mockRestore();
      closingNative.mockRestore();
      await session.close();
    }
  });

  it('rejects writes from a retired Session and preserves the retained goal', async () => {
    const server = new ModelServer([]);
    await using provider = await providerFor(server);
    const agent = agentFor(provider);
    const storage = localStorage(await profile());
    const session = await agent.session({ storage });
    const thread = (await binding()).NativeThread.prototype;
    const failure = new Error(
      'Application instruction acceptance is uncertain',
    );
    const call = vi.spyOn(thread, 'call').mockRejectedValueOnce(failure);
    const receipt = vi
      .spyOn(thread, '_application_instructions')
      .mockImplementationOnce(() => {
        throw failure;
      });
    let goal;
    try {
      goal = await session.setPausedGoal('Keep the accepted goal');
      await expect(session.update({ instructions: 'Uncertain' })).rejects.toBe(
        failure,
      );
      await expect(session.setPausedGoal('Retired update')).rejects.toThrow(
        'unavailable after failed persistence or cleanup',
      );
    } finally {
      call.mockRestore();
      receipt.mockRestore();
      await session.close();
    }
    await using reopened = await agent.session({ storage, resume: session.id });
    expect(await reopened.goal()).toEqual(goal);
    expect(server.requests).toHaveLength(0);
  });

  it.each(['active', 'paused'] as const)(
    'compacts a %s goal with real accounting and reopens its exact state in another process',
    async (status) => {
      const path = await profile();
      const effects = join(path, '..', 'compaction-effects');
      let calls = 0;
      const server = new ModelServer(
        [
          [
            call(
              'create_goal',
              '{"objective":"Preserve native state","token_budget":9223372036854775807}',
              { callId: 'create' },
            ),
          ],
          [message('created')],
          [call('effect', {}, { callId: 'known-effect' })],
          async () => {
            // A separate real work turn supplies both tokens and elapsed native
            // seconds. Never manufacture counters with a stored-row update.
            await new Promise((resolve) => setTimeout(resolve, 2100));
            return [message('accounted work')];
          },
          ...(status === 'paused'
            ? [[call('update_goal', { status }, { callId: 'pause' })]]
            : []),
          ...(status === 'paused' ? [[message('paused')]] : []),
          [message('Summary: retained objective and accepted work.')],
          [message('explicit continuation')],
        ],
        usage,
      );
      await using provider = await providerFor(server);
      const agent = new Agent({
        instructions: 'Manage only the requested native goal.',
        model: 'gpt-5.1-codex',
        provider,
        tools: [
          nativeGoals(),
          tool({
            name: 'effect',
            parameters: z.object({}),
            execute: async () => {
              calls++;
              await appendFile(effects, 'once\n');
              return 'accepted once';
            },
          }),
        ],
      });
      const storage = localStorage(path);
      const session = await agent.session({ storage });
      const usageEvents: unknown[] = [];
      const observing = (async () => {
        for await (const event of session.events())
          if (event.type === 'usage_updated') usageEvents.push(event);
      })();
      let after;
      const recordedTurns = [];
      const items = [];
      try {
        const first = await session.submit('Create the exact requested goal.');
        const firstResult = await first.wait();
        await (await session.submit('Perform one accounted work turn.')).wait();
        const seeded = (await session.goal())!;
        expect(seeded.tokensUsed > 0).toBe(true);
        expect(seeded.timeUsedSeconds > 0).toBe(true);
        if (status === 'paused')
          await (await session.submit('Pause the current goal.')).wait();
        const previous = await session.wait();
        const before = await session.goal();
        expect(before!.status).toBe(status);
        expect(before!.tokenBudget).toBe(9223372036854775807n);
        const requests = server.requests.length;
        await session.compact();
        expect(server.requests).toHaveLength(requests + 1);
        expect(session.id).toBe(before!.threadId);
        after = (await session.goal())!;
        expect(after).toMatchObject({
          threadId: before!.threadId,
          objective: before!.objective,
          status,
          tokenBudget: before!.tokenBudget,
          createdAt: before!.createdAt,
        });
        expect(after.tokensUsed >= before!.tokensUsed).toBe(true);
        expect(after.timeUsedSeconds >= before!.timeUsedSeconds).toBe(true);
        expect(after.updatedAt >= before!.updatedAt).toBe(true);
        expect(await session.wait()).toBe(previous);
        expect(await first.wait()).toBe(firstResult);
        for await (const turn of session.turns()) recordedTurns.push(turn);
        for await (const item of session.items()) items.push(item);
        expect(recordedTurns.some((turn) => turn.usage?.totalTokens)).toBe(
          true,
        );
      } finally {
        await session.close();
        await observing;
      }
      expect(usageEvents).toContainEqual(
        expect.objectContaining({
          type: 'usage_updated',
          usage: expect.objectContaining({
            lastTokenUsage: expect.objectContaining({
              inputTokens: usage.input_tokens,
              outputTokens: usage.output_tokens,
              totalTokens: usage.total_tokens,
            }),
          }),
        }),
      );
      const requests = server.requests.length;
      const reopened = await worker(server, {
        profile: path,
        resume: session.id,
        effects,
        mode: 'inspect',
      });
      expect(reopened.code, reopened.stderr).toBe(0);
      expect(reopened.value.pid).not.toBe(process.pid);
      expect(reopened.value.id).toBe(session.id);
      expect(reopened.value.goal).toEqual(after);
      expect(reopened.value.recordedTurns).toEqual(recordedTurns);
      expect(reopened.value.items).toEqual(items);
      expect(server.requests).toHaveLength(requests);
      const denied = await worker(server, {
        profile: path,
        resume: session.id,
        mode: 'denied',
      });
      expect(denied.code, denied.stderr).toBe(0);
      expect(denied.value.denied).toBe(true);
      expect(server.requests).toHaveLength(requests);
      const continued = await worker(server, {
        profile: path,
        resume: session.id,
        effects,
        mode: 'continue',
      });
      expect(continued.code, continued.stderr).toBe(0);
      expect(continued.value.before).toEqual(after);
      expect(continued.value.goal.status).toBe(status);
      expect(server.requests).toHaveLength(requests + 1);
      expect(JSON.stringify(server.requests.at(-1))).toContain(
        'Summary: retained objective and accepted work.',
      );
      expect(calls).toBe(1);
      expect(await readFile(effects, 'utf8')).toBe('once\n');
      server.assertExhausted();
    },
    120_000,
  );

  it.each([false, true])(
    'keeps ordinary compaction and prior structured results without goal authority (local=%s)',
    async (local) => {
      const server = new ModelServer([
        [message('{"answer":7}')],
        [message('Summary: answer seven.')],
      ]);
      await using provider = await providerFor(server);
      await using session = await new Agent({
        instructions: 'Return the requested answer object.',
        model: 'gpt-5',
        provider,
        outputType: z.object({ answer: z.number() }),
      }).session(local ? { storage: localStorage(await profile()) } : {});
      const turn = await session.submit('Answer seven.');
      const result = await turn.wait();
      expect(result.finalOutput).toEqual({ answer: 7 });
      await session.compact();
      expect(await session.wait()).toBe(result);
      expect(await turn.wait()).toBe(result);
      expect(JSON.stringify(server.requests[0].tools)).not.toContain(
        'create_goal',
      );
      if (local)
        await expect(session.goal()).rejects.toThrow('current NativeGoals');
      server.assertExhausted();
    },
  );

  it.each(['interrupt', 'close'] as const)(
    'joins a held local compaction through %s without releasing the model first',
    async (stop) => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const drained = Promise.withResolvers<void>();
      let released = false;
      const server = new ModelServer(
        [
          [
            call(
              'create_goal',
              { objective: 'Keep the current owner' },
              { callId: 'create' },
            ),
          ],
          [message('created')],
          async () => {
            entered.resolve();
            try {
              await release.promise;
              return [message('held compaction summary')];
            } finally {
              drained.resolve();
            }
          },
        ],
        usage,
      );
      await using provider = await providerFor(server);
      const path = await profile();
      const agent = agentFor(provider);
      const session = await agent.session({ storage: localStorage(path) });
      let outcome: Promise<{ ok: boolean }> | undefined;
      try {
        await (await session.submit('Create an active goal.')).wait();
        outcome = session.compact().then(
          () => ({ ok: true }),
          () => ({ ok: false }),
        );
        await entered.promise;
        const competitor = await worker(server, {
          profile: path,
          resume: session.id,
          mode: 'inspect',
        });
        expect(competitor.code).not.toBe(0);
        expect(competitor.stderr).toMatch(/lock|writer|already|owned/i);
        await session[stop]();
        expect(released).toBe(false);
        expect((await outcome).ok).toBe(false);
        await session.close();
        const reopened = await worker(server, {
          profile: path,
          resume: session.id,
          mode: 'inspect',
        });
        expect(reopened.code, reopened.stderr).toBe(0);
        expect(reopened.value.goal).toMatchObject({
          threadId: session.id,
          objective: 'Keep the current owner',
        });
        expect(server.requests).toHaveLength(3);
      } finally {
        released = true;
        release.resolve();
        await session.close();
        await outcome;
        if (server.requests.length >= 3) await drained.promise;
      }
      server.assertExhausted();
    },
    90_000,
  );

  it('refuses callback compaction without consuming the live local callback', async () => {
    const server = new ModelServer([
      [call('lookup', {}, { callId: 'callback-compact' })],
      [message('callback completed')],
    ]);
    await using provider = await providerFor(server);
    let checked = false;
    const agent = new Agent({
      instructions: 'Use the current lookup.',
      model: 'gpt-5',
      provider,
      tools: [
        tool({
          name: 'lookup',
          parameters: z.object({}),
          execute: async () => {
            await expect(session.compact()).rejects.toThrow(
              'A tool callback cannot compact its own session',
            );
            checked = true;
            return 'accepted lookup';
          },
        }),
      ],
    });
    const session: Awaited<ReturnType<Agent['session']>> = await agent.session({
      storage: localStorage(await profile()),
    });
    try {
      expect(
        (await (await session.submit('Look up the current key.')).wait())
          .finalOutput,
      ).toBe('callback completed');
      expect(checked).toBe(true);
      server.assertExhausted();
    } finally {
      await session.close();
    }
  });

  it('reports a compaction provider failure without replacing native goal state', async () => {
    const server = new ModelServer(
      [
        [
          call(
            'create_goal',
            { objective: 'Retain native accounting', token_budget: 4000 },
            { callId: 'create' },
          ),
        ],
        [message('created')],
        { status: 400, body: 'synthetic compaction request rejected' },
      ],
      usage,
    );
    await using provider = await providerFor(server);
    // Exercise terminal provider failure without Core retry backoff.
    const acquire = provider._acquire.bind(provider);
    vi.spyOn(provider, '_acquire').mockImplementationOnce(() => {
      const lease = acquire();
      lease.config['model_providers.native_agent.request_max_retries'] = 0;
      lease.config['model_providers.native_agent.stream_max_retries'] = 0;
      return lease;
    });
    await using session = await agentFor(provider).session({
      storage: localStorage(await profile()),
    });
    const previous = await (
      await session.submit('Create the current goal.')
    ).wait();
    const before = (await session.goal())!;
    await expect(session.compact()).rejects.toThrow();
    const after = (await session.goal())!;
    expect(after).toMatchObject({
      threadId: before.threadId,
      objective: before.objective,
      tokenBudget: before.tokenBudget,
      createdAt: before.createdAt,
    });
    expect(after.tokensUsed >= before.tokensUsed).toBe(true);
    expect(after.timeUsedSeconds >= before.timeUsedSeconds).toBe(true);
    expect(await session.wait()).toBe(previous);
    server.assertExhausted();
  });

  it('preserves a native i64 budget across the actual JSON bridge', async () => {
    const server = new ModelServer(
      [
        [
          call(
            'create_goal',
            '{"objective":"Exact native budget","token_budget":9223372036854775807}',
            { callId: 'exact' },
          ),
        ],
        [message('exact')],
      ],
      usage,
    );
    await using provider = await providerFor(server);
    await using session = await agentFor(provider).session({
      storage: localStorage(await profile()),
    });
    await (await session.submit('Create the exact requested budget.')).wait();
    expect((await session.goal())!.tokenBudget).toBe(9223372036854775807n);
  });

  it('discards a cancelled late goal update and preserves the successor goal', async () => {
    let reached!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = new ModelServer(
      [
        [
          call(
            'create_goal',
            { objective: 'Keep current ownership' },
            { callId: 'create' },
          ),
        ],
        [message('active')],
        async () => {
          reached();
          await held;
          return [
            call(
              'update_goal',
              { status: 'complete' },
              { callId: 'retired-complete' },
            ),
          ];
        },
        [
          call(
            'update_goal',
            { status: 'paused' },
            { callId: 'current-pause' },
          ),
        ],
        [message('paused')],
      ],
      usage,
    );
    await using provider = await providerFor(server);
    await using session = await agentFor(provider).session({
      storage: localStorage(await profile()),
    });
    try {
      await (await session.submit('Create an active goal.')).wait();
      const old = await session.submit('This old update will be cancelled.');
      await entered;
      const reader = vi.spyOn(
        (await binding()).NativeThread.prototype,
        '_read_goal',
      );
      let before;
      let active: NativeThread;
      try {
        before = await session.goal();
        active = reader.mock.contexts[0] as NativeThread;
      } finally {
        reader.mockRestore();
      }
      await expect(session.setPausedGoal('Busy update')).rejects.toThrow(
        'settled open session',
      );
      await expect(
        active._set_paused_goal('Busy native update'),
      ).rejects.toThrow('idle, open native thread');
      expect(await session.goal()).toEqual(before);
      const cancelled = session.interrupt();
      release();
      await cancelled;
      await expect(old.wait()).rejects.toThrow();
      // interrupt acknowledges the stop; the next idle roster update waits for its cleanup.
      await vi.waitFor(() => session.update({ tools: [] }), {
        timeout: 10_000,
      });
      expect((await session.goal())!.status).toBe('active');
      await (await session.submit('Pause the current goal.')).wait();
      expect((await session.goal())!.status).toBe('paused');
    } finally {
      release();
    }
  });

  it('keeps an ordinary managed get_goal valid without native goal authority', async () => {
    const server = new ModelServer(
      [
        [call('get_goal', {}, { callId: 'ordinary' })],
        [message('ordinary done')],
      ],
      usage,
    );
    await using provider = await providerFor(server);
    let effects = 0;
    const agent = new Agent({
      instructions: 'Use the current application callback.',
      provider,
      tools: [
        tool({
          name: 'get_goal',
          parameters: z.object({}),
          execute: () => {
            effects++;
            return 'ordinary result';
          },
        }),
      ],
    });
    await using session = await agent.session({
      storage: localStorage(await profile()),
    });
    await (await session.submit('Read the ordinary record.')).wait();
    expect(effects).toBe(1);
    await expect(session.goal()).rejects.toThrow('current NativeGoals');
    expect(JSON.stringify(server.requests[1].input)).toContain(
      'ordinary result',
    );
  });

  it.each([
    'missing ceiling',
    'incomplete fixed grant',
    'wrong namespace',
    'unrelated native',
    'missing backend',
    'missing current feature',
    'excluded managed',
    'managed collision',
    'mismatched stores',
  ])('preserves the native local policy boundary: %s', async (scenario) => {
    const server = new ModelServer([]);
    const path = await profile();
    const home = join(path, '..');
    const native = await binding();
    const fixed = ['create_goal', 'get_goal', 'update_goal'].map((name) => ({
      namespace: 'functions',
      name,
    }));
    const allowed =
      scenario === 'missing ceiling'
        ? undefined
        : scenario === 'incomplete fixed grant'
          ? fixed.slice(0, 2)
          : scenario === 'wrong namespace'
            ? [...fixed, { namespace: 'other', name: 'get_goal' }]
            : scenario === 'unrelated native'
              ? [...fixed, { namespace: 'functions', name: 'exec_command' }]
              : fixed;
    const managed =
      scenario === 'excluded managed'
        ? 'lookup'
        : scenario === 'managed collision'
          ? 'get_goal'
          : null;
    const specs = captureTools(
      managed
        ? [
            tool({
              name: managed,
              parameters: z.object({}),
              execute: () => 'must not execute',
            }),
          ]
        : [],
    );
    const config = {
      ...(await server.config()),
      'features.goals': scenario !== 'missing current feature',
      'features.apps': false,
      'features.plugins': false,
      'features.tool_registry.error_on_tool_collisions': true,
      'tools.update_plan.enabled': false,
      'agents.enabled': false,
      web_search: 'disabled',
      mcp_servers: {},
    };
    const runtime = {
      ...native._packaged_runtime(),
      codex_home: home,
      cwd: home,
      native_thread_store: path,
      ephemeral: false,
      ...(scenario === 'missing backend'
        ? {}
        : {
            native_goal_store:
              scenario === 'mismatched stores' ? path + '-other' : path,
          }),
      strict_config: true,
      loader: { ignore_user_config: true, ignore_project_config: true },
    };
    let engine: Awaited<ReturnType<typeof native.create_engine>> | undefined;
    try {
      if (scenario === 'mismatched stores') {
        await expect(
          native.create_engine(
            JSON.stringify(config),
            JSON.stringify(runtime),
            null,
          ),
        ).rejects.toThrow(
          'native goal and thread storage directories must agree',
        );
      } else {
        engine = await native.create_engine(
          JSON.stringify(config),
          JSON.stringify(runtime),
          null,
        );
        const expected =
          scenario === 'missing ceiling'
            ? 'explicit managed ToolPolicy ceiling'
            : scenario === 'missing backend'
              ? 'local goals require the current goal store'
              : scenario === 'excluded managed'
                ? 'JavaScript tool is excluded by ToolPolicy'
                : scenario === 'managed collision'
                  ? 'JavaScript tool collides with fixed tool'
                  : 'local storage ToolPolicy may only allow admitted managed tools';
        await expect(
          engine.start_replaceable_thread(
            JSON.stringify({
              instructions: 'Use current native authority.',
              _managed_instructions: true,
              tool_policy: { allowed_tools: allowed },
            }),
            specs.specsJson,
          ),
        ).rejects.toThrow(expected);
      }
    } finally {
      await engine?.close();
    }
    expect(server.requests).toHaveLength(0);
  });

  it('does not replay an unknown effect because an active goal exists', async () => {
    const server = new ModelServer(
      [
        [
          call(
            'create_goal',
            { objective: 'Process this request' },
            { callId: 'goal' },
          ),
        ],
        [call('effect', {}, { callId: 'unknown' })],
      ],
      usage,
    );
    const path = await profile();
    const effects = path + '-effects';
    const crashed = await worker(server, {
      profile: path,
      mode: 'unknown',
      effects,
    });
    expect(crashed.code, crashed.stderr).toBe(67);
    // The ID is recoverable from the native profile without an application receipt;
    // the worker reports it before starting any potentially crashing work.
    const id = crashed.value.id;
    for (let attempt = 0; attempt < 2; attempt++) {
      const refused = await worker(server, {
        profile: path,
        resume: id,
        mode: 'recover',
        effects,
      });
      expect(refused.code).not.toBe(0);
      expect(refused.stderr).toMatch(
        /LocalRecoveryRequired:.*unknown tool effects/,
      );
    }
    expect(await readFile(effects, 'utf8')).toBe('once\n');
    expect(server.requests).toHaveLength(2);
  }, 120_000);
});
