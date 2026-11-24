---
'@openai/agents-core': patch
---

perf(agents-core): defer copying plain input messages until a reader needs a mutable snapshot.
