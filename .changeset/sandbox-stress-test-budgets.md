---
'@openai/agents-core': patch
'@openai/agents-codex': patch
---

fix: Sandbox stress tests have been receiving longer time budgets, and tool timeout tests have been using controlled completion to avoid timing races.
