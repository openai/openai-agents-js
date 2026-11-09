---
'@openai/agents-core': patch
'@openai/agents-openai': patch
---

fix(openai): Default reasoning effort to `none` for function tools and handoffs on the OpenAI Chat Completions API with `gpt-6-sol` and `gpt-6-luna`, matching openai/openai-agents-python#5420.
