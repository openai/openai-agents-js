# Session Persistence

Use this reference for `Session`, session-input callbacks, stored input, history mutation, per-turn writes, failure rollback, or compaction replacement.

## Session Contract

- `getItems(limit)` returns the latest limited window in chronological order. `addItems()` appends, `popItem()` removes the newest item, and `clearSession()` clears the boundary. Backends must preserve these semantics even when their storage API orders or paginates differently.
- Return clones or otherwise prevent caller mutation from silently rewriting stored history. Normalize external records and skip or surface corrupt records according to the backend's documented recovery policy.
- `SessionHistoryRewriteAwareSession.applyHistoryMutations(...)` lets a session backend apply history mutations such as replacing approved function-call arguments. Do not emulate this contract with a partial clear-and-rebuild unless failure restoration is defined.

## Preparing and Persisting Input

- `sessionInputCallback` controls how stored history combines with current input for model preparation. Model-input filtering happens after preparation and filtered clones become the persistence candidates.
- Keep prepared model input and persisted session input distinct. Server-managed conversations may use a session callback or session identity while intentionally omitting prior session history and writes.
- Sanitize generated items before storage. Persist complete call/output pairs and remove provider-only replay metadata only at the boundary that requires it.

## Per-Turn Writes and Resume

- Streaming can persist input before the run finishes and append generated items incrementally. Use the one-shot persistence helper and persisted-item count so cancellation, retry, and resume do not duplicate records.
- Preserve `_currentTurnPersistedItemCount` across RunState resume for an in-progress turn. Count post-conversion items that were actually written, not raw generated items.
- An ordinary Session append performed after approved tool work may commit before its acknowledgement is lost. Before executing resumed tool work, claim exclusive ownership of the live RunState and capture the runtime Session ID plus persistence policy while failures are still side-effect free. After the tool completes, derive the exact append in the canonical persistence pipeline and publish a `prepared` checkpoint before another Session callback or await. Do not serialize the derived append as authority: reconstruct any transaction-owned deferred input prefix from the existing Session input snapshot and reconstruct the complete generated suffix from the pending RunItem range and captured policy. The checkpoint records comparable history immediately before the first append attempt, then accepts only that exact unchanged history or the exact committed history on retry. Retain the checkpoint through cancellation, read failures, or another append rejection until the append is known committed. After append settlement, retire the history snapshots and advance the same checkpoint to a `compaction_pending` phase that retains only the captured Session identity, persistence policy, item range, and terminal provenance. Clear that phase and record the compacted item count only after input compaction succeeds. Missing, different, or server-managed Sessions must fail before guardrails, model calls, tool calls, lifecycle completion, or compaction; field absence does not create recovery authority for ordinary or older-schema states. When terminal tool output is involved, retain same-live producer identity across a failed compaction, and validate compaction-pending terminal authority before any retry side effect. Fail closed for concurrent live-state reuse, a different Session or policy, a partial append, comparison output that loses record boundaries, or any later history change before append settlement. Do not convert an unresolved append into an error-handler output.
- The resumed-write checkpoint is not a general exactly-once Session protocol. Keep blocked output-guardrail `SessionHistoryTransactionAwareSession` operations on their existing atomic transaction path. When output guardrails accept a resumed terminal tool result, publish the prepared ordinary-write checkpoint after the guardrail verdict and before the final Session append. Declarative terminal behavior may be revalidated from the current Agent across serialization; reconstruct the ordered completed-result candidates from validated pending history or the current response's canonical completion evidence so restored data cannot select a later or forged result. When a later selection depends on a live result batch that serialization cannot prove, require the same live RunState. Function-produced terminal output also requires the same live RunState and exact callback identity because unauthenticated serialized data cannot prove an arbitrary callback result without rerunning caller code; reject function-produced terminal restoration while compaction remains pending. Do not checkpoint compaction replacement or server-managed conversation writes, and never serialize a live Session backend or let restored data select the runtime Session.
- A failed input guardrail must not leave new input committed as a successful turn. An aborted model request may need input preserved for retry; decide from the request boundary rather than applying one rollback rule to every failure.

## Replacement and Recovery

- Validate and normalize compacted replacement items before clearing history. Capture prior history before a destructive replacement.
- If clear or append fails after storage changed, clean partial replacement state and restore the old history. If restoration also fails, preserve the primary failure and expose the restore failure rather than reporting success.
- OpenAI Conversations conversion is a persistence boundary: preserve supported reasoning identity and encrypted content, drop unpersistable items deliberately, and skip empty writes.

## Review Checklist

1. Test ordering, limits, clone isolation, append, pop, clear, and optional rewrite semantics.
2. Compare model input with exactly what the session stores after callbacks and filters.
3. Test streaming cancellation, retry, interrupted resume, and partial per-turn persistence.
4. Inject ordinary resumed append failures before and after commit; verify exact reconciliation, same-session binding, serialized ownership, and no model call, tool work, terminal completion, or error-handler conversion before settlement.
5. Inject failures before and after destructive replacement and verify restoration.
6. Confirm server-managed continuation does not produce a second authoritative transcript.

## Sources

- `packages/agents-core/src/memory/session.ts`
- `packages/agents-core/src/memory/memorySession.ts`
- `packages/agents-core/src/memory/historyMutations.ts`
- `packages/agents-core/src/runner/sessionPersistence.ts`
- `packages/agents-openai/src/memory/openaiConversationsSession.ts`
- `packages/agents-openai/src/memory/openaiResponsesCompactionSession.ts`
- `packages/agents-core/test/memorySession.test.ts`
- `packages/agents-core/test/runner/sessionPersistence.test.ts`
- `packages/agents-core/test/runner/sessionPersistence.extended.test.ts`
- `packages/agents-openai/test/openaiConversationsSession.test.ts`
- `packages/agents-openai/test/openaiResponsesCompactionSession.test.ts`
- `docs/src/content/docs/guides/sessions.mdx`
