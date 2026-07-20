---
'@openai/agents-core': patch
---

fix: clear the local tool cache on MCPServerStdio/MCPServerSSE connect(), close(), and invalidateToolsCache()

The public `MCPServerStdio` and `MCPServerSSE` wrappers keep their own `_cachedTools` (separate from the underlying shim's cache). Previously only `MCPServerStreamableHttp` cleared that wrapper cache, so the Stdio/SSE wrappers served stale tools indefinitely after `invalidateToolsCache()`, `close()`, or a reconnect via `connect()`. This mirrors the existing `clearLocalToolsCache()` behavior from `MCPServerStreamableHttp`.
