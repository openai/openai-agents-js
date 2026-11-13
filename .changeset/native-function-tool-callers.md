---
'@openai/agents-codex': minor
---

feat: Enforce native function-tool caller restrictions across direct calls, Code Mode, forks, and restores. Keep public MCP tool aliases stable while dispatching the original server and tool. After direct function outcomes settle in model order, `Agent.toolBatchCompletion` can continue, add feedback, stop, or return validated final output.
