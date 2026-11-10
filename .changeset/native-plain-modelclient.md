---
'@openai/agents-codex': patch
---

Eligible native `Agent.run()` calls have been avoiding conversational Session setup while preserving their public results, observations and owned cleanup.

The existing buffered response preference has been using the same direct path, while default streaming and explicit Sessions have been retaining their existing routes.
