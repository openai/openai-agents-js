# Configure native sessions

Choose the provider, model, and tools for a conversation. For a two-turn example, see [Open and run a session](sessions.md#open-and-run-a-session).

## Validate agent defaults

`await agent.validate()` checks the Agent's default tool declarations and output schema without opening a Session, reading credentials, or connecting to services. It returns `undefined` on success and throws if a declaration is invalid. The packaged native addon must be available.

Context, environment, opening overrides, and native model requirements still need checks when a Session opens. Validation checks the defaults at the time of the call. Changes to those defaults need another check. It does not verify credentials or model availability.

## Provider connection and credentials

`NativeProvider` sends model requests through Codex's built-in Responses client. Choose the endpoint, API key, and WebSocket policy in the provider options. A custom endpoint must implement Responses.

- `baseUrl` defaults to `https://api.openai.com/v1`. To use `OPENAI_BASE_URL`, pass `baseUrl: process.env.OPENAI_BASE_URL`.
- A custom endpoint uses HTTP by default.
- When you omit the key, the SDK reads `OPENAI_API_KEY` as the Session opens.

Close the provider's Sessions before calling `provider.close()`. To open more Sessions after that, create a new provider.

For JavaScript clients and custom model loops, see [classic model configuration](https://github.com/openai/openai-agents-js/blob/feat/codex-harness/packages/agents/CLASSIC.md#choose-a-model-for-a-classic-run) and [native Model migration](migrate-models.md).

## Per-session configuration

Pass `provider`, `model`, or `modelSettings` to `agent.session(...)` or `agent.run(...)` to configure one conversation.

Native `modelSettings` accepts these fields:

| Field | Value and behavior |
| --- | --- |
| `reasoningEffort` | A string selecting the model's reasoning effort. |
| `reasoningSummary` | A string selecting the model's reasoning summary setting. |
| `serviceTier` | A string selecting a service tier, or `null` to clear an inherited override. |

Supported values and account access depend on the model provider. Accepting a setting in the SDK does not establish that the provider accepts it. When you omit reasoning settings, native model metadata can supply defaults. For the resolved fields of a sampling call, read [passive request metadata](request-metadata.md). Native settings do not accept classic fields such as `temperature`, `maxTokens`, or `retry`; use [Model migration](migrate-models.md) for a supported classic Model.

- An opening provider or model overrides the Agent default.
- Defined `modelSettings` keys override the matching Agent settings. Omitted or `undefined` keys inherit the defaults. An empty object inherits every default.
- `serviceTier: null` clears an inherited tier. Tools and workspace access come from their own declarations.

Each Session captures its effective configuration when it opens. The Agent keeps its defaults for other Sessions. The Session borrows a supplied provider and releases its own resources when it closes. Other Sessions can keep using that provider.

Portable `state`, including state from `session.fork()`, retains the saved model and accepted settings. Restore through the same Agent even if its default model differs or is absent. Leave `model` and `modelSettings` undefined when restoring. Passing `modelSettings: {}` rejects the restore.

You can supply a provider with current credentials on restore. Afterward, an idle Session can use `session.update(...)` to change supported settings. A `NativeAgents` Session keeps its opening model settings. Checkpoints omit provider credentials and tool grants.

The scripted [session configuration example](../session-configuration.ts) merges settings, clears an inherited tier, and checks the recorded configuration. It uses the current [source build](building.md), with no model credentials. Run it from the repository root:

```sh
pnpm exec tsx examples/codex/session-configuration.ts
```

The command prints a native Turn receipt after checking the request's effective reasoning settings and omitted service tier. Its synthetic model name and setting values demonstrate configuration; they do not verify access to a live model or tier.

## Load trusted instruction files

With the current [source build](building.md), pass `instructionFiles` when opening a Session or starting a new `agent.run()`. The SDK loads each selected file as UTF-8 during opening, appends its text after the Agent instructions in the supplied order, and separates the parts with blank lines. Relative paths resolve against the application's current working directory. An unreadable file, non-file path, or invalid UTF-8 rejects opening.

Select files and parent directories that untrusted actors cannot modify. File contents become developer instructions. This option does not discover project files automatically or read files through an executor. Later edits to a file do not update an open Session's captured instructions.

The [session configuration example](../session-configuration.ts) creates two private temporary policy files, opens a Session with both, and checks their order in the sampled input. It then reads the Turn receipt, checks the resolved paths and exact byte hashes, closes the Session, and removes the files. See [Inspect effective turn settings](state.md#inspect-effective-turn-settings) for receipt fields and observation limits.

## Prepare one model request

With the current [source build](building.md), use `prepareRequest` to edit detached sampling instructions, input, and tool presentation. Return the edited request to apply it. Read [Prepare a native model request](request-preparation.md) for the HTTP, model, tool, compaction, and restore constraints before adding a callback.

## Override opening tools

Open a Session with `agent.session({ tools })` to replace its initial tool declarations, as with Python's `agent.session(tools=...)`. Omit `tools` to inherit `agent.tools`. Pass `[]` to open without those declarations. The SDK captures each Session's opening configuration before its first await. Concurrent Sessions can use the same tool names with different callbacks or MCP connections. Application hooks keep the original Agent, and the SDK does not change `agent.tools`.

Opening overrides do not remove a separately supplied Environment or programmatic execution capabilities. MCP declarations using the default activation connect during opening. To override tools, use a Session. `agent.run()` does not accept `tools`. Restore uses the current opening declarations and bindings after the existing checkpoint matching checks.

See [the tenant tools example](../opening-tools.ts) for two Sessions with separate callbacks.

## Connection retries and errors

`NativeProvider` uses the native client's request and stream recovery limits and backoff. Its public options do not expose retry budgets. Classic Model retry settings belong to the separate [Model migration](migrate-models.md) route. The SDK disables unbounded connection retries. Startup fails if a managed requirement mandates them. Native retry limits do not set a total operation timeout or cap server-requested delays.

Use `turn.cancel()` to stop an active Turn and join its cleanup, including while it waits to retry. If a request fails, inspect the error before deciding whether to submit more work.

| NativeError field | How to read it |
| --- | --- |
| `statusCode` | Observed HTTP status as a number, or `null` when unavailable. |
| `code` | Observed provider error code as a string, or `null` when unavailable. |
| `category` | Native error classification as a string, such as `authentication_error` or `rate_limit_exceeded`, or `null` when unavailable. |
| `requestId` | Observed provider request ID as a string, or `null` when unavailable. This differs from the SDK's passive request-observation ID. |
| `retryable` | The runtime classified this request error as eligible or ineligible for retry. A terminal error can still report `true` after exhausting its attempt budget. `null` means the runtime supplied no classification. |
| `retryAfterMs` | The server-advised delay remaining when the runtime reported the error. `null` means the runtime observed no advice. `0` includes expired advice. The value stays fixed after the error is reported. |

`NativeError.effects` describes the failed operation.

- `unknown` means the SDK cannot establish its effects. Transport failures and invalid or mismatched receipts report `unknown`, even for `TurnNotSubmitted`.
- `notStarted` means a validated native `not_submitted` receipt rejected the operation before admission.
- `recorded` is reserved for confirmed effects. The SDK does not currently produce this value.

Before repeating an operation with uncertain effects, check the original action against an application or provider record.

### Diagnose authentication failures

With the current [source build](building.md), terminal HTTP 401 or 403 errors retain their observed status, provider code, request ID, and `authentication_error` category when available. Native authentication recovery can make another attempt before reporting a terminal 401. Once recovery ends, authentication errors report `retryable: false`, even if the server supplied `Retry-After` advice. A reported delay does not make that failure retryable.

Check the selected endpoint, model credential, and provider error code before starting more work. An explicit provider API key is captured by that provider; changing `OPENAI_API_KEY` does not replace it. Create a provider with corrected credentials for a new Session or supported restore, and close its Sessions before closing the old provider. A later authentication failure can follow a completed tool effect, so reconcile earlier work before repeating the operation.

### Inspect an incomplete model response

With the current [source build](building.md), `NativeError.responseIntegrityReason` can identify why the runtime rejected model output. Known causes are `undecodable_output_item`, `provider_owned_tool_receipt`, `unfinished_assistant_item`, and `missing_supported_terminal_output`. The field is `null` when the runtime has no recognized cause for the selected failure. Use it for diagnosis alongside the effect information above.

### Check the WebSocket request size

For admitted WebSocket requests, the carrier checks the final JSON after schema restoration and continuation encoding. It rejects requests above 64 MiB of UTF-8 before sending them to the provider. Requests at the exact limit are allowed. Model context limits are separate. A send or disconnect failure has an unknown outcome and is not replayed. Oversized loopback messages rejected before admission can still report a generic connection failure.

## Context compaction

`await session.compact()` asks the model to summarize its context. For an idle, memory-backed root, `await session.compact({ summary: 'The user prefers vegetarian meals.' })` installs a supplied summary without a model request or a new Turn. The SDK keeps system and developer messages, canonical history, Session identity, and current bindings.

To retain other originals, call `await session.modelContext()` while the Session is idle. The snapshot exposes detached Responses-shaped JSON items in native context order. Pass both `snapshot` and `retain` to `await session.compact({ summary, snapshot, retain })`. Each index must be a zero-based integer within the snapshot. An empty list keeps only the protected originals alongside the summary. The SDK ignores duplicate indices and keeps the originals in context order. For a tool call and its result, retain both items or omit both.

Use a fresh snapshot from the same open Session. A turn that changes context or a successful compaction makes older snapshots stale. Edits to the exposed JSON have no effect on retained originals. Use `saveState()` after compaction. Supported restores preserve the summary, retained context, and canonical history. Capture a new snapshot after restore.

A supplied summary must contain text. An abort before source retirement discards the candidate when cleanup succeeds. Once source retirement begins, the SDK finishes publication before reporting cancellation. Close joins the compaction operation. If cleanup is incomplete, the SDK retires the Session. Retry close in that case.

Use a memory-backed root for an application-supplied summary. Persistent storage, goals, active or background work, children, and pending effects prevent this operation.

A declared code environment can accept its first supplied summary if the SDK can prove it is unused. For used or previously compacted programmatic code, use ordinary `compact()` for model-driven compaction of supported state.

The [retained compaction example](../retained-compaction.ts) saves a compacted Session, restores it, and checks the next model request. Run it with the current [source build](building.md) and a scripted provider that needs no credentials.

```sh
pnpm exec tsx examples/codex/retained-compaction.ts
```
