---
'@openai/agents-realtime': patch
---

fix: reject mcp_call, mcp_tool_call, and mcp_approval_request additions/updates in resetHistory with a UserError

Previously, adding a new MCP item in `resetHistory()` was silently ignored, while updating an existing MCP item sent `conversation.item.delete` without ever recreating it, permanently dropping the item from the live conversation and, after the server ack, from local history too. Neither case produced a warning. `resetHistory()` now throws before sending any client event when an MCP item would be added or updated; unchanged MCP items still no-op and explicit removals still send their delete as before.
