# MCP Transport, Cache, and Shims

Use this reference for local MCP connection ownership, stdio/SSE/streamable HTTP transports, requests, tool cache/filtering, retries, cancellation, timeout, or cleanup.

## Connection and Request Ownership

- Each MCP server owns its client session and transport. Connect before listing/calling tools and close the owning transport once; do not let a cached function-tool wrapper outlive or invoke a prior server instance.
- `MCPServers` coordinates serial or parallel connect/close and tracks failed servers. Strict connect failure must clean up both successfully connected and currently failing servers before returning.
- A timeout or abort is not proof that remote cleanup finished. Reject new manager commands while close remains in flight, observe late failures, and allow a failed close to be retried.
- Preserve runtime-specific transport construction in `shims/mcp-server/`. Node supports local process transports; browser/workerd surfaces must fail clearly or use their supported transport rather than importing Node-only code.

## Cache and Filtering

- Tool-list caching assumes schemas are stable until invalidation. `invalidateToolsCache()` and `invalidateServerToolsCache()` must clear every relevant agent/server key.
- Cache the server tool description, not a wrapper permanently bound to one connection. Rebind executable wrappers to the current server instance after reconnect.
- Static and callable filters run against the current agent/run context. Their output must not leak between agents, and a callable filter or custom cache key can make a globally shared entry invalid.
- Apply strict-schema conversion, error functions, metadata/custom-data resolvers, server-name prefixing, and collision allocation consistently when rebuilding cached tools.

## Calls and Failures

- Preserve the original MCP tool name for `callTool` even when the model-visible wrapper name is overridden or prefixed.
- Keep legacy content output as the default unless structured output/full result is explicitly enabled. Preserve error content and full serializable results according to the selected contract.
- Normalize abort-like failures into the configured tool error only when an error function owns conversion. `errorFunction: null` means rethrow, including abort-like errors.
- Trace list/call operations without requiring an ambient trace and without leaking headers, authorization, or sensitive tool payloads.

## Review Checklist

1. Test connect, partial failure, reconnect failed-only, close timeout, close retry, and abort.
2. Invalidate and reconnect while caching is enabled; prove wrappers use the current server.
3. Test static/callable filters and custom cache keys across multiple agents.
4. Cover Node and non-Node shim conditions and ensure imports remain safe.
5. Verify original tool names, normalized wrapper names, errors, structured content, and full-result serialization.

## Sources

- `packages/agents-core/src/mcp.ts`
- `packages/agents-core/src/mcpServers.ts`
- `packages/agents-core/src/mcpUtil.ts`
- `packages/agents-core/src/shims/mcp-server/`
- `packages/agents-core/test/mcpServers.test.ts`
- `packages/agents-core/test/mcpCache.test.ts`
- `packages/agents-core/test/mcpToolFilter.test.ts`
- `packages/agents-core/test/mcpToFunctionTool.test.ts`
- `packages/agents-core/test/shims/mcp-server/`
- `docs/src/content/docs/guides/mcp.mdx`
