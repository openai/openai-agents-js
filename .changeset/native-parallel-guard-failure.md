---
'@openai/agents-codex': patch
---

Native parallel input guard exceptions have been cancelling model work before peer cleanup, while preserving physical joins and the first exception.
