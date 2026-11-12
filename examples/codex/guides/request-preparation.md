# Prepare a native model request

In `0.22.0-alpha.2`, `prepareRequest` changes what the model samples without changing canonical conversation history or the original tools' execution authority. Use it to add sampling-only context or adjust the descriptions and parameter schemas shown to the model.

Run the [scripted request preparation example](../prepared-request.ts) from the repository root with matching built packages and native runtime. It needs no model credential:

```sh
pnpm exec tsx examples/codex/prepared-request.ts
```

The command prints `The record is allowed.` after checking a two-request tool round trip. The first request produces a tool call. A `before` hook corrects the tool arguments, the original handler runs once, and an `after` hook shapes its result. The request editor then adds a sampling-only note and changes the presented instructions and tool schema for the next call. The example checks the outgoing request and the actual tool effect separately.

## Select the supported request path

Pass `prepareRequest` to `session.submit()`, `session.enqueue()`, or a new `agent.run()` with input. The supported profile requires all of these conditions:

- The editor has been requiring `NativeProvider({ supportsWebsockets: false })` explicitly and a standard Responses model. Responses Lite and WebSocket-enabled calls have been remaining outside this profile. The scripted peer has already been supplying an HTTP provider. An eligible plain run's default HTTP selection has not been replacing this explicit setting.
- Edit direct root sampling with eager ordinary function or MCP tools. Selected deferred tools reject before the callback. In an explicit Session, `beforeStep` can narrow a mixed opening catalog to an eligible selection. A one-shot `agent.run()` with an editor requires an eager opening catalog.
- Omit an Environment, programmatic Code Mode, native children, native goals, checklists, web search, and hosted tool registrations. An empty selected tool list does not make these other configurations eligible.
- For structured output, use native output or prompted output with `maxRetries: 0`. Request editing does not support output correction attempts.

The callback does not intercept child, reviewer, background, or compaction requests. Automatic compaction before or during a turn fails the edited operation before making a hidden model request. Earlier tool effects remain. Shorten the input or start a new operation without the editor. Post-turn compaction is also refused, but the completed answer remains available.

## Return the detached request

The callback receives `request`, application `context`, its owning `submission`, a cancellation `signal`, `preparationIndex`, and `recoveryAttempt`. The request exposes `instructions`, `input`, and `tools`. Each tool presentation exposes editable `description` and `parameters`; its identity and other declaration fields stay fixed.

Return the edited `request`, or a valid replacement, to apply changes. Returning `undefined` keeps the original sampling request, including when you mutated the detached object. The SDK captures a returned replacement when the callback settles. Later mutations to an object retained by the application do not change the captured request. All replacement data must be lossless JSON.

Sampling edits do not change the registered handler, validator, approval policy, or tool-selection authority. Widening a sampled parameter enum cannot make the original validator accept a new value. Removing a tool's presentation is not a substitute for selecting allowed tools before sampling.

## Handle retries, cancellation, and restore

`preparationIndex` starts at zero for an operation and advances on each preparation. Recovery can prepare again without a completed response, so inspect the request input instead of treating the index as a completed-step count. Internal HTTP retries reuse the captured edit. Keep business effects out of the callback.

Use the callback's `signal` for cooperative cancellation. Cancellation joins an entered asynchronous callback before the next root can proceed. A thrown callback fails preparation before dispatching that edited request; it does not undo earlier tool effects.

An active edited operation cannot export a manual checkpoint. For manual tools in `agent.run()`, supply `onInteraction` to answer live requests. Do not add an editor to `agent.run(null, { state, ... })` when resuming an admitted turn. Completed idle history can be saved and restored; supply a fresh callback on the next new operation. The callback and sampling-only edits do not persist as executable configuration or canonical history.

To inspect effective scalar settings and correlate retained responses without editing a request, use [passive request metadata](request-metadata.md). For a classic Model wrapper, use [prepared model declarations](../prepared-model-declarations/README.md).

For broader native model-input replacement, see [`transformContext`](session-configuration.md#control-model-context-and-completion). It also covers child, compaction, and output-repair input, but does not edit tool presentation.
