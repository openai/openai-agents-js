# Run a classic Model through the native loop

Use `SDKRunner` from `@openai/agents/migration` when a classic Agent and Model fit the adapter's supported features. The native runtime runs the turns. Your application supplies the classic Model or a model name and an explicit provider, and owns their cleanup.

[Build the workspace packages and matching native runtime](building.md), then run the scripted example from the repository root. It needs no model API key.

```sh
pnpm exec tsx packages/agents-codex/examples/migration.ts
```

The [example](../migration.ts) submits a classic Agent to the native loop and reads its settled answer. Pass fresh text or completed SDK conversation items and explicit application context. The selected Model receives the admitted IDs, order, and content. Completed function calls and their results provide history. The adapter rejects pending calls, remote images, files, audio, and unsupported provider items before execution. User messages can include ordered text and inline base64 images with default detail.

A successful run returns final output, copies of the Model responses, guardrail results, and native session, turn, and usage information. See [migrated tools](migrate-tools.md) for functions and delegation, or [migrated streams and sessions](migrate-sessions.md) for live events and history.

## Supported declarations and settings

By default, this experimental API accepts string or synchronous/asynchronous instruction callbacks, text or supported Zod object output, and ordinary strict classic function tools with default error handling and static approval-free policies. The [tool migration guide](migrate-tools.md) describes Agent tools, terminal handoffs, and held approvals.

The adapter rejects unsupported declarations and settings before resolving a provider or opening native resources. Declaration errors point to the full classic runtime. Setting errors identify the unsupported setting. Use `@openai/agents/classic` when a setting is outside this adapter's supported subset.

Supported settings are finite temperature, topP and penalties, positive safe-integer maxTokens, boolean store, cooperative `timeoutMs`, classic `retry` settings, and tool choice hints: `auto`, `none`, `required`, or an enabled ordinary function name. `required` needs an enabled function. Names interpreted as hosted selectors by Responses, such as `web_search`, are refused as named-function choices.

Agent settings retain precedence over Runner defaults, including nested retry/backoff settings. Explicit `modelSettings: {}` avoids unsupported implicit model defaults when needed.

## Resolve instructions for each Model request

Instruction callbacks receive the original Agent and the run's trusted `RunContext` when preparing each selected Model request. Their return value becomes the request's system instructions, which retries reuse. Finishing with a tool result skips the next Model call and its instruction callback. The adapter waits for callbacks that have started to settle, including during cancellation.

## Select Models and control attempts

Pass `model`, `modelProvider`, and `modelSettings` through the adapter options to supply run defaults. Explicit Agent models and settings retain precedence. The classic Runner constructor's `modelOverride` setting is unsupported here. To force a different Model, use an Agent configured with that Model or select the classic runtime.

`SDKRunner.run()` returns after completion. Its `modelInvocation: 'stream'` option selects the Model's streaming method and buffers at most 4 MiB per invocation. It waits for the terminal response, the end of the stream, and iterator cleanup. Use [`SDKRunner.stream()`](migrate-sessions.md#live-model-events-and-accepted-semantic-replay) to receive live Model events.

### Argument conversion

The adapter re-encodes native tool arguments as JSON and runs the original classic parser once. The function callback receives the parsed result. Parser input does not preserve lexical whitespace, escape spelling, duplicate keys, or negative-zero identity. The adapter converts native developer messages to classic system messages.

### Retries and cancellation

The adapter keeps native request, stream, and unbounded connection retries disabled for its owned engine. Selected Model calls use the classic cooperative timeout and opt-in retry rules. The selected provider keeps its transport retry behavior for the first attempt. Later runner attempts disable provider-managed retries. A retry budget alone does not opt into retries without a policy. Visible stream events prevent replay.

A timeout aborts the current Model call and waits for its started producer and iterator cleanup. It does not set a deadline for tools or the whole run. Entered retry advice and policy callbacks also finish before cleanup settles.

The adapter does not close or dispose of the supplied Model or ModelProvider. Cancellation waits for Model, tool, and guardrail callbacks that have started to finish. A callback that ignores cancellation can keep the run pending.

### Execution and cleanup errors

