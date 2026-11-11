---
'@openai/agents-codex': patch
---

fix: Native history restoration has been preserving typed Responses item references, including repeated provider pointers and their order in outbound requests.
