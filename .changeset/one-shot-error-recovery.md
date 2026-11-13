---
'@openai/agents-codex': minor
---

Add an opt-in one-shot errorHandler that supplies schema-validated fallback output after settled output validation, provider refusal, or request-budget failure. Recovery preserves the original native outcome and usage, and can append the fallback through canonical history without retrying the request.
