import type { SessionStoreCleanup } from './custom-thread-store';
import { encode, type JsonObject } from './binding';
import type { GuardrailRecord } from './guardrails';
import type { UserInput } from './input';
import type { Agent } from './public-agent';
import type { Completed, ProducedItem } from './session';

/**
 * A one-shot run and its owned resource cleanup failed.
 * Retry cleanup.close() on this error; it closes the same resources without
 * repeating the run. Close can still report a diagnostic after retirement.
 * The original failure remains in cause and both failures remain in errors.
 */
export class RunCleanupError extends AggregateError {
  /** An owning wrapper has been retaining its completed result here. */
  declare result?: Completed<unknown>;
  readonly cleanup: { close(): Promise<void> };

  constructor(
    errors: unknown[],
    message: string,
    close: () => Promise<void>,
    options?: ErrorOptions,
  ) {
    super(errors, message, options);
    this.name = new.target.name;
    this.cleanup = Object.freeze({ close });
  }
}

/** Evidence retained before a failed one-shot submission closes. */
export interface RunErrorDetails {
  readonly input: UserInput | null;
  readonly lastAgent: Agent<any, any> | null;
  readonly items: readonly ProducedItem[];
  /** Detached canonical records when bounded capture succeeds. */
  readonly history?: readonly Record<string, unknown>[];
  /** Detached client JSON from retained provider observations. */
  readonly rawResponses: readonly JsonObject[];
  readonly guardrailResults: readonly GuardrailRecord[];
  /** Gaps in the available native evidence. */
  readonly incomplete: boolean;
}

/** An opted-in native run failure, with the original value as its cause. */
export class RunDiagnosticError extends Error {
  readonly #details: RunErrorDetails;

  constructor(details: RunErrorDetails, cause: unknown) {
    super('Native run failed', { cause });
    this.name = new.target.name;
    this.#details = details;
  }

  get details(): RunErrorDetails {
    return this.#details;
  }
}

/** Safe cause captured for the selected model-output failure, when known. */
export type ResponseIntegrityReason =
  | 'undecodable_output_item'
  | 'provider_owned_tool_receipt'
  | 'unfinished_assistant_item'
  | 'missing_supported_terminal_output'
  | 'provider_refusal'
  | 'malformed_probability_facts';

function responseIntegrityReason(
  value: unknown,
): ResponseIntegrityReason | null {
  return typeof value === 'string' &&
    [
      'undecodable_output_item',
      'provider_owned_tool_receipt',
      'unfinished_assistant_item',
      'missing_supported_terminal_output',
      'provider_refusal',
      'malformed_probability_facts',
    ].includes(value)
    ? (value as ResponseIntegrityReason)
    : null;
}

/** Observed native failure details. Missing values do not imply safe replay. */
export interface NativeErrorOptions extends ErrorOptions {
  statusCode?: number | null;
  code?: string | null;
  param?: string | null;
  requestId?: string | null;
  category?: string | null;
  retryable?: boolean | null;
  retryAfterMs?: number | null;
}

type Metadata = {
  readonly effects: 'unknown' | 'notStarted' | 'recorded';
  readonly responseIntegrityReason: ResponseIntegrityReason | null;
  readonly statusCode: number | null;
  readonly code: string | null;
  readonly param: string | null;
  readonly requestId: string | null;
  readonly category: string | null;
  readonly retryable: boolean | null;
  readonly retryAfterMs: number | null;
  readonly mcpCallbackError?: Readonly<{ error: unknown }>;
};

// One snapshot permits terminal enrichment without replacing the original Error.
const metadata = new WeakMap<NativeError, Metadata>();

