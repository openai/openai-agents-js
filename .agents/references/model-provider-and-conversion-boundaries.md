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

## Provider Validation and Error Ownership

Do not duplicate provider-side request validation in the SDK merely to fail earlier. When the provider already rejects an invalid value with an actionable error, preserve that single source of truth instead of copying provider grammar, length limits, enum membership, or other request constraints into SDK runtime code. Duplicated validation can drift as provider contracts evolve, can reject values accepted by another provider, and can turn a provider-neutral SDK type into an accidental provider-specific contract.

Add SDK-side validation only when it enforces an SDK-owned invariant or prevents a concrete risk that provider validation cannot address. Examples include ambiguous local routing, collisions before request serialization, invalid persisted state, unsafe local side effects, or a provider error that cannot identify the offending SDK input. A generic preference for earlier failure or a different error message is not sufficient.

When local validation is justified and the constraint is provider-specific, keep it at the owning adapter boundary and derive it from an authoritative provider contract. Do not apply it to shared `Model` interfaces, provider-neutral tool types, or third-party adapters. Tests should distinguish the SDK-owned invariant from values that are intentionally left for the provider to validate.

## Provider Data and Raw Events

- Treat `providerData` as namespaced provider extension data. Remove SDK-reserved keys before forwarding unknown options, preserve per-tool-call metadata through replay, and do not drop values needed by third-party providers.
- Raw model stream events must carry their source discriminator so consumers can narrow Responses and Chat Completions events safely.
- Keep response IDs, request IDs, usage, refusal, and terminal status available through normalized responses even when providers surface them in different chunks.

## Retry and Persistent Transports

- Model retries are opt-in. Apply abort and replay-safety vetoes before user policy, preserve failed-attempt usage, and do not retry a stateful request unless the provider indicates replay is safe or the request boundary proves it.
- Responses WebSocket mode reuses a persistent connection and chains requests with connection-local state. Serialize access per session, propagate terminal errors, and close only the session-owned socket.
- Compare HTTP and WebSocket Responses behavior for input, continuation, raw events, terminal items, and errors; transport choice must not change runner semantics.

## Review Checklist

1. Identify provider capability and the exact converter/transport that owns it.
2. Before adding validation, determine whether it protects an SDK-owned invariant or only duplicates an actionable provider error.
3. Compare agent, runner, per-run, model-default, and provider-data precedence without mutation.
4. Test Responses and Chat Completions plus streaming/non-streaming when both are supported.
5. Preserve IDs, usage, raw events, metadata, terminal status, and absent/null distinctions.
6. Test retry replay safety and persistent transport ownership with abort and close failures.

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
