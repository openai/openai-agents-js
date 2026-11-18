---
'@openai/agents-core': patch
'@openai/agents-extensions': patch
'@openai/agents-openai': patch
---

feat: add an experimental stock Codex provider with streaming, structured output, local images, SDK tools, handoffs, deferred tool discovery, local executors, compaction and reasoning replay, and SDK-managed sandbox tools and memory while preserving codexTool support for @openai/codex-sdk >=0.86.0.

Applications have been able to supply their own OpenAI 7.2 or later client even when the Agents SDK has been installing a different 7.x version. Codex has also been supporting `toolChoice: 'required'` for SDK tools and handoffs, throwing a `UserError` if Codex finishes without requesting one.

fix: preserve the full exported OpenAIClient type and the client resources exposed by default provider and session options while accepting compatible application-owned clients at injection boundaries.
