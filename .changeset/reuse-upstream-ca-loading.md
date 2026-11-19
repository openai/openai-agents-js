---
'@openai/agents-codex': patch
---

fix: Use the upstream custom CA loader, share the executor tool check, and build MCP tool discovery with Rust's default recursion limit. Each new HTTP client parses the configured CA bundle and may repeat notices about ignored revocation lists.
