import type {
  Model,
  ModelRequest,
  ModelResponse,
  ModelRetryAdvice,
  ModelRetryAdviceRequest,
  ModelRetryBackoffSettings,
  ModelRetryNormalizedError,
  ModelSettings,
  RetryDecision,
  RetryPolicy,
  RetryPolicyContext,
} from '../model';
import { ModelTimeoutError, UserError } from '../errors';
import type { StreamEvent } from '../types/protocol';
import { RequestUsage, Usage } from '../usage';

const DEFAULT_INITIAL_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 2_000;
const DEFAULT_BACKOFF_MULTIPLIER = 2;
const DEFAULT_BACKOFF_JITTER = true;
const RETRY_AFTER_MS_HEADER = 'retry-after-ms';
const RETRY_AFTER_HEADER = 'retry-after';
const MAX_MODEL_TIMEOUT_MS = 2_147_483_647;

type ResolvedRetryDecision = {
  retry: boolean;
  delayMs?: number;
  reason?: string;
  approveUnsafeReplay?: boolean;
};

// Marks internal veto and approval decisions without widening the public API.
const hardVetoSymbol = Symbol('hardRetryVeto');
const delegableReplayVetoSymbol = Symbol('delegableReplayVeto');
const replaySafeApprovalSymbol = Symbol('replaySafeApproval');
const providerRetryAuthoritySymbol = Symbol('providerRetryAuthority');

type ProviderRetryAuthority = Readonly<{
  suggested?: boolean;
  replaySafety: 'safe' | 'unsafe' | 'unknown';
  responseStarted?: boolean;
}>;

type InternalRetryDecision = ResolvedRetryDecision & {
  [hardVetoSymbol]?: true;
  [delegableReplayVetoSymbol]?: true;
  [replaySafeApprovalSymbol]?: true;
};

type InternalRetryPolicyContext = RetryPolicyContext & {
  [providerRetryAuthoritySymbol]?: ProviderRetryAuthority;
};

type EvaluateRetryParams = {
  error: unknown;
  attempt: number;
  maxRetries: number;
  retryPolicy?: RetryPolicy;
  retryBackoff?: ModelRetryBackoffSettings;
  signal?: AbortSignal;
  stream: boolean;
  request: ModelRequest;
  emittedVisibleEvent: boolean;
  emittedRawModelEvent: boolean;
  providerAdvice?: ModelRetryAdvice;
  allowUnsafeStreamReplayApproval?: boolean;
};

type ModelRetryHandlers = {
  onModelTimeout?: () => void;
  onPossiblyAcceptedRequestFailure?: () => void;
};

type ModelAttemptScope = {
  request: ModelRequest;
  cleanup: () => void;
  normalizeError: (error: unknown) => unknown;
  timeoutError: () => ModelTimeoutError | undefined;
  timedOut: () => boolean;
};

function addFailedRetryAttemptsToUsage(
  usage: Usage,
  failedRetryAttempts: number,
): Usage {
  if (failedRetryAttempts <= 0) {
    return usage;
  }

  const inferredEndpoint = usage.requestUsageEntries?.[0]?.endpoint;
  const requestUsageEntries = [
    ...Array.from(
      { length: failedRetryAttempts },
      () =>
        new RequestUsage({
          endpoint: inferredEndpoint,
        }),
    ),
    ...(usage.requestUsageEntries?.map((entry) => new RequestUsage(entry)) ?? [
      new RequestUsage({
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        inputTokensDetails: usage.inputTokensDetails[0],
        outputTokensDetails: usage.outputTokensDetails[0],
        endpoint: inferredEndpoint,
      }),
    ]),
  ];

  return new Usage({
    requests: usage.requests + failedRetryAttempts,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    inputTokensDetails: usage.inputTokensDetails,
    outputTokensDetails: usage.outputTokensDetails,
    requestUsageEntries,
  });
}

function withRunnerManagedRetry(request: ModelRequest): ModelRequest {
  return Object.assign({}, request, {
    _internal: {
      ...request._internal,
      runnerManagedRetry: true,
    },
  });
}

function shouldDisableProviderManagedRetry(
  request: ModelRequest,
  attempt: number,
): boolean {
  if (typeof request.modelSettings.retry === 'undefined') {
    return false;
  }

  return attempt > 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function validateModelTimeoutMs(
  modelSettings: ModelSettings,
): number | undefined {
  const timeoutMs = modelSettings.timeoutMs;
  if (timeoutMs === undefined) {
    return undefined;
  }
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_MODEL_TIMEOUT_MS
  ) {
    throw new UserError(
      `modelSettings.timeoutMs must be a positive finite number less than or equal to ${MAX_MODEL_TIMEOUT_MS} when provided.`,
    );
  }
  return timeoutMs;
}