export class NativeError extends Error {
  /** Retry an unfinished storage release without repeating reconciliation. */
  cleanup?: SessionStoreCleanup;
  constructor(message: string, options?: NativeErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    metadata.set(this, {
      effects: 'unknown',
      responseIntegrityReason: null,
      statusCode: options?.statusCode ?? null,
      code: options?.code ?? null,
      param: options?.param ?? null,
      requestId: options?.requestId ?? null,
      category: options?.category ?? null,
      retryable: options?.retryable ?? null,
      retryAfterMs: options?.retryAfterMs ?? null,
    });
  }

  /** Effects of this failed operation only; never permission to replay earlier work. */
  get effects(): 'unknown' | 'notStarted' | 'recorded' {
    return metadata.get(this)!.effects;
  }

  /** Absent for restored or unowned errors; never permission to replay work. */
  get responseIntegrityReason(): ResponseIntegrityReason | null {
    return metadata.get(this)!.responseIntegrityReason;
  }

  get statusCode(): number | null {
    return metadata.get(this)!.statusCode;
  }
  get code(): string | null {
    return metadata.get(this)!.code;
  }
  /** The provider's bounded request parameter, when the error identifies one. */
  get param(): string | null {
    return metadata.get(this)!.param;
  }
  get requestId(): string | null {
    return metadata.get(this)!.requestId;
  }
  get category(): string | null {
    return metadata.get(this)!.category;
  }

  /**
   * Native error eligibility before attempt limits. This does not mean that
   * attempts remain or that replaying a whole run is safe. Null means unknown.
   */
  get retryable(): boolean | null {
    return metadata.get(this)!.retryable;
  }

  /**
   * Server-advised delay remaining when native code reported the error, in
   * milliseconds. Null means no advice; zero includes expired advice. This is
   * a snapshot, not a countdown, and does not grant permission to retry.
   */
  get retryAfterMs(): number | null {
    return metadata.get(this)!.retryAfterMs;
  }

  /** Read the original application error from a root turn's MCP callback.
   * This value may contain private application data.
   */
  getMcpCallbackError(): Readonly<{ error: unknown }> | undefined {
    return metadata.get(this)!.mcpCallbackError;
  }
}

/** @internal Keep callback diagnostics outside the standard error chain. */
export function retainMcpCallbackError(
  failure: NativeError,
  error: unknown,
): void {
  metadata.set(failure, {
    ...metadata.get(failure)!,
    mcpCallbackError: Object.freeze({ error }),
  });
}

