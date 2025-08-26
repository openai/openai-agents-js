---
'@openai/agents-core': patch
---

Fix streaming agents not calling agent_end lifecycle hook

Streaming agents were not emitting the `agent_end` lifecycle event when completing execution, while non-streaming agents were correctly emitting this event. This fix ensures that both the agent instance and the runner emit the `agent_end` event for streaming agents when they produce a final output, maintaining consistency with the non-streaming behavior.

This resolves the issue where users could not collect usage information or perform cleanup tasks at the end of streaming agent runs using the `agent_end` event handler.