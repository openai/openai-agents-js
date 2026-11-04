import { createHash, randomUUID } from 'node:crypto';
import { Message, Part, Role, Task, TaskState } from '@a2a-js/sdk';
import {
  AgentEvent,
  InMemoryTaskStore,
  ResultManager,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
  type ServerCallContext,
  type TaskStore,
} from '@a2a-js/sdk/server';
import { type Agent, type Session } from '../runtime/public-agent';
import {
  manualResultSchema,
  validateManualResult,
  type ManualTool,
} from '../runtime/manual';
import { isManualSessionState, type SessionState } from '../runtime/state';
import { a2aInput } from './content';
export { a2aInput } from './content';
import { canonicalDeferredInput } from '../experimental/deferred-codec';
import { A2AError, bound, checkBytes, type A2ALimits } from './client';
import type { A2AInputReply } from './provider';
import type {
  TraceContext,
  TraceContextHeaders,
} from '../runtime/trace-context';

/** Trusted scope derived from authenticated transport context, never message metadata. */
export interface NativeA2ABinding {
  readonly tenant: string;
  readonly principal: string;
  readonly taskId: string;
  readonly contextId: string;
}

export interface NativeA2ATask {
  readonly schemaVersion: 1;
  readonly binding: NativeA2ABinding;
  readonly generation: number;
  readonly publicationRevision: number;
  readonly state:
    | 'running'
    | 'waiting'
    | 'claimed'
    | 'completed'
    | 'failed'
    | 'canceled'
    | 'unknown';
  readonly desired: Task;
  readonly checkpoint?: SessionState;
  readonly pending?: {
    readonly name: string;
    readonly callId: string;
    readonly declaration: string;
    readonly challenge: string;
  };
}

/** An unforgeable host lease. Every operation rechecks ownership and principal. */
export interface NativeA2AClaim {
  current(): Promise<void>;
  load(): Promise<NativeA2ATask | undefined>;
  /** Atomic compare-and-swap of private state AND matching desired public snapshot. */
  commit(
    expectedGeneration: number | undefined,
    record: NativeA2ATask,
  ): Promise<void>;
  /** Join the exact revision's durable official save acknowledgment, or fail on publication loss. */
  published(revision: number): Promise<void>;
}

/**
 * One host-owned official TaskStore and private native journal.
 *
 * own must fence across processes and check the current principal. save must
 * reject stale/noncanonical snapshots and acknowledge publicationRevision only
 * AFTER the exact desired snapshot is durable. Never acknowledge intermediate
 * saves. Keep the desired snapshot after uncertain acknowledgment. Official JS
 * has no CAS argument: the host must enforce the fence in its database.
 *
 * When the official handler directly saves cancellation without a local bus,
 * save must atomically retire a waiting checkpoint, or reject live work until
 * its execution owner has joined cancellation. TaskStore load/list must enforce
 * the same current principal for Get/List/Subscribe/Cancel/follow-up.
 * The official handler appends inbound follow-up history before execute: allow
 * that authenticated history-only save without acknowledging a publication.
 */
export interface NativeA2AStore extends TaskStore {
  own<T>(
    binding: NativeA2ABinding,
    run: (claim: NativeA2AClaim) => Promise<T>,
  ): Promise<T>;
}

export interface NativeA2AExecutorOptions<Context, Output> {
  readonly store: NativeA2AStore;
  /** Return CURRENT trusted configuration/context. Saved state never supplies these. */
  agentFactory(
    binding: NativeA2ABinding,
    callContext: ServerCallContext,
  ): Promise<{
    agent: Agent<Context, Output>;
    context: Context;
    parentTrace?: TraceContext | TraceContextHeaders | null;
  }>;
  readonly limits?: A2ALimits;
}

function binding(
  context: ServerCallContext,
  taskId: string,
  contextId: string,
): NativeA2ABinding {
  if (
    !context.user?.isAuthenticated ||
    !context.user.userName ||
    !taskId ||
    !contextId
  )
    throw new A2AError('authorization');
  return Object.freeze({
    tenant: context.tenant ?? '',
    principal: context.user.userName,
    taskId,
    contextId,
  });
}

