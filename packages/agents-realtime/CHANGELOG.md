# @openai/agents-realtime

## 0.1.8

### Patch Changes

- bb18a43: fix: #552 WebSocket Realtime Agent: invalid_request_error with decimal audio_end_ms data
- Updated dependencies [f3d1ff8]
  - @openai/agents-core@0.1.8

## 0.1.7

### Patch Changes

- 0fd8b6e: feat: #478 add isEnabled to handoffs & agents as tools
- 926bc13: fix: #494 Voice input transcription failing in realtime-demo
- Updated dependencies [becabb9]
- Updated dependencies [0fd8b6e]
- Updated dependencies [be686e9]
- Updated dependencies [74a6ca3]
  - @openai/agents-core@0.1.7

## 0.1.6

### Patch Changes

- Updated dependencies [3115177]
- Updated dependencies [8516799]
  - @openai/agents-core@0.1.6

## 0.1.5

### Patch Changes

- 2dfb4fd: feat: add factory-based Cloudflare support.
  - Realtime (WebSocket): add `createWebSocket` and `skipOpenEventListeners` options to enable
    custom socket creation and connection state control for specialized runtimes.
  - Extensions: add `CloudflareRealtimeTransportLayer`, which performs a `fetch()`-based WebSocket
    upgrade on Cloudflare/workerd and integrates via the WebSocket factory.

## 0.1.4

### Patch Changes

- 18fd902: fix: #495 Realtime session config falls back to legacy format when voice is set
- 1d4984b: Realtime: expose Call ID in OpenAIRealtimeWebRTC
- Updated dependencies [5f4e139]
- Updated dependencies [9147a6a]
  - @openai/agents-core@0.1.4

## 0.1.3

### Patch Changes

- Updated dependencies [74dd52e]
  - @openai/agents-core@0.1.3

## 0.1.2

### Patch Changes

- Updated dependencies [01fad84]
- Updated dependencies [3d652e8]
  - @openai/agents-core@0.1.2

## 0.1.1

### Patch Changes

- b4d315b: feat: Fix #412 add optional details data to function tool execution
- 1cb6188: fix: allow setting an initial tracing configuration for Realtime
- Updated dependencies [b4d315b]
- Updated dependencies [a1c43dd]
- Updated dependencies [2c43bcc]
  - @openai/agents-core@0.1.1

## 0.1.0

### Minor Changes

- f1e2f60: moving realtime to the new GA API and add MCP support

### Patch Changes

- 79a1999: Make docs and comments more consistent using Codex
- 8cf5356: Fix: ensure assistant message items from `response.output_item.done` preserve API status and default to `"completed"` when missing, so `history_updated` no longer stays `"in_progress"` after completion.
- f1e2f60: Add backgroundResult as an option to return tool results without triggering a new response
- Updated dependencies [2260e21]
- Updated dependencies [94f606c]
- Updated dependencies [79a1999]
- Updated dependencies [42702c0]
- Updated dependencies [ecea142]
- Updated dependencies [2b10adc]
- Updated dependencies [f1e2f60]
- Updated dependencies [8fc01fc]
- Updated dependencies [6f1677c]
  - @openai/agents-core@0.1.0

## 0.0.17

### Patch Changes

- f825f71: Fix #187 Agent outputType type error with zod@3.25.68+
- 5d247a5: Fix #245 CJS resolution failure
- Updated dependencies [1cd3266]
- Updated dependencies [f825f71]
- Updated dependencies [5d247a5]
  - @openai/agents-core@0.0.17

## 0.0.16

### Patch Changes

