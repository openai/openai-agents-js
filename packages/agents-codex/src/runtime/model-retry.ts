import { z } from 'zod';
import {
  retryPolicies as sharedPolicies,
  type RetryDecision as SharedDecision,
  type RetryPolicyContext as SharedContext,
} from '@openai/agents-core';
import type { ModelRequest } from './models';
import type { JsonObject } from './binding';

export interface RetryNormalizedError {
  readonly statusCode?: number;
  readonly errorCode?: string;
  readonly message?: string;
  readonly requestId?: string;
  readonly retryAfterMs?: number;
  readonly isAbort: boolean;
  readonly isNetworkError: boolean;
  readonly isTimeout: boolean;
}
export interface ModelRetryAdvice {
  readonly normalized?: Readonly<Partial<RetryNormalizedError>>;
  readonly suggested?: boolean;
  readonly retryAfterMs?: number;
  readonly replaySafety?: 'safe' | 'unsafe' | 'unknown';
  readonly reason?: string;
  /** Provider response-start evidence; omitted when unknown. */
  readonly responseStarted?: boolean;
}
export interface RetryContext {
  readonly attemptId: string;
  /** One-based policy budget index, excluding compatibility-only retries. */
  readonly attempt: number;
  /** Actual logical request ordinal, including compatibility-only retries. */
  readonly requestAttempt: number;
  readonly maxRetries: number;
  readonly model: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly transport: string;
  /** Whether the failed request used streaming, when the request mode is known. */
  readonly stream?: boolean;
  readonly signal: AbortSignal;
  readonly error: unknown;
  readonly normalizedError: RetryNormalizedError;
  readonly providerAdvice?: ModelRetryAdvice;
  readonly responseStarted: boolean;
  readonly retryUnsafeOutput: boolean;
  readonly localEffects: boolean;
  readonly stateful: boolean;
  readonly previousResponseId?: string;
  readonly conversationId?: string;
}
export interface RetryDecision {
  readonly retry: boolean;
  readonly delayMs?: number;
  readonly reason?: string;
  readonly approveUnsafeReplay?: boolean;
}
export type RetryPolicy = (
  context: RetryContext,
) => RetryDecision | Promise<RetryDecision>;
export interface ModelRetryAdviceRequest {
  readonly request: ModelRequest;
  readonly error: unknown;
  readonly attemptId: string;
  readonly attempt: number;
  /** Whether the failed request selected a streaming producer. */
  readonly stream?: boolean;
  /** The live logical owner, independent of the retired request's signal. */
  readonly signal: AbortSignal;
}
export interface ModelRetryBackoffSettings {
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly multiplier?: number;
  readonly jitter?: boolean;
}
export interface ModelRetrySettings {
  readonly maxRetries?: number;
  readonly backoff?: ModelRetryBackoffSettings;
  /** Captured runtime callback; excluded from native/persisted configuration. */
  readonly policy?: RetryPolicy;
}

/** @internal Capture callbacks and nested settings before opening can await. */
export function captureModelRetrySettings(
  value: ModelRetrySettings,
): ModelRetrySettings {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('retry must be a settings object or null');
  const result: {
    maxRetries?: number;
    backoff?: ModelRetryBackoffSettings;
    policy?: RetryPolicy;
  } = {};
  for (const key of Object.getOwnPropertyNames(value)) {
    if (!['maxRetries', 'backoff', 'policy'].includes(key))
      throw new TypeError('Unsupported retry setting');
    const selected = (value as Record<string, unknown>)[key];
    if (selected === undefined) continue;
    if (key === 'maxRetries') {
      if (
        typeof selected !== 'number' ||
        !Number.isInteger(selected) ||
        selected < 0 ||
        selected > 4294967295
      )
        throw new TypeError(
          'maxRetries must be an integer in the range 0..4294967295',
        );
      result.maxRetries = selected;
    } else if (key === 'policy') {
      if (typeof selected !== 'function')
        throw new TypeError('retry.policy must be callable');
      result.policy = selected as RetryPolicy;
    } else {
      if (!selected || typeof selected !== 'object' || Array.isArray(selected))
        throw new TypeError('retry.backoff must be an object');
      const backoff: Record<string, number | boolean> = {};
      for (const name of Object.getOwnPropertyNames(selected)) {
        if (
          !['initialDelayMs', 'maxDelayMs', 'multiplier', 'jitter'].includes(
            name,
          )
        )
          throw new TypeError('Unsupported retry backoff setting');
        const part = (selected as Record<string, unknown>)[name];
        if (part === undefined) continue;
        if (
          name === 'jitter'
            ? typeof part !== 'boolean'
            : typeof part !== 'number' || !Number.isFinite(part) || part < 0
        )
          throw new TypeError('Invalid retry backoff setting');
        backoff[name] = part as number | boolean;
      }
      result.backoff = Object.freeze(backoff);
    }
  }
  return Object.freeze(result);
}

