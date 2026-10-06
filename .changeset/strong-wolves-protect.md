---
'@openai/agents-core': minor
---

fix: Require trusted Python 3 for UnixLocal file operations and reject disabled protection. Honor `runAs` for file tools and replace edited files without modifying other hardlinks. Updates now require writable parent directories and preserve ordinary permissions and ownership.
