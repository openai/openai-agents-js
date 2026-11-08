---
'@openai/agents-codex': minor
---

fix(codex): preserve synchronous tool results and expose named executor and item types

Require an output schema for non-text agents and JSON-compatible parsed manual-tool arguments. Preserve callback context, native execution history, pending manual replies during graceful stop, and safe storage cleanup. Capture A2A callback values before awaiting transport work, reject unsupported tool replacements and overflowing timers, and clarify storage and lifecycle guides.
