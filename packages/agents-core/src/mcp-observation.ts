import type { CallToolResult } from './mcp';

/** A detached MCP call snapshot. It grants no invocation or approval authority. */
export interface MCPToolStartObservation {
  readonly serverName: string;
  readonly toolName: string;
  readonly callId: string | null;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
}

/** The normalized MCP envelope, before model-output projection or serialization. */
export interface MCPToolEndObservation extends MCPToolStartObservation {
  readonly result: CallToolResult;
}

/**
 * One observer per phase for materialized SDK MCP tools, not direct callTool calls.
 * The SDK captures these callbacks when it creates a binding. Existing synchronous
 * Agent/Runner event listeners and Core-owned MCP policy hooks are separate.
 */
export interface MCPToolObservers {
  /**
   * Awaited after approval, before client-side argument transforms or invocation.
   * Fulfillment values are ignored. The callback must settle or cooperate with
   * its signal: cancellation prevents dispatch after the callback settles, but
   * does not force an uncooperative callback to return. Cleanup joins entered work.
   */
  onToolStart?: (event: MCPToolStartObservation) => unknown;
  /**
   * Awaited after normalization/result transforms, before projection/serialization.
   * Fulfillment values are ignored. Rejection or cancellation withholds output;
   * cleanup still joins the callback. It must settle or cooperate with its signal.
   * Completed tool effects cannot be rolled back and the observer is not retried.
   */
  onToolEnd?: (event: MCPToolEndObservation) => unknown;
}

export function captureMcpObservers(
  options: MCPToolObservers,
): Readonly<MCPToolObservers> {
  const { onToolStart, onToolEnd } = options;
  for (const callback of [onToolStart, onToolEnd])
    if (callback !== undefined && typeof callback !== 'function')
      throw new TypeError('MCP observers must be callable');
  return Object.freeze({ onToolStart, onToolEnd });
}

export function detachedMcpObservation<T extends MCPToolStartObservation>(
  event: T,
): T {
  const { signal, ...data } = event;
  return Object.freeze({
    ...structuredClone(data),
    ...(signal === undefined ? {} : { signal }),
  }) as T;
}

/** Capture legacy array metadata before copying its content elements. */
export function normalizeMcpResult(
  raw: unknown,
  fullResult: boolean,
): CallToolResult {
  if (
    fullResult &&
    (raw === null || typeof raw !== 'object' || Array.isArray(raw))
  )
    throw new TypeError('MCP callToolResult must return an object');
  const result = fullResult ? (raw as Record<string, unknown>) : undefined;
  const content = result ? result.content : raw;
  if (!Array.isArray(content))
    throw new TypeError('MCP content must be an array');
  const attached = content as unknown as Record<string, unknown>;
  const normalized: Record<string, unknown> = {
    ...result,
    content: [...content],
  };
  for (const key of ['isError', 'structuredContent', '_meta']) {
    const primary = result?.[key];
    const value = primary !== undefined ? primary : attached[key];
    if (value !== undefined) normalized[key] = value;
  }
  if (
    normalized.isError !== undefined &&
    typeof normalized.isError !== 'boolean'
  )
    throw new TypeError('MCP isError must be a boolean');
  return structuredClone(normalized) as unknown as CallToolResult;
}

// Private control flow: preserve an observer's original rejection instead of
// converting it through the ordinary function-tool transport error handler.
// Identity checks must not inspect arbitrary thrown values, including Proxies.
const observerFailures = new WeakSet<object>();

export function isMcpObserverFailure(
  error: unknown,
): error is McpObserverFailure {
  return (
    error !== null &&
    (typeof error === 'object' || typeof error === 'function') &&
    observerFailures.has(error)
  );
}

export class McpObserverFailure extends Error {
  constructor(cause: unknown) {
    super('MCP observer failed', { cause });
    observerFailures.add(this);
  }
}
