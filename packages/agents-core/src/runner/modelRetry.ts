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

type ResolvedRetryDecision = {
  retry: boolean;
  delayMs?: number;
  reason?: string;
};

// Marks internal veto decisions that should stop retryPolicies.any() immediately.
const hardVetoSymbol = Symbol('hardRetryVeto');
const replaySafeApprovalSymbol = Symbol('replaySafeApproval');

type InternalRetryDecision = ResolvedRetryDecision & {
  [hardVetoSymbol]?: true;
  [replaySafeApprovalSymbol]?: true;
};

type EvaluateRetryParams = {
  error: unknown;
  attempt: number;
  maxRetries: number;
  retryPolicy?: RetryPolicy;
  retryBackoff?: ModelRetryBackoffSettings;
  signal?: AbortSignal;
  stream: boolean;
  replayUnsafeRequest: boolean;
  emittedVisibleEvent: boolean;
  emittedRawModelEvent: boolean;
  providerAdvice?: ModelRetryAdvice;
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

  return {
    ...normalized,
    ...(providerAdvice?.normalized ?? {}),
  };
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

function isStatefulConversationRequest(request: ModelRequest): boolean {
  return Boolean(request.conversationId || request.previousResponseId);
}

async function evaluateRetry({
  error,
  attempt,
  maxRetries,
  retryPolicy,
  retryBackoff,
  signal,
  stream,
  replayUnsafeRequest,
  emittedVisibleEvent,
  emittedRawModelEvent,
  providerAdvice,
}: EvaluateRetryParams): Promise<ResolvedRetryDecision> {
  if (attempt > maxRetries) {
    return { retry: false };
  }

  const normalized = normalizeRetryError(error, signal, providerAdvice);
  if (
    normalized.isAbort ||
    emittedVisibleEvent ||
    emittedRawModelEvent ||
    providerAdvice?.replaySafety === 'unsafe'
  ) {
    return {
      retry: false,
      reason: providerAdvice?.reason,
    };
  }

  if (!retryPolicy) {
    return { retry: false };
  }

  const context: RetryPolicyContext = {
    error,
    attempt,
    maxRetries,
    stream,
    providerAdvice,
    normalized,
  };
  const decision = resolveRetryDecision(await retryPolicy(context));
  if (!decision.retry) {
    return decision;
  }
  if (replayUnsafeRequest && !isReplaySafeApproval(decision)) {
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
  };
}

export const retryPolicies = {
  never(): RetryPolicy {
    return () => false;
  },

  providerSuggested(): RetryPolicy {
    return ({ providerAdvice, normalized }) => {
      if (providerAdvice?.suggested === false) {
        return withHardVeto({
          retry: false,
          reason: providerAdvice.reason,
        });
      }
      if (!providerAdvice?.suggested) {
        return false;
      }
      const decision = {
        retry: true,
        delayMs: providerAdvice.retryAfterMs ?? normalized.retryAfterMs,
        reason: providerAdvice.reason,
      };
      return providerAdvice.replaySafety === 'safe'
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
    return async (context) => {
      let firstRetryDecision: ResolvedRetryDecision | undefined;
      let lastObjectDecision: ResolvedRetryDecision | undefined;

      for (const policy of policies) {
        const rawDecision = await policy(context);
        const decision = resolveRetryDecision(rawDecision);
        if (isHardVeto(decision)) {
          return decision;
        }
        if (decision.retry) {
          if (
            firstRetryDecision === undefined ||
            (isReplaySafeApproval(decision) &&
              !isReplaySafeApproval(firstRetryDecision))
          ) {
            firstRetryDecision = decision;
          }
          continue;
        }
        if (typeof rawDecision !== 'boolean') {
          lastObjectDecision = decision;
        }
      }
      if (firstRetryDecision) {
        return firstRetryDecision;
      }
      return lastObjectDecision ?? false;
    };
  },

  all(...policies: RetryPolicy[]): RetryPolicy {
    return async (context) => {
      if (policies.length === 0) {
        return false;
      }

      let merged: ResolvedRetryDecision = { retry: true };
      for (const policy of policies) {
        const decision = resolveRetryDecision(await policy(context));
        if (isHardVeto(decision)) {
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
        if (isReplaySafeApproval(decision)) {
          merged = withReplaySafeApproval(merged);
        }
      }
      return merged;
    };
  },
} as const;

export async function getResponseWithRetry(
  model: Model,
  request: ModelRequest,
): Promise<ModelResponse> {
  const maxRetries = request.modelSettings.retry?.maxRetries ?? 0;
  const retryPolicy = request.modelSettings.retry?.policy;
  const retryBackoff = request.modelSettings.retry?.backoff;

  let attempt = 1;
  const replayUnsafeRequest = isStatefulConversationRequest(request);
  while (true) {
    const requestForAttempt = shouldDisableProviderManagedRetry(
      request,
      attempt,
    )
      ? withRunnerManagedRetry(request)
      : request;
    try {
      const response = await model.getResponse(requestForAttempt);
      if (attempt === 1) {
        return response;
      }
      return {
        ...response,
        usage: addFailedRetryAttemptsToUsage(response.usage, attempt - 1),
      };
    } catch (error) {
      const providerAdvice = await getRetryAdvice(model, {
        request,
        error,
        stream: false,
        attempt,
      });
      const decision = await evaluateRetry({
        error,
        attempt,
        maxRetries,
        retryPolicy,
        retryBackoff,
        signal: request.signal,
        stream: false,
        replayUnsafeRequest,
        emittedVisibleEvent: false,
        emittedRawModelEvent: false,
        providerAdvice,
      });

      if (!decision.retry) {
        throw error;
      }

      await waitForRetryDelay(request.signal, decision.delayMs ?? 0);
      attempt += 1;
    }
  }
}

export async function* getStreamedResponseWithRetry(
  model: Model,
  request: ModelRequest,
): AsyncIterable<StreamEvent> {
  const maxRetries = request.modelSettings.retry?.maxRetries ?? 0;
  const retryPolicy = request.modelSettings.retry?.policy;
  const retryBackoff = request.modelSettings.retry?.backoff;

  let attempt = 1;
  const replayUnsafeRequest = isStatefulConversationRequest(request);
  while (true) {
    let emittedVisibleEvent = false;
    let emittedRawModelEvent = false;
    const requestForAttempt = shouldDisableProviderManagedRetry(
      request,
      attempt,
    )
      ? withRunnerManagedRetry(request)
      : request;
    try {
      for await (const event of model.getStreamedResponse(requestForAttempt)) {
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
    } catch (error) {
      const providerAdvice = await getRetryAdvice(model, {
        request,
        error,
        stream: true,
        attempt,
      });
      const decision = await evaluateRetry({
        error,
        attempt,
        maxRetries,
        retryPolicy,
        retryBackoff,
        signal: request.signal,
        stream: true,
        replayUnsafeRequest,
        emittedVisibleEvent,
        emittedRawModelEvent,
        providerAdvice,
      });

      if (!decision.retry) {
        throw error;
      }

      await waitForRetryDelay(request.signal, decision.delayMs ?? 0);
      attempt += 1;
    }
  }
}
