---
'@openai/agents-codex': patch
---

fix: preserve embedded NUL characters when reading SQLite memory on Node 22, including existing UTF-16 databases.
