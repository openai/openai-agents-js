# Keep large MCP reports outside model context

[mcp-reports.ts](mcp-reports.ts) discovers a selected `report` tool through the classic SDK's `MCPServerStreamableHttp` client, then uses it in a native Session through `selectMcpTools`. The application owns the connection, report resolver, stored results and reader identity. This recipe adds no SDK storage service.

Use Node.js 24 and complete the [native source setup](guides/building.md), including built workspace packages. Run from the repository root:

```sh
MCP_URL=http://localhost:8000/mcp pnpm exec tsx packages/agents/examples/mcp-reports.ts
```

This command makes live model calls. Set `OPENAI_API_KEY` in the server environment. The example uses `NativeProvider` and `gpt-5.5`; `OPENAI_BASE_URL` can select a compatible Responses endpoint. The MCP endpoint must advertise a tool named `report` that accepts an empty object and returns a text block plus `structuredContent: { "reportId": "example" }`. The demo's application map resolves that ID to a report. Replace the map lookup with an awaited call to your application's report service. Do not interpret peer results as arbitrary URLs or filesystem paths.

The example follows these steps:

1. Connect the application-owned MCP client, discover its declarations, and select only `report` for the native Session.
2. Await the selected MCP call, then await the application's resolver. A peer error bypasses the resolver and creates no stored reference.
3. Keep a small successful result inline. For an oversized result, retain the original JSON in application memory and replace text and structured fields with short excerpts, the original byte count and an opaque UUID reference.
4. Let the model continue with the replacement. The application can read a copy of the original through `server.read(owner, reference)` after the turn ends.
5. Close the Session, provider and server. Server close expires every reference.

The example prints the final answer and the number of bytes retrieved from each stored report. It does not print full reports. Importing the module does not run the command. `openReportSession(server, provider)` is the same entry point used by the command and its native acceptance tests.

## Bounds and ownership

For successful results, the example limits the JSON representation of text blocks plus `structuredContent` to 4096 UTF-8 bytes. Excerpts contain at most 32 Unicode code points each. They are not generated summaries. Existing text slots keep their order and type. Text replacements also include the structured excerpt, since the selected content route consumes those text slots. A structured result without a text slot gets a text fallback.

The example accepts up to eight original content blocks. It stores at most four reports, 64 KiB per report and 128 KiB in total, measured as serialized JSON. When storage is full, the example rejects the new result. It does not evict a reference that the model or application may still hold. These are per-connection bounds, not a network response limit or a session-wide token budget.

An application-created symbol represents the authenticated reader. Keep it outside model arguments. Both enumeration and retrieval require that same identity. UUIDs alone do not grant access. References are process-local and expire when this server instance closes. They cannot be restored from saved conversation state. Use one instance per Session.

Non-text blocks pass through unchanged. The selected SDK route keeps its existing handling. Images become image input, and other blocks become JSON. This recipe does not fetch resource URLs, decode media or qualify audio and video processing. Non-text blocks are outside that 4096-byte bound, including audio or resource blocks represented as text by the selected SDK route. The serialized blocks count toward the storage limit when the example stores an entire report. A large media-only result can pass through without being stored. Use a separate media policy when adapting this example to untrusted or large media results.

## Failure and cancellation

The resolver receives the invocation's `AbortSignal`. Pass it to cancellable application I/O. The example checks cancellation and server lifetime after the resolver settles and before storing a result. A resolver that ignores the signal must still settle before its work can be joined. Cancellation does not prove that the remote service stopped an operation.

Failed resolution and cancellation during pending work publish no successful replacement. Closing the server also prevents a pending resolver from storing a late result. A fully resolved result already accepted by the application remains valid until close. A later failure or cancellation does not roll back that completed work. Always keep the server's `close()` in `finally`, as the command does.