When execution alone fails and cleanup succeeds, the Promise rejects with the execution error. Model and provider errors retain their original thrown value. Function-tool errors that stop execution use the existing `ToolCallError`, whose `error` property retains the underlying failure, including typed tool guardrail tripwires.

Failed cleanup produces `MigrationCleanupError`. Its `retryCleanup()` method retries only the same unfinished cleanup. Concurrent calls share one cleanup attempt. Later calls retry a failed attempt or reuse its successful result. Cleanup retries never resolve a Model, open a Session, submit input, or replay a tool. Some native cleanup failures cannot recover and will keep rejecting.

## Structured final output

A Zod object `outputType` can produce a typed object through the native loop. The adapter uses the existing classic output descriptor for the Model request and the existing native schema preparation. It admits only object schemas whose two generation schemas agree. The adapter rejects known unsupported declarations, including open maps and raw JSON-schema declarations, before provider resolution or native execution. The adapter cannot prove during admission that arbitrary user validators are safe or will succeed.

After the native loop finishes, the captured Agent parses and validates the final JSON once. Output guardrails and synchronous `agent_end` listeners receive that checked value. A successful `finalOutput` exposes the same value with its inferred type.

Result items, history and buffered events keep actual Model and native records. Reading them neither reparses the JSON nor inserts a synthesized parsed object into the conversation.

Invalid JSON, failed schema validation or an output tripwire prevents a successful result. Raw diagnostic observations can still contain the rejected response. A listener or cleanup failure can also reject after validation. Text output remains the default. This subset does not add schema repair, classic `RunState` conversion or general structured-schema compatibility; the direct native structured-output API and full classic route remain available.

Object output uses `SDKRunner.run()`, including buffered `modelInvocation: 'stream'`. The live `SDKRunner.stream()` entrypoint currently accepts text-output Agents.

## Guardrails and lifecycle events

Agent input and output guardrails receive the original Agent and the run's `RunContext`. You can also pass `inputGuardrails` and `outputGuardrails` in the run options. The adapter captures guardrail definitions before callbacks begin. A successful result includes `inputGuardrailResults`, `outputGuardrailResults`, `toolInputGuardrailResults`, and `toolOutputGuardrailResults`.

### Guardrail order

Input guardrails with `runInParallel: false` finish before provider resolution, lifecycle events, or native work. Other input guardrails start alongside the first Model call. The native loop receives that response only after the input checks pass, so a rejected input cannot start a tool. A tripwire cancels the run and waits for its started callbacks to finish.

Output guardrails check the parsed final value before `agent_end` or a successful result is published. These rules also apply when `modelInvocation` is `'stream'`.

Registered function tools support their existing input and output guardrails. An input `rejectContent` result returns its message without invoking the function or its output guardrails. An output guardrail receives the original function result before conversion. `rejectContent` replaces that result. A `throwException` result retains the typed tripwire through `ToolCallError.error`. These checks cover the declared SDK function tools; they do not intercept hidden native or hosted operations.

### Lifecycle listeners

Register Agent listeners as usual, and pass a `RunHooks` instance through the `hooks` option for run listeners. An existing `Runner` also works as the emitter. The adapter does not apply that Runner's run configuration. Listeners run synchronously. The SDK does not wait for promises returned by listeners, so your application owns any asynchronous work they start.

Agent listeners run before run listeners for `agent_start`. Run listeners run first for tool start, tool end, and `agent_end`. Events retain the original Agent, context, and function-tool objects. A function failure attempts one error-end notification, including an input tripwire that prevents tool start. An end listener that throws stops that dispatch. It does not cause a second end notification.

`agent_end` signals that final output guardrails passed. A later listener or cleanup error can still reject the run.

See [the guarded migration example](../migration-guardrails.ts) for a scripted Model, function guardrails, and lifecycle listeners without API credentials.

## Choose the full classic runtime

Choose `@openai/agents/classic` when your application needs any of these features.

- MCP, broader approval workflows, or delegation beyond the [supported tools and handoffs](migrate-tools.md).
- Full classic streaming, `RunState` results, or resume behavior beyond [completed Session history](migrate-sessions.md).
- Other structured-output schemas, media inputs, stores, model settings, or parser behavior outside this guide's supported subset.
