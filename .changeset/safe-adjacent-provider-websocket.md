---
'@openai/agents-codex': patch
---

perf: reuse Engines across adjacent one-shot WebSocket `Agent.run` calls with fresh TLS trust when no `NativeRuntime` is supplied.
