---
'@openai/agents': patch
'@openai/agents-codex': patch
---

fix: stop sampling after final HTTP 401 or 403 responses and share bounded credential recovery across WebSocket-to-HTTP fallback while preserving final provider metadata.
