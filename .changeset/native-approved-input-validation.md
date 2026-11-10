---
'@openai/agents-codex': patch
'@openai/agents': patch
---

fix: approved native tools have been reusing captured input validation while retaining the execution-time input policy.
