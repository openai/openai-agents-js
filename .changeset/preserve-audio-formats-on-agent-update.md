---
'@openai/agents-realtime': patch
---

fix(realtime-session): preserve audio format & other session config fields on agent update

Previously, calling `updateAgent()` rebuilt the session config from a minimal subset of fields and
omitted properties like `inputAudioFormat` / `outputAudioFormat`, `modalities`, `speed`, etc. This
caused the server to fall back to defaults (e.g. `pcm16`), producing loud static in Twilio calls
when a custom format (e.g. `g711_ulaw`) was required.

This change caches the last full session config and merges it when generating a new config so
updates only override dynamic fields (instructions, voice, tools, tracing) while preserving the
rest. A regression test was added to ensure audio formats persist across `updateAgent` calls.
