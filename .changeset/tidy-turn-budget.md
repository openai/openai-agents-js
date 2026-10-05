---
'@openai/agents-core': minor
---

fix: count model calls after approval resumes toward maxTurns; callers needing a follow-up model response at the limit must increase maxTurns.
