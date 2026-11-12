---
'@openai/agents-codex': patch
---

Native Handoff declarations have been accepting typed function callbacks for custom presentation and acknowledgements. The native tool owner has been awaiting callback cleanup and publishing only accepted targets. Captured callback identity has been surviving reordered tool bindings while same-key replacements have been failing before callback effects.
