---
'@openai/agents-codex': patch
---

refactor: Check prior hosted program results without keeping a second copy of their IDs. Sessions that read many old results at once may take longer.
