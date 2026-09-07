---
'@openai/agents-core': patch
'@openai/agents-openai': patch
---

fix: Preserve tool-search Agent attribution across handoffs and history replay; persisted discovery requires a unique logical Agent name, and unattributed or ambiguous history requires a new search.
