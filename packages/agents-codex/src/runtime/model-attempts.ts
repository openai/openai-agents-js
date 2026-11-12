import { z } from 'zod';
import { losslessJsonObjectSchema, type JsonObject } from './binding';
import type { ModelRequest, NativeModel } from './models';
import type { RetryPolicy } from './model-retry';
import {
  addRunUsage,
  captureUsageReport,
  mergeRunUsage,
  nonnegativeTokenCountWireSchema,
  parseTokenCount,
  runUsageSnapshot,
  type RunUsage,
  type TokenCount,
  type TokenUsage,
} from './run-events';

export interface ModelAttemptFailure {
  readonly attemptId: string;
  readonly error: unknown;
  readonly request: ModelRequest;
  readonly model: NativeModel;
  readonly advice: NativeModel['getRetryAdvice'];
  readonly policy?: RetryPolicy;
}
/** One bounded slot on the existing root/child owner, never a global error cache. */
export interface ModelAttemptState {
  native?: CapturedModelAttempt;
  additive: RunUsage;
  failure?: ModelAttemptFailure;
  sources?: Set<ModelAttemptState>;
  terminalError?: { readonly attemptId: string; readonly error: unknown };
}
export interface ModelAttemptOwner {
  tokenUsage: TokenUsage | null;
  requests: TokenCount;
  missingUsageRequests: TokenCount;
  modelAttempts?: ModelAttemptState;
}
const nativeUsage = z.object({
  requests: nonnegativeTokenCountWireSchema,
  requests_without_token_usage: nonnegativeTokenCountWireSchema,
  token_usage: losslessJsonObjectSchema.nullable(),
});
export const modelAttemptSnapshotSchema = z.object({
  owner_attempt_id: z.string().min(1).nullable(),
  usage: nativeUsage,
  terminal_attempt_id: z.string().min(1).nullable(),
});
export interface CapturedModelAttempt {
  readonly ownerAttemptId: string | null;
  readonly usage: RunUsage;
  readonly wire: z.infer<typeof modelAttemptSnapshotSchema>;
  readonly terminalAttemptId: string | null;
}
export function captureModelAttemptSnapshot(
  value: unknown,
): CapturedModelAttempt {
  const wire = modelAttemptSnapshotSchema.parse(value);
  const usage = runUsageSnapshot(
    wire.usage.token_usage === null
      ? null
      : addRunUsage(null, wire.usage.token_usage),
    parseTokenCount(wire.usage.requests),
    parseTokenCount(wire.usage.requests_without_token_usage),
  );
  if (BigInt(usage.missingUsageRequests) > BigInt(usage.requests))
    throw new TypeError('Native missing-usage count exceeds model requests');
  if (
    wire.owner_attempt_id === null &&
    (BigInt(usage.requests) !== 0n || wire.terminal_attempt_id !== null)
  )
    throw new TypeError('Native model usage is missing its ledger owner');
  const raw = captureUsageReport(usage, 0).raw;
  wire.usage.token_usage =
    wire.usage.token_usage === null ? null : Object.freeze(raw);
  Object.freeze(wire.usage);
  Object.freeze(wire);
  return Object.freeze({
    ownerAttemptId: wire.owner_attempt_id,
    usage,
    wire,
    terminalAttemptId: wire.terminal_attempt_id,
  });
}
export function modelAttemptState(owner: ModelAttemptOwner): ModelAttemptState {
  return (owner.modelAttempts ??= {
    additive: runUsageSnapshot(
      owner.tokenUsage,
      owner.requests,
      owner.missingUsageRequests,
    ),
  });
}
export function retainModelAttemptFailure(
  owner: ModelAttemptOwner,
  failure: ModelAttemptFailure,
): void {
  const state = modelAttemptState(owner);
  state.failure = failure;
}
export function modelAttemptOriginalError(
  owner: ModelAttemptOwner,
  attemptId: unknown,
): { readonly error: unknown } | undefined {
  const current = owner.modelAttempts?.failure;
  return current && current.attemptId === attemptId ? current : undefined;
}
function stateUsage(state: ModelAttemptState): RunUsage {
  let total = mergeRunUsage(
    state.native?.usage ?? runUsageSnapshot(null),
    state.additive,
  );
  for (const source of state.sources ?? [])
    total = mergeRunUsage(total, stateUsage(source));
  return total;
}
export function modelAttemptUsage(owner: ModelAttemptOwner): RunUsage {
  return owner.modelAttempts
    ? stateUsage(owner.modelAttempts)
    : runUsageSnapshot(
        owner.tokenUsage,
        owner.requests,
        owner.missingUsageRequests,
      );
}
/** Attach the existing physical owner without copying or replacing its parent's totals. */
export function attachModelUsageSource(
  owner: ModelAttemptOwner,
  source: ModelAttemptOwner,
): void {
  (modelAttemptState(owner).sources ??= new Set()).add(
    modelAttemptState(source),
  );
}
function publish(owner: ModelAttemptOwner, state: ModelAttemptState): void {
  const total = stateUsage(state);
  owner.tokenUsage = total;
  owner.requests = total.requests;
  owner.missingUsageRequests = total.missingUsageRequests;
}
/** Exact native integers, only from the existing captured typed usage report. */
export function modelAttemptUsageJson(usage: TokenUsage): string {
  const { raw } = captureUsageReport(usage, 0);
  return JSON.stringify(raw, (_key, value: unknown) =>
    typeof value === 'string' ? JSON.rawJSON(value) : value,
  );
}
/** Replace cumulative native counters; explicit tool reports remain separately additive. */
export function applyModelAttemptSnapshot(
  owner: ModelAttemptOwner,
  value: unknown,
): void {
  applyCaptured(owner, captureModelAttemptSnapshot(value));
}
function applyCaptured(
  owner: ModelAttemptOwner,
  native: CapturedModelAttempt,
): void {
  const state = modelAttemptState(owner);
  state.native = native;
  const terminal = state.native.terminalAttemptId;
  const failure =
    state.failure?.attemptId === terminal ? state.failure : undefined;
  if (terminal !== null && failure) {
    state.terminalError = { attemptId: terminal, error: failure.error };
    state.failure = undefined;
  }
  publish(owner, state);
}
const factSchema = modelAttemptSnapshotSchema.extend({
  attempt_id: z.string().min(1),
  phase: z.enum([
    'started',
    'measured',
    'finished',
    'retry',
    'terminal',
    'cancelled',
  ]),
});
export function applyModelAttemptFact(
  owner: ModelAttemptOwner,
  value: unknown,
): void {
  const fact = factSchema.parse(value);
  const captured = captureModelAttemptSnapshot(fact);
  const state = modelAttemptState(owner);
  if (
    fact.phase === 'retry' ||
    fact.phase === 'cancelled' ||
    fact.phase === 'started'
  ) {
    state.failure = undefined;
    state.terminalError = undefined;
  }
  applyCaptured(owner, captured);
}
export function addModelReportedUsage(
  owner: ModelAttemptOwner,
  raw: JsonObject,
  requests: TokenCount,
  missing: TokenCount,
): void {
  const state = modelAttemptState(owner);
  state.additive = mergeRunUsage(
    state.additive,
    runUsageSnapshot(addRunUsage(null, raw), requests, missing),
  );
  publish(owner, state);
}
export function restoreModelUsageOffset(
  owner: ModelAttemptOwner,
  usage: RunUsage,
): void {
  modelAttemptState(owner).additive = mergeRunUsage(
    runUsageSnapshot(null),
    usage,
  );
  publish(owner, modelAttemptState(owner));
}
export function modelAttemptTerminalError(
  owner: ModelAttemptOwner,
): { readonly error: unknown } | undefined {
  const state = owner.modelAttempts;
  return state?.terminalError?.attemptId === state?.native?.terminalAttemptId
    ? state?.terminalError
    : undefined;
}
export function releaseModelAttemptPayload(owner: ModelAttemptOwner): void {
  if (owner.modelAttempts) {
    owner.modelAttempts.failure = undefined;
    owner.modelAttempts.terminalError = undefined;
  }
}
