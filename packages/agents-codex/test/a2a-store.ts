// Test host: a single stopped-worker JSON file, never a production storage engine.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import {
  Task,
  TaskState,
  type ListTasksRequest,
  type ListTasksResponse,
} from '@a2a-js/sdk';
import type { ServerCallContext } from '@a2a-js/sdk/server';
import type {
  NativeA2ABinding,
  NativeA2AClaim,
  NativeA2AStore,
  NativeA2ATask,
} from '../src/a2a/executor';

interface Row {
  record?: NativeA2ATask;
  public?: unknown;
  acknowledged: number;
  owner: number;
}
function canonical(task: Task): string {
  return JSON.stringify(Task.toJSON(task));
}

export class FileA2AStore implements NativeA2AStore {
  readonly #rows = new Map<string, Row>();
  readonly #waiters = new Map<string, () => void>();
  fail: 'before-save' | 'after-save' | undefined;
  constructor(readonly path?: string) {
    if (path && existsSync(path))
      for (const [key, row] of JSON.parse(readFileSync(path, 'utf8'))) {
        if (row.record) row.record.desired = Task.fromJSON(row.record.desired);
        this.#rows.set(key, row);
      }
  }
  #key(taskId: string, context: ServerCallContext): string {
    if (!context.user?.isAuthenticated) throw new Error('unauthorized');
    return JSON.stringify([
      context.tenant ?? '',
      context.user.userName,
      taskId,
    ]);
  }
  #persist() {
    if (!this.path) return;
    writeFileSync(
      `${this.path}.next`,
      JSON.stringify(
        [...this.#rows].map(([key, row]) => [
          key,
          {
            ...row,
            ...(row.record
              ? {
                  record: {
                    ...row.record,
                    desired: Task.toJSON(row.record.desired),
                  },
                }
              : {}),
          },
        ]),
      ),
    );
    renameSync(`${this.path}.next`, this.path);
  }
  async own<T>(
    binding: NativeA2ABinding,
    run: (claim: NativeA2AClaim) => Promise<T>,
  ): Promise<T> {
    const key = JSON.stringify([
      binding.tenant,
      binding.principal,
      binding.taskId,
    ]);
    const row = this.#rows.get(key) ?? { acknowledged: 0, owner: 0 };
    const owner = ++row.owner;
    this.#rows.set(key, row);
    this.#persist();
    const current = async () => {
      if (this.#rows.get(key)?.owner !== owner) throw new Error('stale owner');
    };
    try {
      return await run({
        current,
        load: async () => {
          await current();
          return structuredClone(row.record);
        },
        commit: async (expected, record) => {
          await current();
          if (
            row.record?.generation !== expected ||
            record.generation !== (expected ?? 0) + 1 ||
            JSON.stringify(record.binding) !== JSON.stringify(binding)
          )
            throw new Error('CAS');
          row.record = structuredClone(record);
          this.#persist();
        },
        published: async (revision) => {
          await current();
          if (row.acknowledged === revision) return;
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              this.#waiters.delete(key);
              reject(new Error('publication unavailable'));
            }, 500);
            this.#waiters.set(key, () => {
              clearTimeout(timer);
              resolve();
            });
          });
          await current();
          if (row.acknowledged !== revision)
            throw new Error('wrong acknowledgment');
        },
      });
    } finally {
      if (row.owner === owner) {
        row.owner++;
        this.#persist();
      }
    }
  }
  async save(task: Task, context: ServerCallContext): Promise<void> {
    const key = this.#key(task.id, context),
      row = this.#rows.get(key);
    if (!row?.record) throw new Error('no desired snapshot');
    const desired = row.record.desired;
    const exact = canonical(task) === canonical(desired);
    const old = row.public ? Task.fromJSON(row.public) : undefined;
    const historyOnly =
      old &&
      old.status?.state === TaskState.TASK_STATE_INPUT_REQUIRED &&
      canonical({ ...task, history: old.history }) === canonical(old) &&
      task.history.length === old.history.length + 1 &&
      task.history
        .slice(0, -1)
        .every(
          (message, index) =>
            JSON.stringify(message) === JSON.stringify(old.history[index]),
        );
    const canceled =
      row.record.state === 'waiting' &&
      task.status?.state === TaskState.TASK_STATE_CANCELED &&
      task.contextId === desired.contextId;
    if (!exact && !historyOnly && !canceled) throw new Error('stale snapshot');
    if (this.fail === 'before-save') {
      this.fail = undefined;
      throw new Error('lost save');
    }
    row.public = Task.toJSON(task);
    if (canceled)
      row.record = {
        ...row.record,
        generation: row.record.generation + 1,
        publicationRevision: row.record.publicationRevision + 1,
        state: 'canceled',
        desired: structuredClone(task),
        checkpoint: undefined,
        pending: undefined,
      };
    this.#persist();
    if (this.fail === 'after-save') {
      this.fail = undefined;
      throw new Error('lost ack');
    }
    if (exact || canceled) {
      row.acknowledged = row.record.publicationRevision;
      this.#persist();
      this.#waiters.get(key)?.();
      this.#waiters.delete(key);
    }
  }
  async load(
    taskId: string,
    context: ServerCallContext,
  ): Promise<Task | undefined> {
    const value = this.#rows.get(this.#key(taskId, context))?.public;
    return value ? Task.fromJSON(value) : undefined;
  }
  async list(
    _request: ListTasksRequest,
    context: ServerCallContext,
  ): Promise<ListTasksResponse> {
    const prefix = JSON.stringify([
      context.tenant ?? '',
      context.user?.userName,
    ]).slice(0, -1);
    const tasks = [...this.#rows]
      .filter(([key]) => key.startsWith(prefix))
      .flatMap(([, row]) => (row.public ? [Task.fromJSON(row.public)] : []));
    return {
      tasks,
      totalSize: tasks.length,
      pageSize: tasks.length,
      nextPageToken: '',
    };
  }
  record(taskId: string, context: ServerCallContext) {
    return structuredClone(this.#rows.get(this.#key(taskId, context))?.record);
  }
}
