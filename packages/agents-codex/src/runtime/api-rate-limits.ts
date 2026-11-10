import type { JsonObject, JsonValue } from './binding';
import { parseTokenCount } from './run-events';

/** One provider-reported window. Missing values stay unknown. */
export interface ApiRateLimitWindow {
  readonly limit?: number | bigint;
  readonly remaining?: number | bigint;
  readonly resetAfterSeconds?: number;
}

/** Latest usable provider limits and retry advice. An absent field is unknown. */
export interface ApiRateLimits {
  readonly requests?: ApiRateLimitWindow;
  readonly tokens?: ApiRateLimitWindow;
  readonly projectTokens?: ApiRateLimitWindow;
  readonly retryAfterSeconds?: number;
  /** Absolute UTC retry time in ISO 8601 form when the provider sends a date. */
  readonly retryAt?: string;
}

const seconds = { h: 3600, m: 60, s: 1, ms: 1e-3, us: 1e-6, ns: 1e-9 };
const duration = /^(?:[0-9]+(?:\.[0-9]+)?(?:ms|us|ns|h|m|s))+$/;

function object(value: JsonValue | undefined): JsonObject | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
}

function count(value: JsonValue | undefined): number | bigint | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return;
  // The native bridge emits decimal text for integers beyond Number.MAX_SAFE_INTEGER.
  const parsed = parseTokenCount(value);
  return parsed >= 0 ? parsed : undefined;
}

function window(value: JsonValue | undefined): ApiRateLimitWindow | undefined {
  const fields = object(value);
  if (!fields) return;
  const limit = count(fields.limit);
  const remaining = count(fields.remaining);
  const reset = fields.reset_after;
  let resetAfterSeconds: number | undefined;
  if (typeof reset === 'string' && reset.length <= 64 && duration.test(reset)) {
    resetAfterSeconds = 0;
    for (const [, amount, unit] of reset.matchAll(
      /([0-9]+(?:\.[0-9]+)?)(ms|us|ns|h|m|s)/g,
    )) {
      resetAfterSeconds +=
        Number(amount) * seconds[unit as keyof typeof seconds];
    }
  }
  if (
    limit === undefined &&
    remaining === undefined &&
    resetAfterSeconds === undefined
  )
    return;
  return Object.freeze({
    ...(limit === undefined ? {} : { limit }),
    ...(remaining === undefined ? {} : { remaining }),
    ...(resetAfterSeconds === undefined ? {} : { resetAfterSeconds }),
  });
}

/** @internal Project only fields already allowlisted by native code. */
export function apiRateLimits(
  value: JsonValue | undefined,
): ApiRateLimits | undefined {
  const fields = object(value);
  if (!fields) return;
  const requests = window(fields.requests);
  const tokens = window(fields.tokens);
  const projectTokens = window(fields.project_tokens);
  let retryAfterSeconds: number | undefined;
  let retryAt: string | undefined;
  const retry = fields.retry_after;
  if (typeof retry === 'string' && retry.length <= 64) {
    if (/^[0-9]+$/.test(retry)) {
      const delay = Number(retry);
      if (Number.isSafeInteger(delay)) retryAfterSeconds = delay;
    } else {
      const deadline = Date.parse(retry);
      if (Number.isFinite(deadline)) retryAt = new Date(deadline).toISOString();
    }
  }
  if (
    !requests &&
    !tokens &&
    !projectTokens &&
    retryAfterSeconds === undefined &&
    retryAt === undefined
  )
    return;
  return Object.freeze({
    ...(requests ? { requests } : {}),
    ...(tokens ? { tokens } : {}),
    ...(projectTokens ? { projectTokens } : {}),
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    ...(retryAt === undefined ? {} : { retryAt }),
  });
}
