---
'@openai/agents': patch
'@openai/agents-core': patch
'@openai/agents-extensions': patch
---

fix: resolve ambiguous tool and handoff names consistently with a warning by default and an opt-in error policy, including owner-scoped approvals for nested agents
