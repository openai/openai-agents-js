import { createHash } from 'node:crypto';
import type { FetchLike } from '@modelcontextprotocol/client';
import type { JobClaim, JobContext, JobProvider, JobUpdate } from '../deferred';
import { canonicalDeferredInput } from '../deferred-codec';
import {
  MCPInputReply,
  acceptsForm,
  captureJson,
  containsToken,
} from './input-reply';
import {
  admitSelectedTool,
  parseResult,
  type CompleteToolResult,
  type TaskDetail,
  type TaskFields,
} from './protocol';
import {
  TaskTransportError,
  fixedEndpoint,
  withTaskExchange,
  type TaskExchange,
} from './transport';

type Operation = 'start' | 'observe' | 'respond' | 'cancel';
type JsonValue = ReturnType<typeof captureJson>;

export interface MCPTasksProviderOptions {
  /** One host-approved HTTPS URL, or HTTP on localhost, 127.0.0.1 or ::1. */
  endpoint: string;
  /** The exact remote tool name. Model arguments cannot select another tool. */
  tool: string;
  /** The host's configured egress route. The adapter never selects a fallback. */
  fetch: FetchLike;
  /** Check current principal, binding and generation; return a primitive bearer token without its prefix. */
  authorize(
    claim: JobClaim,
    operation: Operation,
    context: JobContext,
  ): Promise<string>;
  /** Operation budget in milliseconds, including queue time. Entered callbacks and streams are still joined. */
  timeoutMs?: number;
  /** Enable only when the target permanently binds request keys and rejects retired or satisfied keys. */
  allowInputReplies?: boolean;
  /** Commit an atomic host reservation immediately before dispatch. Lost acknowledgments leave it spent. */
  reserveMutation?(
    claim: JobClaim,
    reply: MCPInputReply | null,
    context: JobContext,
  ): Promise<boolean>;
  /** Fast synchronous approval of private task/form metadata. Only exactly true permits retention. */
  admitPending?(
    claim: JobClaim,
    taskId: string,
    requestsJson: string | null,
  ): boolean;
  /** Release only host-verified finite JSON. Without this callback, peer content is withheld. */
  admitResult?(claim: JobClaim, result: CompleteToolResult): unknown;
}

