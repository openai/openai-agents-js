---
'@openai/agents-extensions': patch
---

Fix : correctly extract token counts when AI SDK providers return them as objects instead of numbers (e.g. @ai-sdk/google)
