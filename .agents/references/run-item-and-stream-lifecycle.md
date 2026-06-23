# Run Item and Stream Lifecycle

Use this reference for new model output types, run items, stream events, result extraction, history replay, persistence coordination, or SDK-only custom data.

## Coordinated Item Surfaces

- A new model output or tool-call variant normally needs coordinated handling in protocol types, model conversion, `processModelResponse()`, actionable tool metadata, `RunItem` wrappers, stream events, result history, session conversion, RunState serialization, tracing, and adapters.
- Keep raw provider items and SDK wrappers distinct. `rawItem` is replay/persistence data; wrapper fields carry SDK identity, agent attribution, and SDK-only metadata.
- Separate a tool call item from its output item in stream events and history. Consumers must be able to order calls and results and match them by stable identity.
- Tool-search outputs can update an earlier call and can arrive out of order. Prefer provider call IDs, then stable item IDs, and do not let server-executed outputs consume pending client-executed call IDs.

## Replay and Persistence

- Convert only replay-safe items into later model input. Drop pending hosted calls that lack a matching output and remove reasoning items whose owned call was dropped.
- Avoid replaying provider persistence metadata such as assistant conversation item IDs when the next request expects fresh input. Preserve reasoning identity only where the target persistence API supports it.
- `RunResult` history and session history have different consumers. Apply public-history cleanup and session normalization deliberately rather than assuming one conversion is correct for both.
- SDK-only `customData` belongs on wrappers and serialized SDK state, not in provider-visible model input. Extract it from a cloned execution value so custom extractors cannot mutate the actual tool result.

## Streaming Events

- Raw model events preserve provider source information. Run-item events represent SDK lifecycle milestones; do not infer one from the other when a provider omits a delta or emits a terminal item directly.
- Reconcile streamed text and item events without duplicating content when a final item repeats already emitted deltas. Delay synthetic final events until tool and side-effect completion makes their order truthful.

## Review Checklist

1. List every protocol, processing, execution, event, replay, persistence, serialization, tracing, and adapter surface for a new item.
2. Verify stable call/output matching with missing IDs, out-of-order outputs, and repeated updates.
3. Test streaming and non-streaming extraction and public/session history separately.
4. Confirm pending or orphan calls cannot be replayed without results.
5. Ensure SDK-only metadata never leaks into provider payloads or mutates caller-owned values.

## Sources

- `packages/agents-core/src/items.ts`
- `packages/agents-core/src/events.ts`
- `packages/agents-core/src/result.ts`
- `packages/agents-core/src/runner/items.ts`
- `packages/agents-core/src/runner/modelOutputs.ts`
- `packages/agents-core/src/runner/streamReconciliation.ts`
- `packages/agents-core/src/runState.ts`
- `packages/agents-core/test/items.test.ts`
- `packages/agents-core/test/events.test.ts`
- `packages/agents-core/test/result.test.ts`
- `packages/agents-core/test/runner/modelOutputs.test.ts`
- `packages/agents-core/test/runner/items.helpers.test.ts`
- `packages/agents-extensions/test/ai-sdk-ui/uiMessageStream.test.ts`
- `docs/src/content/docs/guides/results.mdx`
