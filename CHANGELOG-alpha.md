# Alpha changelog

Release notes for alpha versions of the OpenAI Agents SDK for JavaScript and TypeScript.

## Unreleased

- Native API-key Sessions with provider-managed history have been selecting standard Responses automatically, including when continuing a stored response. For other requests, `new NativeProvider({ responsesFormat: 'standard' })` has been enabling standard request controls on compatible endpoints. [Provider configuration](examples/codex/guides/session-configuration.md#provider-connection-and-credentials)
- The SDK has been surfacing stream interruptions after publishing ordinary assistant text, even in `agent.run()` without an event reader. Interruptions before the first text event have still been eligible for retry. [Connection retries](examples/codex/guides/session-configuration.md#connection-retries-and-errors)
- The SDK has been leaving generated revision IDs out of application instructions sent to the model. Otherwise identical fresh Sessions have been sending the same prompt prefix while saved history has been retaining the original instruction receipts.
- Idle portable checkpoints for ordinary roots with only unnamespaced JavaScript function tools have been accepting updated, added, and removed tools. An explicit saved selection has been keeping surviving tools in their saved order. [Restore instructions and tools](examples/codex/guides/state.md#restore-instructions-and-tools)
- SDK Sessions have been omitting newly generated CLI collaboration instructions. Older checkpoints have still been retaining collaboration text for replay.

## 0.22.0-alpha.3

### Highlights

- Native agents have been gaining [typed Decisions](examples/codex/guides/decisions.md) and [application-owned model backends](examples/codex/guides/session-configuration.md).
- Native [Realtime and voice](examples/codex/guides/native-voice.md) have been gaining audio input, response controls, history edits, and usage data.
- Native Responses HTTP requests, history reads, and WebSocket handshakes have been reporting the installed SDK version in their `User-Agent`. The bundle workflow has been adding Linux ARM64 to its platform matrix.

### Upgrade actions

- **Tool callbacks can now overlap.** Native catalogs with only automatic tools have been admitting callbacks concurrently by default. Shared mutable state or side effects can race. Setting `maxFunctionConcurrency: 1` on `agent.run()` or `agent.session()` has been preserving one-at-a-time admission per turn. [Function admission](examples/codex/guides/tools.md#function-admission)
- `Session.enqueue()` has been rejecting the previously ignored `ifBusy` option. Calling `enqueue(input)` has been keeping queueing semantics. Calling `submit(input, { ifBusy: 'reject' })` has been rejecting busy work. [Agents and sessions](examples/codex/guides/sessions.md)
- Native Agents with a non-string `Output` type have been requiring a matching `outputType` schema. [Output contracts](examples/codex/guides/output.md)
- Serialized Classic sandbox restores have been requiring trusted `resumeAuthority` bindings. UnixLocal restores have been checking trusted workspace or local snapshot paths. UnixLocal and Docker remote snapshot restores have been checking a trusted snapshot ID. [Sandbox resume and snapshots](docs/src/content/docs/guides/sandbox-agents/clients.mdx#resume-and-snapshots)

## 0.22.0-alpha.2

[GitHub prerelease and prebuilt bundles](https://github.com/openai/openai-agents-js/releases/tag/v0.22.0-alpha.2)

### Highlights

- Add native `fileSearch()`, `codeInterpreter()`, and `imageGeneration()` tools, with retained provider results and streamed progress. `codeInterpreter()` also accepts `allowedCallers`. `webSearch()` adds filters, location, tool choice, and citation details.
- Control active work with exact-step steering, typed supervisory outcomes, and `maxModelSteps`. Optional `RunBudget` limits gate later work based on root requests, observed tokens, and estimated cost.
- Recover native conversations through application-owned `SessionStore` storage, with durable tool-call records and explicit reconciliation of uncertain results. `fileSessionStore()` provides a local file adapter. This preview supports root conversations with application-managed function tools; it does not support MCP, manual tools, environments, native children, goals, or portable checkpoints.
- Connect native agents over A2A 1.0 through `@openai/agents/a2a`. Call remote agents, serve a native Agent, or integrate deferred remote work. The adapter uses JSON-RPC polling; your application owns authorization, durable storage, execution, and reconciliation of uncertain mutations.
- Build speech workflows with `VoicePipeline`, `OpenAISpeechProvider`, and `NativeSessionVoiceWorkflow` from `@openai/agents/voice`. The native workflow speaks validated final string output after the turn settles. A Realtime example delegates substantive work to a native Session.

### Upgrade actions

- Keep all five bundled SDK packages together when upgrading: `@openai/agents`, `@openai/agents-codex`, `@openai/agents-core`, `@openai/agents-openai`, and `@openai/agents-realtime`. The new `@openai/agents-codex` package owns the native runtime; application imports remain at `@openai/agents` and its supported subpaths.
- Replace the removed experimental `SDKRunner` bridge and `@openai/agents/migration` imports. Use native Agent, Session, and Turn APIs directly, or retain classic workflows at `@openai/agents/classic`. Native and classic agents and state remain separate. Follow the [migration guide](https://github.com/openai/openai-agents-js/blob/3b02bd8f560f241762f70b95fe7f55877257bba5/examples/codex/guides/migration.md).
- Review executor write grants. New environments default to `writePolicy: 'strict'`, which permits workspace writes and explicitly granted `writableRoots`. Local environments support strict writes only. Older checkpoints without an executor-policy digest require an explicit remote `writePolicy: 'legacy'` environment to restore with an executor. Start a new conversation to use strict execution. Portable checkpoints require the exact native Codex revision that saved them.

### Added

- Control captured turns with `turn.steerExact()` and acceptance receipts, `turn.waitForAttention()`, and typed interruption outcomes. Exact steering rejects a stale native step with `StaleTurnError`.
- Limit root work with `maxModelSteps`, including the remaining limit after manual suspension. Optional `RunBudget` limits cover root request admissions, observed tokens, and estimated cost. Budgets gate subsequent work; they do not guarantee a spending cap or cover independent child requests.
- Edit sampling-only input, instructions, and tool presentations with `prepareRequest`. Original history, validators, handlers, and permissions retain authority. This opt-in profile requires explicit HTTP, standard Responses models, and eligible root function or MCP tools; it excludes environments, hosted tools, children, compaction, and active portable checkpoints.
- List and read MCP resources and templates with `listMcpResources()`, `listMcpResourceTemplates()`, and `readMcpResource()`. Discover and retrieve prompts with `listMcpPrompts()` and `getMcpPrompt()`. These operations require an idle Session and return application-owned data without adding it to model context. MCP declarations can select no tools for resource-only use.
- Opt into workspace search through `project_glob` and `project_grep`. Use `sandboxEnvironment()` to connect native execution to existing sandbox storage, or read-only, same-path local directory mounts on Linux. Provider-backed storage requires an application-supplied authenticated executor connection.
- Add explicit `TraceContext` propagation, tool callback trace context, sampled turn receipts, passive request metadata, and retained response observations with provider-reported status and usage.
- Inspect selected native errors through the read-only `responseIntegrityReason` field. It is `null` when the original owned cause is unavailable.
- Retain selected original model context alongside a supplied compaction summary. Idle local Sessions with `NativeGoals` can also set or update a paused goal.
- Return a failed tool result after a callback timeout with `timeoutBehavior: 'error_as_result'` and optional `timeoutErrorFunction`. The default still fails the turn. Timeout handling joins entered callback cleanup and cannot undo completed effects.

### Fixed

- Recover MCP connections without replaying calls whose outcomes are unknown. Stop sampling after final HTTP 401 or 403 responses and bound credential recovery across transport fallback.
- Preserve synchronous function results, cache-write token counts, and tracing and privacy settings across queued submissions and later child turns. Report unknown model context windows as `null`.
- Preserve cleanup ownership after failed one-shot runs and reconciliation. Cancellation and Session close prevent new automatic compaction requests.
- Reduce native binary size and memory use, reuse compatible HTTP clients and bundled model catalogs across Sessions, and avoid loading the classic agent runtime through native sandbox helpers.

## 0.22.0-alpha.1

[GitHub prerelease and prebuilt bundles](https://github.com/openai/openai-agents-js/releases/tag/v0.22.0-alpha.1)

This alpha introduces the embedded Codex harness through `@openai/agents`. Use the examples and package guides from the same release as your installed SDK.

### Added

- Run agents with `Agent.run()` or open an `Agent.session()` for a conversation. The Codex harness manages model turns, tool execution, history, and compaction.
- Define TypeScript function tools with schema validation, application context, and typed output. Connect native MCP tools and manage remote executors through an `Environment`.
- Observe text and tool events, steer active work, queue independent submissions, and cancel a captured `Turn` with cleanup.
- Save and restore supported portable `SessionState` checkpoints, fork idle sessions, and compact conversation context. Use `LocalStorage` for local profiles with separate persistence rules.
- Handle manual tool requests and apply tool approval and result policies. Inspect live session capabilities before selecting features or saving a checkpoint.
- Test native sessions against local scripted responses through `@openai/agents/testing`, without a live model or API key.

### API changes

- Import the Codex harness API from `@openai/agents`. Use `@openai/agents/classic` for the classic Agent and Runner APIs, and `/classic/realtime` for the retained Realtime API.
- Keep classic and native session state separate. Converting an active classic `RunState` into native `SessionState` is unsupported.
- Use the experimental `@openai/agents/migration` adapter for supported classic declarations that run through the native engine. The [classic guide](packages/agents/CLASSIC.md) describes its supported features and limits.

### Documentation and examples

- Start from one platform bundle with the compiled native runtime, matching SDK packages, a lockfile, and `hello.mjs`. See [installation](examples/codex/guides/installation.md) for release availability and setup.
- Add the same matched package set to an existing application with local file dependencies and npm overrides.
- Follow the [native API guide](packages/agents-codex/NATIVE.md), [testing guide](packages/agents-codex/TESTING.md), and [examples](examples/codex/README.md) for supported workflows.
