---
'@openai/agents-codex': patch
---

Native function and MCP results have been retaining application-only JSON data in detached result views and SDK checkpoints, while provider requests, native history and trace export have been keeping their existing public output shape.
