---
'@openai/agents-core': patch
---

fix: Bound streamable HTTP session termination by the client session timeout and cancel stalled cleanup requests.
