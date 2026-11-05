---
'@openai/agents': minor
'@openai/agents-codex': patch
'@openai/agents-core': patch
'@openai/agents-extensions': patch
'@openai/agents-openai': patch
'@openai/agents-realtime': patch
---

feat: Ship the embedded runtime in `@openai/agents-codex`, forward the Codex API from `@openai/agents` and expose the classic Agent and Runner APIs at `@openai/agents/classic`. Native workers gain exact steering, attention and rate-limit signals, execution and instruction receipts, local execution with per-turn writable roots on Linux and macOS, remote macOS execution with writable roots granted when opening the session, and verified recovery for uncertain tool results. Keep the native runtime home and any local session storage outside local executor write roots.
