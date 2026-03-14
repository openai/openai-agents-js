---
'@openai/agents-extensions': patch
---

Fix tool result image format for AI SDK V3 models. convertStructuredOutputsToAiSdkOutput now uses file-data/file-url content parts for V3 models instead of the V2-only media format, fixing 400 errors with V3 providers like Vercel AI Gateway
