---
'@openai/agents-core': patch
'@openai/agents-extensions': patch
'@openai/agents-openai': patch
---

Add an experimental `CodexProvider` to run an agent through the stock Codex CLI with SDK tools, handoffs, streaming, and structured output. Existing `codexTool()` users can stay on `@openai/codex-sdk` 0.86.0, and applications can keep their own compatible OpenAI 7.x client.
