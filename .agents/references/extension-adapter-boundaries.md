# Extension Adapter Boundaries

Use this reference for AI SDK model/UI adapters, provider metadata, usage translation, reasoning, tool-call conversion, abort propagation, stream completion, or optional integration behavior.

## Adapter Ownership

- Adapters translate between two public protocols; they do not redefine the core runner contract. Preserve the source model/item semantics and reject unsupported constructs explicitly rather than fabricating a lossy equivalent.
- Keep optional adapter dependencies and entrypoints behind `@openai/agents-extensions` subpaths. Importing unrelated extension or SDK roots must not require the adapter dependency.
- Support declared external protocol versions through shape-based compatibility where necessary, with tests for each supported version. Do not assume one dependency's private class identity is stable across versions.

## Model and Message Conversion

- Preserve system instructions, structured output, tool choice, qualified tool names, tool call/result pairing, provider metadata, images, reasoning, usage, and abort signals across generate and stream paths.
- Reject core tool/item types the target adapter cannot represent. Unknown provider items may pass through only through the documented provider-data escape hatch.
- Per-tool-call provider metadata such as reasoning signatures must stay attached to the matching call across multi-turn replay. Do not duplicate one reasoning block across parallel calls.
- Normalize empty string tool input only when the target object schema makes the intended empty object unambiguous.

## Streaming and UI Messages

- Stream adapters must propagate source errors and cancellation to the underlying iterator. A terminal response event can arrive before delayed run-item events; emit finish only after owned item/tool output work is drained.
- Deduplicate text when both deltas and final message items carry the same content, but synthesize message output when no deltas were emitted.
- Preserve tool-search call IDs and replacement outputs exactly as core routing does. Server tool-search outputs without a call ID must not consume pending client calls.
- Emit approval, reasoning, tool input/output, step, and finish chunks in an order accepted by the target UI protocol.

## Usage and Errors

- Translate numeric and object-shaped usage, cache/read-write details, and provider metadata without producing `NaN` or double-counting requests.
- Preserve explicit provider retry guidance and rich error fields while keeping core replay-safety policy in control. Abort remains terminal unless the owning contract says otherwise.

## Review Checklist

1. Test every declared external protocol version and optional-dependency import path.
2. Compare generate and stream conversion for instructions, tools, structured output, metadata, reasoning, usage, and errors.
3. Exercise parallel/out-of-order tool calls and repeated tool-search output updates.
4. Cancel the consumer and prove the source iterator or model request is aborted.
5. Verify finish ordering after early terminal events and late run-item outputs.

## Sources

- `packages/agents-extensions/src/ai-sdk/index.ts`
- `packages/agents-extensions/src/ai-sdk-ui/textStream.ts`
- `packages/agents-extensions/src/ai-sdk-ui/uiMessageStream.ts`
- `packages/agents-extensions/package.json`
- `packages/agents-extensions/test/ai-sdk/index.test.ts`
- `packages/agents-extensions/test/ai-sdk/GoogleFormat.test.ts`
- `packages/agents-extensions/test/ai-sdk-ui/textStream.test.ts`
- `packages/agents-extensions/test/ai-sdk-ui/uiMessageStream.test.ts`
- `docs/src/content/docs/extensions/ai-sdk.mdx`
