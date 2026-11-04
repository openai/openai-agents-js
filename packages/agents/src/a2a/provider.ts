import { createHash, randomUUID } from 'node:crypto';
import { Message, Role, Task, TaskState, type Part } from '@a2a-js/sdk';
import type {
  JobClaim,
  JobContext,
  JobProvider,
  JobUpdate,
} from '../experimental/deferred';
import { canonicalDeferredInput } from '../experimental/deferred-codec';
import {
  A2AError,
  bound,
  checkBytes,
  connectA2A,
  fixedUrl,
  type A2AEndpoint,
  type A2ALimits,
  type A2AOperation,
} from './client';
import { a2aInput, inputProposal } from './content';
import type {
  TraceContext,
  TraceContextHeaders,
} from '../runtime/trace-context';

export interface A2AInputReply {
  readonly taskId: string;
  readonly contextId: string;
  readonly challenge: string;
  readonly generation: number;
  readonly result: unknown;
}

export interface A2AJobProviderOptions<Input> {
  readonly endpoint: A2AEndpoint;
  /** Check the current principal, exact binding and generation. */
  authorize(claim: JobClaim, operation: A2AOperation): Promise<void>;
  /** Fixed-endpoint credential resolver, separate from current authorization. */
  authorization(operation: A2AOperation): Promise<string>;
  /** Spend one durable mutation. An uncertain send leaves this reservation spent. */
  reserve(
    claim: JobClaim,
    operation: Exclude<A2AOperation, 'observe'>,
    actionId: string,
  ): Promise<void>;
  encode(input: Input): readonly Part[];
  /** Validate using the host's current result schema before returning model-visible data. */
  project(task: Task): unknown;
  readonly limits?: A2ALimits;
  readonly fetch?: typeof fetch;
  /** Fresh host-supplied parent for this worker. Never part of a durable receipt. */
  readonly parentTrace?: TraceContext | TraceContextHeaders | null;
}

interface Receipt {
  scope: string;
  taskId: string;
  contextId: string;
}

/** Official A2A 1.0 client behind the native durable-job boundary. No mutation retries. */
export class A2AJobProvider<Input> implements JobProvider<Input> {
  readonly id: string;
  readonly #options: A2AJobProviderOptions<Input>;
  constructor(options: A2AJobProviderOptions<Input>) {
    const endpoint = Object.freeze({
      ...options.endpoint,
      cardUrl: fixedUrl(options.endpoint.cardUrl),
      rpcUrl: fixedUrl(options.endpoint.rpcUrl),
    });
    this.#options = { ...options, endpoint };
    this.id = `a2a:${endpoint.name}:${createHash('sha256').update(endpoint.rpcUrl).digest('hex')}`;
  }

