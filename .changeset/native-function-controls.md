---
'@openai/agents-codex': minor
---

feat: add native function namespaces and per-turn admission limits; admit automatic calls independently by default and use maxFunctionConcurrency: 1 for explicit serialization.

fix: prevent native HTTP MCP initialization from stalling while waiting for request readiness.
