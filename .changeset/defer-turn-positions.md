---
'@openai/agents-core': patch
---

Reduce allocations when preparing long, ordered text histories by building the saved messages and their owner records on demand.
