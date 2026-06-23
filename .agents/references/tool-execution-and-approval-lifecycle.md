# Tool Execution and Approval Lifecycle

Use this reference for tool planning, approvals, guardrails, concurrency, aborts, timeouts, hooks, failure conversion, nested agent tools, or tool-choice reset.

## Plan Before Side Effects

- Normalize model output into an execution plan before invoking tools. Separate function, hosted, computer, shell, apply-patch, MCP approval, handoff, and tool-search actions so each lifecycle can enforce its own contract.
- Parse and validate arguments before approval decisions that depend on input. Convert malformed JSON into the configured model-visible error path instead of crashing the runner without state.
- Start all function calls by default or honor the configured concurrency cap while preserving output order. After the first fatal capped failure, do not start queued calls whose side effects have not begun.

## Approval and Guardrail Order

- Approval decisions are scoped by tool identity and call ID. An undecided call becomes a public interruption item; a decided call must not request approval again after resume.
- Input guardrails run immediately before execution. `preApprovalInputGuardrails` optionally runs them before exposing a pending approval, but successful guardrails run again after approval because context or arguments may have changed.
- Rejection returns the tool-specific or formatted model-visible result without running the tool. Preserve explicit rejection reasons and redact them from traces when sensitive tracing data is disabled.
- Apply argument overrides to the executed call and canonical persisted history together. Do not execute one argument set while replaying another.

## Invocation, Timeout, and Failure

- Pass the current `RunContext`, stable call identity, abort signal, and tool-scoped metadata to invocation. Do not expose internal parent run configuration through public callback details.
- A timeout can become an error result or a `ToolTimeoutError` carrying run state. Preserve the selected behavior across function and provider-backed tool paths.
- Emit start/end hooks and spans exactly once, including error paths. A custom-data extractor failure must not emit a successful end event after the tool itself succeeded.
- Tool input/output guardrail `rejectContent` replaces model-visible content; `throwException` surfaces a typed tool-call error. Stop evaluating later guardrails after a terminal behavior.
- A nested agent tool has its own run state and can return an interruption. Rejecting it must clear the pending nested run so it cannot resume accidentally.

## Tool Choice

- Track use per agent identity. When `resetToolChoice` is enabled, clear a forced or named choice after that agent uses a tool, but preserve explicit `none` and do not mutate reusable agent settings.

## Review Checklist

1. Trace parse, guardrail, approval, invocation, output guardrail, custom data, hooks, spans, and persistence in order.
2. Test approved, rejected, undecided, overridden, timed out, aborted, and throwing calls.
3. Test uncapped and capped concurrency with a failure before queued work starts.
4. Verify sensitive data redaction and one start/end event on every exit path.
5. Resume function, hosted MCP, computer, shell, apply-patch, and nested-agent approvals.

## Sources

- `packages/agents-core/src/runner/toolExecution.ts`
- `packages/agents-core/src/runner/mcpApprovals.ts`
- `packages/agents-core/src/runner/approvalRejection.ts`
- `packages/agents-core/src/runner/toolUseTracker.ts`
- `packages/agents-core/src/toolGuardrail.ts`
- `packages/agents-core/src/runContext.ts`
- `packages/agents-core/test/runner/toolExecution.test.ts`
- `packages/agents-core/test/runner/mcpApprovals.test.ts`
- `packages/agents-core/test/agentScenarios.test.ts`
- `docs/src/content/docs/guides/human-in-the-loop.mdx`
- `docs/src/content/docs/guides/guardrails.mdx`
