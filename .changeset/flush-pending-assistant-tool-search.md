---
'@openai/agents-extensions': patch
---

fix(ai-sdk): flush the pending assistant message before user and system turns

Provider-executed tool search folds its result into the in-progress assistant message and leaves it pending (no flush). The `user` and `system` message branches in `itemsToLanguageV2Messages` did not flush that pending assistant message before pushing their own, so a server tool-search turn followed by a new user turn emitted the assistant message last — the request ended on an assistant message and Anthropic rejected it as an unintended prefill. Route all turn-boundary branches through a shared `flushCurrentAssistantMessage()` helper so the pending assistant is always flushed first.
