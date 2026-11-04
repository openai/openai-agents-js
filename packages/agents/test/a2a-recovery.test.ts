import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { Task, TaskState } from '@a2a-js/sdk';
import {
  DefaultExecutionEventBus,
  RequestContext,
  ServerCallContext,
} from '@a2a-js/sdk/server';
import {
  NativeA2AExecutor,
  a2aInput,
  type NativeA2ATask,
} from '../src/a2a/executor';
import { Part, Message, Role } from '@a2a-js/sdk';
import { FileA2AStore } from './a2a-store';

const context = new ServerCallContext({
  user: { isAuthenticated: true, userName: 'user' },
  requestedVersion: '1.0',
});
const binding = {
  tenant: '',
  principal: 'user',
  taskId: 'task',
  contextId: 'conversation',
};
const task = (): Task => ({
  ...Task.fromJSON({}),
  id: binding.taskId,
  contextId: binding.contextId,
  status: {
    state: TaskState.TASK_STATE_COMPLETED,
    message: undefined,
    timestamp: undefined,
  },
  artifacts: [
    {
      artifactId: 'result',
      name: '',
      description: '',
      extensions: [],
      metadata: undefined,
      parts: [Part.fromJSON({ text: 'once' })],
    },
  ],
});

it.each(['before-save', 'after-save'] as const)(
  'recovers retained exact snapshots in a fresh process after %s without execution',
  async (fault) => {
    const directory = await mkdtemp(join(tmpdir(), 'a2a-recovery-'));
    try {
      const file = join(directory, 'journal.json'),
        store = new FileA2AStore(file);
      const desired = task();
      await store.own(binding, (claim) =>
        claim.commit(undefined, {
          schemaVersion: 1,
          binding,
          generation: 1,
          publicationRevision: 1,
          state: 'completed',
          desired,
        }),
      );
      store.fail = fault;
      await expect(store.save(desired, context)).rejects.toThrow();
      expect(store.record('task', context)?.state).toBe('completed');
      const child = () =>
        spawnSync(
          process.execPath,
          [
            '--import',
            'tsx',
            fileURLToPath(
              new URL('./fixtures/a2a-recover.ts', import.meta.url),
            ),
            file,
            'task',
            'conversation',
          ],
          { encoding: 'utf8', timeout: 20_000 },
        );
      const recovered = child();
      expect(recovered.status, recovered.stderr).toBe(0);
      const result = JSON.parse(recovered.stdout.trim());
      expect(result.executions).toBe(0);
      expect(result.task).toEqual(Task.toJSON(desired));
      const again = child();
      expect(again.status, again.stderr).toBe(0);
      expect(JSON.parse(again.stdout.trim()).task.artifacts).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it('fences stale saves and stale owner claims across awaits', async () => {
  const store = new FileA2AStore(),
    desired = task();
  await store.own(binding, async (old) => {
    await old.commit(undefined, {
      schemaVersion: 1,
      binding,
      generation: 1,
      publicationRevision: 1,
      state: 'completed',
      desired,
    });
    await store.own(binding, async (current) => {
      await current.commit(1, {
        schemaVersion: 1,
        binding,
        generation: 2,
        publicationRevision: 2,
        state: 'completed',
        desired: { ...desired, artifacts: [] },
      });
    });
    await expect(old.current()).rejects.toThrow('stale');
    await expect(store.save(desired, context)).rejects.toThrow('stale');
  });
});

it.each(['running', 'claimed'] as const)(
  'records crashed %s execution as unknown without replay',
  async (state) => {
    const store = new FileA2AStore(),
      desired = task();
    await store.own(binding, (claim) =>
      claim.commit(undefined, {
        schemaVersion: 1,
        binding,
        generation: 1,
        publicationRevision: 1,
        state,
        desired,
      }),
    );
    const executor = new NativeA2AExecutor({
      store,
      agentFactory: async () => {
        throw new Error('must not execute');
      },
    });
    await executor.recover(binding, context);
    expect(store.record('task', context)?.state).toBe('unknown');
    expect((await store.load('task', context))?.metadata).toEqual({
      'agents.a2a.outcome': 'unknown',
    });
  },
);

it('rejects unauthorized recovery and unsupported remote file/URI parts before factory admission', async () => {
  const store = new FileA2AStore();
  let factories = 0;
  const executor = new NativeA2AExecutor({
    store,
    agentFactory: async () => {
      factories++;
      throw new Error('unexpected');
    },
  });
  await expect(
    executor.recover(binding, new ServerCallContext()),
  ).rejects.toThrow('authorization');
  for (const part of [
    Part.fromJSON({ url: 'file:///private.txt' }),
    Part.fromJSON({ raw: 'eA==', mediaType: 'text/plain' }),
  ]) {
    const message = {
      ...Message.fromJSON({}),
      role: Role.ROLE_USER,
      parts: [part],
    };
    const request = new RequestContext(
      { message, tenant: '', metadata: undefined, configuration: undefined },
      'task',
      'conversation',
      context,
    );
    await expect(
      executor.execute(request, new DefaultExecutionEventBus()),
    ).rejects.toThrow('unsupported');
  }
  expect(factories).toBe(0);
  expect(
    a2aInput([
      Part.fromJSON({ text: 'hello' }),
      Part.fromJSON({ raw: 'eA==', mediaType: 'image/png' }),
    ]),
  ).toMatchObject({
    role: 'user',
    content: [{ type: 'input_text' }, { type: 'input_image' }],
  });
});

it('isolates public/private task reads by the current principal and retires a waiting checkpoint on official cancel save', async () => {
  const store = new FileA2AStore(),
    desired = task();
  desired.status!.state = TaskState.TASK_STATE_INPUT_REQUIRED;
  const waiting: NativeA2ATask = {
    schemaVersion: 1,
    binding,
    generation: 1,
    publicationRevision: 1,
    state: 'waiting',
    desired,
  };
  await store.own(binding, (claim) => claim.commit(undefined, waiting));
  await store.save(desired, context);
  expect(
    await store.load(
      'task',
      new ServerCallContext({
        user: { isAuthenticated: true, userName: 'other' },
      }),
    ),
  ).toBeUndefined();
  const canceled = structuredClone(desired);
  canceled.status!.state = TaskState.TASK_STATE_CANCELED;
  await store.save(canceled, context);
  expect(store.record('task', context)?.state).toBe('canceled');
  expect(store.record('task', context)?.checkpoint).toBeUndefined();
});
