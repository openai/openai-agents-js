---
'@openai/agents-codex': patch
'@openai/agents-core': patch
'@openai/agents-extensions': patch
---

feat: support native sandbox lifecycle, snapshots and budgets, expose pure diff application, and add external Codex CLI delegation with Session-scoped thread reuse and cancellation.

Borrowed native sandboxes validate provider-owned environment defaults, and authorized resume preserves unusable-state checks on the original state identity.

Borrowed Docker resources validate their actual host bind authority against the current trusted manifest before opening a native gateway.
