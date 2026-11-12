---
'@openai/agents-codex': patch
---

fix: Release the native trace flush worker before reporting completion so the next flush can start immediately.
