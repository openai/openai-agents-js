---
'@openai/agents-realtime': patch
---

fix(realtime): surface the provider error when the WebRTC `/realtime/calls` request fails

The WebRTC transport now checks `response.ok` before treating the `/realtime/calls` response as an SDP answer. On a non-2xx response it throws an error carrying the provider's message (e.g. `insufficient_quota`, invalid ephemeral key) instead of passing the error body to `setRemoteDescription`, which previously surfaced as an opaque "Failed to parse SessionDescription".
