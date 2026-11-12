---
'@openai/agents-codex': patch
---

feat: configured Agent tools have been retaining child approvals, providers and guard ownership through the parent interaction API. Parent cancellation and close have been joining child cleanup. Active configured children have been continuing to require live replies.
