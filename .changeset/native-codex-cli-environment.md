---
'@openai/agents-extensions': patch
---

Native Codex tools have been limiting default subprocess environment inheritance to platform, Codex authentication and transport settings. Explicit environment mappings and supplied Codex clients have been retaining their configured behavior.
