---
'@openai/agents-codex': minor
'@openai/agents': minor
'@openai/agents-core': minor
---

feat: Generate sandbox memory explicitly with native Agents.

Resource-backed native Sessions have been using opted-in phase Agents and shared memory storage through `flushMemory()`. Native generation has been filtering source instructions and reasoning, retaining the acquired resource owner, and cancelling active phases when the Session closes. Settled managed-workspace capture has been preparing memory before retirement and preserving retry after a failed phase. Ordinary end-of-turn generation and restored native Sessions have been remaining unsupported.
