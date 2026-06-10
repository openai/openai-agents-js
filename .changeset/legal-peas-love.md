---
'@openai/agents-realtime': patch
---

fix(agents-realtime): accept `{ type: "duration", seconds }` usage on `conversation.item.input_audio_transcription.completed` so `whisper-1` (duration-billed) transcripts no longer fall through to the generic-event path and skip the typed emit and retrieve fallback
