---
'@openai/agents-core': minor
'@openai/agents-realtime': minor
---

Replace `toolErrorFormatter` with `message` parameter on `reject()`

- Add optional `message` parameter to `RunState.reject()` that replaces the default rejection text sent to the model
- Remove `toolErrorFormatter` callback, `ToolErrorFormatter` type, and `ToolErrorFormatterArgs` type
- Rejection messages are now set per-call at the `reject()` call site instead of via a global callback on `RunConfig`
