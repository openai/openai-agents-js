# Provider-hosted tools in a native session

Use Node.js 24 and [build the current source checkout and matching native runtime](../guides/building.md) before running this example. These declarations are part of the native API and are not available in the published stable SDK. Use an API key and a Responses model that supports the selected tools. The provider validates model-specific options; Responses Lite does not support these tools.

Set `OPENAI_API_KEY` in the server environment, optionally `OPENAI_MODEL`, and optionally `VECTOR_STORE_ID`. Run from the repository root:

```sh
pnpm exec tsx examples/codex/hosted-tools/run.ts
```

The default model is `gpt-5.2`. The example requests Code Interpreter and image generation. When you provide a vector store ID, it also enables file search with raw retrieval results. Upload files, complete indexing, and create the vector store before running it.

The provider executes these tools. No application callback, workspace executor, or custom model loop runs them. Code Interpreter requires an explicit container: pass an existing container ID, or `{ type: 'auto' }` to request provider creation. The provider owns container reuse and expiry. Your application manages uploaded files, downloads artifacts before they expire, stores durable copies, and performs any explicit resource cleanup. Closing a session does not delete provider resources.

The example prints hosted items from canonical history. Each item keeps provider field names, IDs, status, and complete `provider_data`, including code outputs, file references, image metadata, and image bytes. Do not log real retrieval content, code outputs, or images in a production application. File-search citations live in assistant text annotations; raw results require `includeSearchResults: true`.

For editing, use `imageGeneration({ action: 'edit' })` and supply an image through the native user-message input. An `input_image` accepts exactly one `image_url` (an HTTP(S) URL or inline base64 image data URL) or provider `file_id`. Optional `inputImageMask` uses the provider mask shape.

The SDK also accepts provider-owned file descriptors through `input_file`; see [input, tools, and output](../guides/tools.md#input-tools-and-output). The SDK does not fetch URLs, upload files, or open host paths when it captures these inputs. Image quality, format, size, transparency, masks, and animation controls depend on the selected model.

A session captures hosted declarations when it opens. Tool updates must retain those declarations. Restoring a conversation requires current declarations; saved history does not grant tools or restore credentials. Full idle history restore remains available. Hosted tools do not support a checkpoint taken while awaiting a manual tool result.

`session.events()` and `turn.events()` provide passive, bounded observations for hosted progress and completed items. By default, completed items contain only their type, IDs, and status, and progress contains only the provider event type and SDK identities. For a trusted consumer, pass `{ includeExecutionDetails: true }` to expose full hosted results and the original progress event, including code, search results, and image bytes. Keep these payloads private.

The buffer keeps at most 256 events and 65,536 metadata characters. Recognized partial-image base64 has a separate limit of 16 MiB per event and 32 MiB across retained events. These are observation retention limits, not provider output promises. A slow observer or an oversize payload can cause a gap; the SDK never truncates an image. Read complete final results through `session.items()`; do not treat a progress event as completion of the entire turn.

The source-build [hosted-tool fixtures](../../../packages/agents-codex/test/native/hosted-tools-native.test.ts) have been comparing streaming HTTP, buffered HTTP, and WebSocket requests against scripted peers. Responses Lite has been rejecting hosted declarations before the first provider request. Live model and account eligibility has been depending on the configured provider and tool options.

The file-search projection fixture has been retaining the full accepted result in canonical history. Before a later request, `transformContext` has been replacing that history item with a bounded summary containing exact IDs, the total, and an application reference. The first provider round has already been executing its hosted tool by that point.
