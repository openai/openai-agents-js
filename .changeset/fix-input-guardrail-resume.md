---
'@openai/agents-core': minor
---

fix: reject started checkpoints without completed initial input validation, including older snapshots without completion evidence; restart with the original input and context.
