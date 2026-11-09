---
'@openai/agents-codex': patch
---

fix: Prevent native Worker shutdown from aborting the host process while an asynchronous SDK operation is pending.
