# Select the classic API explicitly

This package provides the TypeScript Agents SDK 0.21.0 API through `@openai/agents/classic`. Its classic Runner, custom Model/ModelProvider, tools, sessions and streaming use the restored classic runtime. The package root, `@openai/agents`, continues to select the current native API.

Change the import path when bringing an ordinary classic application into this package. Existing classic calls then keep their engine. This snippet uses top-level `await`; run it in an ESM module or place the calls inside an async function:

```ts
import { Agent, Runner } from '@openai/agents/classic';

const agent = new Agent({ name: 'assistant' });
const runner = new Runner();
const result = await runner.run(agent, 'Hello');
console.log(result.finalOutput);
```

The default OpenAI provider requires credentials when it makes a request. Custom Models can run without an OpenAI request or native helpers. See `examples/classic.ts` for an offline custom-Model example.

The retained public auxiliary routes are `/classic/testing`, `/classic/utils`, `/classic/sandbox`, `/classic/sandbox/local`, `/classic/realtime` and `/classic/realtime/testing`. Their implementations and optional integration requirements come from the matched classic packages. Realtime retains its existing API; this change does not introduce a new audio runtime.

For a pre-created Modal sandbox, the [selected sandbox example](examples/selected-modal-sandbox.ts) binds the application-supplied handle through the existing `SandboxClient` and `SandboxSessionLike` contracts. Use a `SandboxAgent` with only `capabilities: [shell()]`, imported from `@openai/agents/classic/sandbox`. The example accepts one blocking `python -V` probe with `login: false`; it suppresses command output and returns the exit code. It does not create or look up a sandbox, change its proxy configuration, or implement a general Modal backend.

Pass `borrowSelectedModalProbe(selected)` as `sandbox.session` to retain application ownership. Pass `ownSelectedModalProbe(selected, disposeSelected)` as `sandbox.client` only when granting the SDK responsibility to dispose that selected resource. Owned shutdown joins the admitted probe before calling the supplied disposal action once. No extra credentials or live proxy are needed for the controlled selection tests. A real supplied handle uses its application's existing provider setup. The adapter rejects unsupported provisioning and execution options; it provides no PTY, file tools, snapshots or resume. Native `Environment` ownership remains unchanged.

This package builds on the classic 0.21.0 implementation. It adds `modelOverride` and an internal runner-factory hook. The hook keeps the ordinary classic Runner as its default and does not choose a different engine globally.

The classic and native runtimes use separate session state. Converting an active classic `RunState` into native `SessionState` is not supported. Neither entrypoint switches runtimes automatically.

## Retained classic APIs

