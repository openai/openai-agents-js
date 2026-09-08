---
'@openai/agents-core': patch
'@openai/agents-openai': patch
---

fix: preserve explicit settings for GPT-5-and-newer models and concrete model instances, default gpt-6-astra reasoning to low, and use adapter-declared prompt model selection when applying implicit defaults (#1849).
