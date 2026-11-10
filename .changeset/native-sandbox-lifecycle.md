---
'@openai/agents-codex': patch
'@openai/agents-core': patch
'@openai/agents-extensions': patch
---

feat: support native sandbox lifecycle, snapshots and budgets, expose pure diff application, and add external Codex CLI delegation with Session-scoped thread reuse and cancellation.

Borrowed native sandboxes validate provider-owned environment defaults, and authorized resume preserves unusable-state checks on the original state identity.

Borrowed Docker resources validate their actual host bind authority and explicit no-network policy against current trusted configuration before opening a native gateway.

E2B and Vercel reuse also rejects current network-policy and port-exposure mismatches before provider or gateway effects.

Daytona and Modal reuse checks explicit port exposure against current provider configuration. Native UnixLocal resume retains existing SDK runtime authority through state capture; copied public fields do not authorize host paths.
