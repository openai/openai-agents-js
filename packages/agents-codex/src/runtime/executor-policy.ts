import {
  jsonObject,
  losslessJsonValueSchema,
  losslessJsonObjectSchema,
  type JsonObject,
  copyJsonValue,
} from './binding';
import {
  Environment,
  type ExecutorContext,
  type ExecutorToolName,
} from './environment';
import type { ToolCallContext } from './tools';
import type { Session } from './session';
import type { Agent } from './public-agent';
import { interceptedCallInfo } from './call-metadata';
import { readExecutorPolicyDecision } from './executor-decisions';

export function hasExecutorPolicy(environment: Environment | null): boolean {
  return (
    !!environment &&
    !!(
      environment.approval ||
      environment.transformArguments ||
      environment.transformResult
    )
  );
}

/** @internal Native selection prevents unrelated tools from acquiring a decision waiter. */
export function executorPolicyRules(
  environment: Environment,
  includeChildren: boolean,
): string {
  return JSON.stringify(
    environment.tools.map((name) => ({
      name,
      namespace: 'functions',
      timeout: environment.approval ? null : environment.policyTimeout,
      scope: includeChildren ? 'thread_tree' : 'root',
      result: !!environment.transformResult,
      ...(environment.approval || environment.transformArguments
        ? { executor_before: true }
        : {}),
    })),
  );
}

/**
 * @internal The caller retains and joins the exact native callback owner.
 * requestStop claims and fences that reservation synchronously. A true return
 * requires suppressing ordinary reply delivery and scheduling native settlement
 * and physical cleanup after this callback returns. Refusal must fail closed.
 */
export async function applyExecutorPolicy<Context>(
  environment: Environment<Context>,
  session: Session<any, any>,
  agent: Agent<any, any>,
  context: Context,
  submission: ToolCallContext<Context>['submission'],
  request: JsonObject,
  signal: AbortSignal,
  fail: (error: Error) => void,
  requestStop?: () => boolean,
): Promise<JsonObject> {
  const name = jsonObject.parse(request.tool_name);
  if (
    (name.namespace !== null &&
      name.namespace !== 'functions' &&
      name.namespace !== '') ||
    !environment.tools.includes(name.name as ExecutorToolName)
  )
    return { action: 'continue' };
  signal.throwIfAborted();
  const before = request.phase === 'before';
  const stop = (): JsonObject => {
    if (!before || request.boundary !== 'pre_dispatch' || !requestStop?.())
      throw new Error('Executor owner stop was not accepted');
    // The caller has fenced ordinary delivery for this reservation.
    return { action: 'deny' };
  };
  const callback = before
    ? environment.transformArguments
    : environment.transformResult;
  const identity: ExecutorContext<Context> = Object.freeze({
    context,
    submission,
    call: interceptedCallInfo(submission, request),
    session,
    agent,
    toolName: name.name as ExecutorToolName,
    threadId: request.thread_id as string,
    turnId: request.turn_id as string,
    callId: request.call_id as string | null,
    outerCallId: request.outer_call_id as string | null,
    cellId: request.cell_id as string | null,
    runtimeToolCallId: request.runtime_tool_call_id as string | null,
    agentRole: (request.agent_role as string | null) ?? null,
    model: (request.model as string | null) ?? null,
  });
  let supplied = before ? request.input : request.result;
  if (before && request.tool_kind === 'function_json')
    supplied = losslessJsonObjectSchema.parse(JSON.parse(supplied as string));
  if (before && environment.approval) {
    const approved = await environment.approval(
      identity,
      structuredClone(supplied),
    );
    signal.throwIfAborted();
    if (readExecutorPolicyDecision(approved)?.kind === 'stop') return stop();
    if (typeof approved !== 'boolean')
      throw new TypeError(
        'Executor approval must return a boolean or executor stop decision',
      );
    if (!approved)
      return request.route === 'code_mode' ? stop() : { action: 'deny' };
  }
  if (!callback) return { action: 'continue' };
  const deadline = performance.now() + environment.policyTimeout * 1000;
  const failure = new Error('Executor policy failed');
  let expired = false;
  const expire = () => {
    if (expired || signal.aborted) return;
    expired = true;
    fail(failure);
  };
  const timer = setTimeout(expire, environment.policyTimeout * 1000);
  try {
    const value = await callback(identity, supplied);
    if (performance.now() >= deadline) expire();
    signal.throwIfAborted();
    if (expired) throw failure;
    const decision = readExecutorPolicyDecision(value);
    if (!before) {
      if (decision)
        throw new TypeError('Executor result transforms must return JSON data');
      return { action: 'replace', value: copyJsonValue(value) };
    }
    if (decision?.kind === 'stop') return stop();
    if (decision?.kind === 'allow') return { action: 'continue' };
    const replacement =
      decision?.kind === 'replace'
        ? decision.value
        : losslessJsonValueSchema.parse(value);
    if (
      name.name === 'apply_patch'
        ? typeof replacement !== 'string'
        : replacement === null ||
          typeof replacement !== 'object' ||
          Array.isArray(replacement)
    )
      throw new TypeError(
        'Executor arguments must be a patch string or a command/stdin JSON object',
      );
    return { action: 'replace', value: replacement };
  } finally {
    clearTimeout(timer);
    if (performance.now() >= deadline) expire();
  }
}
