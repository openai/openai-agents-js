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
- A failed input guardrail must not leave new input committed as a successful turn. An aborted model request may need input preserved for retry; decide from the request boundary rather than applying one rollback rule to every failure.

## Replacement and Recovery

- Validate and normalize compacted replacement items before clearing history. Capture prior history before a destructive replacement.
- If clear or append fails after storage changed, clean partial replacement state and restore the old history. If restoration also fails, preserve the primary failure and expose the restore failure rather than reporting success.
- OpenAI Conversations conversion is a persistence boundary: preserve supported reasoning identity and encrypted content, drop unpersistable items deliberately, and skip empty writes.

## Review Checklist

1. Test ordering, limits, clone isolation, append, pop, clear, and optional rewrite semantics.
2. Compare model input with exactly what the session stores after callbacks and filters.
3. Test streaming cancellation, retry, interrupted resume, and partial per-turn persistence.
4. Inject failures before and after destructive replacement and verify restoration.
5. Confirm server-managed continuation does not produce a second authoritative transcript.

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