function canonicalMetadata(value: JsonValue): string {
  // Captured MCP metadata follows wire JSON semantics, including -0 becoming 0.
  // Deferred input stays strict and is never normalized through this path.
  return canonicalDeferredInput(JSON.parse(JSON.stringify(value)));
}
function digest(value: JsonValue): string {
  return createHash('sha256').update(canonicalMetadata(value)).digest('hex');
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function denied(): never {
  throw new TaskTransportError('authorization');
}
function unavailable(): never {
  throw new TaskTransportError('unavailable');
}
function unsupported(): never {
  throw new TaskTransportError('unsupported');
}
function pollAt(task: TaskFields): number {
  return Date.now() + task.pollIntervalMs;
}
function unknown(receipt?: string, deadline?: number): JobUpdate {
  return {
    status: 'unknown',
    ...(receipt ? { receipt } : {}),
    ...(deadline === undefined ? {} : { value: { pollAt: deadline } }),
  };
}
function checkInterrupted(signal: AbortSignal): void {
  if (signal.aborted) throw new TaskTransportError('interrupted');
}
async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  checkInterrupted(signal);
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new TaskTransportError('interrupted'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/**
 * Optional fixed-target Tasks adapter; the host owns persistence and authority.
 * Register with requireReconciliation: false only for approved low-impact work.
 * This protocol cannot reconcile a lost create response and never retries creation.
 * Restore the same admission policy and verify or quarantine old private journal rows.
 */
export class MCPTasksProvider<Input> implements JobProvider<Input> {
  #endpoint: URL;
  #originalEndpoint: string;
  #tool: string;
  #fetch: FetchLike;
  #authorize: MCPTasksProviderOptions['authorize'];
  #reserve?: MCPTasksProviderOptions['reserveMutation'];
  #admitPending?: MCPTasksProviderOptions['admitPending'];
  #admitResult?: MCPTasksProviderOptions['admitResult'];
  #allowReplies: boolean;
  #timeoutMs: number;

  constructor(options: MCPTasksProviderOptions) {
    const endpoint = fixedEndpoint(options.endpoint);
    if (!options.tool || typeof options.fetch !== 'function') unsupported();
    const timeout = options.timeoutMs ?? 10_000;
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 2 ** 31 - 1)
      unsupported();
    this.#endpoint = endpoint;
    this.#originalEndpoint = options.endpoint;
    this.#tool = options.tool;
    this.#fetch = options.fetch;
    this.#authorize = options.authorize;
    this.#reserve = options.reserveMutation;
    this.#admitPending = options.admitPending;
    this.#admitResult = options.admitResult;
    this.#allowReplies = options.allowInputReplies === true;
    this.#timeoutMs = timeout;
  }

  #scope(claim: JobClaim): string {
    const b = claim.binding;
    return digest([
      this.#endpoint.href,
      this.#tool,
      [
        b.tenant,
        b.runId,
        b.providerId,
        b.sessionId,
        b.turnId,
        b.callId,
        b.toolName,
        b.requestDigest,
        b.checkpointDigest,
      ],
      claim.key,
    ]);
  }

  async #operation(
    claim: JobClaim,
    action: Operation,
    context: JobContext,
    run: (
      claim: JobClaim,
      signal: AbortSignal,
      current: (signal: AbortSignal) => Promise<string>,
      issued: Set<string>,
    ) => Promise<JobUpdate>,
  ): Promise<JobUpdate> {
    if (
      claim.action !== action &&
      !(action === 'observe' && claim.action === 'start' && claim.update)
    )
      denied();
    const retained: JobClaim = Object.freeze({
      binding: Object.freeze({ ...claim.binding }),
      key: claim.key,
      generation: claim.generation,
      action: claim.action,
      ...(claim.update === undefined
        ? {}
        : { update: captureJson(claim.update) as JobUpdate }),
      ...(claim.resultJson === undefined
        ? {}
        : { resultJson: claim.resultJson }),
    });
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.#timeoutMs);
    const signal = AbortSignal.any([context.signal, deadline.signal]);
    const issued = new Set<string>();
    const current = async (requestSignal: AbortSignal) => {
      checkInterrupted(requestSignal);
      let token: string;
      try {
        token = await this.#authorize(retained, action, {
          signal: requestSignal,
        });
      } catch {
        checkInterrupted(requestSignal);
        return denied();
      }
      checkInterrupted(requestSignal);
      if (typeof token !== 'string' || !/^[\x21-\x7e]+$/.test(token)) denied();
      issued.add(token);
      return token;
    };
    try {
      await current(signal);
      return await run(retained, signal, current, issued);
    } finally {
      clearTimeout(timer);
      issued.clear();
    }
  }

  async #exchange<T>(
    signal: AbortSignal,
    authorize: (signal: AbortSignal) => Promise<string>,
    run: (exchange: TaskExchange) => Promise<T>,
  ): Promise<T> {
    return withTaskExchange(
      {
        endpoint: this.#endpoint,
        tool: this.#tool,
        fetch: this.#fetch,
        authorize,
        signal,
        timeoutMs: this.#timeoutMs,
      },
      async (exchange) => {
        try {
          parseResult(
            'server/discover',
            await exchange.request('server/discover'),
          );
        } catch (error) {
          if (error instanceof TaskTransportError) throw error;
          return unsupported();
        }
        return run(exchange);
      },
    );
  }

  #complete(
    claim: JobClaim,
    result: CompleteToolResult,
    receipt?: string,
  ): JobUpdate {
    const value: Record<string, unknown> = {
      content: [],
      isError: result.isError === true,
    };
    if (this.#admitResult) {
      try {
        value.structuredContent = captureJson(this.#admitResult(claim, result));
      } catch {
        return { status: 'failed', ...(receipt ? { receipt } : {}) };
      }
    }
    return { status: 'completed', ...(receipt ? { receipt } : {}), value };
  }

  #admit(
    claim: JobClaim,
    taskId: string,
    requests: JsonValue | null,
    issued: Set<string>,
  ): void {
    const encoded = requests === null ? null : canonicalMetadata(requests);
    for (const token of issued) {
      if (
        containsToken(taskId, token) ||
        (requests !== null && containsToken(requests, token))
      )
        unavailable();
    }
    try {
      if (this.#admitPending?.(claim, taskId, encoded) === true) return;
    } catch {
      /* Keep private peer and callback data out of errors. */
    }
    unavailable();
  }

  #task(claim: JobClaim): {
    update: JobUpdate;
    receipt: string;
    taskId: string;
    deadline: number;
  } {
    const update = claim.update;
    if (
      !update?.receipt ||
      !['pending', 'inputRequired', 'unknown'].includes(update.status) ||
      Buffer.byteLength(update.receipt, 'utf8') > 256 * 1024 + 128
    )
      denied();
    let decoded: unknown;
    try {
      decoded = JSON.parse(update.receipt);
    } catch {
      return denied();
    }
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 3 ||
      decoded[0] !== 1 ||
      decoded[1] !== this.#scope(claim) ||
      typeof decoded[2] !== 'string' ||
      !decoded[2]
    )
      denied();
    const deadline =
      object(update.value) && update.value.pollAt !== undefined
        ? update.value.pollAt
        : 0;
    if (typeof deadline !== 'number' || !Number.isFinite(deadline)) denied();
    return { update, receipt: update.receipt, taskId: decoded[2], deadline };
  }

  async #get(exchange: TaskExchange, taskId: string): Promise<TaskDetail> {
    let detail: TaskDetail;
    try {
      detail = parseResult(
        'tasks/get',
        await exchange.request('tasks/get', { taskId }),
      );
    } catch (error) {
      if (error instanceof TaskTransportError) throw error;
      return unavailable();
    }
    if (detail.taskId !== taskId) unavailable();
    return detail;
  }

  #status(
    claim: JobClaim,
    task: TaskDetail,
    receipt: string,
    issued: Set<string>,
  ): JobUpdate {
    if (task.status === 'completed' && task.result)
      return this.#complete(claim, task.result, receipt);
    if (task.status === 'cancelled' || task.status === 'failed')
      return { status: task.status, receipt };
    const value: Record<string, unknown> = { pollAt: pollAt(task) };
    if (task.status === 'working') return { status: 'pending', receipt, value };
    if (
      task.status === 'input_required' &&
      task.inputRequests &&
      Object.keys(task.inputRequests).length
    ) {
      const requests = captureJson(task.inputRequests);
      this.#admit(claim, task.taskId, requests, issued);
      value.requests = requests;
      value.challenge = digest([receipt, task.lastUpdatedAt, requests]);
      return { status: 'inputRequired', receipt, value };
    }
    return unavailable();
  }

  async start(
    claim: JobClaim,
    input: Input,
    context: JobContext,
  ): Promise<JobUpdate> {
    return this.#operation(
      claim,
      'start',
      context,
      async (owned, signal, current, issued) => {
        let payload: JsonValue;
        let inputDigest: string;
        try {
          payload = captureJson(input);
          inputDigest = createHash('sha256')
            .update(canonicalDeferredInput(payload))
            .digest('hex');
        } catch {
          return denied();
        }
        if (!object(payload) || inputDigest !== owned.binding.requestDigest)
          denied();
        let attempted = false;
        try {
          return await this.#exchange(signal, current, async (exchange) => {
            let cursor: string | undefined;
            const cursors = new Set<string>();
            let found = false;
            for (let page = 0; page < 32; page++) {
              const raw = await exchange.request(
                'tools/list',
                cursor === undefined ? {} : { cursor },
              );
              let listing;
              try {
                listing = parseResult('tools/list', raw);
              } catch {
                return unsupported();
              }
              for (const tool of listing.tools) {
                if (tool.name !== this.#tool) continue;
                if (found) unsupported();
                try {
                  admitSelectedTool(tool, payload as Record<string, unknown>);
                } catch {
                  return unsupported();
                }
                found = true;
              }
              cursor = listing.nextCursor;
              if (cursor === undefined) break;
              if (page === 31 || cursors.has(cursor)) unsupported();
              cursors.add(cursor);
            }
            if (!found) unsupported();
            const raw = await exchange.request(
              'tools/call',
              { name: this.#tool, arguments: payload },
              {
                beforeDispatch: async () => {
                  attempted = true;
                },
              },
            );
            let result;
            try {
              result = parseResult('tools/call', raw);
            } catch {
              return unavailable();
            }
            if (result.resultType === 'complete')
              return this.#complete(owned, result);
            this.#admit(owned, result.taskId, null, issued);
            return {
              status: 'pending',
              receipt: JSON.stringify([1, this.#scope(owned), result.taskId]),
              value: { pollAt: pollAt(result) },
            };
          });
        } catch (error) {
          if (
            error instanceof TaskTransportError &&
            (['authorization', 'interrupted'].includes(error.kind) ||
              (!attempted && error.kind === 'unsupported'))
          )
            throw error;
          return unknown();
        }
      },
    );
  }

  async observe(claim: JobClaim, context: JobContext): Promise<JobUpdate> {
    return this.#operation(
      claim,
      'observe',
      context,
      async (owned, signal, current, issued) => {
        const task = this.#task(owned);
        const remaining = task.deadline - Date.now();
        if (remaining > 0) {
          if (owned.action !== 'start' || remaining > this.#timeoutMs)
            return captureJson(task.update) as JobUpdate;
          await delay(remaining, signal);
        }
        try {
          return await this.#exchange(signal, current, async (exchange) =>
            this.#status(
              owned,
              await this.#get(exchange, task.taskId),
              task.receipt,
              issued,
            ),
          );
        } catch (error) {
          if (
            error instanceof TaskTransportError &&
            ['authorization', 'interrupted'].includes(error.kind)
          )
            throw error;
          return unknown(task.receipt, task.deadline);
        }
      },
    );
  }

  async respond(
    claim: JobClaim,
    response: unknown,
    context: JobContext,
  ): Promise<JobUpdate> {
    if (!this.#allowReplies || !this.#reserve) denied();
    return this.#operation(
      claim,
      'respond',
      context,
      async (owned, signal, current, issued) => {
        const task = this.#task(owned);
        if (
          !(response instanceof MCPInputReply) ||
          task.update.status !== 'inputRequired' ||
          !object(task.update.value) ||
          response.challenge !== task.update.value.challenge ||
          !Object.keys(response.responses).length
        )
          denied();
        let deadline = task.deadline;
        try {
          return await this.#exchange(signal, current, async (exchange) => {
            const detail = await this.#get(exchange, task.taskId);
            const truth = this.#status(owned, detail, task.receipt, issued);
            if (
              truth.status !== 'inputRequired' ||
              !object(truth.value) ||
              truth.value.challenge !== response.challenge
            )
              return truth;
            deadline = truth.value.pollAt as number;
            const answers = response.responses;
            for (const [key, answer] of Object.entries(answers)) {
              const request = detail.inputRequests?.[key];
              if (
                request?.method !== 'elicitation/create' ||
                !object(request.params) ||
                (request.params.mode !== undefined &&
                  request.params.mode !== 'form')
              )
                unsupported();
              if (answer.action === 'accept') {
                if (
                  !answer.content ||
                  !acceptsForm(request.params.requestedSchema, answer.content)
                )
                  unsupported();
              } else if (answer.content !== undefined) unsupported();
              if (
                [
                  task.taskId,
                  owned.key,
                  this.#originalEndpoint,
                  this.#endpoint.href,
                ].some((secret) =>
                  containsToken(answer.content ?? null, secret),
                )
              )
                unsupported();
            }
            const raw = await exchange.request(
              'tasks/update',
              { taskId: task.taskId, inputResponses: answers },
              {
                beforeDispatch: async (requestSignal) => {
                  for (const token of issued) {
                    if (
                      containsToken(task.taskId, token) ||
                      containsToken(detail.inputRequests ?? null, token) ||
                      containsToken(answers, token)
                    )
                      denied();
                  }
                  if (
                    (await this.#reserve!(owned, response, {
                      signal: requestSignal,
                    })) !== true
                  )
                    denied();
                },
              },
            );
            try {
              parseResult('tasks/update', raw);
            } catch {
              return unavailable();
            }
            return {
              status: 'pending',
              receipt: task.receipt,
              value: { pollAt: deadline },
            };
          });
        } catch (error) {
          if (
            error instanceof TaskTransportError &&
            ['authorization', 'interrupted'].includes(error.kind)
          )
            throw error;
          return unknown(task.receipt, deadline);
        }
      },
    );
  }

  async cancel(claim: JobClaim, context: JobContext): Promise<JobUpdate> {
    if (!this.#reserve) denied();
    return this.#operation(
      claim,
      'cancel',
      context,
      async (owned, signal, current, issued) => {
        const task = this.#task(owned);
        if (task.update.status === 'unknown')
          return captureJson(task.update) as JobUpdate;
        let deadline = task.deadline;
        try {
          return await this.#exchange(signal, current, async (exchange) => {
            const detail = await this.#get(exchange, task.taskId);
            const truth = this.#status(owned, detail, task.receipt, issued);
            if (
              !['pending', 'inputRequired'].includes(truth.status) ||
              !object(truth.value)
            )
              return truth;
            deadline = truth.value.pollAt as number;
            const raw = await exchange.request(
              'tasks/cancel',
              { taskId: task.taskId },
              {
                beforeDispatch: async (requestSignal) => {
                  for (const token of issued)
                    if (
                      containsToken(task.taskId, token) ||
                      containsToken(detail.inputRequests ?? null, token)
                    )
                      denied();
                  if (
                    (await this.#reserve!(owned, null, {
                      signal: requestSignal,
                    })) !== true
                  )
                    denied();
                },
              },
            );
            try {
              parseResult('tasks/cancel', raw);
            } catch {
              return unavailable();
            }
            return {
              status: 'pending',
              receipt: task.receipt,
              value: { pollAt: deadline },
            };
          });
        } catch (error) {
          if (
            error instanceof TaskTransportError &&
            ['authorization', 'interrupted'].includes(error.kind)
          )
            throw error;
          return unknown(task.receipt, deadline);
        }
      },
    );
  }
}
