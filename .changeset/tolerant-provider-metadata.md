---
'@openai/agents-core': minor
'@openai/agents-openai': patch
'@openai/agents-realtime': minor
---

fix: Preserve bounded JSON usage metadata and reuse OpenAI wire types; breaking types require narrowing usage details, Realtime image content, nullable MCP descriptions, unknown schemas/tracing metadata, and optional transcription breakdowns; saved states retain schema 1.23 when compatible and use 1.24 for richer metadata or newer nested runs.
