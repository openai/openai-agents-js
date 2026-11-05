import { Task, TaskState } from '@a2a-js/sdk';
import { InMemoryTaskStore, type ServerCallContext } from '@a2a-js/sdk/server';
import type {
  NativeA2ABinding,
  NativeA2AClaim,
  NativeA2AStore,
  NativeA2ATask,
} from '@openai/agents/a2a';

/** Single-process demonstration only. Production hosts supply durable fenced storage. */
export class ExampleA2AStore
  extends InMemoryTaskStore
  implements NativeA2AStore
{
  readonly #records = new Map<string, NativeA2ATask>();
  readonly #owners = new Map<string, symbol>();
  readonly #published = new Map<string, number>();
  readonly #waiters = new Map<string, () => void>();
  #key(scope: NativeA2ABinding): string {
    return JSON.stringify([scope.tenant, scope.principal, scope.taskId]);
  }
  async own<T>(
    scope: NativeA2ABinding,
    run: (claim: NativeA2AClaim) => Promise<T>,
  ): Promise<T> {
    const key = this.#key(scope);
    if (this.#owners.has(key)) throw new Error('Task already has an owner');
    const owner = Symbol('task owner');
    this.#owners.set(key, owner);
    const current = async () => {
      if (this.#owners.get(key) !== owner) throw new Error('Task owner ended');
    };
    try {
      return await run({
        current,
        load: async () => {
          await current();
          return structuredClone(this.#records.get(key));
        },
        commit: async (expected, record) => {
          await current();
          if (this.#records.get(key)?.generation !== expected)
            throw new Error('Stale generation');
          this.#records.set(key, structuredClone(record));
        },
        published: async (revision) => {
          if (this.#published.get(key) === revision) return;
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              this.#waiters.delete(key);
              reject(new Error('Publication did not complete'));
            }, 5000);
            this.#waiters.set(key, () => {
              clearTimeout(timer);
              resolve();
            });
          });
          await current();
          if (this.#published.get(key) !== revision)
            throw new Error('Stale publication');
        },
      });
    } finally {
      this.#owners.delete(key);
    }
  }
  override async save(task: Task, context: ServerCallContext): Promise<void> {
    if (!context.user?.isAuthenticated)
      throw new Error('Authentication required');
    const key = this.#key({
      tenant: context.tenant ?? '',
      principal: context.user.userName,
      taskId: task.id,
      contextId: task.contextId,
    });
    let record = this.#records.get(key);
    if (!record) throw new Error('No private task record');
    const canonical = (value: Task) => JSON.stringify(Task.toJSON(value));
    const exact = canonical(task) === canonical(record.desired);
    const old = await super.load(task.id, context);
    const appended =
      old &&
      record.state === 'waiting' &&
      task.history.length === old.history.length + 1 &&
      canonical({ ...task, history: old.history }) === canonical(old) &&
      JSON.stringify(task.history.slice(0, -1)) === JSON.stringify(old.history);
    const canceled =
      record.state === 'waiting' &&
      task.contextId === record.binding.contextId &&
      task.status?.state === TaskState.TASK_STATE_CANCELED;
    if (!exact && !appended && !canceled) throw new Error('Stale publication');
    if (canceled) {
      record = {
        ...record,
        state: 'canceled',
        generation: record.generation + 1,
        publicationRevision: record.publicationRevision + 1,
        desired: structuredClone(task),
        checkpoint: undefined,
        pending: undefined,
      };
      this.#records.set(key, record);
    }
    await super.save(task, context);
    if (exact || canceled) {
      this.#published.set(key, record.publicationRevision);
      this.#waiters.get(key)?.();
      this.#waiters.delete(key);
    }
  }
}
