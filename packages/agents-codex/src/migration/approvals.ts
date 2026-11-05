import {
  RunToolApprovalItem,
  type Agent,
  type AgentOutputType,
  type ModelResponse,
  type RunContext,
} from '@openai/agents-core';
import type { AgentInputItem } from '@openai/agents-core/types';
import type { ToolCallContext } from '../runtime/tools';
import { Turn } from '../runtime/session';
import type { MigrationRunResult } from './index';

/** One live approval choice; its native callback owner still controls execution. */
export function approvalDecision(
  item: RunToolApprovalItem,
  signal: AbortSignal,
) {
  const decision = Promise.withResolvers<'approve' | 'reject'>();
  let choice: 'approve' | 'reject' | undefined;
  let continued = false;
  const abort = () => decision.reject(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener('abort', abort, { once: true });
  const wait = decision.promise.finally(() =>
    signal.removeEventListener('abort', abort),
  );
  void wait.catch(() => {});
  const choose = (
    candidate: RunToolApprovalItem,
    value: 'approve' | 'reject',
  ) => {
    signal.throwIfAborted();
    if (candidate !== item)
      throw new TypeError('Approval must identify this exact live item');
    if (continued || choice !== undefined)
      throw new TypeError('Approval already has a decision');
    choice = value;
  };
  return Object.freeze({
    wait,
    approve: (candidate: RunToolApprovalItem) => choose(candidate, 'approve'),
    reject: (candidate: RunToolApprovalItem) => choose(candidate, 'reject'),
    continue() {
      signal.throwIfAborted();
      if (choice === undefined)
        throw new TypeError('Approve or reject before continuing');
      if (!continued) {
        continued = true;
        decision.resolve(choice);
      }
      return wait;
    },
  });
}

type FunctionCall = Extract<AgentInputItem, { type: 'function_call' }>;

/** An in-process held call, not RunState, completed history or a checkpoint. */
export interface MigrationPausedRun<
  Context,
  Output extends AgentOutputType = 'text',
> {
  readonly status: 'paused';
  readonly interruptions: readonly RunToolApprovalItem[];
  readonly lastAgent: Agent<Context, Output>;
  readonly runContext: RunContext<Context>;
  readonly native: Readonly<{
    sessionId: string;
    submissionId: string;
    turnId: string;
    callId: string;
  }>;
  approve(item: RunToolApprovalItem): void;
  reject(item: RunToolApprovalItem): void;
  /** Consume the selected decision once; join the same original native run. */
  continue(): Promise<MigrationRunResult<Context, Output>>;
  /** Still pending while held; abort through the original caller AbortSignal. */
  readonly completed: Promise<MigrationRunResult<Context, Output>>;
}

export interface HeldApprovalOwner<Context> {
  validateResponse(response: ModelResponse): void;
  hold(
    call: FunctionCall,
    context: ToolCallContext<Context>,
    runContext: RunContext<Context>,
  ): Promise<boolean>;
}

/** Keep the existing native run alive behind one bounded, live decision. */
export function runWithApproval<
  Context,
  Output extends AgentOutputType = 'text',
>(
  agent: Agent<Context, Output>,
  produce: (
    owner: HeldApprovalOwner<Context>,
  ) => Promise<MigrationRunResult<Context, Output>>,
): Promise<
  MigrationRunResult<Context, Output> | MigrationPausedRun<Context, Output>
> {
  const pause = Promise.withResolvers<{
    item: RunToolApprovalItem;
    context: ToolCallContext<Context>;
    runContext: RunContext<Context>;
    decision: ReturnType<typeof approvalDecision>;
  }>();
  let calls = 0;
  let held = false;
  const completed = produce({
    validateResponse(response) {
      calls += response.output.filter(
        (item) => item.type === 'function_call',
      ).length;
      if (calls > 1)
        throw new TypeError(
          'Manual approval supports one function call per run',
        );
    },
    async hold(call, context, runContext) {
      context.signal.throwIfAborted();
      if (
        held ||
        !(context.submission instanceof Turn) ||
        context.submission.childId !== null
      )
        throw new TypeError(
          'Manual approval requires one live root function call',
        );
      held = true;
      const item = new RunToolApprovalItem(
        Object.freeze(structuredClone(call)),
        agent,
      );
      Object.freeze(item);
      const decision = approvalDecision(item, context.signal);
      pause.resolve({ item, context, runContext, decision });
      return (await decision.wait) === 'approve';
    },
  });
  void completed.catch(() => {});
  const paused = pause.promise.then(
    ({ item, context, runContext, decision }) => {
      let continuation:
        Promise<MigrationRunResult<Context, Output>> | undefined;
      return Object.freeze({
        status: 'paused' as const,
        interruptions: Object.freeze([item]),
        lastAgent: agent,
        runContext,
        native: Object.freeze({
          sessionId: context.threadId,
          submissionId: (context.submission as Turn).submissionId,
          turnId: context.turnId,
          callId: context.callId,
        }),
        approve: decision.approve,
        reject: decision.reject,
        continue() {
          if (!continuation) {
            decision.continue();
            continuation = completed;
          }
          return continuation;
        },
        completed,
      });
    },
  );
  return Promise.race([completed, paused]);
}
