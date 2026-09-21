---
'@openai/agents-core': patch
'@openai/agents-openai': patch
---

fix: Reject selected handoff input filters with server-managed conversationId or previousResponseId before handoff side effects; use client-managed history or a Session without continuation options instead.
