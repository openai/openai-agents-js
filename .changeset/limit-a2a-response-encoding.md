---
'@openai/agents': patch
'@openai/agents-codex': patch
---

Reject compressed A2A discovery and RPC responses before reading their bodies, and request identity encoding so the adapter's response-byte bound does not depend on automatic decompression.