/** @internal Native configuration only; callback authority stays with its owner. */
export function retrySettingsToNative(value: ModelRetrySettings): JsonObject {
  const selected = captureModelRetrySettings(value);
  const result: JsonObject = { configured: true };
  if (selected.policy !== undefined) result.has_policy = true;
  if (selected.maxRetries !== undefined)
    result.max_retries = selected.maxRetries;
  if (selected.backoff !== undefined) {
    const backoff: JsonObject = {};
    for (const [key, wire] of Object.entries({
      initialDelayMs: 'initial_delay_ms',
      maxDelayMs: 'max_delay_ms',
      multiplier: 'multiplier',
      jitter: 'jitter',
    })) {
      const part = selected.backoff[key as keyof ModelRetryBackoffSettings];
      if (part !== undefined) backoff[wire] = part;
    }
    result.backoff = backoff;
  }
  return result;
}

function snapshot(context: RetryContext): RetryContext {
  return Object.freeze({
    ...context,
    normalizedError: Object.freeze({ ...context.normalizedError }),
    providerAdvice:
      context.providerAdvice === undefined
        ? undefined
        : Object.freeze({
            ...context.providerAdvice,
            ...(context.providerAdvice.normalized === undefined
              ? {}
              : {
                  normalized: Object.freeze({
                    ...context.providerAdvice.normalized,
                  }),
                }),
          }),
  });
}
/** @internal Provider observations cannot clear a native response-start fact. */
export function withModelRetryAdvice(
  context: RetryContext,
  advice: ModelRetryAdvice,
): RetryContext {
  return snapshot({
    ...context,
    providerAdvice: { ...context.providerAdvice, ...advice },
    responseStarted: context.responseStarted || advice.responseStarted === true,
    normalizedError: {
      ...context.normalizedError,
      ...(advice.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: advice.retryAfterMs }),
      ...advice.normalized,
      isAbort:
        context.normalizedError.isAbort || advice.normalized?.isAbort === true,
    },
  });
}

function shared(context: RetryContext): SharedContext {
  return {
    error: context.error,
    attempt: context.attempt,
    maxRetries: context.maxRetries,
    // Only the shared pure selectors/combinators consume this projection.
    // Core owns stream exposure and every final replay/cancellation veto.
    stream: false,
    normalized: context.normalizedError,
    providerAdvice:
      context.providerAdvice === undefined
        ? undefined
        : {
            ...context.providerAdvice,
            replaySafety:
              context.providerAdvice.replaySafety === 'unknown'
                ? undefined
                : context.providerAdvice.replaySafety,
          },
    previousResponseId: context.previousResponseId,
    conversationId: context.conversationId,
    statefulRequest: context.stateful,
    responseStarted: context.responseStarted,
  };
}
function decision(value: SharedDecision): RetryDecision {
  // Preserve the existing combinators' private hard/delegable veto markers.
  return typeof value === 'boolean' ? { retry: value } : value;
}
function select(policy: ReturnType<typeof sharedPolicies.never>): RetryPolicy {
  return async (context) => {
    context.signal.throwIfAborted();
    const result = decision(await policy(shared(snapshot(context))));
    context.signal.throwIfAborted();
    return result;
  };
}
/** Pure policy helpers. Core retains attempt budgets, waits and hard safety fences. */
export const retryPolicies = {
  never: (): RetryPolicy => select(sharedPolicies.never()),
  providerSuggested: (): RetryPolicy =>
    select(sharedPolicies.providerSuggested()),
  networkError: (): RetryPolicy => select(sharedPolicies.networkError()),
  retryAfter: (): RetryPolicy => select(sharedPolicies.retryAfter()),
  httpStatus: (statuses: readonly number[]): RetryPolicy =>
    select(sharedPolicies.httpStatus([...statuses])),
  all:
    (...policies: RetryPolicy[]): RetryPolicy =>
    async (context) => {
      const captured = snapshot(context);
      return decision(
        await sharedPolicies.all(
          ...policies.map((policy) => async () => {
            captured.signal.throwIfAborted();
            const value = await policy(captured);
            captured.signal.throwIfAborted();
            return value;
          }),
        )(shared(captured)),
      );
    },
  any:
    (...policies: RetryPolicy[]): RetryPolicy =>
    async (context) => {
      const captured = snapshot(context);
      return decision(
        await sharedPolicies.any(
          ...policies.map((policy) => async () => {
            captured.signal.throwIfAborted();
            const value = await policy(captured);
            captured.signal.throwIfAborted();
            return value;
          }),
        )(shared(captured)),
      );
    },
} as const;

