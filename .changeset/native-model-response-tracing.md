---
'@openai/agents-codex': patch
---

fix: Native model tracing has been preserving span ownership and releasing child callback storage, while Windows native producers have been building the addon and helpers concurrently.
