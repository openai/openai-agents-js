# Session history and state

Choose the record that matches your task. The application reconciles external effects before it retries uncertain work.

| Task | Read |
| --- | --- |
| Inspect conversation progress and retained usage | [Native history snapshots](#history-and-state). |
| Move a supported conversation to another Session | [Save or suspend a session](#save-or-suspend-a-session), then [restore its declarations](#restore-instructions-and-tools). |
| Branch from full conversation history | [Fork a conversation](#fork-a-conversation). |
| Inspect the settings recorded for a native turn | [Inspect effective turn settings](#inspect-effective-turn-settings). |
| Check whether the current boundary can be captured | [Capture readiness](recovery.md#check-capture-readiness). |
| Keep canonical snapshots in application-owned files | [File-backed custom storage](session-store.md#store-canonical-conversation-state-in-application-owned-files). |
| Reopen a native profile with checklist or goal support | [Local native profiles](local-state.md#local-native-profiles). |
| Confirm an external operation before continuing | [Reconcile external effects](recovery.md#reconcile-external-effects). |

Conversation history and checkpoints do not replace an external service receipt. For Session opening and cleanup, start with [Agents and sessions](sessions.md#open-and-run-a-session).

## History and state

`items()`, `turns()`, and `subagents()` return asynchronous iterators over native history snapshots. The projection includes supported user and assistant content and reasoning summaries, and can omit unsupported records.

A `function_call_output` projection can have `status: 'completed'` and `error: null` even when its body describes a failed reply. Read the body and match its turn and call identity with `tool_started` and `tool_finished`.

Keep missing timestamps, usage, and records missing. Read the Turn outcome for execution status and the application's external receipt for the effect.

History projects a canonical accepted input's Responses record and native user item as one message, retaining the native ID and content. A snapshot taken before the native item is recorded can expose the Responses ID; a later snapshot replaces it with the native item. Saved checkpoints preserve native recording semantics; their raw history is not an API for authoring independent messages.

### Inspect effective turn settings

With the [current source build](building.md), a recorded turn from `session.turns()` can include `receipt: TurnReceipt`. The receipt describes the latest recorded sampling attempt within that native turn, rather than every request or the Session's current defaults. Read a child's receipt through `session.turns({ subagentId })`. The published `0.22.0-alpha.1` does not expose this receipt.

The receipt records the sampled model and reasoning effort, accepted instruction revision, developer-instruction hash, ordered instruction-file paths/sources/hashes, whether native user configuration participated, native source/build identities, approval policy, and executor settings when available. Inspect these observations when an answer appears to use different settings from those you expected. The [session configuration example](../session-configuration.ts) loads trusted instruction files, runs a scripted turn, and checks their sampled hashes and turn identity.

A missing or unsupported receipt leaves these settings unknown. A receipt is an observation of selected configuration, not proof that the provider honored a request, that a tool succeeded, or that an external effect committed. Hashes identify bytes; they do not contain the original instructions or make a portable checkpoint self-contained. Portable snapshots withhold executor policy details, so `executors: null` does not prove that no executor was admitted. Receipt paths and configuration can be private application data.

For application-supplied workflow correlation, see [request metadata](request-metadata.md). Correlation metadata and sampled settings answer different questions; neither grants execution authority.

### Read retained response usage

A turn returned by `session.turns()` can include `responses`, an optional list of retained provider observations. Each `RecordedResponse` carries its thread and turn identity, a provider `responseId` when available, optional terminal `status` and `incompleteReason`, and nullable usage. Provider response IDs can repeat; use the native observation `id` when available to distinguish occurrences. Legacy unlinked observations can have `id: null`.

`usageSource: 'received'` preserves the counters the provider supplied. Missing counters remain unknown. `usageSource: 'native_normalized'` identifies a legacy normalized record; its zero fields do not prove the provider reported zero. Retained provider status is independent of SDK acceptance and the owning Turn's success.

The list is not a complete log of provider attempts or charges. Read the Turn outcome for execution success, and use provider billing records for charges.

For a live Turn, the result of `await turn.wait()` exposes a separate thread usage snapshot at `result.threadUsage`. `usage_updated` events expose it at `event.usage`. Each is a nullable `TokenUsageInfo` with cumulative `totalTokenUsage` and `lastTokenUsage` for its latest reported response. These snapshots differ from the retained per-response facts in `RecordedResponse.usage`.

`result.threadUsage?.modelContextWindow`, also available as `event.usage?.modelContextWindow`, reports the usable model limit captured with the settings and model metadata behind that response's usage. The `TokenUsageInfo` field has type `number | bigint | null`. Unknown fallback metadata reports `null` unless an explicit context-window override supplies a known value. This field does not measure remaining tokens.

Changing the selected model alone does not rewrite an old usage snapshot. A new usage observation can replace a known context window with `null`; restore and fork preserve the observed snapshot. Child compaction or sampling and terminal compaction overflow report the model actually used.

### Usage counters

Usage has different live and serialized representations:

| Location | Exact integer representation |
| --- | --- |
| Public history counters | Numbers within JavaScript's safe integer range, `bigint` outside it. |
| Checkpoint token-usage counters | Safe numbers or canonical decimal strings. |

`inputTokensDetails.cacheWriteTokens` is optional. An omitted count is unknown, not zero. Response-based totals omit cache writes when any contributing response omits that count.

This encoding applies to response, turn, and thread usage, including retained compacted records and descendant histories. Preserve those strings in JSON storage. Restore and `readSessionInstructions()` reject older unsafe numeric counters because they may already have rounded; converting such a number to a string cannot recover the original value. Core's stored history and application tool data keep their existing formats.

## Save or suspend a session

`saveState()` exports idle conversation state. `suspend()` seals a supported pending manual boundary and exports its continuation. Restore with `agent.session({ state })`, supplying current trusted declarations. Snapshots contain conversation data. They contain neither running JavaScript nor a workspace backup. Python checkpoint interchange is not supported.

Opening a checkpoint with a local executor or strict WSS Environment requires the matching saved executor policy digest. New Environments default to `writePolicy: 'strict'`; saved policies retain their original mode. For a legacy checkpoint without that digest, restore with a WSS Environment that explicitly sets `writePolicy: 'legacy'`, omits `writableRoots`, and matches the saved `network` setting. For an idle legacy checkpoint with no network policy, you can also omit the Environment. To use a local executor or strict WSS policy instead, open a new Session without this checkpoint. Store checkpoints where your application can verify their integrity. The digest checks for a matching executor policy.

[Check capture readiness](recovery.md#check-capture-readiness) before attempting a capture when needed. The report does not reserve a checkpoint; `saveState()` and `suspend()` perform their own checks.

### Restore instructions and tools

Validate the envelope with `parseSessionState(json)`. If you trust the storage, read and reuse the last accepted instructions with `await readSessionInstructions(state)`. Older v2 and manual v3 checkpoints can lack that record. The reader then throws, and you can restore with current trusted instructions.

Idle restore requires matching managed declarations, including materialized borrowed MCP tools. The SDK compares names, descriptions, parameter schemas, namespaces, and catalog order. Current callback implementations can differ. Selected checkpoints retain the full admitted catalog, including hidden tools, separately from narrowed defaults.

The destination selects native `HttpMCP` and `StdioMCP` declarations. Restore matching managed declarations first, then use supported idle updates within the opening ceiling.

### Model settings on restore

Portable restore uses the checkpoint's latest accepted model settings. Those settings include the model, reasoning effort, reasoning summary and service tier.

Fork retains those accepted settings too. A different model or setting on the destination Agent does not replace the saved settings. Current provider credentials, callbacks, context and Environment still come from the application. To change accepted settings on an ordinary Session, restore first and call `session.update({ model, modelSettings })` while idle. Finish a pending manual turn before updating. Sessions opened with `NativeAgents` keep their model settings fixed.

### Output and checkpoint versions

Treat checkpoints as opaque data for this SDK and language. The current reader retains SDK envelope versions 2 through 15, subject to each version's restore checks below, and rejects unknown versions. SDK envelope versions and native checkpoint codec versions are separate. Do not edit a version or `codex_revision` to bypass validation.

The destination SDK must use the exact Codex revision that saved the checkpoint. A recognized envelope does not permit another native revision. Current trusted host configuration still supplies credentials, callbacks, tool bindings, the matching output contract, and executor policy; a recognized version grants none of those permissions.

The [checkpoint capture provenance](../../../packages/agents-codex/test/native/fixtures/checkpoint-upgrades/README.md) records real idle, manual, and Code Mode captures from a preview source snapshot and its matching native artifact. Retained captures qualify later candidates by replaying accepted history and checking current restore refusals. They do not establish a stable-release upgrade, coverage of every historical preview, cross-language conversion, downgrade support, or arbitrary native-revision portability. Keep the producer SDK available until your candidate passes the relevant continuation tests.

For a pending manual checkpoint, instructions and pending tool declarations/result schemas must match. Output-aware versions also require the same effective mode, JSON schema, and repair budget. Omitted, `undefined`, and zero repair budgets have the same output identity. Supply the matching output declaration on the destination Agent before restoring.

| Idle / pending versions | Data and restore constraints |
| --- | --- |
| Legacy idle v2 / pending v3 | Plain-text final output only. |
| v4 / v5 | Effective output contract. Pending v5 supports plain or prompted output over HTTP or WebSocket; native structured output retains the active turn's schema, including a per-turn override. |
| v6 / v7 | Adds settled Code Mode stored JSON, cell counters, and terminal observations. |
| v8 / v9 | Retains managed defaults; pending v9 can retain the paused operation's static selection. |
| v10 / v11 | Managed defaults and optional pending selection, with settled Code Mode state. |
| v12 / v13 | Explicit network policy identity for ordinary idle/manual state, with the same optional selection data. |
| v14 / v15 | Explicit network policy identity with settled Code Mode state and the same optional selection data. |

Code Mode capture refuses active cells. It preserves stored JSON object keys as data, including `__proto__`, without changing object prototypes. It does not serialize JavaScript stacks, arbitrary globals, or old reply grants. The destination supplies current trusted declarations and callback implementations.

An omitted selection differs from an empty one. Saved defaults control later ordinary roots. Neither defaults nor selections add authority beyond the destination's opening tools. Use a reader that supports the envelope as written.

### Manual suspension and repair receipts

Prompted output works with live manual replies and explicit `suspend()`. Supply `onInteraction` for a one-shot prompted run that uses manual tools; implicit pending transfer remains plain-only. A pending capture uses the active turn's output override, while an idle capture uses the Session default. After a successful seal, repeated `suspend()` calls return detached copies of the retained receipt, including after close or an application persistence failure. A rejected pre-commit suspension leaves existing requests live.

Output-aware envelopes retain passive repair receipts separately from native history. Save, fork, supplied-summary replacement, and later manual suspension preserve them without replaying requests or effects. They preserve exact counters and actual attempt identities across capture; a new root retargets only their parent Session identity. Restoring receipts grants no reply authority. Neither corrected text nor repair receipts enter later model context. If a possibly admitted attempt lacks a complete receipt, portable capture remains unavailable for that Session.

## Fork a conversation

Use `saveState()` to capture the current conversation identity for later restore. Use `fork()` to create portable state for a fresh, independently owned root with the full retained history up to the capture boundary. Forking makes no model request and does not replay recorded tool effects. Later source turns do not enter the branch. You can continue using the source and close either Session independently.

On a settled portable source Session, await `source.fork()`. Pass the returned state to `await agent.session({ state })` to open the branch. Submit its new input, await the returned Turn's `wait()`, and read `finalOutput` after that wait succeeds. Close the branch in an async disposal scope or `finally`. The [native fork tests](../../../packages/agents-codex/test/native/settled-fork-native.test.ts) verify the copied history boundary and independent Session ownership.

Restore with the current trusted declarations described in [restore instructions and tools](#restore-instructions-and-tools). The destination uses the saved accepted model settings and current application credentials, callbacks, context, and Environment. A branch's new Session ID does not create a new external business operation: retain the original application effect key when checking or deduplicating effects. Close the source as well as the branch when their owners finish.

Fork requires settled portable root history without descendants, pending effects, or live background terminals. Local profiles and custom SessionStore storage do not support it. Retained checklist and goal data do not grant destination tools or resume autonomous work. An [application-supplied summary](session-configuration.md#context-compaction) is an optional context replacement with its own stricter limits. The [summary-and-fork helper](../fork-summary.ts) composes the two operations; a full-history fork needs no summary.

## Storage and recovery tasks

Continue with the guide for the storage or recovery task you need.

| Task | Guide |
| --- | --- |
| <a id="live-capabilities-and-checkpoint-advice"></a>Inspect admitted features | [Live capabilities and checkpoint advice](recovery.md#live-capabilities-and-checkpoint-advice). |
| <a id="check-capture-readiness"></a>Inspect portable capture readiness | [Check capture readiness](recovery.md#check-capture-readiness). |
| <a id="reconcile-external-effects"></a>Confirm an uncertain external outcome | [Reconcile external effects](recovery.md#reconcile-external-effects). |
| <a id="resume-external-work"></a>Continue a durable manual job | [Resume external work](recovery.md#resume-external-work). |
| <a id="local-native-profiles"></a>Open or resume a native profile | [Local native profiles](local-state.md#local-native-profiles). |
| <a id="profile-ownership"></a>Separate profile and workspace ownership | [Profile ownership](local-state.md#profile-ownership). |
| <a id="supported-capabilities"></a>Choose supported native-profile features | [Supported capabilities](local-state.md#supported-capabilities). |
| <a id="reopen-with-descendant-history"></a>Reopen a root with descendant history | [Reopen with descendant history](local-state.md#reopen-with-descendant-history). |
| <a id="persistence-failures-and-cleanup"></a>Reconcile a native profile and finish cleanup | [Persistence failures and cleanup](local-state.md#persistence-failures-and-cleanup). |
| <a id="native-local-goals"></a>Declare and inspect native goals | [Native local goals](local-state.md#native-local-goals). |
