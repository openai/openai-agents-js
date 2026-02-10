---
'@openai/agents-realtime': patch
---

fix(agents-realtime): wait for session.updated ack before resolving connect()

WebRTC `connect()` previously resolved immediately after sending session config,
before the server acknowledged it. This caused a race where audio could flow to
the server before instructions, tools, and modalities were applied — the server
would silently use defaults instead.

`connect()` now waits for the `session.updated` event from the server before
resolving, with a 5-second hard timeout as a safety net. No consumer code changes
required.
