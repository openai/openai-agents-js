---
'@openai/agents-core': patch
---

Fixes a bug where `onTraceEnd` was called immediately after `onTraceStart` when streaming is enabled