/** @internal Capture only the supported advice fields before native dispatch. */
export function captureModelRetryAdvice(
  value: unknown,
): ModelRetryAdvice | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('getRetryAdvice must return retry advice or undefined');
  const row = value as Record<string, unknown>;
  const result: {
    suggested?: boolean;
    retryAfterMs?: number;
    replaySafety?: 'safe' | 'unsafe' | 'unknown';
    reason?: string;
    responseStarted?: boolean;
    normalized?: Readonly<Partial<RetryNormalizedError>>;
  } = {};
  for (const name of Object.getOwnPropertyNames(row)) {
    const part = row[name];
    if (
      ![
        'suggested',
        'retryAfterMs',
        'replaySafety',
        'reason',
        'responseStarted',
        'normalized',
      ].includes(name)
    )
      throw new TypeError('Unsupported model retry advice field');
    if (part === undefined) continue;
    if (name === 'normalized') {
      if (!part || typeof part !== 'object' || Array.isArray(part))
        throw new TypeError('normalized must be an options object');
      const normalized: Record<string, unknown> = {};
      for (const key of Object.getOwnPropertyNames(part)) {
        if (
          ![
            'statusCode',
            'errorCode',
            'message',
            'requestId',
            'retryAfterMs',
            'isAbort',
            'isNetworkError',
            'isTimeout',
          ].includes(key)
        )
          throw new TypeError('Unsupported normalized retry field');
        const value = (part as Record<string, unknown>)[key];
        const flag = ['isAbort', 'isNetworkError', 'isTimeout'].includes(key);
        if (value === undefined && flag) continue;
        const valid = flag
          ? typeof value === 'boolean'
          : value === undefined ||
            (key === 'statusCode'
              ? typeof value === 'number' && Number.isInteger(value)
              : key === 'retryAfterMs'
                ? typeof value === 'number' &&
                  Number.isFinite(value) &&
                  value >= 0
                : typeof value === 'string');
        if (!valid) throw new TypeError('Invalid normalized retry field');
        normalized[key] = value;
      }
      result.normalized = Object.freeze(normalized) as Readonly<
        Partial<RetryNormalizedError>
      >;
    } else if (name === 'suggested' && typeof part === 'boolean')
      result.suggested = part;
    else if (
      name === 'retryAfterMs' &&
      typeof part === 'number' &&
      Number.isFinite(part) &&
      part >= 0
    )
      result.retryAfterMs = part;
    else if (
      name === 'replaySafety' &&
      ['safe', 'unsafe', 'unknown'].includes(part as string)
    )
      result.replaySafety = part as 'safe' | 'unsafe' | 'unknown';
    else if (name === 'responseStarted' && typeof part === 'boolean')
      result.responseStarted = part;
    else if (name === 'reason' && typeof part === 'string')
      result.reason = part;
    else throw new TypeError('Invalid model retry advice field');
  }
  return Object.freeze(result);
}

/** @internal The native reply has no application objects or callable values. */
export function retryAdviceToNative(value: ModelRetryAdvice): JsonObject {
  const captured = captureModelRetryAdvice(value)!;
  return {
    ...(captured.suggested === undefined
      ? {}
      : { suggested: captured.suggested }),
    ...(captured.retryAfterMs === undefined
      ? {}
      : { retry_after_ms: captured.retryAfterMs }),
    ...(captured.replaySafety === undefined
      ? {}
      : { replay_safety: captured.replaySafety }),
    ...(captured.reason === undefined ? {} : { reason: captured.reason }),
  };
}

