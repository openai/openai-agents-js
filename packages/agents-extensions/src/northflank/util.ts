import type {
  NorthflankApprovalsConfig,
  NorthflankToolName,
  NorthflankToolsOptions,
} from './types';

export const DEFAULT_OUTPUT_LIMIT = 20_000;

const MUTATING_TOOLS: ReadonlySet<NorthflankToolName> = new Set([
  'northflank_create_service',
  'northflank_update_service_deployment',
  'northflank_start_service_build',
  'northflank_restart_service',
  'northflank_scale_service',
  'northflank_exec_service',
  'northflank_exec_job',
  'northflank_exec_addon',
  'northflank_upload_files',
  // download_files writes to the agent host filesystem — treat as mutating.
  'northflank_download_files',
]);

/**
 * Resolve whether a given tool requires approval according to the user's
 * config. Defaults to `'auto'` (mutating tools require approval, reads don't).
 */
export function resolveNeedsApproval(
  toolName: NorthflankToolName,
  approvals: NorthflankApprovalsConfig | undefined,
): boolean {
  if (approvals === 'always') return true;
  if (approvals === 'never') return false;
  if (approvals && typeof approvals === 'object') {
    const override = approvals[toolName];
    if (typeof override === 'boolean') return override;
  }
  return MUTATING_TOOLS.has(toolName);
}

/**
 * Truncate a string to the configured limit. Adds a marker indicating how many
 * characters were dropped so the model can adapt its strategy (e.g. ask for
 * a tighter command).
 */
export function truncate(input: string, limit = DEFAULT_OUTPUT_LIMIT): string {
  if (!input) return '';
  if (input.length <= limit) return input;
  const dropped = input.length - limit;
  return `${input.slice(0, limit)}\n... [truncated ${dropped} chars]`;
}

/**
 * Resolve the project ID for a tool call, falling back to the configured
 * default. Throws a clear error if neither is present.
 */
export function resolveProjectId(
  argProjectId: string | undefined,
  options: NorthflankToolsOptions,
): string {
  const id = argProjectId ?? options.defaultProjectId;
  if (!id) {
    throw new Error(
      'projectId is required (no defaultProjectId was configured on northflankTools).',
    );
  }
  return id;
}

/**
 * Wrap an API call so any thrown error is converted to a string. The Agents
 * SDK passes execute results back to the model verbatim; throwing leaks
 * internals and aborts the run. Instead we return a structured error string
 * that the model can read and recover from.
 *
 * Use this for client methods that throw on failure (exec, fileCopy). For
 * methods that return `ApiCallResponse`, use {@link runApiCall} instead so
 * non-2xx HTTP responses are surfaced even when the client is configured with
 * `throwErrorOnHttpErrorCode: false` (the JS-client default).
 */
export async function runSafe<T>(
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: formatError(err) };
  }
}

/**
 * Shape of every Northflank `ApiCallResponse`. Reproduced here so we don't
 * pull the runtime type into our public types — it lives in the client.
 */
interface ApiResponseLike<T> {
  data: T;
  error?: {
    status?: number;
    message?: string;
    id?: string;
    details?: unknown;
  };
}

/**
 * Wrap an `ApiCallResponse`-returning call. Catches thrown errors AND surfaces
 * the `response.error` field that the JS client populates when it's running
 * with the default `throwErrorOnHttpErrorCode: false`.
 *
 * Without this, a 404 / 500 from Northflank would silently return `undefined`
 * data and look like success to the agent.
 */
export async function runApiCall<T>(
  fn: () => Promise<ApiResponseLike<T>>,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    const response = await fn();
    if (response.error) {
      const { status, message, id } = response.error;
      const parts = [
        status ? `HTTP ${status}` : null,
        message ?? 'unknown API error',
        id ? `(id ${id})` : null,
      ].filter(Boolean);
      return { ok: false, error: parts.join(' ') };
    }
    return { ok: true, value: response.data };
  } catch (err) {
    return { ok: false, error: formatError(err) };
  }
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    // NorthflankApiCallError tucks the HTTP status on the instance.
    const status = (err as Error & { status?: number }).status;
    return status ? `HTTP ${status} ${err.message}` : err.message;
  }
  return String(err);
}

/**
 * Build the params object passed to the Northflank JS client. When a `teamId`
 * is configured we merge it in; the client tolerates an undefined teamId so we
 * only add the key when it's set.
 */
export function buildParams<T extends Record<string, unknown>>(
  params: T,
  options: NorthflankToolsOptions,
): T & { teamId?: string } {
  if (options.teamId) {
    return { ...params, teamId: options.teamId };
  }
  return params;
}

/**
 * Stringify a JSON-compatible value, truncating to fit within the output cap.
 * Tools return strings; this keeps payloads readable without blowing up the
 * context window.
 */
export function jsonResult(value: unknown, limit?: number): string {
  return truncate(
    JSON.stringify(value, null, 2),
    limit ?? DEFAULT_OUTPUT_LIMIT,
  );
}

/**
 * OpenAI Structured Outputs requires every property be `required` in the JSON
 * schema, so optional fields use `.nullable().optional()` — the model passes
 * `null` to "omit" them. Convert those nulls back to `undefined` before
 * forwarding to the Northflank API, which expects missing rather than null.
 */
export function nu<T>(value: T | null | undefined): T | undefined {
  return value == null ? undefined : value;
}

/**
 * Strip null/undefined values from a record. Used to assemble pass-through
 * payloads for the Northflank API without polluting them with explicit nulls.
 */
export function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v != null) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