/** Mark only an SDK-validated native not_submitted receipt, preserving identity. */
export function markNativeErrorNotStarted<T extends NativeError>(error: T): T {
  metadata.set(error, { ...metadata.get(error)!, effects: 'notStarted' });
  return error;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function category(value: unknown): string | null {
  let info = object(value)?.codex_error_info;
  let details: unknown;
  const tagged = object(info);
  if (tagged) {
    const keys = Object.keys(tagged);
    if (keys.length !== 1) return null;
    info = keys[0];
    details = tagged[keys[0]];
  }
  if (typeof info !== 'string') return null;
  const code = info.replace(
    /[A-Z]/g,
    (letter, offset) => (offset ? '_' : '') + letter.toLowerCase(),
  );
  if (
    [
      'http_connection_failed',
      'response_stream_connection_failed',
      'response_stream_disconnected',
      'response_too_many_failed_attempts',
    ].includes(code)
  ) {
    const status = object(details)?.http_status_code;
    if (typeof status === 'number' && Number.isInteger(status)) {
      const mapped: Record<number, string> = {
        401: 'authentication_error',
        403: 'authentication_error',
        402: 'usage_limit_exceeded',
        404: 'resource_not_found',
        408: 'request_timeout',
        504: 'request_timeout',
        429: 'rate_limit_exceeded',
        503: 'server_overloaded',
        529: 'server_overloaded',
      };
      if (mapped[status]) return mapped[status];
      if (status >= 400 && status < 500) return 'invalid_request';
      if (status >= 500 && status < 600) return 'server_error';
    }
    return code === 'response_too_many_failed_attempts'
      ? 'server_error'
      : 'connection_failed';
  }
  const aliases: Record<string, string> = {
    context_window_exceeded: 'context_length_exceeded',
    unauthorized: 'authentication_error',
    bad_request: 'invalid_request',
    internal_server_error: 'server_error',
    thread_rollback_failed: 'server_error',
    other: 'internal_error',
  };
  if (Object.hasOwn(aliases, code)) return aliases[code];
  return [
    'session_budget_exceeded',
    'model_invocation_deadline_exceeded',
    'usage_limit_exceeded',
    'project_spend_limit_exceeded',
    'organization_spend_limit_exceeded',
    'organization_usage_limit_exceeded',
    'billing_not_active',
    'credit_balance_exhausted',
    'rate_limit_exceeded',
    'flex_unavailable',
    'server_overloaded',
    'cyber_policy',
    'misalignment_policy_violation',
    'sandbox_error',
    'active_turn_not_steerable',
  ].includes(code)
    ? code
    : null;
}

/** Replace observed provider fields while retaining independently proved operation effects. */
export function enrichNativeError(error: NativeError, value: unknown): void {
  const provider = object(object(value)?._sdk_provider_error);
  const status = provider?.status_code;
  let failureCategory = category(value);
  const localDeadline =
    failureCategory === 'model_invocation_deadline_exceeded';
  const code = localDeadline
    ? 'model_invocation_deadline_exceeded'
    : provider?.code;
  const param = localDeadline ? undefined : provider?.param;
  const requestId = provider?.request_id;
  let retryable = localDeadline ? false : provider?.retryable;
  switch (code) {
    case 'rate_limit_exceeded':
      // Registered SSE retains its actual HTTP 200 in provider diagnostics.
      if (status === 200 && failureCategory === 'connection_failed') {
        failureCategory = 'rate_limit_exceeded';
      }
      break;
    case 'subscription_sharing_usage_limit_exceeded':
      failureCategory = 'usage_limit_exceeded';
      retryable = false;
      break;
    case 'subscription_sharing_usage_unavailable':
      failureCategory = 'server_overloaded';
      retryable = true;
      break;
    case 'subscription_sharing_unsupported_capability':
      retryable = false;
      break;
  }
  const retryAfterMs = localDeadline ? undefined : provider?.retry_after_ms;
  metadata.set(error, {
    ...metadata.get(error)!,
    statusCode:
      typeof status === 'number' &&
      Number.isInteger(status) &&
      status >= 100 &&
      status <= 999
        ? status
        : null,
    code:
      typeof code === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(code)
        ? code
        : null,
    param:
      typeof param === 'string' && /^[A-Za-z0-9_.[\]-]{1,128}$/.test(param)
        ? param
        : null,
    requestId:
      typeof requestId === 'string' && /^[\x21-\x7e]{1,256}$/.test(requestId)
        ? requestId
        : null,
    category: failureCategory,
    retryable: typeof retryable === 'boolean' ? retryable : null,
    retryAfterMs:
      typeof retryAfterMs === 'number' &&
      Number.isSafeInteger(retryAfterMs) &&
      retryAfterMs >= 0
        ? retryAfterMs
        : null,
  });
}

/** Convert native data without interpreting provider bodies or display messages. */
export function nativeError(
  value: unknown,
  message?: string,
  options?: ErrorOptions,
): NativeError {
  const publicError = object(value);
  const fallback = publicError
    ? Object.fromEntries(
        Object.entries(publicError).filter(
          ([key]) =>
            key !== '_sdk_provider_error' &&
            key !== '_sdk_response_integrity_reason',
        ),
      )
    : value;
  const error = new NativeError(message ?? encode(fallback), options);
  metadata.set(error, {
    ...metadata.get(error)!,
    responseIntegrityReason: responseIntegrityReason(
      publicError?._sdk_response_integrity_reason,
    ),
  });
  enrichNativeError(error, value);
  return error;
}