export function validateModelMaxRetries(modelSettings: ModelSettings): number {
  const maxRetries = modelSettings.retry?.maxRetries ?? 0;
  if (
    !Number.isFinite(maxRetries) ||
    maxRetries < 0 ||
    !Number.isInteger(maxRetries)
  ) {
    throw new UserError(
      'modelSettings.retry.maxRetries must be a non-negative finite integer when provided.',
    );
  }
  return maxRetries;
}

function createModelTimeoutError(
  timeoutMs: number,
  cause?: unknown,
): ModelTimeoutError {
  return new ModelTimeoutError({ timeoutMs, cause });
}

function createModelAttemptScope(
  request: ModelRequest,
  timeoutMs: number | undefined,
): ModelAttemptScope {
  if (timeoutMs === undefined) {
    return {
      request,
      cleanup: () => {},
      normalizeError: (error) => error,
      timeoutError: () => undefined,
      timedOut: () => false,
    };
  }

  const controller = new AbortController();
  const parentSignal = request.signal;
  let didTimeOut = false;
  let timeoutError: ModelTimeoutError | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const clearAttemptTimeout = () => {
    if (timeout !== undefined) {
      clearTimeout(timeout);
      timeout = undefined;
    }
  };
  const detachParentAbort = () => {
    parentSignal?.removeEventListener('abort', onParentAbort);
  };
  const onParentAbort = () => {
    clearAttemptTimeout();
    detachParentAbort();
    controller.abort(parentSignal?.reason);
  };

  if (parentSignal?.aborted) {
    onParentAbort();
  } else {
    parentSignal?.addEventListener('abort', onParentAbort, { once: true });
    timeout = setTimeout(() => {
      didTimeOut = true;
      timeoutError = createModelTimeoutError(timeoutMs);
      timeout = undefined;
      detachParentAbort();
      controller.abort(timeoutError);
    }, timeoutMs);
  }

  const cleanup = () => {
    clearAttemptTimeout();
    detachParentAbort();
  };

  return {
    request: {
      ...request,
      signal: controller.signal,
    },
    cleanup,
    normalizeError: (error) => {
      if (parentSignal?.aborted) {
        try {
          throwAbortError(parentSignal);
        } catch (parentError) {
          return parentError;
        }
      }
      if (!didTimeOut) {
        return error;
      }
      if (error === timeoutError) {
        return error;
      }
      return createModelTimeoutError(timeoutMs, error);
    },
    timeoutError: () => timeoutError,
    timedOut: () => didTimeOut,
  };
}

function isStatefulRequest(request: ModelRequest): boolean {
  return Boolean(request.previousResponseId || request.conversationId);
}

function asError(value: unknown): Error | undefined {
  return value instanceof Error ? value : undefined;
}

function getNestedError(value: unknown): Error | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const cause = value.cause;
  return cause instanceof Error ? cause : undefined;
}

function getErrorMessage(error: unknown): string {
  return asError(error)?.message ?? '';
}

function getErrorName(error: unknown): string | undefined {
  return asError(error)?.name;
}

function getErrorCode(error: unknown): string | undefined {
  if (isRecord(error)) {
    if (typeof error.code === 'string') {
      return error.code;
    }
    if (typeof error.errorCode === 'string') {
      return error.errorCode;
    }
  }
  const cause = getNestedError(error);
  return cause ? getErrorCode(cause) : undefined;
}

function getStatusCode(error: unknown): number | undefined {
  if (isRecord(error)) {
    if (typeof error.statusCode === 'number') {
      return error.statusCode;
    }
    if (typeof error.status === 'number') {
      return error.status;
    }
  }
  const cause = getNestedError(error);
  return cause ? getStatusCode(cause) : undefined;
}

function isAbortLikeError(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') {
    return true;
  }
  const DomExceptionCtor =
    typeof DOMException !== 'undefined' ? DOMException : undefined;
  if (
    DomExceptionCtor &&
    error instanceof DomExceptionCtor &&
    error.name === 'AbortError'
  ) {
    return true;
  }
  const cause = getNestedError(error);
  return cause ? isAbortLikeError(cause) : false;
}

