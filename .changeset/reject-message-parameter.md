---
'@openai/agents-core': minor
'@openai/agents-realtime': minor
---

Add `message` parameter to `reject()` on `RunState`

- Add optional `message` parameter to `RunState.reject()` that replaces the default rejection text sent to the model
- Per-call `message` takes precedence over the global `toolErrorFormatter` callback when both are provided
