import { type ChildProcess, fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  checklist,
  localStorage,
  tool,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

const homes: string[] = [];
type ChecklistWorker = {
  child?: ChildProcess;
  stopping: boolean;
  done: Promise<void>;
};
const workers = new Set<ChecklistWorker>();
async function stopWorker(owner: ChecklistWorker) {
  owner.stopping = true;
  const child = owner.child;
  if (
    child?.pid !== undefined &&
    child.exitCode === null &&
    child.signalCode === null
  )
    child.kill('SIGKILL');
  await owner.done;
}
afterEach(async () => {
  // Join direct children and helper cleanup before closing their server/profile.
  // The qualification runner still owns the outer process-group drain.
  await Promise.all([...workers].map(stopWorker));
  await ModelServer.closeAll();
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});
async function profile() {
  const home = await mkdtemp(join(tmpdir(), 'local-checklist-'));
  homes.push(home);
  return join(home, 'profile');
}
async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-local-checklist',
    supportsWebsockets: false,
  });
}
const update = (
  plan: { step: string; status: string }[],
  id: string,
  explanation?: string,
) =>
  call(
    'update_plan',
    { plan, ...(explanation === undefined ? {} : { explanation }) },
    { callId: id },
  );

it('persists accepted local whole lists, rejects invalid updates and distinguishes an accepted empty list', async () => {
  const plan = [
    { step: 'Inspect', status: 'in_progress' },
    { step: 'Report', status: 'pending' },
  ];
  const server = new ModelServer([
    [update(plan, 'first', 'phase')],
    [message('saved')],
    [update([{ step: 'bad', status: 'done' }], 'invalid')],
    [message('unchanged')],
    [update([], 'empty', '')],
    [message('empty')],
  ]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    instructions: 'Maintain the checklist.',
    provider,
    model: 'gpt-5.1-codex',
    tools: [checklist()],
  });
  await using session = await agent.session({
    storage: localStorage(await profile()),
  });
  expect(await session.checklist()).toBeNull();
  expect(server.requests).toHaveLength(0);
  await expect(session.checklist({ subagentId: randomUUID() })).rejects.toThrow(
    'current root',
  );
  await (await session.submit('Update the list.')).wait();
  const saved = await session.checklist();
  expect(saved).toMatchObject({
    threadId: session.id,
    plan,
    explanation: 'phase',
  });
  expect(saved!.turnId).toBeTruthy();
  await (await session.submit('Try the invalid update.')).wait();
  expect(await session.checklist()).toEqual(saved);
  await session.update({ tools: [] });
  await (await session.submit('Clear the whole list.')).wait();
  expect(await session.checklist()).toMatchObject({
    threadId: session.id,
    plan: [],
    explanation: '',
  });
  const requests = server.requests.length;
  await session.checklist();
  expect(server.requests).toHaveLength(requests);
  server.assertExhausted();
});

function worker(server: ModelServer, config: Record<string, unknown>) {
  const owner: ChecklistWorker = { stopping: false, done: Promise.resolve() };
  workers.add(owner);
  async function run() {
    await using provider = await providerFor(server);
    if (owner.stopping) throw new Error('Checklist worker stopped before fork');
    const env = { ...process.env };
    delete env.OPENAI_API_KEY;
    const child = fork(
      fileURLToPath(
        new URL('./fixtures/local-checklist-worker.ts', import.meta.url),
      ),
      [JSON.stringify({ ...config, url: provider.baseUrl })],
      {
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env,
      },
    );
    owner.child = child;
    const errors: Error[] = [];
    const retainError = (error: Error) => {
      errors.push(error);
    };
    // A failed spawn may emit error and close without ever emitting exit.
    child.on('error', retainError);
    let stdout = '';
    let stderr = '';
    let value: any;
    child.stdout?.on('data', (data) => {
      stdout += String(data);
    });
    child.stderr?.on('data', (data) => {
      stderr += String(data);
    });
    child.stdout?.on('error', retainError);
    child.stderr?.on('error', retainError);
    child.on('message', (message) => {
      value = message;
    });
    let didClose = false;
    const closed = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      child.once('close', (code, signal) => {
        didClose = true;
        resolve({ code, signal });
      });
    });
    const timer = setTimeout(() => {
      errors.push(
        new Error('Checklist worker exceeded its 30 second close deadline'),
      );
      child.kill('SIGKILL');
    }, 30_000);
    try {
      const result = await closed;
      const diagnostic = `stdout:\n${stdout}\nstderr:\n${stderr}`;
      if (errors.length)
        throw new AggregateError(
          errors,
          `Checklist worker failed after close:\n${diagnostic}`,
        );
      return { ...result, stdout, stderr, diagnostic, value };
    } finally {
      clearTimeout(timer);
      if (!didClose) child.kill('SIGKILL');
      await closed;
    }
  }
  const result = run().finally(() => {
    workers.delete(owner);
  });
  // Includes run's async provider disposal. Retain result's original rejection
  // for its caller while ensuring teardown can always join the operation.
  owner.done = result.then(
    () => {},
    () => {},
  );
  return result;
}

