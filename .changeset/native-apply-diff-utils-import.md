---
'@openai/agents-codex': patch
---

The native SDK has been importing applyDiff through the utilities entry point, avoiding eager classic runtime initialization.
