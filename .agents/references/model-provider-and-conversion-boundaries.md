# Model, Provider, and Conversion Boundaries

Use this reference for model/provider resolution, settings merge, Responses versus Chat Completions conversion, provider data, raw events, retries, transport reuse, or Responses WebSocket sessions.

## Core Boundary

- `Model` normalizes provider behavior into `getResponse()` and `getStreamedResponse()` outputs consumed by the runner. Preserve provider raw events and provider data needed by public narrowing helpers without making the runner depend on one provider shape.
- `ModelProvider` resolves names and owns model-instance caches or persistent transports. Close provider/model resources only when that implementation created and owns them.
- Agent model configuration takes precedence when explicitly set; the runner/default provider fills only the placeholder. Per-run settings override runner/agent defaults through the established merge helpers.

## Settings and Capability

- Merge nested reasoning, text, retry/backoff, and provider-data maps deliberately. Shallow replacement can silently discard sibling configuration; uncontrolled deep merge can retain incompatible provider options.
- Strip implicit default-model-only settings when a run resolves to a different model, but preserve explicit caller settings. Do not mutate agent-owned settings while preparing a request.
- Responses and Chat Completions differ in structured output, tool/message shapes, reasoning, hosted tools, conversation state, terminal events, and usage. Enforce unsupported combinations in the owning converter rather than pretending feature parity.
- Preserve absent versus `null` versus empty values because providers use them differently. Do not pass empty tools, empty tool outputs, or text response formats when the target path rejects them.

## Provider Data and Raw Events

- Treat `providerData` as namespaced provider extension data. Remove SDK-reserved keys before forwarding unknown options, preserve per-tool-call metadata through replay, and do not drop values needed by third-party providers.
- Raw model stream events must carry their source discriminator so consumers can narrow Responses and Chat Completions events safely.
- Keep response IDs, request IDs, usage, refusal, and terminal status available through normalized responses even when providers surface them in different chunks.

## Retry and Persistent Transports

- Model retries are opt-in. Apply abort and replay-safety vetoes before user policy, preserve failed-attempt usage, and do not retry a stateful request unless the provider indicates replay is safe or the request boundary proves it.
- Providers with ambiguous in-flight acceptance must mark the attempt replay-unsafe before a runner timeout can mask their eventual transport error. Responses and Hosted Multi-Agent WebSocket attempts become replay-unsafe after the request frame is sent; pre-send timeouts remain eligible for the configured retry policy.
- Responses WebSocket mode reuses a persistent connection and chains requests with connection-local state. Serialize access per session, propagate terminal errors, and close only the session-owned socket.
- Compare HTTP and WebSocket Responses behavior for input, continuation, raw events, terminal items, and errors; transport choice must not change runner semantics.

## Review Checklist

1. Identify provider capability and the exact converter/transport that owns it.
2. Compare agent, runner, per-run, model-default, and provider-data precedence without mutation.
3. Test Responses and Chat Completions plus streaming/non-streaming when both are supported.
4. Preserve IDs, usage, raw events, metadata, terminal status, and absent/null distinctions.
5. Test retry replay safety and persistent transport ownership with abort and close failures.

## Sources

- `packages/agents-core/src/model.ts`
- `packages/agents-core/src/providers.ts`
- `packages/agents-core/src/runner/modelSettings.ts`
- `packages/agents-core/src/runner/modelSettingsMerge.ts`
- `packages/agents-core/src/runner/modelRetry.ts`
- `packages/agents-openai/src/openaiProvider.ts`
- `packages/agents-openai/src/openaiResponsesModel.ts`
- `packages/agents-openai/src/openaiChatCompletionsModel.ts`
- `packages/agents-openai/src/openaiChatCompletionsConverter.ts`
- `packages/agents-openai/src/responsesWebSocketSession.ts`
- `packages/agents-openai/test/openaiResponsesModel.test.ts`
- `packages/agents-openai/test/openaiChatCompletionsModel.test.ts`
- `packages/agents-openai/test/responsesWebSocketSession.test.ts`
- `packages/agents-core/test/retryPolicy.test.ts`
- `docs/src/content/docs/guides/models.mdx`