it('reopens in fresh processes with identical native checklist data but no inherited update grant or passive model work', async () => {
  const plan = [{ step: 'Retain order', status: 'completed' }];
  const server = new ModelServer([
    [update(plan, 'persist')],
    [message('saved')],
    [message('continued without native planning')],
  ]);
  const path = await profile();
  const created = await worker(server, {
    profile: path,
    grant: true,
    mode: 'create',
  });
  expect(created.code, created.diagnostic).toBe(0);
  expect(created.value.before).toBeNull();
  expect(created.value.checklist.plan).toEqual(plan);
  expect(server.requests).toHaveLength(2);
  const read = await worker(server, {
    profile: path,
    resume: created.value.id,
    grant: false,
    mode: 'inspect',
  });
  expect(read.code, read.diagnostic).toBe(0);
  expect(read.value.pid).not.toBe(created.value.pid);
  expect(read.value.id).toBe(created.value.id);
  expect(read.value.checklist).toEqual(created.value.checklist);
  expect(read.value.historyBefore).toEqual(read.value.historyAfter);
  expect(server.requests).toHaveLength(2);
  const continued = await worker(server, {
    profile: path,
    resume: created.value.id,
    grant: false,
    mode: 'continue',
  });
  expect(continued.code, continued.diagnostic).toBe(0);
  expect(continued.value.checklist).toEqual(created.value.checklist);
  expect(server.requests).toHaveLength(3);
  expect(JSON.stringify(server.requests.at(-1)!.tools)).not.toContain(
    'update_plan',
  );
  server.assertExhausted();
}, 120_000);

it('does not turn a same-named managed callback output into accepted checklist data', async () => {
  let effects = 0;
  const server = new ModelServer([
    [call('update_plan', {}, { callId: 'managed' })],
    [message('managed')],
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Call the managed function.',
    provider,
    model: 'gpt-5.1-codex',
    tools: [
      tool({
        name: 'update_plan',
        parameters: z.object({}),
        execute: () => {
          effects++;
          return {
            plan: [{ step: 'Untrusted callback', status: 'completed' }],
          };
        },
      }),
    ],
  }).session({ storage: localStorage(await profile()) });
  await (await session.submit('Call the managed function.')).wait();
  expect(effects).toBe(1);
  expect(await session.checklist()).toBeNull();
  server.assertExhausted();
});

it('refuses a managed collision with the current fixed native checklist grant', async () => {
  const server = new ModelServer([]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    instructions: 'Keep fixed and managed ownership distinct.',
    provider,
    model: 'gpt-5.1-codex',
    tools: [
      checklist(),
      tool({
        name: 'update_plan',
        parameters: z.object({}),
        execute: () => 'managed',
      }),
    ],
  });
  await expect(
    agent.session({ storage: localStorage(await profile()) }),
  ).rejects.toThrow('Checklist reserves the tool name update_plan');
  expect(server.requests).toHaveLength(0);
  server.assertExhausted();
});

it('does not publish a queued local native snapshot after Session close starts', async () => {
  const server = new ModelServer([]);
  await using provider = await providerFor(server);
  const session = await new Agent({
    instructions: 'Read only.',
    provider,
    model: 'gpt-5.1-codex',
    tools: [checklist()],
  }).session({ storage: localStorage(await profile()) });
  const reading = session.checklist();
  const rejected = expect(reading).rejects.toThrow(/open|closed|closing/i);
  try {
    await session.close();
    await rejected;
    expect(server.requests).toHaveLength(0);
    server.assertExhausted();
  } finally {
    await session.close();
  }
});
