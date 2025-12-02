---
"@openai/agents-openai": patch
---

Fix streaming tool call arguments when providers like Bedrock return an initial empty `{}` followed by actual arguments, resulting in malformed `{}{...}` JSON.
