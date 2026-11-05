# Native input, retrieval and specialist tools

These three examples run local scripted Responses through `@openai/agents/testing`. Use Node.js 24 and [build the matching workspace and native runtime](../guides/building.md). Run each command from the repository root. The scripted examples need no model API key.

## Send an inline image

```sh
pnpm exec tsx packages/agents-codex/examples/input-retrieval-specialist/image-input.ts
```

The example creates a red PNG, reads its bytes into an inline image data URL, and submits that URL alongside text. It validates the scripted final answer. This checks request transport and output validation. Use a live model to assess image understanding. Supply inline image data for this input. Paths, remote URLs, file IDs, and PDFs cannot serve as image bytes.

## Check retrieved source IDs

```sh
pnpm exec tsx packages/agents-codex/examples/input-retrieval-specialist/retrieval.ts
```

The application supplies decoded text and selects the tenant through typed context. The model supplies a query. The tool returns up to two passages per search, each capped at 240 JavaScript string code units.

The application records returned IDs across searches in the same run. It rejects a final citation outside that set, including a foreign tenant ID. The `found` flag must agree with whether the answer cites a source. Each ID must identify a passage within its tenant. Assessing whether the text supports the answer requires a separate content check.

## Call a specialist from a tool

```sh
pnpm exec tsx packages/agents-codex/examples/input-retrieval-specialist/specialist-tool.ts
```

The ordinary `consult` tool opens a Session for a separately configured Agent. The application gives that Agent its own catalog context, tool list, output schema, and borrowed provider. The summary title is bounded to 240 JavaScript string code units.

The tool closes the nested Session on success, failure, or parent cancellation and joins cleanup before returning. The testing callback owns the provider. Other callers retain ownership of their Sessions. An application closure keeps the authority granted to it even when its TypeScript fields are readonly. For child tracking within the same Session, see [native child agents](../guides/executors.md#native-child-agents).

## Retrieve and check sources with a live model

The standalone [retrieval example](../retrieval.ts) uses a live model and a fixed tenant-scoped corpus. Set `OPENAI_API_KEY` and, for a different Responses endpoint, `OPENAI_BASE_URL`. Run it from the checkout root.

```sh
pnpm exec tsx packages/agents-codex/examples/retrieval.ts
```

The tool accepts a bounded query and records up to two passages per call, each capped at 240 Unicode code points. After structured output settles, `checkSources` verifies that each cited ID appeared in the results and that `found` agrees with the citations. Unknown citations reject the result. Provider failures reject the request.

## Run the standalone specialist

```sh
pnpm exec tsx packages/agents-codex/examples/specialist-agent.ts
```

The [standalone specialist](../specialist-agent.ts) uses scripted providers and checks both tool receipts. Its outer `consult` tool opens an independent specialist Session with a selected read-only catalog value, one `read_catalog` tool, and a summary schema.

Cancellation closes and joins the nested Session even during opening or submission. Callback and output-validation failures reject the outer run. Observe its cleanup errors as well as the Session close result. The application chooses trusted tools and data for each Session. Native children share their parent's Session and follow [different lifecycle rules](../guides/executors.md#native-child-agents).
