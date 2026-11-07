# Stream a migrated run and reuse completed history

Use `SDKRunner.stream()` to display Model events during a supported text run. To reopen a native conversation, use a portable checkpoint or native storage. Use a classic Session to share completed items with the classic Runner.

Start with the [model and runtime prerequisites](migrate-models.md). Both examples use scripted Models and need no model credentials.

## Live Model events and accepted semantic replay

Run the streaming example from the checkout root. It counts tentative Model events, waits for final guardrails and cleanup, then reads accepted events and final output.

```sh
pnpm exec tsx examples/codex/migration-stream.ts
```

Call `await SDKRunner.stream(agent, input, options)` with the same supported Agent, input and context. This additional entrypoint selects the Model's streaming method. It rejects an explicit `modelInvocation: 'response'` before execution. Ordinary `SDKRunner.run()` and the separate classic `Runner.run(..., { stream: true })` route keep their behavior. See [the complete streaming example](../migration-stream.ts), which runs without model credentials.

### Tentative raw events

The returned handle exposes two event views. `unvalidatedRaw` is a Web ReadableStream of actual SDK `RunRawModelStreamEvent` values as the selected Model emits them. Raw text and even a Model's `response_done` event can precede final guardrails or a later run failure. Treat this content as tentative. These events come from the Model, without native carrier SSE reconstruction or native diagnostics.

### Accepted semantic replay

Use `for await (const event of live.replayEvents())` for supported SDK semantic events: `tool_called`, `tool_output`, and `message_output_created`. They replay accepted items in Model-batch and tool-call order after guarded completion and physical cleanup. A rejected run emits no accepted semantic items. This route does not promise pre-completion semantic delivery, every classic stream event, or a fabricated RunState.

Completed results also support `for await (const event of result.replayEvents())` for accepted semantic replay. For a completed handoff, events replay in this order:

1. `handoff_requested` and `handoff_occurred` for retained transfer items.
2. An `agent_updated_stream_event` with the actual target Agent, followed by that Agent's items.

If a handoff filter removes the transfer items, the accepted target change still appears. Replay does not recreate the removed items. Check `event.type` before reading item-only fields such as `name` or `item`. Live `SDKRunner.stream()` handoff runs remain unsupported.

### Completed results

`await live.completed` returns the existing completed result. Read `finalOutput`, `newItems`, `rawResponses`, `lastAgent`, and `runContext`. Application context and SDK usage live under `runContext.context` and `runContext.usage`.

Native IDs and usage accounting remain separate under `native`. `interruptions` is empty for the current approval-free admission. `history` and `toInputList()` export supported captured input and generated items. Raw Model response records remain diagnostics, rather than a separately guard-certified transcript.

### Backlog and cancellation

The raw channel has a fixed 4 MiB UTF-8 JSON backlog limit, including SDK event wrappers. This native safety policy is separate from the per-Model payload limit and does not bound exact process memory. Completion does not require a reader while the retained data fits this budget.

On overflow, the adapter fails explicitly, discards pending raw delivery, requests cancellation, and waits for the producer. It never silently drops content. Consume raw events during execution when you need live progress. Use `run()` for completed-only consumers that do not need this raw channel.

Cancel through the supplied AbortSignal, a raw reader or iterator, or a pending semantic reader. There is no public `live.cancel()` method. Reader cancellation can close delivery before an outstanding Model `next()`, iterator `return()`, tool or guard callback finishes. Always await `live.completed` on cancellation and error paths to join that work.

The native execution owner keeps the actual outcome. A late cancellation request cannot revoke a successful result. Failed cleanup can reject `completed` with `MigrationCleanupError` even when raw delivery already reported an earlier cancellation reason. An uncooperative callback can keep completion pending.

## Reopen native history with a selected Model

Pass fresh text and explicit context when using native persistence. On each open, provide the current Agent, Model or ModelProvider, and tool callbacks. The runtime keeps the native session ID and opens a new turn. The selected Model receives the retained conversation context. Completed calls and results provide context without running the old callbacks again. The migration result contains the current invocation's input and output.

