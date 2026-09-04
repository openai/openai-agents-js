---
'@openai/agents-core': patch
'@openai/agents-realtime': patch
---

fix: reject non-boolean local tool approval callback results instead of treating them as approval. (#1803)
