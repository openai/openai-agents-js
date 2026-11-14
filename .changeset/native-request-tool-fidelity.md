---
'@openai/agents-codex': patch
---

Native model backends, Responses and AI SDK adapters have been retaining caller cache keys, request and retry controls, and hosted tools while borrowed Chat models have been accepting the native reasoning context default and rejecting explicit unsupported reasoning options.
