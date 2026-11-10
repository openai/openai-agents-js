---
'@openai/agents-extensions': patch
---

Native Codex CLI tools have been restricting model-selected thread IDs to successful calls in the invoking Session or an application-configured initial thread. The `threadId` option has been supporting trusted initial resume while preserving Session-local persistence.