function isNetworkLikeError(error: unknown): boolean {
  const name = getErrorName(error);
  if (
    name === 'APIConnectionError' ||
    name === 'APIConnectionTimeoutError' ||
    name === 'FetchError'
  ) {
    return true;
  }

  const code = getErrorCode(error);
  if (
    code === 'ECONNABORTED' ||
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'connection_closed_before_opening' ||
    code === 'connection_closed_before_terminal_response_event' ||
    code === 'EHOSTUNREACH' ||
    code === 'ENETUNREACH' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'EPIPE' ||
    code === 'socket_not_open' ||
    code === 'ETIMEDOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT'
  ) {
    return true;
  }

  const message = getErrorMessage(error).toLowerCase();
  if (
    message.includes('fetch failed') ||
    message.includes('network error') ||
    message.includes('connection error') ||
    message === 'terminated' ||
    message.includes('socket hang up')
  ) {
    return true;
  }

  const cause = getNestedError(error);
  return cause ? isNetworkLikeError(cause) : false;
}

function extractHeaders(
  value: unknown,
): Headers | Record<string, string> | undefined {
  if (!value) {
    return undefined;
  }

  if (typeof Headers !== 'undefined' && value instanceof Headers) {
    return value;
  }

  if (isRecord(value)) {
    if (typeof Headers !== 'undefined' && value.headers instanceof Headers) {
      return value.headers;
    }
    if (
      typeof Headers !== 'undefined' &&
      value.responseHeaders instanceof Headers
    ) {
      return value.responseHeaders;
    }
    if (value.responseHeaders && isRecord(value.responseHeaders)) {
      return Object.fromEntries(
        Object.entries(value.responseHeaders).flatMap(([key, headerValue]) =>
          typeof headerValue === 'string' ? [[key, headerValue]] : [],
        ),
      );
    }
    if (
      value.response &&
      isRecord(value.response) &&
      value.response.headers instanceof Headers
    ) {
      return value.response.headers;
    }
  }

  const cause = getNestedError(value);
  return cause ? extractHeaders(cause) : undefined;
}

function getHeaderValue(
  headers: Headers | Record<string, string> | undefined,
  key: string,
): string | undefined {
  if (!headers) {
    return undefined;
  }

  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return headers.get(key) ?? undefined;
  }

  const normalizedKey = key.toLowerCase();
  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (headerName.toLowerCase() === normalizedKey) {
      return headerValue;
    }
  }

  return undefined;
}

function parseRetryAfterDateOrSeconds(value: string): number | undefined {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1_000);
  }

  const parsedDate = Date.parse(value);
  if (!Number.isNaN(parsedDate)) {
    const delayMs = parsedDate - Date.now();
    return delayMs > 0 ? delayMs : undefined;
  }

  return undefined;
}

function getRetryAfterMs(
  headers: Headers | Record<string, string> | undefined,
): number | undefined {
  const retryAfterMs = getHeaderValue(headers, RETRY_AFTER_MS_HEADER);
  if (retryAfterMs !== undefined) {
    const parsedMs = Number(retryAfterMs);
    if (Number.isFinite(parsedMs) && parsedMs >= 0) {
      return parsedMs;
    }
  }

  const retryAfter = getHeaderValue(headers, RETRY_AFTER_HEADER);
  if (!retryAfter) {
    return undefined;
  }

  return parseRetryAfterDateOrSeconds(retryAfter);
}

function normalizeRetryError(
  error: unknown,
  signal: AbortSignal | undefined,
  providerAdvice?: ModelRetryAdvice,
): ModelRetryNormalizedError {
  const isModelTimeout = error instanceof ModelTimeoutError;
  const headers = extractHeaders(error);
  const normalized: ModelRetryNormalizedError = {
    statusCode: getStatusCode(error),
    retryAfterMs: getRetryAfterMs(headers),
    errorCode: getErrorCode(error),
    isNetworkError: isNetworkLikeError(error),
    isAbort:
      !isModelTimeout && (Boolean(signal?.aborted) || isAbortLikeError(error)),
  };

  if (providerAdvice?.retryAfterMs !== undefined) {
    normalized.retryAfterMs = providerAdvice.retryAfterMs;
  }

  const providerNormalized = providerAdvice?.normalized;
  return {
    ...normalized,
    ...(providerNormalized ?? {}),
    // Provider normalization may add abort evidence but cannot clear evidence
    // inferred from the signal or raw exception.
    isAbort:
      !isModelTimeout &&
      (normalized.isAbort || providerNormalized?.isAbort === true),
  };
}

