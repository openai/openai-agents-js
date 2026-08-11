---
"@openai/agents-realtime": patch
---

Seed the user audio transcript into realtime history when a tool call pre-empts item seeding, so `conversation.item.input_audio_transcription.completed` transcripts are retained and surfaced via `history_updated`.