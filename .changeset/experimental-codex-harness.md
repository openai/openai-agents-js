---
'@openai/agents': minor
'@openai/agents-codex': patch
'@openai/agents-core': patch
'@openai/agents-extensions': patch
'@openai/agents-openai': patch
'@openai/agents-realtime': patch
---

feat: Embed the Codex harness in `@openai/agents`. Add explicit turn control, captured model-context, completion, and compaction callbacks, replaceable typed decision providers bound to Agents and callback contexts, strict write defaults, trusted A2A environments, typed interactions, recoverable storage, validated output, checkpoint upgrade checks, and configurable speech workflows with validated native output and bounded private tracing. Retain the classic Agent and Runner APIs at `@openai/agents/classic`, reject mixed runtime declarations before work starts, and finish traces when callbacks fail.
