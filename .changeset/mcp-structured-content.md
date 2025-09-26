---
'@openai/agents-core': patch
---

feat(mcp): add structuredContent support behind `useStructuredContent`; return full CallToolResult from `callTool`

- `MCPServer#callTool` now returns the full `CallToolResult` (was `content[]`), exposing optional `structuredContent`.
- Add `useStructuredContent` option to MCP servers (stdio/streamable-http/SSE), default `false` to avoid duplicate data by default.
- When enabled, function tool outputs return JSON strings for consistency with Python SDK implementation.
