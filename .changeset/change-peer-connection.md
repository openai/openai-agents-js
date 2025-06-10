---
'@openai/agents-realtime': patch
---

Add `changePeerConnection` option to `OpenAIRealtimeWebRTC` allowing interception
and replacement of the created `RTCPeerConnection` before the offer is made.
