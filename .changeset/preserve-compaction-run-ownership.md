---
'@openai/agents-core': patch
'@openai/agents-openai': patch
---

fix: preserve concurrent wrapper writes by skipping automatic session compaction when the run no longer owns its history snapshot.
