---
'@openai/agents-codex': patch
---

Preserve the one-shot WebSocket retry guard after connecting. An ambiguous disconnect after sending a request returns an error without replaying that request.
