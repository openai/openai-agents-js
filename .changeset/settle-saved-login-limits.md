---
'@openai/agents-codex': patch
---

fix: Settle saved Codex login turns after quota and rate limits without automatic retries. Preserve provider retry timing so callers can choose when to submit a new turn.
