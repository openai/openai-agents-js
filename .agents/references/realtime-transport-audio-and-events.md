# Realtime Transport, Audio, and Events

Use this reference for WebRTC, WebSocket, SIP, Twilio, Cloudflare, connection states, audio formats, transcripts, or Realtime event payloads.

## Transport Boundary

- `RealtimeTransportLayer` is the session/transport contract. WebRTC, WebSocket, SIP, Twilio, and Cloudflare implementations must normalize connection, audio, transcript, tool-call, response, and error events without erasing transport-specific data needed by consumers.
- Use WebRTC for browser/client media and WebSocket-style transports for server media pipelines according to the supported runtime. SIP attaches to an existing call and has different connection inputs from a fresh client session.
- Keep transport state machines explicit. Distinguish connecting, connected, transient disconnect, terminal disconnect, closing, and closed; a brief WebRTC peer state change is not always proof the session should close.
- A failed connection attempt must reset state and media resources so retry does not reuse a rejected promise, stale peer connection, data channel, socket, or microphone track.

## Audio and Transcript State

- Preserve negotiated input/output audio formats across session updates and handoffs. Twilio commonly uses telephony formats that must not revert to default PCM.
- Treat base64, `ArrayBuffer`, and typed-array conversion as binary operations. Encode large buffers without argument-spread limits and preserve exact bytes and channel/sample metadata.
- Audio delta, transcript delta/completion, and output-item completion are separate signals. Merge transcript updates into the correct item and use terminal item events as a fallback when a provider omits status.
- Store local audio bytes only when requested. Cleanup must stop owned microphone tracks and detach handlers without closing caller-owned media or peer connections unexpectedly.

## Events and Compatibility

- Validate known Realtime server events while preserving unknown/generic event payloads for forward compatibility. Do not drop provider fields merely because the SDK has no typed interpretation yet.
- Preserve call IDs, item IDs, event IDs, and provider error details. Round numeric timing fields only where the API requires integer values.
- Cloudflare/workerd and browser event APIs differ from Node event emitters. Use the runtime shim contract and test listener removal, fetch-based WebSocket upgrade, and unavailable WebRTC behavior in their target environments.

## Review Checklist

1. Test the relevant WebRTC, WebSocket, SIP, Twilio, or Cloudflare state machine through connect, transient failure, terminal failure, retry, and close.
2. Verify audio bytes and formats across handoff and session update.
3. Reconcile transcript, audio, item, and response events with missing or reordered terminal signals.
4. Confirm owned media/listeners are cleaned up without closing caller-owned resources.
5. Preserve unknown events and stable IDs across runtime-specific shims.

## Sources

- `packages/agents-realtime/src/transportLayer.ts`
- `packages/agents-realtime/src/transportLayerEvents.ts`
- `packages/agents-realtime/src/openaiRealtimeBase.ts`
- `packages/agents-realtime/src/openaiRealtimeWebRtc.ts`
- `packages/agents-realtime/src/openaiRealtimeWebsocket.ts`
- `packages/agents-realtime/src/openaiRealtimeSip.ts`
- `packages/agents-extensions/src/CloudflareRealtimeTransport.ts`
- `packages/agents-extensions/src/TwilioRealtimeTransport.ts`
- `packages/agents-realtime/test/openaiRealtimeWebRtc.test.ts`
- `packages/agents-realtime/test/openaiRealtimeWebsocket.test.ts`
- `packages/agents-extensions/test/CloudflareRealtimeTransport.test.ts`
- `packages/agents-extensions/test/TwilioRealtimeTransport.test.ts`
- `docs/src/content/docs/guides/voice-agents/transport.mdx`
