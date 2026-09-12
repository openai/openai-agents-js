---
'@openai/agents-openai': patch
---

fix: treat a blank OPENAI_WEBSOCKET_BASE_URL as unconfigured so the client base URL can be used
