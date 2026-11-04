---
'@openai/agents': minor
'@openai/agents-core': patch
'@openai/agents-extensions': patch
'@openai/agents-openai': patch
'@openai/agents-realtime': patch
---

feat: Embed the Codex harness in `@openai/agents` and expose the classic Agent and Runner APIs at `@openai/agents/classic`. Native workers gain exact steering, attention and rate-limit signals, execution and instruction receipts, local execution with per-turn writable roots on Linux and fixed writable roots on macOS, and verified recovery for uncertain tool results. Keep the native runtime home and any local session storage outside local executor write roots.

The supervised-worker example preserves attention errors and records failed artifact verification in its recovery journal.
