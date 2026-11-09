---
'@openai/agents': patch
'@openai/agents-codex': patch
---

feat: add optional native tool completion, image/file input and output, settled initial history, model request controls and invocation deadlines, typed response facts, bounded buffered Responses support, and per-call MCP request metadata. Terminal results use the captured output contract and publish after durable native settlement. Host MCP startup also works with a selected remote executor. Existing defaults and Classic entrypoints stay unchanged.
