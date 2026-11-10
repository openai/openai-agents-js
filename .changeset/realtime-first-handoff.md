---
'@openai/agents-codex': patch
---

fix: Client Realtime sessions have been running only the first requested handoff per response. Native Agent handoffs have been using the direct model tool path that applies the destination profile.
