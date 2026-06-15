---
'@openai/agents-realtime': patch
---

fix: capture realtime user transcript when a message triggers a tool call (#141)

When a user's spoken message triggered a tool call, the `conversation.item.added`/`.retrieved` seeding event that normally creates the user message item did not arrive, so `updateRealtimeHistory`'s `input_audio_transcription.completed` branch no-op'd and the user's transcribed message was silently dropped from `session.history()`.

`updateRealtimeHistory` is now self-sufficient: if no item with the transcript's `item_id` exists it creates the user message (keyed on id-presence so no duplicate is appended), and if a matching user item has no `input_audio` entry it adds one. The session transcript handler now emits `history_added` (before `history_updated`) for items it creates, mirroring the `item_update` handler. A user-side analog of `preserveAssistantAudioTranscripts` keeps a captured transcript from being clobbered by a later `item_update` carrying a null transcript. The assistant audio-transcript path is unchanged.

Note: positional ordering of a created item relative to the triggering tool call is best-effort (the transcription event carries no `previous_item_id`); the fix guarantees the message is present, not its exact position.
