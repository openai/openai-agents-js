import type {
  ModelRetryAdvice,
  ModelRetryAdviceRequest,
} from '@openai/agents-core';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isUnsafeToReplayError(error: unknown): boolean {
  return isRecord(error) && error.unsafeToReplay === true;
}

function getHeaderValue(error: unknown, key: string): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  const headerSources = [error.headers, error.responseHeaders];
  for (const source of headerSources) {
    if (!source) {
      continue;
    }

    if (typeof Headers !== 'undefined' && source instanceof Headers) {
      return source.get(key) ?? undefined;
    }

    if (isRecord(source)) {
      const normalizedKey = key.toLowerCase();
      for (const [headerName, headerValue] of Object.entries(source)) {
        if (
          headerName.toLowerCase() === normalizedKey &&
          typeof headerValue === 'string'
        ) {
          return headerValue;
        }
      }
    }
  }

  return undefined;
}

function getStatusCode(error: unknown): number | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  if (typeof error.statusCode === 'number') {
    return error.statusCode;
  }

  if (typeof error.status === 'number') {
    return error.status;
  }

  return undefined;
}

function isStatefulReplayRequest(
  request: ModelRetryAdviceRequest['request'],
): boolean {
  return Boolean(request.conversationId || request.previousResponseId);
}

export function getOpenAIRetryAdvice(
  args: ModelRetryAdviceRequest,
): ModelRetryAdvice | undefined {
  const { error, request } = args;
  if (isUnsafeToReplayError(error)) {
    return {
      suggested: false,
      replaySafety: 'unsafe',
      reason: error instanceof Error ? error.message : undefined,
    };
  }

  const errorMessage =
    error instanceof Error ? error.message.toLowerCase() : undefined;
  const shouldRetryHeader = getHeaderValue(error, 'x-should-retry')
    ?.toLowerCase()
    .trim();

  if (
    errorMessage?.includes(
      'the request may have been accepted, so the sdk will not automatically retry this websocket request.',
    )
  ) {
    return {
      suggested: false,
      replaySafety: 'unsafe',
      reason: error instanceof Error ? error.message : undefined,
    };
  }

  if (shouldRetryHeader === 'true') {
    return {
      suggested: true,
      replaySafety: 'safe',
      reason: error instanceof Error ? error.message : undefined,
    };
  }

  if (shouldRetryHeader === 'false') {
    return {
      suggested: false,
      reason: error instanceof Error ? error.message : undefined,
    };
  }

  const statusCode = getStatusCode(error);
  if (
    !isStatefulReplayRequest(request) &&
    // Mirror the OpenAI SDK fallback retry statuses when x-should-retry is absent.
    // This is specific to the OpenAI provider contract and should not automatically
    // be mirrored in the AI SDK adapter, which depends on provider-specific guidance.
    (statusCode === 408 ||
      statusCode === 409 ||
      statusCode === 429 ||
      (typeof statusCode === 'number' && statusCode >= 500))
  ) {
    return {
      suggested: true,
      reason: error instanceof Error ? error.message : undefined,
    };
  }

  return undefined;
}
