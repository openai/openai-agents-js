import { UserError } from '../errors';
import type {
  Model,
  ModelRequest,
  ModelResponse,
  ModelRetryAdvice,
  ModelRetryAdviceRequest,
  ModelRetryBackoffSettings,
  ModelRetryNormalizedError,
  RetryDecision,
  RetryPolicy,
  RetryPolicyContext,
} from '../model';
import type { StreamEvent } from '../types/protocol';
import { RequestUsage, Usage } from '../usage';

const DEFAULT_INITIAL_DELAY_MS = 250;
const DEFAULT_MAX_DELAY_MS = 2_000;
const DEFAULT_BACKOFF_MULTIPLIER = 2;
const DEFAULT_BACKOFF_JITTER = true;
const RETRY_AFTER_MS_HEADER = 'retry-after-ms';
const RETRY_AFTER_HEADER = 'retry-after';
const MAX_TIMER_DELAY_MS = 2_147_483_647;

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
};

type ModelRetryHandlers = {
  onPossiblyAcceptedRequestFailure?: () => void;
};

type ModelAttemptTimeoutError = Error & {
  code: 'ETIMEDOUT';
  timeoutMs: number;
  unsafeToReplay?: true;
  responseStarted?: true;
};

type ModelAttemptScope = {
  request: ModelRequest;
  cleanup: () => void;
  normalizeError: (error: unknown) => unknown;
  race: <T>(operation: Promise<T>) => Promise<T>;
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

function getModelAttemptTimeoutMs(request: ModelRequest): number | undefined {
  const timeoutMs = request.modelSettings.retry?.attemptTimeoutMs;
  if (timeoutMs === undefined) {
    return undefined;
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new UserError(
      'modelSettings.retry.attemptTimeoutMs must be a positive finite number when provided.',
    );
  }
  if (timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new UserError(
      `modelSettings.retry.attemptTimeoutMs must be less than or equal to ${MAX_TIMER_DELAY_MS}ms.`,
    );
  }
  return timeoutMs;
}

function createModelAttemptTimeoutError(
  timeoutMs: number,
  source?: unknown,
): ModelAttemptTimeoutError {
  const error = Object.assign(
    new Error(`Model request attempt timed out after ${timeoutMs}ms.`),
    {
      name: 'ModelAttemptTimeoutError',
      code: 'ETIMEDOUT' as const,
      timeoutMs,
    },
  ) as ModelAttemptTimeoutError;

  if (source !== undefined) {
    Object.defineProperty(error, 'cause', {
      value: source,
      configurable: true,
    });
  }

  if (isRecord(source)) {
    if (source.unsafeToReplay === true) {
      error.unsafeToReplay = true;
    }
    if (source.responseStarted === true) {
      error.responseStarted = true;
    }
  }
  return error;
}

function isModelAttemptTimeoutError(
  error: unknown,
): error is ModelAttemptTimeoutError {
  return (
    isRecord(error) &&
    error.name === 'ModelAttemptTimeoutError' &&
    error.code === 'ETIMEDOUT' &&
    typeof error.timeoutMs === 'number'
  );
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
      race: async <T>(operation: Promise<T>) => await operation,
    };
  }

  const controller = new AbortController();
  const parentSignal = request.signal;
  let timedOut = false;
  let timeoutError: ModelAttemptTimeoutError | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let rejectDeadline: ((error: unknown) => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject;
  });

  const onParentAbort = () => {
    controller.abort(parentSignal?.reason);
  };

  if (parentSignal?.aborted) {
    onParentAbort();
  } else {
    parentSignal?.addEventListener('abort', onParentAbort, { once: true });
    timeout = setTimeout(() => {
      timedOut = true;
      timeoutError = createModelAttemptTimeoutError(timeoutMs);
      controller.abort(timeoutError);
      queueMicrotask(() => rejectDeadline?.(timeoutError));
    }, timeoutMs);
  }

  const cleanup = () => {
    if (timeout !== undefined) {
      clearTimeout(timeout);
      timeout = undefined;
    }
    parentSignal?.removeEventListener('abort', onParentAbort);
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
      if (!timedOut) {
        return error;
      }
      if (error === timeoutError) {
        return error;
      }
      return createModelAttemptTimeoutError(timeoutMs, error);
    },
    race: async <T>(operation: Promise<T>) =>
      await Promise.race([operation, deadline]),
  };
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
  const headers = extractHeaders(error);
  const normalized: ModelRetryNormalizedError = {
    statusCode: getStatusCode(error),
    retryAfterMs: getRetryAfterMs(headers),
    errorCode: getErrorCode(error),
    isNetworkError: isNetworkLikeError(error),
    isAbort: Boolean(signal?.aborted) || isAbortLikeError(error),
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
    isAbort: normalized.isAbort || providerNormalized?.isAbort === true,
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

function requestMayHaveBeenAccepted(
  authority: ProviderRetryAuthority,
  request: ModelRequest,
  error: unknown,
): boolean {
  const statefulRequest = Boolean(
    request.previousResponseId || request.conversationId,
  );
  const timedOutWithUnknownAcceptance =
    statefulRequest &&
    authority.replaySafety !== 'safe' &&
    isModelAttemptTimeoutError(error);
  return (
    authority.replaySafety === 'unsafe' ||
    authority.responseStarted === true ||
    timedOutWithUnknownAcceptance
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

function getRetryAdviceError(error: unknown): unknown {
  if (
    isModelAttemptTimeoutError(error) &&
    isRecord(error) &&
    error.cause !== undefined
  ) {
    return error.cause;
  }
  return error;
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
    (stream && authority.replaySafety === 'unsafe')
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
  const maxRetries = request.modelSettings.retry?.maxRetries ?? 0;
  const retryPolicy = request.modelSettings.retry?.policy;
  const retryBackoff = request.modelSettings.retry?.backoff;
  const attemptTimeoutMs = getModelAttemptTimeoutMs(request);

  let attempt = 1;
  while (true) {
    const requestForAttempt = shouldDisableProviderManagedRetry(
      request,
      attempt,
    )
      ? withRunnerManagedRetry(request)
      : request;
    const attemptScope = createModelAttemptScope(
      requestForAttempt,
      attemptTimeoutMs,
    );
    try {
      const response = await attemptScope.race(
        model.getResponse(attemptScope.request),
      );
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
        providerAdvice = await getRetryAdvice(model, {
          request,
          error: getRetryAdviceError(error),
          stream: false,
          attempt,
        });
      } catch (adviceError) {
        if (
          requestMayHaveBeenAccepted(
            createProviderRetryAuthority(undefined),
            request,
            error,
          )
        ) {
          handlers.onPossiblyAcceptedRequestFailure?.();
        }
        throw adviceError;
      }
      const authority = createProviderRetryAuthority(providerAdvice);
      const markPossiblyAcceptedFailure = () => {
        if (requestMayHaveBeenAccepted(authority, request, error)) {
          handlers.onPossiblyAcceptedRequestFailure?.();
        }
      };
      let decision: ResolvedRetryDecision;
      try {
        decision = await evaluateRetry({
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
        });
      } catch (retryError) {
        markPossiblyAcceptedFailure();
        throw retryError;
      }

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
  const maxRetries = request.modelSettings.retry?.maxRetries ?? 0;
  const retryPolicy = request.modelSettings.retry?.policy;
  const retryBackoff = request.modelSettings.retry?.backoff;
  const attemptTimeoutMs = getModelAttemptTimeoutMs(request);

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
    const attemptScope = createModelAttemptScope(
      requestForAttempt,
      attemptTimeoutMs,
    );
    try {
      const iterator = model
        .getStreamedResponse(attemptScope.request)
        [Symbol.asyncIterator]();
      while (true) {
        const next = await attemptScope.race(iterator.next());
        if (next.done) {
          break;
        }
        const event = next.value;
        if (event.type === 'model') {
          emittedRawModelEvent = true;
        }
        emittedVisibleEvent = true;
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
      return;
    } catch (caughtError) {
      attemptScope.cleanup();
      const error = attemptScope.normalizeError(caughtError);
      let providerAdvice: ModelRetryAdvice | undefined;
      try {
        providerAdvice = await getRetryAdvice(model, {
          request,
          error: getRetryAdviceError(error),
          stream: true,
          attempt,
        });
      } catch (adviceError) {
        if (
          requestMayHaveBeenAccepted(
            createProviderRetryAuthority(undefined),
            request,
            error,
          )
        ) {
          handlers.onPossiblyAcceptedRequestFailure?.();
        }
        throw adviceError;
      }
      const authority = createProviderRetryAuthority(providerAdvice);
      const markPossiblyAcceptedFailure = () => {
        if (requestMayHaveBeenAccepted(authority, request, error)) {
          handlers.onPossiblyAcceptedRequestFailure?.();
        }
      };
      let decision: ResolvedRetryDecision;
      try {
        decision = await evaluateRetry({
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
        });
      } catch (retryError) {
        markPossiblyAcceptedFailure();
        throw retryError;
      }

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