/** @internal Validate policy output without granting any replay authority. */
export function retryDecisionToNative(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Retry policy must return a retry decision');
  const row = value as Record<string, unknown>;
  if (
    Object.getOwnPropertyNames(row).some(
      (name) =>
        !['retry', 'delayMs', 'reason', 'approveUnsafeReplay'].includes(name),
    )
  )
    throw new TypeError('Unsupported retry decision field');
  if (!Object.hasOwn(row, 'retry'))
    throw new TypeError('Retry decision requires an own retry flag');
  const retry = row.retry;
  const delayMs = Object.hasOwn(row, 'delayMs') ? row.delayMs : undefined;
  const reason = Object.hasOwn(row, 'reason') ? row.reason : undefined;
  const approveUnsafeReplay = Object.hasOwn(row, 'approveUnsafeReplay')
    ? row.approveUnsafeReplay
    : undefined;
  if (
    typeof retry !== 'boolean' ||
    (delayMs !== undefined &&
      (typeof delayMs !== 'number' ||
        !Number.isFinite(delayMs) ||
        delayMs < 0)) ||
    (reason !== undefined && typeof reason !== 'string') ||
    (approveUnsafeReplay !== undefined &&
      typeof approveUnsafeReplay !== 'boolean')
  )
    throw new TypeError('Invalid retry decision');
  return {
    retry,
    ...(delayMs === undefined ? {} : { delay_ms: delayMs }),
    ...(reason === undefined ? {} : { reason }),
    approve_unsafe_replay: approveUnsafeReplay ?? false,
  };
}

