---
'@openai/agents-core': patch
---

Replay managed tool outputs that completed before an abort, so aborted runs don't lose already-finished tool results on the next turn.