| Persistence | First run | Later run |
| --- | --- | --- |
| [Idle portable checkpoint](state.md#save-or-suspend-a-session) | Set `returnState: true` and save the completed result's `state`. | Pass `state` and supply matching managed tool declarations and output type. Parse serialized state with `parseSessionState()`. |
| [Native local profile](local-state.md) | Set `storage: localStorage(directory)` and keep `result.native.sessionId`. | Pass the same storage and the session ID as `resume`. |
| [Root canonical store](session-store.md) | Set `storage` to a supported `SessionStore`, such as `fileSessionStore(directory)`, and keep `result.native.sessionId`. | Pass the same store and the session ID as `resume`. |

Portable checkpoints cover one idle root. Portable export requires the native turn to complete normally. A held approval keeps the original Model and native writer until the application decides and continues, or cancels the run. The held handle has no portable state. Pending checkpoints and migration handoffs fall outside this persistence contract. Choose one persistence source per run. The classic `session` and `sessionInputCallback` options belong to the completed history path below.

Local profiles use the existing native writer lock and [effect recovery](local-state.md). If opening raises `LocalRecoveryRequired`, verify the effects in application records before supplying `reconciledCalls` on reopen. Custom stores use their [canonical recovery rules](session-store.md#reconcile-an-unresolved-tool-intent). Wait for completion or joined cancellation before reopening. A storage or cleanup error can follow an external effect. Check the recorded outcome before trying the operation again.

For a supported local root with completed native children, reopen it through the native `Agent.session()` API to read child records. List children with `session.subagents()` and read their records with `session.turns({ subagentId })` and `session.items({ subagentId })`. The selected Model runs the root only. Migration Agent tools use separate native roots.

## Completed Session history

Finish the classic run before migrating. The adapter admits only completed item snapshots and complete pairs. Those items do not prove that the whole run has ended.

Pass `session` to load completed supported messages and complete function-call/result pairs through the classic `Session` contract. Imported calls provide Model context. The adapter does not execute them again.

Standard empty provider envelopes, matching duplicate item identity and output-text annotations/logprobs remain detached data. Provider metadata cannot override item identity or add approval state. The adapter rejects pending approvals, unmatched calls, unknown items, unsupported media, and other provider metadata before provider or tool work. This bounded admission does not support the wire-item normalization used by `OpenAIConversationsSession`. Use the classic Runner for that store or unsupported history.

### Select and append history

`sessionInputCallback` selects effective history and fresh input before provider work. The selected delta may contain supported completed items or be empty. Historical objects changed by the callback retain canonical classic classification, so they are not appended again. The completed result's `input`, `history` and `toInputList()` include captured effective history. `newItems` and `output` contain only this run's generated items.

After guards and owned cleanup succeed, the adapter awaits `addItems` with the selected fresh input and validated actual generated items.

A failed read or input callback prevents execution. An append can fail after tool effects or a committed write. Caller cancellation does not replace its original rejection. The SDK does not retry or roll back the write.

The application owns storage durability and concurrent access. Another application process can reopen the completed storage. This is not a native checkpoint, live migration, or a guarantee that effects happen exactly once.

## Reopen an application-owned file Session

The [file Session example](../migration-session.ts) combines this completed-history contract with a selected public `ScriptedModel` and a small application-owned JSON store. It exports `openFileSession(path, sessionId)` and `runMigrationSessionPhase(phase, session, effectsPath)` outside the SDK API. The store loads history into the public `MemorySession` and awaits a file write after each mutation. `MemorySession` supplies cloning and chronological reads.

Use Node.js 24 after building the classic packages and matching native addon/runtime helpers. No model API key is needed. From the checkout root:

1. Create a private directory.
2. Run the three commands sequentially, once each. Each command starts a separate process with the same session identity and history path.

```sh
SESSION_DIRECTORY=$(mktemp -d)
pnpm exec tsx examples/codex/migration-session.ts classic "$SESSION_DIRECTORY/history.json" "$SESSION_DIRECTORY/effects.txt" example-session
pnpm exec tsx examples/codex/migration-session.ts native "$SESSION_DIRECTORY/history.json" "$SESSION_DIRECTORY/effects.txt" example-session
pnpm exec tsx examples/codex/migration-session.ts restarted "$SESSION_DIRECTORY/history.json" "$SESSION_DIRECTORY/effects.txt" example-session
```

The stored item counts are 4, 8, then 10. The native continuation adds its function-call/result pair. The final process restores history without another effect. The effects file contains exactly `old` and `new` on separate lines. The application owns the directory and removes it when finished.

### Storage ownership and failure recovery

Use one writer and await each operation before starting another. A successful awaited write survives an ordinary application restart. This demo does not provide atomic transactions, crash or power-loss durability, encrypted storage, concurrent access, native checkpoints, pending-approval recovery, or exactly-once effects.

A failed write can follow an in-memory mutation or a committed effect. Stop and let the application reconcile uncertain state. Do not retry the run automatically. The application owns file validation, access, retention, and cleanup. Only use trusted application-owned history files with this recipe.

Use this recipe for [completed classic history](#completed-session-history). Native `LocalStorage` has its own format and lifecycle. When a workflow needs the full classic Runner, select it explicitly.
