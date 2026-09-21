---
'@openai/agents-core': minor
---

fix: bound agent tool streaming callbacks to 1024 pending events by default, with onStreamMaxPendingEvents to adjust the limit or restore unlimited buffering with null.