function createProviderRetryAuthority(
  providerAdvice: ModelRetryAdvice | undefined,
): ProviderRetryAuthority {
  const replaySafety = providerAdvice?.replaySafety;
  return Object.freeze({
    suggested: providerAdvice?.suggested,
    replaySafety:
      replaySafety === 'safe' || replaySafety === 'unsafe'
        ? replaySafety
        : 'unknown',
    responseStarted: providerAdvice?.responseStarted,
  });
}

function withTimeoutReplayAuthority(
  providerAdvice: ModelRetryAdvice | undefined,
  timedOut: boolean,
): ModelRetryAdvice | undefined {
  if (!timedOut || providerAdvice?.replaySafety === 'safe') {
    return providerAdvice;
  }
  return {
    ...providerAdvice,
    replaySafety: 'unsafe',
  };
}

function requestMayHaveBeenAccepted(
  authority: ProviderRetryAuthority,
): boolean {
  return (
    authority.replaySafety === 'unsafe' || authority.responseStarted === true
  );
}

function withProviderRetryAuthority(
  context: RetryPolicyContext,
  authority = createProviderRetryAuthority(context.providerAdvice),
): InternalRetryPolicyContext {
  const existing = (context as InternalRetryPolicyContext)[
    providerRetryAuthoritySymbol
  ];
  if (existing) {
    return context as InternalRetryPolicyContext;
  }

  const internalContext = { ...context } as InternalRetryPolicyContext;
  Object.defineProperties(internalContext, {
    replaySafety: {
      value: authority.replaySafety,
      enumerable: true,
    },
    responseStarted: {
      value: authority.responseStarted,
      enumerable: true,
    },
    statefulRequest: {
      value:
        context.statefulRequest ??
        Boolean(context.previousResponseId || context.conversationId),
      enumerable: true,
    },
    [providerRetryAuthoritySymbol]: {
      value: authority,
    },
  });
  return internalContext;
}

function getProviderRetryAuthority(
  context: RetryPolicyContext,
): ProviderRetryAuthority {
  return (
    (context as InternalRetryPolicyContext)[providerRetryAuthoritySymbol] ??
    createProviderRetryAuthority(context.providerAdvice)
  );
}

function resolveRetryDecision(decision: RetryDecision): ResolvedRetryDecision {
  if (typeof decision === 'boolean') {
    return { retry: decision };
  }
  return decision;
}

function markInternalDecision(
  decision: ResolvedRetryDecision,
  symbol: symbol,
): InternalRetryDecision {
  const marked = { ...decision } as InternalRetryDecision;
  Object.defineProperty(marked, symbol, {
    value: true,
    enumerable: false,
    configurable: true,
  });
  return marked;
}

function withHardVeto(decision: ResolvedRetryDecision): InternalRetryDecision {
  return markInternalDecision(decision, hardVetoSymbol);
}

function withDelegableReplayVeto(
  decision: ResolvedRetryDecision,
): InternalRetryDecision {
  const marked = withHardVeto(decision);
  Object.defineProperty(marked, delegableReplayVetoSymbol, {
    value: true,
    enumerable: false,
    configurable: true,
  });
  return marked;
}

function withReplaySafeApproval(
  decision: ResolvedRetryDecision,
): InternalRetryDecision {
  return markInternalDecision(decision, replaySafeApprovalSymbol);
}

function isHardVeto(
  decision: ResolvedRetryDecision,
): decision is InternalRetryDecision {
  return (
    typeof decision === 'object' &&
    decision !== null &&
    hardVetoSymbol in decision &&
    decision[hardVetoSymbol] === true
  );
}

function isDelegableReplayVeto(
  decision: ResolvedRetryDecision,
): decision is InternalRetryDecision {
  return (
    isHardVeto(decision) &&
    delegableReplayVetoSymbol in decision &&
    decision[delegableReplayVetoSymbol] === true
  );
}

function isReplaySafeApproval(
  decision: ResolvedRetryDecision,
): decision is InternalRetryDecision {
  return (
    typeof decision === 'object' &&
    decision !== null &&
    replaySafeApprovalSymbol in decision &&
    decision[replaySafeApprovalSymbol] === true
  );
}

function withUnsafeReplayApproval(
  decision: ResolvedRetryDecision,
  approveUnsafeReplay: boolean,
): ResolvedRetryDecision {
  if (!approveUnsafeReplay || decision.approveUnsafeReplay) {
    return decision;
  }

  const approved = {
    ...decision,
    approveUnsafeReplay: true,
  };
  return isReplaySafeApproval(decision)
    ? withReplaySafeApproval(approved)
    : approved;
}