export function modelErrorField(error: unknown, name: string): unknown {
  try {
    return error !== null &&
      (typeof error === 'object' || typeof error === 'function')
      ? (error as Record<string, unknown>)[name]
      : undefined;
  } catch {
    // Broken metadata must not replace the borrowed exception's identity.
    return undefined;
  }
}
/** @internal Read known transport metadata without copying the response or headers. */
export function modelErrorHeader(
  error: unknown,
  key: string,
): string | undefined {
  for (const field of ['headers', 'responseHeaders']) {
    const headers = modelErrorField(error, field);
    try {
      if (typeof Headers !== 'undefined' && headers instanceof Headers)
        return headers.get(key) ?? undefined;
      if (headers && typeof headers === 'object') {
        for (const name in headers)
          if (Object.hasOwn(headers, name) && name.toLowerCase() === key) {
            const value = (headers as Record<string, unknown>)[name];
            return typeof value === 'string' ? value : undefined;
          }
      }
    } catch {
      /* Malformed metadata cannot replace the original exception. */
    }
  }
  return undefined;
}
function errorRetryAfterMs(error: unknown): number | undefined {
  const explicit = modelErrorField(error, 'retryAfterMs');
  if (
    typeof explicit === 'number' &&
    Number.isFinite(explicit) &&
    explicit >= 0
  )
    return explicit;
  const milliseconds = modelErrorHeader(error, 'retry-after-ms');
  if (milliseconds?.trim()) {
    const parsed = Number(milliseconds);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  const seconds = modelErrorHeader(error, 'retry-after');
  if (!seconds?.trim()) return undefined;
  const parsed = Number(seconds);
  if (Number.isFinite(parsed) && parsed >= 0) return parsed * 1000;
  const deadline = Date.parse(seconds);
  return Number.isFinite(deadline)
    ? Math.max(0, deadline - Date.now())
    : undefined;
}
function modelErrorName(error: unknown): unknown {
  const name = modelErrorField(error, 'name');
  return name && name !== 'Error'
    ? name
    : modelErrorField(modelErrorField(error, 'constructor'), 'name');
}
/** @internal Callback cleanup classification inspects only the thrown error. */
export function isModelCallbackAbort(error: unknown): boolean {
  const name = modelErrorName(error);
  const code =
    modelErrorField(error, 'code') ?? modelErrorField(error, 'errorCode');
  return (
    name === 'AbortError' ||
    name === 'APIUserAbortError' ||
    code === 'ABORT_ERR' ||
    code === 'ERR_ABORTED'
  );
}
/** @internal Fixed metadata only; never serialize the borrowed error object. */
export function modelRetryFailureToNative(error: unknown): JsonObject {
  const name = modelErrorName(error);
  const code =
    modelErrorField(error, 'code') ??
    modelErrorField(error, 'errorCode') ??
    modelErrorField(modelErrorField(error, 'cause'), 'code');
  const message = modelErrorField(error, 'message');
  const status =
    modelErrorField(error, 'status') ?? modelErrorField(error, 'statusCode');
  const requestId =
    modelErrorField(error, 'request_id') ?? modelErrorField(error, 'requestID');
  const retryAfter = errorRetryAfterMs(error);
  return {
    message: typeof message === 'string' ? message : 'Model request failed',
    ...(typeof status === 'number' &&
    Number.isInteger(status) &&
    status >= 0 &&
    status <= 65535
      ? { status_code: status }
      : {}),
    ...(typeof code === 'string' ? { error_code: code } : {}),
    ...(typeof requestId === 'string' ? { request_id: requestId } : {}),
    ...(typeof retryAfter === 'number' &&
    Number.isFinite(retryAfter) &&
    retryAfter >= 0
      ? { retry_after_ms: retryAfter }
      : {}),
    is_abort:
      name === 'AbortError' ||
      name === 'APIUserAbortError' ||
      code === 'ABORT_ERR' ||
      code === 'ERR_ABORTED',
    is_timeout:
      name === 'TimeoutError' ||
      name === 'APIConnectionTimeoutError' ||
      code === 'ETIMEDOUT',
    is_network_error:
      name === 'FetchError' ||
      name === 'APIConnectionError' ||
      name === 'APIConnectionTimeoutError' ||
      [
        'ECONNRESET',
        'ECONNREFUSED',
        'ENOTFOUND',
        'EAI_AGAIN',
        'EPIPE',
        'ETIMEDOUT',
      ].includes(code as string),
  };
}

const retryContextWire = z.object({
  attempt_id: z.string().min(1),
  attempt: z.number().int().positive().safe(),
  request_attempt: z.number().int().positive().safe(),
  max_retries: z.number().int().min(0).max(4294967295),
  thread_id: z.string(),
  turn_id: z.string(),
  model: z.string(),
  transport: z.string(),
  policy_enabled: z.boolean(),
  normalized: z.object({
    status_code: z.number().int().min(0).max(65535).nullish(),
    error_code: z.string().nullish(),
    message: z.string(),
    request_id: z.string().nullish(),
    retry_after_ms: z.number().nonnegative().finite().nullish(),
    is_abort: z.boolean(),
    is_network_error: z.boolean(),
    is_timeout: z.boolean(),
  }),
  provider_advice: z
    .object({
      suggested: z.boolean().nullish(),
      retry_after_ms: z.number().nonnegative().finite().nullish(),
      replay_safety: z.enum(['safe', 'unsafe', 'unknown']).nullish(),
      reason: z.string().nullish(),
    })
    .nullish(),
  response_started: z.boolean(),
  retry_unsafe_output: z.boolean(),
  local_effects: z.boolean(),
  stateful: z.boolean(),
  previous_response_id: z.string().nullish(),
  conversation_id: z.string().nullish(),
});
/** @internal Detach native authority facts before invoking application policy. */
export function retryContextFromNative(
  data: unknown,
  signal: AbortSignal,
  error: unknown,
): {
  readonly context: RetryContext;
  readonly policyEnabled: boolean;
} {
  const value = retryContextWire.parse(data);
  const raw = value.normalized;
  const advice = value.provider_advice;
  return Object.freeze({
    policyEnabled: value.policy_enabled,
    context: snapshot({
      attemptId: value.attempt_id,
      attempt: value.attempt,
      requestAttempt: value.request_attempt,
      maxRetries: value.max_retries,
      model: value.model,
      threadId: value.thread_id,
      turnId: value.turn_id,
      transport: value.transport,
      ...(value.transport === 'responses_json'
        ? { stream: false }
        : value.transport === 'responses_sse' ||
            value.transport === 'responses_ws'
          ? { stream: true }
          : {}),
      signal,
      error,
      normalizedError: {
        statusCode: raw.status_code ?? undefined,
        errorCode: raw.error_code ?? undefined,
        message: raw.message,
        requestId: raw.request_id ?? undefined,
        retryAfterMs: raw.retry_after_ms ?? undefined,
        isAbort: raw.is_abort,
        isNetworkError: raw.is_network_error,
        isTimeout: raw.is_timeout,
      },
      providerAdvice:
        advice == null
          ? undefined
          : {
              suggested: advice.suggested ?? undefined,
              retryAfterMs: advice.retry_after_ms ?? undefined,
              replaySafety: advice.replay_safety ?? undefined,
              reason: advice.reason ?? undefined,
            },
      responseStarted: value.response_started,
      retryUnsafeOutput: value.retry_unsafe_output,
      localEffects: value.local_effects,
      stateful: value.stateful,
      previousResponseId: value.previous_response_id ?? undefined,
      conversationId: value.conversation_id ?? undefined,
    }),
  });
}
