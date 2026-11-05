---
'@openai/agents': patch
---

feat: expose retained native response observations in recorded turn history. Preserve received terminal status, stable origin identities, and optional exact usage counters independently of turn totals. Mark legacy accounting counters as native normalized, and retain response details through saved state and repair receipts. This preview surface requires a reader that supports the new history records.