function resolveDelegableReplayVeto(
  veto: ResolvedRetryDecision,
  approving: ResolvedRetryDecision,
): ResolvedRetryDecision {
  if (!approving.retry || !approving.approveUnsafeReplay) {
    return veto;
  }

  const resolved: ResolvedRetryDecision = {
    retry: true,
    delayMs: approving.delayMs,
    reason: approving.reason ?? veto.reason,
    approveUnsafeReplay: true,
  };
  return isReplaySafeApproval(approving)
    ? withReplaySafeApproval(resolved)
    : resolved;
}

function getDefaultDelayMs(
  attempt: number,
  backoff: ModelRetryBackoffSettings | undefined,
): number {
  const initialDelayMs = backoff?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const maxDelayMs = backoff?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const multiplier = backoff?.multiplier ?? DEFAULT_BACKOFF_MULTIPLIER;
  const jitter = backoff?.jitter ?? DEFAULT_BACKOFF_JITTER;
  const exponent = Math.max(0, attempt - 1);
  const cappedDelayMs = Math.min(
    initialDelayMs * multiplier ** exponent,
    maxDelayMs,
  );

  if (!jitter) {
    return cappedDelayMs;
  }

  return Math.round(cappedDelayMs * (0.875 + Math.random() * 0.25));
}

function throwAbortError(signal: AbortSignal | undefined): never {
  const reason = signal?.reason;
  if (reason instanceof Error) {
    throw reason;
  }

  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  throw error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throwAbortError(signal);
  }
}

function throwIfTimedModelCallParentAborted(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): void {
  if (timeoutMs !== undefined) {
    throwIfAborted(signal);
  }
}

async function awaitWithTimedModelCallParentAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): Promise<T> {
  if (timeoutMs === undefined || !signal) {
    return await promise;
  }
  if (signal.aborted) {
    throwAbortError(signal);
  }
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      try {
        throwAbortError(signal);
      } catch (error) {
        reject(error);
      }
    };
    const cleanup = () => {
      signal.removeEventListener('abort', onAbort);
    };

    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

