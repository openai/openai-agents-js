# Native input, retrieval and specialist tools

Run these examples from a matching source checkout with Node.js 24, the checkout's pinned pnpm version, installed dependencies, and qualified native products:

```sh
pnpm exec tsx packages/agents-codex/examples/input-retrieval-specialist/image-input.ts
pnpm exec tsx packages/agents-codex/examples/input-retrieval-specialist/retrieval.ts
pnpm exec tsx packages/agents-codex/examples/input-retrieval-specialist/specialist-tool.ts
```

The commands use local scripted Responses through the public `@openai/agents/testing` helpers. They make no live model requests. Imports start no work. The callback owns each testing provider. Every run or explicitly owned Session closes before the callback returns. Application functions borrow the supplied provider.

`image-input.ts` writes a synthetic red PNG into a temporary directory, reads its bytes into an inline image data URL alongside text, and consumes the validated final answer. Paths, remote URLs, file IDs and PDFs are not image inputs. Scripted answers demonstrate request transport and final validation. They do not demonstrate image understanding.

`retrieval.ts` searches a small application-supplied decoded-text corpus. The application selects the tenant through typed context; the model supplies only a query. Each search returns at most two passages, each capped at 240 JavaScript string code units. The map accumulates returned sources across searches in the same run. Each call records its actual returned IDs and rejects final citations outside that set, including foreign tenant IDs. The `found` flag must agree with whether citations exist.

Source membership does not prove that a passage supports the answer. This recipe assumes that application-assigned source IDs identify passages within a tenant. It does not parse files or provide a vector database.

`specialist-tool.ts` calls a separately configured Agent from an ordinary `consult` tool. The specialist receives its own explicit catalog context, tool list, output schema and provider. Its summary title is bounded to 240 JavaScript string code units. The tool owns a nested Session and disposes it on success, failure or parent cancellation, joining cleanup before returning. It borrows the specialist provider and leaves other callers' Sessions open.

This composition does not provide native child tracking, handoff or nested checkpoint parity. TypeScript readonly fields and separate tool lists do not isolate the authority of application closures.
