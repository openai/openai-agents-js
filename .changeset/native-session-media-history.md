---
'@openai/agents': patch
'@openai/agents-codex': patch
---

feat: add optional native tool completion, image/file input and output, settled initial history, model request controls and invocation deadlines, typed response facts, and bounded buffered Responses support. Terminal results use the captured output contract and publish after durable native settlement. Existing defaults and Classic entrypoints stay unchanged.
