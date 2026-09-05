---
'@openai/agents-extensions': patch
---

Decode sandbox PTY output with a streaming decoder so multi-byte UTF-8 characters split across WebSocket frames are no longer corrupted
