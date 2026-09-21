const TRACE_INCLUDE_SENSITIVE_DATA = Symbol(
  'functionToolTraceIncludeSensitiveData',
);

export const REDACTED_TOOL_ERROR_MESSAGE =
  'Tool execution failed. Error details are redacted.';

/** Keep the active runner's trace policy on this invocation only. */
export function setFunctionToolTracePolicy(
  details: object,
  includeSensitiveData: boolean,
): void {
  Object.defineProperty(details, TRACE_INCLUDE_SENSITIVE_DATA, {
    value: includeSensitiveData,
  });
}

/** Missing invocation policy never authorizes sensitive error diagnostics. */
export function includesFunctionToolErrorDetails(details?: object): boolean {
  return (
    (details as { [TRACE_INCLUDE_SENSITIVE_DATA]?: boolean } | undefined)?.[
      TRACE_INCLUDE_SENSITIVE_DATA
    ] === true
  );
}
