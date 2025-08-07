---
'@openai/agents-core': patch
---

fix: prevent crash when importing in cloudflare workers

An export was missed in https://github.com/openai/openai-agents-js/pull/290 for the workerd shim, this prevents the crash when importing there. Long term we should just add an implementation for cloudflare workers (and I suspect the node implementation might just work)
