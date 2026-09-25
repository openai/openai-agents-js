---
'@openai/agents-core': patch
---

fix: snapshot configured tool candidates during asynchronous enablement so in-place array changes do not duplicate or skip tools.
