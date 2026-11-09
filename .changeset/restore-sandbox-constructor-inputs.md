---
'@openai/agents-extensions': patch
---

Restore the existing injected E2B and Vercel session constructor inputs and ordinary reads. Capped reads (`maxBytes`), including remote image reads, require a session created by `E2BSandboxClient` or `VercelSandboxClient`. Injected adapters without captured bounded-read capabilities reject these operations before reading file data.