- b487db1: Fix: clamp and floor `audio_end_ms` in interrupts to prevent Realtime API error with fractional speeds (#315)
- a0b1f3b: fix(realtime-session): preserve audio format & other session config fields on agent update
- Updated dependencies [1bb4d86]
- Updated dependencies [4818d5e]
- Updated dependencies [0858c98]
- Updated dependencies [4bfd911]
- Updated dependencies [c42a0a9]
  - @openai/agents-core@0.0.16

## 0.0.15

### Patch Changes

- Updated dependencies [5f7d0d6]
- Updated dependencies [7b437d9]
- Updated dependencies [b65315f]
- Updated dependencies [0fe38c0]
  - @openai/agents-core@0.0.15

## 0.0.14

### Patch Changes

- 08dd469: agents-core, agents-realtime: add MCP tool-filtering support (fixes #162)
- Updated dependencies [08dd469]
- Updated dependencies [d9c4ddf]
- Updated dependencies [fba44d9]
  - @openai/agents-core@0.0.14

## 0.0.13

### Patch Changes

- 9fdecdb: Expose configurable URL in OpenAIRealtimeWebSocket constructor and RealtimeSession.connect.
- 25241e4: Fix missing `audio_start` event; now emitted on first audio chunk per turn
- Updated dependencies [bd463ef]
  - @openai/agents-core@0.0.13

## 0.0.12

### Patch Changes

- a2f78fe: support noise reduction argument
- d9b94b3: Adds support for the speed parameter
- f6e68f4: fix(realtime-ws): stop accidental cancellation error
- 046f8cc: Fix typos across repo
- Updated dependencies [af73bfb]
- Updated dependencies [046f8cc]
- Updated dependencies [ed66acf]
- Updated dependencies [40dc0be]
  - @openai/agents-core@0.0.12

## 0.0.11

### Patch Changes

- 07939c0: Correct typo in RealtimeTransportEventTypes in code and docs
- a153963: Tentative fix for #187 : Lock zod version to <=3.25.67
- 6e0d1bd: Fixes issue #106 where overlapping user inputs caused null transcripts in history
- Updated dependencies [a60eabe]
- Updated dependencies [a153963]
- Updated dependencies [17077d8]
  - @openai/agents-core@0.0.11

## 0.0.10

### Patch Changes

- 787968b: fix: use web standard event apis for twilio websocket
- Updated dependencies [c248a7d]
- Updated dependencies [ff63127]
- Updated dependencies [9c60282]
- Updated dependencies [f61fd18]
- Updated dependencies [c248a7d]
  - @openai/agents-core@0.0.10

## 0.0.9

### Patch Changes

- 49bfe25: Improve the types of turnDetection and inputAudioTranscription in RealtimeAgent configuration
- Updated dependencies [9028df4]
- Updated dependencies [ce62f7c]
  - @openai/agents-core@0.0.9

## 0.0.8

### Patch Changes

- 0565bf1: Add details to output guardrail execution
- Updated dependencies [6e1d67d]
- Updated dependencies [52eb3f9]
- Updated dependencies [9e6db14]
- Updated dependencies [0565bf1]
- Updated dependencies [52eb3f9]
  - @openai/agents-core@0.0.8

## 0.0.7

### Patch Changes

- Updated dependencies [0580b9b]
- Updated dependencies [77c603a]
- Updated dependencies [1fccdca]
- Updated dependencies [2fae25c]
  - @openai/agents-core@0.0.7

## 0.0.6

### Patch Changes

- Updated dependencies [2c6cfb1]
- Updated dependencies [36a401e]
  - @openai/agents-core@0.0.6

## 0.0.5

### Patch Changes

- 6e2445a: Add `changePeerConnection` option to `OpenAIRealtimeWebRTC` allowing interception
  and replacement of the created `RTCPeerConnection` before the offer is made.
- ca5cf8b: fix(realtime): add zod dependency to package.json
- Updated dependencies [544ed4b]
  - @openai/agents-core@0.0.5

## 0.0.4

### Patch Changes

- Updated dependencies [25165df]
- Updated dependencies [6683db0]
- Updated dependencies [78811c6]
- Updated dependencies [426ad73]
  - @openai/agents-core@0.0.4

## 0.0.3

### Patch Changes

- 68ff0ba: fix: avoid realtime guardrail race condition and detect ongoing response
- Updated dependencies [d7fd8dc]
- Updated dependencies [284d0ab]
  - @openai/agents-core@0.0.3

## 0.0.2

### Patch Changes

- Updated dependencies [a2979b6]
  - @openai/agents-core@0.0.2

## 0.0.1

### Patch Changes

- aaa6d08: Initial release
- Updated dependencies [aaa6d08]
  - @openai/agents-core@0.0.1

## 0.0.1-next.0

### Patch Changes

- Initial release
- Updated dependencies
  - @openai/agents-core@0.0.1-next.0
