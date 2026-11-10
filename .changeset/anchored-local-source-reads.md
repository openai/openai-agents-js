---
'@openai/agents-core': minor
'@openai/agents-extensions': minor
---

fix: retain directory authority when reading local sources and cloned repository directories. Deno applications copying these sources require local node_modules and --allow-ffi. Linux Node hosts without a compatible native binary, including s390x, require trusted, accessible /proc/self/fd; copying fails closed when neither backend is available. On macOS 11/12, source paths require readable ancestor directories.