async function waitForRetryDelay(
  signal: AbortSignal | undefined,
  delayMs: number,
): Promise<void> {
  if (delayMs <= 0) {
    if (signal?.aborted) {
      throwAbortError(signal);
    }
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);

    const onAbort = () => {
      cleanup();
      try {
        throwAbortError(signal);
      } catch (error) {
        reject(error);
      }
    };

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function getRetryAdvice(
  model: Model,
  args: ModelRetryAdviceRequest,
): Promise<ModelRetryAdvice | undefined> {
  const getModelRetryAdvice = model.getRetryAdvice;
  if (typeof getModelRetryAdvice !== 'function') {
    return undefined;
  }
  return await getModelRetryAdvice.call(model, args);
}

async function evaluateRetry({
  error,
  attempt,
  maxRetries,
  retryPolicy,
  retryBackoff,
  signal,
  stream,
  request,
  emittedVisibleEvent,
  emittedRawModelEvent,
  providerAdvice,
  allowUnsafeStreamReplayApproval,
}: EvaluateRetryParams): Promise<ResolvedRetryDecision> {
  if (attempt > maxRetries) {
    return { retry: false };
  }

  const normalized = normalizeRetryError(error, signal, providerAdvice);
  const authority = createProviderRetryAuthority(providerAdvice);
  const context = withProviderRetryAuthority(
    {
      error,
      attempt,
      maxRetries,
      stream,
      providerAdvice,
      normalized,
      previousResponseId: request.previousResponseId,
      conversationId: request.conversationId,
    },
    authority,
  );

  // Aborts and emitted stream events are absolute vetoes. Provider-unsafe
  // streaming failures also remain blocked before application policy runs.
  if (
    normalized.isAbort ||
    emittedVisibleEvent ||
    emittedRawModelEvent ||
    (stream &&
      authority.replaySafety === 'unsafe' &&
      !allowUnsafeStreamReplayApproval)
  ) {
    return {
      retry: false,
      reason: providerAdvice?.reason,
    };
  }

  if (!retryPolicy) {
    return { retry: false };
  }

  const decision = resolveRetryDecision(await retryPolicy(context));
  if (!decision.retry) {
    return decision;
  }

  const statefulRequest = context.statefulRequest === true;
  const providerMarksReplaySafe = authority.replaySafety === 'safe';
  const providerMarksReplayUnsafe = authority.replaySafety === 'unsafe';
  if (
    statefulRequest &&
    !(
      isReplaySafeApproval(decision) ||
      providerMarksReplaySafe ||
      (decision.approveUnsafeReplay && providerMarksReplayUnsafe)
    )
  ) {
    return {
      retry: false,
      reason: decision.reason ?? providerAdvice?.reason,
    };
  }
  if (
    providerMarksReplayUnsafe &&
    !(isReplaySafeApproval(decision) || decision.approveUnsafeReplay)
  ) {
    return {
      retry: false,
      reason: decision.reason ?? providerAdvice?.reason,
    };
  }

  return {
    retry: true,
    delayMs:
      decision.delayMs ??
      normalized.retryAfterMs ??
      getDefaultDelayMs(attempt, retryBackoff),
    reason: decision.reason ?? providerAdvice?.reason,
    approveUnsafeReplay: decision.approveUnsafeReplay,
  };
}

export const retryPolicies = {
  never(): RetryPolicy {
    return () => false;
  },

  providerSuggested(): RetryPolicy {
    return (inputContext) => {
      const context = withProviderRetryAuthority(inputContext);
      const authority = getProviderRetryAuthority(context);
      const { providerAdvice, normalized } = context;
      if (authority.suggested === false) {
        const veto = {
          retry: false,
          reason: providerAdvice?.reason,
        };
        return authority.replaySafety === 'unsafe'
          ? withDelegableReplayVeto(veto)
          : withHardVeto(veto);
      }
      if (authority.suggested !== true) {
        return false;
      }
      const decision = {
        retry: true,
        delayMs: providerAdvice?.retryAfterMs ?? normalized.retryAfterMs,
        reason: providerAdvice?.reason,
      };
      return authority.replaySafety === 'safe'
        ? withReplaySafeApproval(decision)
        : decision;
    };
  },

  networkError(): RetryPolicy {
    return ({ normalized }) => normalized.isNetworkError;
  },

  httpStatus(statuses: number[]): RetryPolicy {
    const allowed = new Set(statuses);
    return ({ normalized }) =>
      normalized.statusCode !== undefined && allowed.has(normalized.statusCode);
  },

  retryAfter(): RetryPolicy {
    return ({ normalized }) => {
      if (normalized.retryAfterMs === undefined) {
        return false;
      }
      return {
        retry: true,
        delayMs: normalized.retryAfterMs,
      };
    };
  },

  any(...policies: RetryPolicy[]): RetryPolicy {
    return async (inputContext) => {
      const context = withProviderRetryAuthority(inputContext);
      let firstRetryDecision: ResolvedRetryDecision | undefined;
      let lastObjectDecision: ResolvedRetryDecision | undefined;
      let delegableReplayVeto: ResolvedRetryDecision | undefined;

      for (const policy of policies) {
        const rawDecision = await policy(context);
        const decision = resolveRetryDecision(rawDecision);
        if (isHardVeto(decision)) {
          if (isDelegableReplayVeto(decision)) {
            delegableReplayVeto ??= decision;
            continue;
          }
          return decision;
        }
        if (decision.retry) {
          const approveUnsafeReplay = Boolean(
            firstRetryDecision?.approveUnsafeReplay ||
            decision.approveUnsafeReplay,
          );
          if (
            firstRetryDecision === undefined ||
            (isReplaySafeApproval(decision) &&
              !isReplaySafeApproval(firstRetryDecision))
          ) {
            firstRetryDecision = decision;
          }
          firstRetryDecision = withUnsafeReplayApproval(
            firstRetryDecision,
            approveUnsafeReplay,
          );
          continue;
        }
        if (typeof rawDecision !== 'boolean') {
          lastObjectDecision = decision;
        }
      }
      if (delegableReplayVeto) {
        return firstRetryDecision
          ? resolveDelegableReplayVeto(delegableReplayVeto, firstRetryDecision)
          : delegableReplayVeto;
      }
      if (firstRetryDecision) {
        return firstRetryDecision;
      }
      return lastObjectDecision ?? false;
    };
  },

  all(...policies: RetryPolicy[]): RetryPolicy {
    return async (inputContext) => {
      const context = withProviderRetryAuthority(inputContext);
      if (policies.length === 0) {
        return false;
      }

      let merged: ResolvedRetryDecision = { retry: true };
      let delegableReplayVeto: ResolvedRetryDecision | undefined;
      for (const policy of policies) {
        const decision = resolveRetryDecision(await policy(context));
        if (isHardVeto(decision)) {
          if (isDelegableReplayVeto(decision)) {
            delegableReplayVeto ??= decision;
            continue;
          }
          return decision;
        }
        if (!decision.retry) {
          return false;
        }
        if (decision.delayMs !== undefined) {
          merged.delayMs = decision.delayMs;
        }
        if (decision.reason !== undefined) {
          merged.reason = decision.reason;
        }
        if (decision.approveUnsafeReplay) {
          merged.approveUnsafeReplay = true;
        }
        if (isReplaySafeApproval(decision)) {
          merged = withReplaySafeApproval(merged);
        }
      }
      if (delegableReplayVeto) {
        return resolveDelegableReplayVeto(delegableReplayVeto, merged);
      }
      return merged;
    };
  },
} as const;

export async function getResponseWithRetry(
  model: Model,
  request: ModelRequest,
  handlers: ModelRetryHandlers = {},
): Promise<ModelResponse> {
  const maxRetries = validateModelMaxRetries(request.modelSettings);
  const retryPolicy = request.modelSettings.retry?.policy;
  const retryBackoff = request.modelSettings.retry?.backoff;
  const timeoutMs = validateModelTimeoutMs(request.modelSettings);

  let attempt = 1;
  while (true) {
    const requestForAttempt = shouldDisableProviderManagedRetry(
      request,
      attempt,
    )
      ? withRunnerManagedRetry(request)
      : request;
    const attemptScope = createModelAttemptScope(requestForAttempt, timeoutMs);
    try {
      const response = await model.getResponse(attemptScope.request);
      throwIfTimedModelCallParentAborted(request.signal, timeoutMs);
      if (attemptScope.timedOut()) {
        throw (
          attemptScope.timeoutError() ?? createModelTimeoutError(timeoutMs!)
        );
      }
      if (attempt === 1) {
        return response;
      }
      return {
        ...response,
        usage: addFailedRetryAttemptsToUsage(response.usage, attempt - 1),
      };
    } catch (caughtError) {
      attemptScope.cleanup();
      const error = attemptScope.normalizeError(caughtError);
      let providerAdvice: ModelRetryAdvice | undefined;
      try {
        providerAdvice = await awaitWithTimedModelCallParentAbort(
          getRetryAdvice(model, {
            request,
            error: caughtError,
            stream: false,
            attempt,
          }),
          request.signal,
          timeoutMs,
        );
      } catch (retryAdviceError) {
        if (attemptScope.timedOut() && isStatefulRequest(request)) {
          handlers.onPossiblyAcceptedRequestFailure?.();
        }
        throwIfTimedModelCallParentAborted(request.signal, timeoutMs);
        throw retryAdviceError;
      }
      providerAdvice = withTimeoutReplayAuthority(
        providerAdvice,
        attemptScope.timedOut(),
      );
      const authority = createProviderRetryAuthority(providerAdvice);
      const markPossiblyAcceptedFailure = () => {
        if (
          requestMayHaveBeenAccepted(authority) ||
          (attemptScope.timedOut() &&
            isStatefulRequest(request) &&
            authority.replaySafety !== 'safe')
        ) {
          handlers.onPossiblyAcceptedRequestFailure?.();
        }
      };
      const throwIfParentAbortedAfterTimedFailure = () => {
        if (timeoutMs !== undefined && request.signal?.aborted) {
          markPossiblyAcceptedFailure();
          throwAbortError(request.signal);
        }
      };
      throwIfParentAbortedAfterTimedFailure();
      let decision: ResolvedRetryDecision;
      try {
        decision = await awaitWithTimedModelCallParentAbort(
          evaluateRetry({
            error,
            attempt,
            maxRetries,
            retryPolicy,
            retryBackoff,
            signal: request.signal,
            stream: false,
            request,
            emittedVisibleEvent: false,
            emittedRawModelEvent: false,
            providerAdvice,
          }),
          request.signal,
          timeoutMs,
        );
      } catch (retryError) {
        markPossiblyAcceptedFailure();
        throwIfTimedModelCallParentAborted(request.signal, timeoutMs);
        throw retryError;
      }
      throwIfParentAbortedAfterTimedFailure();

      if (!decision.retry) {
        markPossiblyAcceptedFailure();
        throw error;
      }

      try {
        await waitForRetryDelay(request.signal, decision.delayMs ?? 0);
      } catch (retryDelayError) {
        markPossiblyAcceptedFailure();
        throw retryDelayError;
      }
      attempt += 1;
    } finally {
      attemptScope.cleanup();
    }
  }
}

export async function* getStreamedResponseWithRetry(
  model: Model,
  request: ModelRequest,
  handlers: ModelRetryHandlers = {},
): AsyncIterable<StreamEvent> {
  const maxRetries = validateModelMaxRetries(request.modelSettings);
  const retryPolicy = request.modelSettings.retry?.policy;
  const retryBackoff = request.modelSettings.retry?.backoff;
  const timeoutMs = validateModelTimeoutMs(request.modelSettings);

  let attempt = 1;
  while (true) {
    let emittedVisibleEvent = false;
    let emittedRawModelEvent = false;
    const requestForAttempt = shouldDisableProviderManagedRetry(
      request,
      attempt,
    )
      ? withRunnerManagedRetry(request)
      : request;
    const attemptScope = createModelAttemptScope(requestForAttempt, timeoutMs);
    try {
      for await (const event of model.getStreamedResponse(
        attemptScope.request,
      )) {
        throwIfTimedModelCallParentAborted(request.signal, timeoutMs);
        if (attemptScope.timedOut()) {
          throw (
            attemptScope.timeoutError() ?? createModelTimeoutError(timeoutMs!)
          );
        }
        if (event.type === 'model') {
          emittedRawModelEvent = true;
        }
        emittedVisibleEvent = true;
        if (event.type === 'response_done') {
          attemptScope.cleanup();
        }
        if (event.type === 'response_done' && attempt > 1) {
          yield {
            ...event,
            response: {
              ...event.response,
              usage: addFailedRetryAttemptsToUsage(
                new Usage(event.response.usage),
                attempt - 1,
              ),
            },
          };
          continue;
        }
        yield event;
      }
      throwIfTimedModelCallParentAborted(request.signal, timeoutMs);
      if (attemptScope.timedOut()) {
        throw (
          attemptScope.timeoutError() ?? createModelTimeoutError(timeoutMs!)
        );
      }
      return;
    } catch (caughtError) {
      attemptScope.cleanup();
      const error = attemptScope.normalizeError(caughtError);
      const markTimedOutFailure = () => {
        if (attemptScope.timedOut()) {
          handlers.onModelTimeout?.();
        }
      };
      let providerAdvice: ModelRetryAdvice | undefined;
      try {
        providerAdvice = await awaitWithTimedModelCallParentAbort(
          getRetryAdvice(model, {
            request,
            error: caughtError,
            stream: true,
            attempt,
          }),
          request.signal,
          timeoutMs,
        );
      } catch (retryAdviceError) {
        markTimedOutFailure();
        if (attemptScope.timedOut() && isStatefulRequest(request)) {
          handlers.onPossiblyAcceptedRequestFailure?.();
        }
        throwIfTimedModelCallParentAborted(request.signal, timeoutMs);
        throw retryAdviceError;
      }
      providerAdvice = withTimeoutReplayAuthority(
        providerAdvice,
        attemptScope.timedOut(),
      );
      const authority = createProviderRetryAuthority(providerAdvice);
      const markPossiblyAcceptedFailure = () => {
        if (
          requestMayHaveBeenAccepted(authority) ||
          (attemptScope.timedOut() &&
            isStatefulRequest(request) &&
            authority.replaySafety !== 'safe')
        ) {
          handlers.onPossiblyAcceptedRequestFailure?.();
        }
      };
      const throwIfParentAbortedAfterTimedFailure = () => {
        if (timeoutMs !== undefined && request.signal?.aborted) {
          markPossiblyAcceptedFailure();
          throwAbortError(request.signal);
        }
      };
      throwIfParentAbortedAfterTimedFailure();
      let decision: ResolvedRetryDecision;
      try {
        decision = await awaitWithTimedModelCallParentAbort(
          evaluateRetry({
            error,
            attempt,
            maxRetries,
            retryPolicy,
            retryBackoff,
            signal: request.signal,
            stream: true,
            request,
            emittedVisibleEvent,
            emittedRawModelEvent,
            providerAdvice,
            allowUnsafeStreamReplayApproval: attemptScope.timedOut(),
          }),
          request.signal,
          timeoutMs,
        );
      } catch (retryError) {
        markTimedOutFailure();
        markPossiblyAcceptedFailure();
        throwIfTimedModelCallParentAborted(request.signal, timeoutMs);
        throw retryError;
      }
      throwIfParentAbortedAfterTimedFailure();

      if (!decision.retry) {
        markTimedOutFailure();
        markPossiblyAcceptedFailure();
        throw error;
      }

      try {
        await waitForRetryDelay(request.signal, decision.delayMs ?? 0);
      } catch (retryDelayError) {
        markTimedOutFailure();
        markPossiblyAcceptedFailure();
        throw retryDelayError;
      }
      attempt += 1;
    } finally {
      attemptScope.cleanup();
    }
  }
}
