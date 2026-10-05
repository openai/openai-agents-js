---
'@openai/agents-extensions': minor
---

fix: Use current Vercel authentication configuration for restored sessions and disable legacy authentication fallback when current authentication is configured; retain per-create authentication choices for live sessions. Keep restoration credentials runtime-only and honor per-run resume overrides.
