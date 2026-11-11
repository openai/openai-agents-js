---
'@openai/agents-codex': patch
---

Recheck Realtime tool permissions immediately before invoking function tools, handoffs, and MCP tools, including after asynchronous input hooks and MCP request metadata. A revoked permission prevents the pending call from executing.
