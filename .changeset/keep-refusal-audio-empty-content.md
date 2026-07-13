---
'@openai/agents-openai': patch
---

Keep refusal and audio outputs when a Chat Completions message has an empty-string content, matching the streaming converter instead of emitting an empty text item.
