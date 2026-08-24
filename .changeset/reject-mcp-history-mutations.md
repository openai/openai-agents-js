---
'@openai/agents-realtime': patch
---

fix: reject mcp_call, mcp_tool_call, and mcp_approval_request additions/updates in resetHistory with a UserError instead of sending conversation.item.delete and warning afterwards
