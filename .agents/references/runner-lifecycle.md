# Runner Lifecycle

Use this reference for turn accounting, guardrail order, handoffs, interruption, cancellation, hooks, final-output selection, or streaming/non-streaming behavior.

## Turn and Guardrail Order

- Count a turn when a model call starts. Resuming a tool or MCP approval in an in-progress turn must not consume another turn before the next model call.
- Run input guardrails only for the starting agent and initial run input. Parallel input guardrails may overlap model work, but the run must await and surface their result before committing a successful turn or exposing guarded output.
- An interruption returns before output guardrails. On resume, reuse the serialized current step and pending tool state rather than rebuilding a fresh model turn.
- Run output guardrails only on the selected final output. A handoff or tool continuation is not final output, and streamed candidate output must remain hidden if a guardrail later fails.

## Streaming Parity and Cancellation

- Keep streaming and non-streaming paths aligned for model preparation, approvals, tool execution, handoffs, persistence, usage, tracing, and final-output resolution. Streaming may emit earlier observations, but it must not change the eventual state transition.
- A streamed result owns a background run loop. Cancellation must abort promptly, resolve completion, detach abort listeners, and avoid leaving a locked `ReadableStream` or unobserved promise rejection.
- When a server-managed streamed request aborts after function-call fragments arrive, reconcile enough terminal tool-call state to resume safely without replaying incomplete or duplicate calls.
- Delay end-of-run lifecycle and trace completion until tools, guardrails, persistence, and the stream loop have settled. Do not emit a successful end event before a later failure path is known.

## Handoffs and Final Output

- A handoff updates the current agent, emits the agent-update lifecycle, applies the selected handoff input filter, and continues the same run state. Keep explicit and runner-level filters consistent and do not expose approval placeholders as normal history.
- Tool-use behavior can stop on a tool result or run the model again. If a named stop tool is not called, continue normally; do not treat an unmatched name as final output.
- Final output must wait for all selected tool actions that belong to the turn. Preserve segmented assistant text and prefer an explicitly handled error result when an error handler resolves the run.

## Review Checklist

1. Trace first turn, second turn, handoff, interruption, resume, max-turn, and cancellation paths.
2. Compare streaming and non-streaming state, events, persistence, usage, and trace completion.
3. Verify parallel guardrails cannot leak output or persist input after failure.
4. Confirm hooks and end events fire once and only after their owned work settles.
5. Test the negative path that can leave a listener, promise, stream lock, or pending tool state behind.

## Sources

- `packages/agents-core/src/run.ts`
- `packages/agents-core/src/runner/runLoop.ts`
- `packages/agents-core/src/runner/turnPreparation.ts`
- `packages/agents-core/src/runner/turnResolution.ts`
- `packages/agents-core/src/runner/guardrails.ts`
- `packages/agents-core/src/runner/streaming.ts`
- `packages/agents-core/src/runner/streamReconciliation.ts`
- `packages/agents-core/src/lifecycle.ts`
- `packages/agents-core/test/run.test.ts`
- `packages/agents-core/test/run.stream.test.ts`
- `packages/agents-core/test/agentScenarios.test.ts`
- `packages/agents-core/test/lifecycle.test.ts`
- `docs/src/content/docs/guides/running-agents.mdx`
- `docs/src/content/docs/guides/streaming.mdx`