function declaration(tool: ManualTool): string {
  return createHash('sha256')
    .update(
      canonicalDeferredInput([
        tool.name,
        tool.parameters,
        manualResultSchema(tool),
      ]),
    )
    .digest('hex');
}

/** Native Sessions remain the sole model/tool execution and cancellation owner. */
export class NativeA2AExecutor<
  Context = undefined,
  Output = string,
> implements AgentExecutor {
  readonly #options: NativeA2AExecutorOptions<Context, Output>;
  readonly #active = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  readonly #waiting = new Map<string, NativeA2ABinding>();
  constructor(options: NativeA2AExecutorOptions<Context, Output>) {
    this.#options = options;
  }

  async #snapshot(context: RequestContext, desired: Task): Promise<Task> {
    const temporary = new InMemoryTaskStore();
    if (context.task) await temporary.save(context.task, context.context);
    const manager = new ResultManager(temporary, context.context);
    manager.setContext(context.userMessage);
    await manager.processEvent(AgentEvent.task(desired));
    const result = await temporary.load(context.taskId, context.context);
    if (!result) throw new A2AError('unavailable');
    return result;
  }

  execute = async (
    context: RequestContext,
    bus: ExecutionEventBus,
  ): Promise<void> => {
    const scope = binding(context.context, context.taskId, context.contextId);
    if (this.#active.has(scope.taskId)) throw new A2AError('unavailable');
    const controller = new AbortController();
    const settled = Promise.withResolvers<void>();
    void settled.promise.catch(() => {});
    let failure: A2AError | undefined;
    this.#active.set(scope.taskId, { controller, done: settled.promise });
    try {
      await this.#options.store.own(scope, async (claim) => {
        let record = await claim.load();
        const current = async () => {
          controller.signal.throwIfAborted();
          await claim.current();
          controller.signal.throwIfAborted();
        };
        await current();
        checkBytes(
          context.userMessage,
          bound(this.#options.limits?.inputBytes, 1024 * 1024),
        );
        if (
          context.request.configuration?.taskPushNotificationConfig ||
          context.userMessage.referenceTaskIds.length ||
          context.userMessage.extensions.length ||
          context.userMessage.role !== Role.ROLE_USER
        )
          throw new A2AError('unsupported');
        if (
          record &&
          canonicalDeferredInput(record.binding) !==
            canonicalDeferredInput(scope)
        )
          throw new A2AError('authorization');
        if (record && record.state !== 'waiting')
          throw new A2AError('unsupported');
        const input = record ? undefined : a2aInput(context.userMessage.parts);
        const setup = await this.#options.agentFactory(scope, context.context);
        await current();
        const tools = [...setup.agent.tools];
        let reply:
          | Pick<A2AInputReply, 'challenge' | 'generation' | 'result'>
          | undefined;
        let manual: ManualTool | undefined;
        if (record) {
          const parts = context.userMessage.parts;
          if (parts.length !== 1 || parts[0].content?.$case !== 'data')
            throw new A2AError('unsupported');
          const payload = parts[0].content.value;
          if (
            !payload ||
            typeof payload !== 'object' ||
            Array.isArray(payload) ||
            Object.keys(payload).sort().join(',') !==
              'challenge,generation,result'
          )
            throw new A2AError('unsupported');
          reply = {
            challenge: payload.challenge,
            generation: payload.generation,
            result: payload.result,
          };
          manual = tools.find(
            (tool) =>
              tool.kind === 'manual' && tool.name === record!.pending?.name,
          ) as ManualTool | undefined;
          if (
            !reply ||
            !manual ||
            !record.pending ||
            !record.checkpoint ||
            reply.generation !== record.generation ||
            reply.challenge !== record.pending.challenge ||
            declaration(manual) !== record.pending.declaration
          )
            throw new A2AError('authorization');
          validateManualResult(manual, reply.result);
        }
        const publish = async (
          state: NativeA2ATask['state'],
          desired: Task,
          extra: Pick<NativeA2ATask, 'checkpoint' | 'pending'> = {},
        ) => {
          await claim.current();
          const snapshot = await this.#snapshot(context, desired);
          await claim.current();
          const next: NativeA2ATask = {
            schemaVersion: 1,
            binding: scope,
            generation: (record?.generation ?? 0) + 1,
            publicationRevision: (record?.publicationRevision ?? 0) + 1,
            state,
            desired: snapshot,
            ...extra,
          };
          await claim.commit(record?.generation, next);
          record = next;
          await claim.current();
          bus.publish(AgentEvent.task(structuredClone(snapshot)));
          await claim.published(next.publicationRevision);
          await claim.current();
        };
        const task = (state: TaskState, message?: Message): Task => ({
          ...Task.fromJSON({}),
          id: scope.taskId,
          contextId: scope.contextId,
          status: { state, message, timestamp: new Date().toISOString() },
          history: record?.desired.history ?? context.task?.history ?? [],
          artifacts: record?.desired.artifacts ?? [],
          metadata: record?.desired.metadata,
        });
        const checkpoint = record?.checkpoint;
        const oldCall = record?.pending?.callId;
        await publish(
          record ? 'claimed' : 'running',
          task(TaskState.TASK_STATE_WORKING),
        );
        this.#waiting.delete(scope.taskId);
        let session: Session<Output, Context> | undefined;
        let closed = false;
        const stop = () => {
          if (session) void session.close().catch(() => {});
        };
        try {
          await current();
          session = await setup.agent.session({
            context: setup.context,
            tools,
            ...(checkpoint ? { state: checkpoint } : {}),
            signal: controller.signal,
            parentTrace: setup.parentTrace,
          });
          controller.signal.addEventListener('abort', stop, { once: true });
          await current();
          if (reply) {
            const pending = await session.pendingInteractions();
            await current();
            if (
              pending.length !== 1 ||
              pending[0].type !== 'action_requested' ||
              pending[0].subagentId !== null ||
              pending[0].callId !== oldCall ||
              !manual?.match(pending[0])
            )
              throw new A2AError('authorization');
            await session.respond(pending[0].reply(reply.result));
          } else {
            await session.submit(input!);
          }
          const outcome = await session.wait({ until: 'request' });
          await claim.current();
          if ('requests' in outcome) {
            await current();
            if (
              outcome.requests.length !== 1 ||
              outcome.requests[0].subagentId !== null
            )
              throw new A2AError('unsupported');
            const request = outcome.requests[0];
            const tool = tools.find(
              (entry) => entry.kind === 'manual' && entry.match(request),
            ) as ManualTool | undefined;
            if (!tool) throw new A2AError('unsupported');
            const saved = await session.suspend();
            await current();
            if (
              !isManualSessionState(saved) ||
              saved.manual_continuation.pending_manual.length !== 1 ||
              saved.manual_continuation.pending_manual[0].call_id !==
                request.callId
            )
              throw new A2AError('unsupported');
            checkBytes(
              saved,
              bound(this.#options.limits?.checkpointBytes, 8 * 1024 * 1024),
            );
            await session.close();
            closed = true;
            await current();
            const challenge = randomUUID();
            const message: Message = {
              ...Message.fromJSON({}),
              messageId: randomUUID(),
              taskId: scope.taskId,
              contextId: scope.contextId,
              role: Role.ROLE_AGENT,
              parts: [
                {
                  ...Part.fromJSON({}),
                  content: {
                    $case: 'data',
                    value: {
                      challenge,
                      generation: record!.generation + 1,
                      tool: request.name,
                      arguments: request.arguments,
                    },
                  },
                  mediaType: 'application/json',
                },
              ],
            };
            await publish(
              'waiting',
              task(TaskState.TASK_STATE_INPUT_REQUIRED, message),
              {
                checkpoint: saved,
                pending: {
                  name: request.name,
                  callId: request.callId,
                  declaration: declaration(tool),
                  challenge,
                },
              },
            );
            this.#waiting.set(scope.taskId, scope);
          } else {
            // Completion includes native settlement; cleanup must also succeed before success is durable.
            await session.close();
            closed = true;
            await claim.current();
            checkBytes(
              outcome.finalOutput,
              bound(this.#options.limits?.bodyBytes, 2 * 1024 * 1024),
            );
            const complete = task(TaskState.TASK_STATE_COMPLETED);
            complete.artifacts = [
              {
                artifactId: 'result',
                name: 'result',
                description: '',
                extensions: [],
                metadata: undefined,
                parts: [
                  {
                    ...Part.fromJSON({}),
                    content:
                      typeof outcome.finalOutput === 'string'
                        ? { $case: 'text', value: outcome.finalOutput }
                        : {
                            $case: 'data',
                            value: { result: outcome.finalOutput },
                          },
                    mediaType:
                      typeof outcome.finalOutput === 'string'
                        ? 'text/plain'
                        : 'application/json',
                  },
                ],
              },
            ];
            await publish('completed', complete);
          }
        } catch {
          if (session && !closed) {
            await session.close();
            closed = true;
          }
          await claim.current();
          if (record?.state !== 'completed' && record?.state !== 'waiting')
            await publish(
              controller.signal.aborted ? 'canceled' : 'failed',
              task(
                controller.signal.aborted
                  ? TaskState.TASK_STATE_CANCELED
                  : TaskState.TASK_STATE_FAILED,
              ),
            );
        } finally {
          controller.signal.removeEventListener('abort', stop);
          if (session && !closed) await session.close();
        }
      });
    } catch (error) {
      failure = error instanceof A2AError ? error : new A2AError('unavailable');
      throw failure;
    } finally {
      this.#active.delete(scope.taskId);
      if (failure) settled.reject(failure);
      else settled.resolve();
      // A late cancel still needs this bus to retire a just-published waiting checkpoint.
      if (
        failure ||
        !controller.signal.aborted ||
        !this.#waiting.has(scope.taskId)
      )
        bus.finished();
    }
  };

  cancelTask = async (
    taskId: string,
    bus: ExecutionEventBus,
  ): Promise<void> => {
    const active = this.#active.get(taskId);
    if (active) {
      active.controller.abort();
      await active.done;
      if (!this.#waiting.has(taskId)) return;
    }
    const scope = this.#waiting.get(taskId);
    if (!scope) throw new A2AError('unavailable');
    await this.#options.store.own(scope, async (claim) => {
      const record = await claim.load();
      await claim.current();
      if (!record || record.state !== 'waiting')
        throw new A2AError('unavailable');
      const desired = structuredClone(record.desired);
      desired.status = {
        state: TaskState.TASK_STATE_CANCELED,
        message: undefined,
        timestamp: new Date().toISOString(),
      };
      await claim.commit(record.generation, {
        ...record,
        generation: record.generation + 1,
        publicationRevision: record.publicationRevision + 1,
        state: 'canceled',
        desired,
        checkpoint: undefined,
        pending: undefined,
      });
      await claim.current();
      // The official cancellation handler starts its event consumer only AFTER this method returns.
      bus.publish(AgentEvent.task(desired));
      bus.finished();
      this.#waiting.delete(taskId);
    });
  };

  /** Host calls only after the prior owner AND official event consumers have stopped. Never reruns a Session. */
  async recover(
    scope: NativeA2ABinding,
    context: ServerCallContext,
  ): Promise<void> {
    if (
      canonicalDeferredInput(
        binding(context, scope.taskId, scope.contextId),
      ) !== canonicalDeferredInput(scope)
    )
      throw new A2AError('authorization');
    await this.#options.store.own(scope, async (claim) => {
      let record = await claim.load();
      await claim.current();
      if (!record) return;
      if (record.state === 'running' || record.state === 'claimed') {
        const desired = structuredClone(record.desired);
        desired.status = {
          state: TaskState.TASK_STATE_FAILED,
          message: undefined,
          timestamp: new Date().toISOString(),
        };
        desired.metadata = {
          ...desired.metadata,
          'agents.a2a.outcome': 'unknown',
        };
        const replacement: NativeA2ATask = {
          ...record,
          generation: record.generation + 1,
          publicationRevision: record.publicationRevision + 1,
          state: 'unknown',
          desired,
          checkpoint: undefined,
          pending: undefined,
        };
        await claim.commit(record.generation, replacement);
        record = replacement;
        await claim.current();
      }
      await this.#options.store.save(structuredClone(record.desired), context);
      await claim.current();
    });
  }
}
