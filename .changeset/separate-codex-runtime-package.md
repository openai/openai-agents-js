---
'@openai/agents': patch
'@openai/agents-codex': patch
---

Move the embedded Codex runtime and its native helpers into `@openai/agents-codex` while preserving existing `@openai/agents` imports. When installing an alpha bundle manually, include the matching `@openai/agents-codex` tarball alongside the other four SDK packages.
