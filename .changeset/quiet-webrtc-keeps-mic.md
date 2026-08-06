---
'@openai/agents-realtime': patch
---

fix(realtime): keep a caller-supplied WebRTC media stream alive on close

`OpenAIRealtimeWebRTC.close()` no longer stops the tracks of a `mediaStream` passed in through the transport options. That stream now stays owned by the application, so it remains usable for a level meter, a recorder, or a later reconnect, and the application is responsible for calling `stop()` on its tracks when it is done with it. A microphone the transport opens itself, when `mediaStream` is omitted, is still stopped by `close()` as before.

`close()` leaves the mute state alone. A caller-supplied track keeps whatever `enabled` value it had, and `muted` keeps reporting what it reported before the close, matching the default microphone path.
