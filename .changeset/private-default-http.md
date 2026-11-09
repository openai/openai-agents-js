---
'@openai/agents-codex': patch
---

Use streaming HTTP for eligible stateless, tool-free Agent.run calls when transport is unspecified, allowing existing private Engine reuse. Explicit supportsWebsockets:true, explicit Sessions and other ineligible calls keep their existing transport selection.
