---
'@openai/agents-core': minor
---

feat: run output guardrails during streaming via `streamingOutputGuardrailCheckpoint`

Adds a runner option that decides, per streamed delta, when output guardrails run against the accumulated partial output. Streamed output is held back until a checkpoint passes, so unsafe content never reaches the consumer; if a guardrail trips, streaming stops and `OutputGuardrailTripwireTriggered` is thrown. The existing behavior is unchanged when the option is not set.
