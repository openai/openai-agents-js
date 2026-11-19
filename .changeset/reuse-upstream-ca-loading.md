---
'@openai/agents-codex': patch
---

Use the upstream TLS certificate loader. Building a new HTTP client can take longer with a large custom CA bundle. Reusing an existing connection avoids that cost.