For retained sessions, guardrails, tracing, and Realtime, use the [classic SDK guides](https://openai.github.io/openai-agents-js/). Translate their `@openai/agents` imports to `@openai/agents/classic`, and `@openai/agents/realtime` imports to `@openai/agents/classic/realtime`. The native package root has a different API.

See the packaged [testing guide](TESTING.md) for `ScriptedModel`, `ScriptedRealtimeTransport`, and `scriptedSandboxSession`. SDK-backed classic MCP clients require the optional `@modelcontextprotocol/client` dependency (the matched core package declares version `2.4.0`) in your application.

Use `@openai/agents/classic` for classic `Agent`, `Runner`, `run`, tools, handoffs, guardrails, tracing, `RunState`, and session stores. Use `/classic/realtime` for `RealtimeAgent`, `RealtimeSession`, and OpenAI audio transports. Use `/classic/testing` and `/classic/realtime/testing` for deterministic model and transport doubles. Sandbox APIs remain under `/classic/sandbox` and `/classic/sandbox/local`.

A `tool()` declaration requires a supported parameter schema in its TypeScript options and at runtime. For a tool without arguments, use an empty object schema such as `z.strictObject({})`.

### Choose a model for a classic run

Classic `Runner` model and model settings supply defaults. An explicit Agent model and explicitly configured Agent settings take precedence.

To choose the model explicitly for every Agent in a Classic run, including handoff targets, use `new Runner({ modelOverride: yourModel })`. The value can be a model name or an existing `Model` implementation. Names resolve through the Runner's `modelProvider`; Model objects are used directly. This overrides Agent models and the Runner's `model` default without changing the registered Agents. Model settings keep their separate precedence: explicit Agent settings still win over Runner settings.

Create a Runner for the selected override, then call its `run()` method. Set `modelOverride` on the Runner constructor. Omit it to retain the existing defaults. This option belongs to the classic Runner. The experimental `/migration` entry point does not accept it.

An `Agent.asTool()` call starts a separate nested Runner and does not inherit the parent's `modelOverride`. Opt in for that child with `child.asTool({ toolDescription: 'Ask the child', runConfig: { modelOverride: childModel } })`. An explicit child Model keeps its existing protection against inherited parent transport settings.

To edit model-facing instructions, history, or tool declarations, use the application-owned wrapper in the [prepared Model declarations example](examples/prepared-model-declarations/README.md). It clones the request data before editing it. Set the wrapper as the Agent's `model`, as the example does, or pass `new Runner({ modelOverride: wrappedModel })` to select it across a classic run's handoffs. The Runner still uses the original registered tools, schemas, and approval policy for execution. Editing a sampled declaration cannot enable a disabled tool or expand its executable arguments.

Classic `toTextStream()` emits text from all responses, including intermediate agents. It can emit text before guardrails finish. Await successful completion and read `finalOutput` when you need the final result after guardrails pass. `result.input` exposes the stored array for array input; make a detached copy before editing it.

## Hosted web search through Responses HTTP

Use the classic `Agent`, `Runner`, `OpenAIProvider`, and `webSearchTool` exports for hosted search. Select Responses HTTP explicitly with `new OpenAIProvider({ apiKey, baseURL, useResponses: true, useResponsesWebSocket: false })` and pass it as the Runner's `modelProvider`. Omit `baseURL` for the default OpenAI endpoint; a custom endpoint must support this Responses route and its tools.

Declare controls with `webSearchTool({ filters: { allowedDomains: ['example.com', 'example.org'] }, userLocation: { type: 'approximate', city: 'San Francisco', country: 'US', region: 'California', timezone: 'America/Los_Angeles' } })`. The typed location supports timezone. The SDK forwards these as `filters.allowed_domains` and `user_location`. Set the outer `modelSettings.toolChoice` to a supported choice such as `'web_search'` or `'auto'`; omit it to retain the provider default. Explicit Agent settings take precedence over Runner defaults.

Read answer text from `result.finalOutput`. Each `result.rawResponses` entry exposes the actual wire response in `providerData`; its assistant output content contains URL citations in `annotations`, including the returned `url`, `title`, `start_index`, and `end_index`. Normalized message content retains the same annotations in `content[i].providerData.annotations`. Hosted calls appear as `hosted_tool_call` items with `name: 'web_search_call'`, status, and action/source metadata in `providerData`. Missing passages remain unavailable; an assistant answer is not a retrieved source passage. Pass `result.history` with a follow-up message to the next classic run to replay the returned messages and hosted calls.

Normalized `usage` counters and `result.runContext.usage` default missing measurements to zero. Check the actual `providerData.usage` to distinguish unknown usage from a measured zero, or enable `modelSettings.preserveRawUsage` to retain a JSON-compatible `rawUsage` snapshot when the provider supplies a usage object. `JSON.stringify(result.rawResponses)` preserves these carriers, including `rawUsage`; `RunState` serialization retains `providerData` but omits the separate `rawUsage` field. Serialize the named carrier when exporting results rather than relying on the result wrapper's getters.

This route forwards controls and preserves returned metadata. The acceptance tests use a local HTTP fixture. They verify serialization and use of the results by callers and later turns. They do not establish live retrieval, domain enforcement, location or date semantics, index freshness, source quality, or passage availability. This coverage applies to Responses HTTP only.

## Current tracing and Realtime limitations

- `createResponseSpan()` accepts response data, identifiers, and `disabled`; start and end the returned span yourself. `withResponseSpan()` accepts the same options and manages the span lifecycle. It still runs its callback when tracing is disabled. Use `createGenerationSpan()` and `withGenerationSpan()` for detailed generation data.
- `BatchTraceProcessor.maxBatchSize` must be a positive integer. It bounds every export, including forced flushes and shutdown.
- Set the default Realtime model in the `RealtimeSession` constructor options, or override it for one connection with `connect({ model })`. Agent updates and handoffs retain that connection's model. A later connection without an override uses the constructor model when set; otherwise, the transport keeps its normal model-selection behavior. Set `workflowName` alongside `groupId` or `traceMetadata`, and leave tracing enabled, for those trace fields to take effect.
- Committing input audio does not request an assistant response. When turn detection does not create responses, use the OpenAI transport's `requestResponse()` method after committing the audio.

## Experimental native Model migration

Import `SDKRunner` from `@openai/agents/migration` to run a supported classic `Agent` through the native turn loop. Supply fresh text or supported completed SDK conversation items, explicit context, and either a classic `Model` object or a model name with an explicit `modelProvider`. User messages can contain ordered text and inline base64 images with default detail. Completed ordinary function-call/result pairs can end the input without an extra user message. The selected Model receives admitted item IDs, order and content; imported calls are context and never execute again. Remote images, files, audio, pending calls and unsupported provider items reject before execution. Agent model selection and settings retain classic precedence. The adapter returns settled final output, copies of the Model responses, guardrail results, and native session, turn, and usage information. See `examples/migration.ts`.

Choose the route that matches your workflow.

| Workflow | Supported route and limit |
| --- | --- |
| Resolve instructions from application context | [Instruction callbacks](#resolve-instructions-for-each-model-request) run for each prepared Model request; retries reuse the prepared text. |
| Return a tool result without another Model call | [Tool finish policies](#finish-with-a-tool-result) validate the accepted result before publishing final output. |
| Select a Model, timeout, or retry policy | [Model controls](#select-models-and-control-attempts) retain Agent precedence and cooperative cancellation. |
| Call a child and return to the parent | [Agent as tool](#use-an-agent-as-a-native-tool) uses a separate native invocation and text extraction. |
| Transfer the active Agent | [One terminal handoff](#transfer-to-one-terminal-agent) requires text Agents with the same explicit Model object. |
| Hold a function for a decision | [Manual approval](#hold-one-function-for-approval) holds one ordinary function call in this process. |
| Reuse a completed classic conversation | [Session history](#completed-session-history) imports completed items and appends this run's generated items. |
| Display tentative Model events | [Live streaming](#live-model-events-and-accepted-semantic-replay) exposes raw events and replays accepted semantic events after completion. |

These routes have separate limits. In particular, handoffs reject Session storage, Agent tools, manual approval, and live `SDKRunner.stream()`. A supported feature alone does not establish that every combination is supported.

By default, this experimental API accepts string or synchronous/asynchronous instruction callbacks, text or supported Zod object output, and ordinary strict classic function tools with default error handling and static approval-free policies. The Agent-tool, handoff and held-approval sections below describe separate supported extensions. It validates the whole declaration before resolving a provider or opening native resources. Unsupported settings and declarations reject before execution. Declaration errors point to the full classic runtime; setting errors identify the unsupported setting. Use `@openai/agents/classic` when a setting is outside this adapter's supported subset. Supported settings are finite temperature, topP and penalties, positive safe-integer maxTokens, boolean store, cooperative `timeoutMs`, classic `retry` settings, and tool choice hints: `auto`, `none`, `required`, or an enabled ordinary function name. `required` needs an enabled function. Names interpreted as hosted selectors by Responses, such as `web_search`, are refused as named-function choices. Agent settings retain precedence over Runner defaults, including nested retry/backoff settings. Explicit `modelSettings: {}` avoids unsupported implicit model defaults when needed.

### Resolve instructions for each Model request

Instruction callbacks receive the original Agent and the run's trusted `RunContext` when preparing each selected Model request. Their return value becomes that request's system instructions. Retried attempts reuse those instructions. A tool finish skips the next Model call and its instruction callback. Callbacks that have started remain owned until they settle, including cancellation.

### Finish with a tool result

The default `toolUseBehavior: 'run_llm_again'` continues with another Model call after tools. `resetToolChoice` uses the existing SDK rule: after an accepted function result, the default `true` clears the next tool-choice hint except `none`; `false` retains it. These are settings for the selected Model. Native function permissions remain governed by the admitted declaration.

`stop_on_first_tool`, `{ stopAtToolNames: [...] }`, and callable tool-use policies can finish with validated final output. A callable receives the original `RunContext` and standard SDK `FunctionToolResult` records in issued-call order, including the original tool objects and checked JSON callback values. Those values are retained as snapshots separately from accepted wire text. The built-in stop policies use the SDK's `toSmartString` conversion; a callable final decision must provide a string. For a supported object `outputType`, the captured schema validates that string after cleanup, and output guards, `agent_end`, and `finalOutput` receive the checked object.

Tool finish waits for the complete batch's output validation and true native acknowledgments. It then force-stops the owned Turn and joins native, callback, producer, carrier, and provider cleanup before the common output guards and `agent_end`. The result's `native.outcome` reports the actual `turn_aborted` event with reason `interrupted`. `modelResponses` contains only actual Model responses, and result items retain the accepted tool history. Caller abort, an unrelated native error, a guardrail tripwire, or a cleanup failure rejects the run.

### Select Models and control attempts

Pass `model`, `modelProvider`, and `modelSettings` through the adapter options to supply run defaults. Explicit Agent models and settings retain precedence. The classic Runner constructor's `modelOverride` setting is unsupported here. To force a different Model, use an Agent configured with that Model or select the classic runtime.

`SDKRunner.run()` returns after completion. Its `modelInvocation: 'stream'` option chooses the Model's streaming method and buffers at most 4 MiB per Model invocation. It waits for the terminal response, the end of the stream, and iterator cleanup. Use the separate `SDKRunner.stream()` entrypoint below to receive live Model events. The adapter re-encodes native tool arguments as JSON and runs the original classic parser once. The function callback receives the parsed result. Parser input does not preserve lexical whitespace, escape spelling, duplicate keys, or negative-zero identity. The adapter converts native developer messages to classic system messages.

The adapter keeps native request, stream, and unbounded connection retries disabled for its owned engine. Selected Model calls use the classic cooperative timeout and opt-in retry rules. The selected provider keeps its first-attempt transport retry behavior; later runner attempts disable provider-managed retries. A retry budget alone does not opt into retries without a policy. Visible stream events prevent replay. A timeout aborts the current Model call and waits for its entered producer and iterator cleanup; it does not impose a deadline on tools or the whole run. Entered retry advice and policy callbacks also finish before cleanup settles. The adapter does not close or dispose of the supplied Model or ModelProvider. Cancellation waits for Model, tool, and guardrail callbacks that have started to finish. A callback that ignores cancellation can keep the run pending.

When execution alone fails and cleanup succeeds, the Promise rejects with the execution error. Model and provider errors retain their original thrown value. Function-tool errors that stop execution use the existing `ToolCallError`, whose `error` property retains the underlying failure, including typed tool guardrail tripwires. Failed cleanup produces `MigrationCleanupError`. Its `retryCleanup()` method retries only the same unfinished cleanup. Concurrent calls share one cleanup attempt; you can retry if that attempt fails. After cleanup succeeds, later calls reuse that result. Cleanup retries never resolve a Model, open a Session, submit input, or replay a tool. Some native cleanup failures cannot recover and will keep rejecting.

### Use an Agent as a native tool

Add a tool returned by a classic Agent's `asTool()` method to a supported parent Agent. `SDKRunner` runs the original child Agent through a separate native invocation, then resumes the same parent with the extracted text. Both Agents must satisfy the migration contract. The adapter requires the registered Agent tool and its original callable; copying its marker does not make another tool eligible.

The child receives the exact resolved `RunContext`, including the application context and SDK usage. It retains its own Agent configuration. Only the parent's run-level model, provider and model settings supply inherited defaults, following the existing nested run configuration rules. Settings configured on the parent Agent do not become child defaults.

For example, given application-supplied `childModel` and `parentModel` objects:

```ts
import { Agent } from '@openai/agents/classic';
import { SDKRunner } from '@openai/agents/migration';

const child = new Agent({
  name: 'Summarizer',
  instructions: 'Summarize the supplied text.',
  model: childModel,
});
const parent = new Agent({
  name: 'Editor',
  instructions: 'Use summarize, then explain the summary.',
  model: parentModel,
  tools: [child.asTool({ toolName: 'summarize' })],
});
const result = await SDKRunner.run(parent, 'Summarize this text: ...', {
  context: { documentId: 'draft' },
});
console.log(result.finalOutput);
```

Default extraction and `customOutputExtractor` run only after the child's output guardrails and cleanup succeed. The custom extractor receives the completed migration result, including the child's actual native session and turn IDs. Its `agentToolInvocation` contains the original SDK call name, ID and argument text. The result has no classic `RunState`. This nested SDK invocation is separate from the native child-actor API.

This route supports approval-free Agent tools with text output. Manual approval still supports only ordinary function tools. The adapter checks each child's declarations before resolving its provider or calling its Model or tools. Earlier parent work is not rolled back. Live Agent-tool event handlers, resume state, general handoffs and unsupported nested run settings remain rejected through the tool's existing error policy. No rejected path falls back to the classic Runner.

Parent cancellation reaches the child and waits for its started callbacks and producers. Native cleanup can initially fail with `MigrationCleanupError`, retaining the original abort cause and `TurnAborted`. A child cleanup failure also rejects the parent with `MigrationCleanupError`, even when the ordinary tool error policy would return error text. Call `retryCleanup()` on that error to retry unfinished parent and child cleanup. This retry does not rerun either Model or any tools.

### Transfer to one terminal Agent

Use this route when a target Agent should take over, rather than return a tool result to its parent. Add that target to the source Agent's `handoffs` array. Declare exactly one handoff to a distinct target with no further handoffs. Both Agents must use text output and the same explicit classic `Model` object. Run the source through `SDKRunner.run()` with response invocation, the default `modelInvocation: 'response'`.

The target becomes active only after the native runtime accepts the transfer. Its instructions, settings, tools, output guardrails and end listener then apply. If the Model does not choose the handoff, the source remains active. A completed result's `lastAgent` identifies the actual final Agent.

Source tools, target tools and the handoff must have distinct names. This route supports the declared per-handoff `inputFilter`, not general run-level handoff filtering. Filtering does not undo earlier effects. It accepts supported completed caller history as Model context. It rejects Agent tools, held approvals and Session storage. `SDKRunner.stream()` and mixed output schemas remain unsupported for handoffs. This transfers work within the native run; it does not create a native child or transfer classic RunState. Keep broader handoff graphs and unsupported combinations on the classic runtime.

### Completed Session history

Finish the classic run before migrating. Session items do not certify whole-run termination; admission checks completed item snapshots and complete pairs only. Pass `session` to load completed supported messages and complete function-call/result pairs through the classic `Session` contract. Imported calls are Model context; the adapter does not execute them again. Standard empty provider envelopes, matching duplicate item identity and output-text annotations/logprobs remain detached data. Provider metadata cannot override item identity or add approval state. Pending approvals, unmatched calls, unknown items, unsupported media and other provider metadata reject before provider or tool work. This bounded admission does not support the wire-item normalization used by `OpenAIConversationsSession`. Use the classic Runner for that store or unsupported history.

`sessionInputCallback` selects effective history and fresh input before provider work. The selected delta may contain supported completed items or be empty. Historical objects changed by the callback retain canonical classic classification, so they are not appended again. The completed result's `input`, `history` and `toInputList()` include the captured effective history; `newItems` and `output` contain only this run's actual generated items.

After guards and owned cleanup succeed, the adapter awaits `addItems` with the selected fresh input and validated actual generated items. A failed read or input callback prevents execution. A failed append can follow tool effects or a committed write; its original rejection survives caller cancellation. The SDK does not retry or roll back the write. The application owns storage durability and concurrent access. Completed storage can be reopened in another application process; this is not a native checkpoint, live migration, or an exactly-once effect guarantee.

### Reopen an application-owned file Session

The [file Session example](examples/migration-session.ts) combines this completed-history contract with a selected public `ScriptedModel` and a small application-owned JSON store. It exports `openFileSession(path, sessionId)` and `runMigrationSessionPhase(phase, session, effectsPath)` outside the SDK API. The store loads history into the public `MemorySession` and awaits a file write after each mutation. `MemorySession` supplies cloning and chronological reads.

From the checkout root, use Node.js 24 after building the classic packages and matching native addon/runtime helpers. No model API key is needed. Create a private directory and run the three commands sequentially, once each. Each command starts a separate application process with the same explicit session identity and history path:

```sh
SESSION_DIRECTORY=$(mktemp -d)
pnpm exec tsx packages/agents/examples/migration-session.ts classic "$SESSION_DIRECTORY/history.json" "$SESSION_DIRECTORY/effects.txt" example-session
pnpm exec tsx packages/agents/examples/migration-session.ts native "$SESSION_DIRECTORY/history.json" "$SESSION_DIRECTORY/effects.txt" example-session
pnpm exec tsx packages/agents/examples/migration-session.ts restarted "$SESSION_DIRECTORY/history.json" "$SESSION_DIRECTORY/effects.txt" example-session
```

The stored item counts are 4, 8, then 10. The native continuation adds its actual function-call/result pair; the final process restores history without another effect. The effects file contains exactly `old` and `new` on separate lines. The application owns the directory and removes it when finished.

Use one writer and await each operation before starting another. A successful awaited write survives an ordinary application restart. This demo does not provide atomic transactions, crash or power-loss durability, encrypted storage, concurrent access, native checkpoints, pending-approval recovery, or exactly-once effects. A failed write can follow an in-memory mutation or a committed effect. Stop and let the application reconcile uncertain state; do not retry the run automatically. The application owns file validation, access, retention, and cleanup. Only use trusted application-owned history files with this recipe.

The completed-history admission and unsupported-item refusals above still apply. This recipe does not convert native LocalStorage into a classic Session or add the wire-item normalization used by `OpenAIConversationsSession`. Choose the classic Runner for unsupported history; the migration adapter never falls back to it silently.

### Structured final output

A Zod object `outputType` can produce a typed object through the native loop. The adapter uses the existing classic output descriptor for the Model request and the existing native schema preparation. It admits only object schemas whose two generation schemas agree. Known unsupported declarations, including open maps and raw JSON-schema declarations, reject before provider resolution or native execution. Arbitrary user validators cannot be proven safe or successful during admission.

After the native loop finishes, the captured Agent parses and validates the final JSON once. Output guardrails and synchronous `agent_end` listeners receive that checked value. A successful `finalOutput` exposes the same value with its inferred type. Reading result items, history or buffered events does not parse it again. Those views retain actual Model/native records rather than synthesizing a parsed object into the conversation.

Invalid JSON, failed schema validation or an output tripwire prevents a successful result. Raw diagnostic observations can still contain the rejected response. A listener or cleanup failure can also reject after validation. Text output remains the default. This subset does not add schema repair, classic `RunState` conversion or general structured-schema compatibility; the direct native structured-output API and full classic route remain available.

Object output uses `SDKRunner.run()`, including buffered `modelInvocation: 'stream'`. The live `SDKRunner.stream()` entrypoint currently accepts text-output Agents.

### Live Model events and accepted semantic replay

Call `await SDKRunner.stream(agent, input, options)` with the same supported Agent, input and context. This additive entrypoint selects the Model's streaming method; an explicit `modelInvocation: 'response'` rejects before execution. Ordinary `SDKRunner.run()` and the separate classic `Runner.run(..., { stream: true })` route keep their behavior. See [the complete streaming example](examples/migration-stream.ts), which runs without model credentials.

The returned handle exposes two event views. `unvalidatedRaw` is a Web ReadableStream of actual SDK `RunRawModelStreamEvent` values as the selected Model emits them. Raw text and even a Model's `response_done` event can precede final guardrails or a later run failure. Treat this content as tentative. These events are not reconstructed from native carrier SSE, and they do not include native diagnostics.

Use `for await (const event of live)` or `live.toStream()` for supported SDK semantic events: `tool_called`, `tool_output`, and `message_output_created`. They replay accepted items in Model-batch and tool-call order after guarded completion and physical cleanup. A rejected run emits no accepted semantic items. This route does not promise pre-completion semantic delivery, every classic stream event, or a fabricated RunState.

Completed results also support `for await (const event of result)` and `result.toStream()` for accepted semantic replay. Completed handoff results replay `handoff_requested` and `handoff_occurred` for retained transfer items, then an `agent_updated_stream_event` with the actual target Agent before its items. If a handoff filter removes the transfer items, the accepted target change still appears; replay does not recreate the removed items. Check `event.type` before reading item-only fields such as `name` or `item`. This is replay after guarded completion; live `SDKRunner.stream()` handoff runs remain unsupported.

`await live.completed` returns the existing completed result. Read `finalOutput`, `newItems`, `rawResponses`, `lastAgent`, and `runContext`; application context and SDK usage live under `runContext.context` and `runContext.usage`. Native identity and accounting remain separate under `native`. `interruptions` is empty for the current approval-free admission. `history` and `toInputList()` export supported captured input and generated items. Raw Model response records remain diagnostics, rather than a separately guard-certified transcript.

The raw channel has a fixed 4 MiB UTF-8 JSON backlog limit, including SDK event wrappers. This native safety policy is separate from the per-Model payload limit and does not bound exact process memory. Completion does not require a reader while the retained data fits this budget. Overflow fails explicitly, discards pending raw delivery, requests cancellation and joins the producer; it never silently drops content. Consume raw events during execution when you need live progress. Use `run()` for completed-only consumers that do not need this raw channel.

Cancel through the supplied AbortSignal, a raw reader or iterator, or a pending semantic reader. There is no public `live.cancel()` method. Reader cancellation can close delivery before an outstanding Model `next()`, iterator `return()`, tool or guard callback finishes. Always await `live.completed` on cancellation and error paths to join that work. The native execution owner retains the actual outcome: a late cancellation request cannot revoke a successful result. Failed cleanup can reject `completed` with `MigrationCleanupError` even when raw delivery already reported an earlier cancellation reason. An uncooperative callback can keep completion pending.

### Guardrails and lifecycle events

Agent input and output guardrails receive the original Agent and the run's `RunContext`. You can also pass `inputGuardrails` and `outputGuardrails` in the run options. The adapter captures guardrail definitions before callbacks begin. A successful result includes `inputGuardrailResults`, `outputGuardrailResults`, `toolInputGuardrailResults`, and `toolOutputGuardrailResults`.

Input guardrails with `runInParallel: false` finish before provider resolution, lifecycle events, or native work. Other input guardrails start alongside the first Model call. The native loop receives that response only after the input checks pass, so a rejected input cannot start a tool. A tripwire cancels the run and waits for its started callbacks to finish. Output guardrails check the parsed final value before `agent_end` or a successful result is published. These rules also apply when `modelInvocation` is `'stream'`.

Registered function tools support their existing input and output guardrails. An input `rejectContent` result returns its message without invoking the function or its output guardrails. An output guardrail receives the original function result before conversion; `rejectContent` replaces that result. A `throwException` result retains the typed tripwire through `ToolCallError.error`. These checks cover the declared SDK function tools; they do not intercept hidden native or hosted operations.

Register Agent listeners as usual, and pass a `RunHooks` instance through the `hooks` option for run listeners. An existing `Runner` also works as the emitter; its run configuration is not applied. Listeners run synchronously. The SDK does not wait for promises returned by listeners, so your application owns any asynchronous work they start.

Agent listeners run before run listeners for `agent_start`. Run listeners run first for tool start, tool end, and `agent_end`. Events retain the original Agent, context, and function-tool objects. A function failure attempts one error-end notification, including an input tripwire that prevents tool start. A throwing end listener stops that dispatch; it does not cause a second end notification. `agent_end` signals that final output guardrails passed. A later listener or cleanup error can still reject the run.

See [the guarded migration example](examples/migration-guardrails.ts) for a scripted Model, function guardrails, and lifecycle listeners without API credentials.

### Hold one function for approval

Pass `approvals: 'manual'` to `SDKRunner.run()` to opt in to one held function call. This slice supports one enabled registered function with static `needsApproval: true` or `false`, and at most one function call in the run. Dynamic approval predicates, batches, repeated calls, child calls and portable paused state remain unsupported. Ordinary runs still reject approval-bearing tools. `SDKRunner.stream()` rejects this opt-in before execution.

Configured text or supported object output retains its existing validator and result type. The run returns its usual completed result or a live carrier with `status: 'paused'`. A paused carrier exposes `interruptions`, the original `lastAgent` and `runContext`, and the actual native session, submission, turn and call IDs. Each interruption is an SDK `RunToolApprovalItem` built from the actual Model call. It has no `finalOutput`, completed history or RunState. The selected Model and native callback owner remain alive while the call is held. The carrier records that pause; its status tag and retained item metadata do not certify that the native call is still live. Decisions recheck the live owner.

Call `paused.approve(item)` or `paused.reject(item)` with that exact live item, then `await paused.continue()`. Choosing a decision alone does not execute the tool. Continue consumes the choice once; repeated calls join the same completion promise rather than repeating effects. Approval rechecks the current native call before the SDK invocation. The parser, tool guards and hooks retain their normal invocation path after consent. Rejection executes no SDK tool code and sends the supported refusal text through the existing native response and true acknowledgment path. Copies, foreign items, duplicate choices and expired decisions fail.

Pass an AbortSignal when the application may cancel. Cancellation revokes the pending decision and `paused.completed` joins the entered owners. An application callback that has already entered must finish before that join can settle. A late decision cannot restart it. Cleanup failure retains `MigrationCleanupError.retryCleanup()`, which retries cleanup only. Never start a new run to replay an action whose effects are uncertain.

This is an in-process SDK function consent boundary over an actual native-held call. It is not a native `ApprovalRequest` or `NativeQuestion`, and it does not change the native approval policy for other tool families. The carrier is neither a portable checkpoint nor legacy RunState. Start this route with fresh native input; keep pending legacy work on its original runtime until settled. Agent tools and handoffs cannot use this approval opt-in. See [the complete held-function example](examples/migration-approvals.ts), which demonstrates approval and rejection without model credentials.

Use `@openai/agents/classic` for broader approval workflows, MCP, handoffs or delegation beyond the bounded routes above, other structured-output schemas, full classic streaming and RunState-backed results, unsupported conversation history or stores, other media input, state, resume, richer settings, or full parser compatibility.
