---
'@openai/agents-core': minor
---

fix: prevent replacement-symlink races in UnixLocal file/editor operations and Docker's inherited Unix host operations using descriptor-relative workers; these operations on Unix hosts now require a trusted Python 3 installation.
