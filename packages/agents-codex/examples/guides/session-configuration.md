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

- An opening provider or model overrides the Agent default.
- Defined `modelSettings` keys override the matching Agent settings. Omitted or `undefined` keys inherit the defaults. An empty object inherits every default.
- `serviceTier: null` clears an inherited tier. Tools and workspace access come from their own declarations.

Each Session captures its effective configuration when it opens. The Agent keeps its defaults for other Sessions. The Session borrows a supplied provider and releases its own resources when it closes. Other Sessions can keep using that provider.

Portable `state`, including state from `session.fork()`, retains the saved model and accepted settings. Restore through the same Agent even if its default model differs or is absent. Leave `model` and `modelSettings` undefined when restoring. Passing `modelSettings: {}` rejects the restore.

You can supply a provider with current credentials on restore. Afterward, an idle Session can use `session.update(...)` to change supported settings. A `NativeAgents` Session keeps its opening model settings. Checkpoints omit provider credentials and tool grants.

## Override opening tools

Open a Session with `agent.session({ tools })` to replace its initial tool declarations, as with Python's `agent.session(tools=...)`. Omit `tools` to inherit `agent.tools`. Pass `[]` to open without those declarations. The SDK captures each Session's opening configuration before its first await. Concurrent Sessions can use the same tool names with different callbacks or MCP connections. Application hooks keep the original Agent, and the SDK does not change `agent.tools`.

Opening overrides do not remove a separately supplied Environment or programmatic execution capabilities. MCP declarations using the default activation connect during opening. To override tools, use a Session. `agent.run()` does not accept `tools`. Restore uses the current opening declarations and bindings after the existing checkpoint matching checks.

See [the tenant tools example](../opening-tools.ts) for two Sessions with separate callbacks.

## Connection retries and errors

Connection recovery uses the provider's configured retry limits for requests and streams, with the existing backoff. The SDK disables unbounded connection retries. Startup fails if a managed requirement mandates them. These limits do not set a total operation timeout or cap server-requested delays.

Use `turn.cancel()` to stop an active Turn and join its cleanup, including while it waits to retry. If a request fails, inspect the error before deciding whether to submit more work.

| NativeError field | How to read it |
| --- | --- |
| `retryable` | The runtime classified this request error as eligible or ineligible for retry. A terminal error can still report `true` after exhausting its attempt budget. `null` means the runtime supplied no classification. |
| `retryAfterMs` | The server-advised delay remaining when the runtime reported the error. `null` means the runtime observed no advice. `0` includes expired advice. The value stays fixed after the error is reported. |

`NativeError.effects` describes the failed operation.

- `unknown` means the SDK cannot establish its effects. Transport failures and invalid or mismatched receipts report `unknown`, even for `TurnNotSubmitted`.
- `notStarted` means a validated native `not_submitted` receipt rejected the operation before admission.
- `recorded` is reserved for confirmed effects. The SDK does not currently produce this value.

Before repeating an operation with uncertain effects, check the original action against an application or provider record.

### Inspect an incomplete model response

With the current [source build](building.md), `NativeError.responseIntegrityReason` can identify why the runtime rejected model output. Known causes are `undecodable_output_item`, `provider_owned_tool_receipt`, `unfinished_assistant_item`, and `missing_supported_terminal_output`. The field is `null` when the runtime has no recognized cause for the selected failure. Use it for diagnosis alongside the effect information above.

### Check the WebSocket request size

For admitted WebSocket requests, the carrier checks the final JSON after schema restoration and continuation encoding. It rejects requests above 64 MiB of UTF-8 before sending them to the provider. Requests at the exact limit are allowed. Model context limits are separate. A send or disconnect failure has an unknown outcome and is not replayed. Oversized loopback messages rejected before admission can still report a generic connection failure.

## Context compaction

`await session.compact()` asks the model to summarize its context. For an idle, memory-backed root, `await session.compact({ summary: 'The user prefers vegetarian meals.' })` instead installs application-supplied model context without a model request or a new Turn. The SDK preserves canonical history, Session identity and current bindings. The summary remains context after saving and restoring state. Retained system/developer context is selected internally.

A supplied summary must contain text. If you abort via `signal`, the operation waits for cleanup. An abort leaves an already published summary in place. Close also waits for publication. Incomplete cleanup retires the Session. Retry close.

Use a memory-backed root for an application-supplied summary. Persistent storage, goals, active or background work, children, and pending effects prevent this operation.

A declared code environment can accept its first supplied summary if the SDK can prove it is unused. For used or previously compacted programmatic code, use ordinary `compact()` for model-driven compaction of supported state.
