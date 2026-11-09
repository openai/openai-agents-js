---
'@openai/agents-core': patch
'@openai/agents-openai': patch
---

feat(tracing): Expose offered Chat Completions tool definitions on generation spans when sensitive data capture is enabled. Custom processors and custom export destinations can inspect the definitions. Hosted OpenAI trace exports omit them.
