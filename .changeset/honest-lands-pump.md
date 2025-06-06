---
'@openai/agents-core': patch
---

fix: Process hangs on SIGINT because `process.exit` is never called
