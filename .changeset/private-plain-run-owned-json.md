---
'@openai/agents-codex': patch
---

perf(codex): private plain-run decoding has been preserving eager validation while avoiding redundant JSON cloning.
