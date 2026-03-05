---
'@openai/agents-core': patch
'@openai/agents-realtime': patch
---

Add `message` parameter to `reject()` on `RunState`

- Add optional `message` parameter to `RunState.reject()` that replaces the default rejection text sent to the model
- Per-call `message` takes precedence over the global `toolErrorFormatter` callback when both are provided