  #scope(claim: JobClaim): string {
    return createHash('sha256')
      .update(canonicalDeferredInput([this.id, claim.binding, claim.key]))
      .digest('hex');
  }

  #receipt(claim: JobClaim): Receipt {
    try {
      const receipt = JSON.parse(claim.update?.receipt ?? '') as Receipt;
      if (
        receipt.scope !== this.#scope(claim) ||
        !receipt.taskId ||
        !receipt.contextId
      )
        throw new Error();
      return receipt;
    } catch {
      throw new A2AError('authorization');
    }
  }

  async #connect(
    claim: JobClaim,
    operation: A2AOperation,
    context: JobContext,
    actionId = `${this.#scope(claim)}:${operation}`,
  ) {
    if (
      claim.action !== operation &&
      !(operation === 'observe' && claim.action === 'start' && claim.update)
    )
      throw new A2AError('authorization');
    const current = async () => {
      context.signal.throwIfAborted();
      try {
        await this.#options.authorize(claim, operation);
      } catch {
        throw new A2AError('authorization');
      }
      context.signal.throwIfAborted();
    };
    await current();
    return connectA2A(this.#options.endpoint, {
      authorization: this.#options.authorization,
      current,
      reserve: async (actual) => {
        if (actual !== operation) throw new A2AError('authorization');
        await this.#options.reserve(claim, actual, actionId);
      },
      limits: this.#options.limits,
      fetch: this.#options.fetch,
      signal: context.signal,
      parentTrace: this.#options.parentTrace,
    });
  }

  async #update(
    claim: JobClaim,
    task: Task,
    operation: A2AOperation,
    context: JobContext,
    expected?: Receipt,
  ): Promise<JobUpdate> {
    context.signal.throwIfAborted();
    await this.#options.authorize(claim, operation);
    context.signal.throwIfAborted();
    if (
      !task.id ||
      !task.contextId ||
      (expected &&
        (task.id !== expected.taskId || task.contextId !== expected.contextId))
    )
      throw new A2AError('unsupported');
    const receipt = JSON.stringify({
      scope: this.#scope(claim),
      taskId: task.id,
      contextId: task.contextId,
    });
    const state = task.status?.state;
    if (
      state === undefined ||
      state === TaskState.TASK_STATE_UNSPECIFIED ||
      state === TaskState.UNRECOGNIZED
    )
      return { status: 'unknown', receipt };
    if (task.metadata?.['agents.a2a.outcome'] === 'unknown')
      return { status: 'unknown', receipt };
    if (state === TaskState.TASK_STATE_COMPLETED) {
      const value = this.#options.project(structuredClone(task));
      checkBytes(
        value,
        bound(this.#options.limits?.bodyBytes, 2 * 1024 * 1024),
      );
      return { status: 'completed', receipt, value };
    }
    if (state === TaskState.TASK_STATE_CANCELED)
      return { status: 'cancelled', receipt };
    if (
      state === TaskState.TASK_STATE_FAILED ||
      state === TaskState.TASK_STATE_REJECTED
    )
      return { status: 'failed', receipt };
    if (state === TaskState.TASK_STATE_INPUT_REQUIRED)
      return {
        status: 'inputRequired',
        receipt,
        value: inputProposal(task),
      };
    // Authentication is a host credential flow; it never becomes an approval answer.
    return {
      status: 'pending',
      receipt,
      ...(state === TaskState.TASK_STATE_AUTH_REQUIRED
        ? { value: { authRequired: true } }
        : {}),
    };
  }

  async start(
    claim: JobClaim,
    input: Input,
    context: JobContext,
  ): Promise<JobUpdate> {
    if (claim.update?.receipt) return this.observe(claim, context);
    const parts = this.#options.encode(input);
    a2aInput(parts);
    checkBytes(parts, bound(this.#options.limits?.inputBytes, 1024 * 1024));
    const client = await this.#connect(claim, 'start', context);
    try {
      const result = await client.sendMessage({
        tenant: '',
        metadata: undefined,
        configuration: undefined,
        message: {
          ...Message.fromJSON({}),
          messageId: randomUUID(),
          role: Role.ROLE_USER,
          parts: [...parts],
        },
      });
      if (!('id' in result)) throw new A2AError('unsupported');
      return await this.#update(claim, result, 'start', context);
    } catch {
      return { status: 'unknown' };
    }
  }

  async observe(claim: JobClaim, context: JobContext): Promise<JobUpdate> {
    const receipt = this.#receipt(claim);
    const client = await this.#connect(claim, 'observe', context);
    try {
      return await this.#update(
        claim,
        await client.getTask({ tenant: '', id: receipt.taskId }),
        'observe',
        context,
        receipt,
      );
    } catch {
      return { status: 'unknown', receipt: claim.update!.receipt };
    }
  }

  async respond(
    claim: JobClaim,
    response: unknown,
    context: JobContext,
  ): Promise<JobUpdate> {
    const receipt = this.#receipt(claim);
    const reply = structuredClone(response) as A2AInputReply;
    if (
      !reply ||
      reply.taskId !== receipt.taskId ||
      reply.contextId !== receipt.contextId ||
      !reply.challenge ||
      !Number.isSafeInteger(reply.generation) ||
      reply.generation <= 0
    )
      throw new A2AError('authorization');
    canonicalDeferredInput(reply.result);
    checkBytes(reply, bound(this.#options.limits?.inputBytes, 1024 * 1024));
    const actionId = `${this.#scope(claim)}:respond:${createHash('sha256')
      .update(
        canonicalDeferredInput([
          reply.taskId,
          reply.contextId,
          reply.challenge,
          reply.generation,
        ]),
      )
      .digest('hex')}`;
    const client = await this.#connect(claim, 'respond', context, actionId);
    const task = await client.getTask({ tenant: '', id: receipt.taskId });
    const challenge = inputProposal(task);
    if (
      task.status?.state !== TaskState.TASK_STATE_INPUT_REQUIRED ||
      task.contextId !== receipt.contextId ||
      challenge?.challenge !== reply.challenge ||
      challenge?.generation !== reply.generation
    )
      throw new A2AError('authorization');
    try {
      const result = await client.sendMessage({
        tenant: '',
        metadata: undefined,
        configuration: undefined,
        message: {
          ...Message.fromJSON({}),
          messageId: randomUUID(),
          role: Role.ROLE_USER,
          taskId: receipt.taskId,
          contextId: receipt.contextId,
          parts: [
            {
              content: {
                $case: 'data',
                value: {
                  challenge: reply.challenge,
                  generation: reply.generation,
                  result: reply.result,
                },
              },
              mediaType: 'application/json',
              filename: '',
              metadata: undefined,
            },
          ],
        },
      });
      if (!('id' in result)) throw new A2AError('unsupported');
      return await this.#update(claim, result, 'respond', context, receipt);
    } catch {
      return { status: 'unknown', receipt: claim.update!.receipt };
    }
  }

  async cancel(claim: JobClaim, context: JobContext): Promise<JobUpdate> {
    const receipt = this.#receipt(claim);
    const client = await this.#connect(claim, 'cancel', context);
    try {
      return await this.#update(
        claim,
        await client.cancelTask({
          tenant: '',
          id: receipt.taskId,
          metadata: undefined,
        }),
        'cancel',
        context,
        receipt,
      );
    } catch {
      return { status: 'unknown', receipt: claim.update!.receipt };
    }
  }
}
