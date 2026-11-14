---
'@openai/agents': patch
'@openai/agents-codex': patch
---

fix: preserve native provider usage and package the worker control for portable runtimes.

Use `HostedResponsesWebSocketModel.fromOpenAI(client)` when the SDK should own the socket and retry an opening failure before dispatch.
