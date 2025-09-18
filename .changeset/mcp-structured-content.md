---
'@openai/agents-core': minor
---

feat(mcp): add structuredContent support behind `useStructuredContent`; return full CallToolResult from `callTool`

- `MCPServer#callTool` now returns the full `CallToolResult` (was `content[]`), exposing optional `structuredContent`.
- Add `useStructuredContent` option to MCP servers (stdio/streamable-http/SSE), default `false` to avoid duplicate data by default.
- When enabled, function tool outputs include `structuredContent` (or return it alone when no `content`).

Notes

- Type-only breaking change for direct `callTool` consumers: use `result.content` where arrays were expected.
- Behavior matches Python SDK feature (openai-agents-python#1150) while keeping JS outputs ergonomic (objects/arrays, no JSON stringify/parse overhead).
