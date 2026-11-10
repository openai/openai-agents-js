---
'@openai/agents-codex': patch
---

Eligible native `Agent.run()` calls have been avoiding conversational Session setup while preserving their public results, observations and owned cleanup.
