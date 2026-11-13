---
'@openai/agents-codex': patch
---

Native model tracing has been honoring configured span IDs, closing response spans at accepted provider completion, and releasing child callback storage when the native owner retires.
