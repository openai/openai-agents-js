# @openai/agents-realtime

## 0.4.3

### Patch Changes

- e28d181: test: fail on unexpected stdout/stderr in Vitest
- Updated dependencies [657cda6]
- Updated dependencies [e28d181]
- Updated dependencies [709fa6f]
  - @openai/agents-core@0.4.3

## 0.4.2

### Patch Changes

- 605670e: test(realtime,core,extensions): add coverage for approvals, tracing, MCP, and codex helpers
- Updated dependencies [d76dcfd]
- Updated dependencies [605670e]
- Updated dependencies [f1b6f7f]
- Updated dependencies [7a1fc88]
- Updated dependencies [3a2bd9e]
- Updated dependencies [9d10652]
  - @openai/agents-core@0.4.2

## 0.4.1

### Patch Changes

- 648a461: fix: handle legacy fileId fallback and expand coverage
- Updated dependencies [60a48d7]
- Updated dependencies [648a461]
- Updated dependencies [6cc01be]
  - @openai/agents-core@0.4.1

## 0.4.0

### Minor Changes

- 2bce164: feat: #561 Drop Zod v3 support and require Zod v4 for schema-based tools and outputs

### Patch Changes

- Updated dependencies [2bce164]
- Updated dependencies [4feaaae]
  - @openai/agents-core@0.4.0

## 0.3.9

### Patch Changes

- Updated dependencies [f0ad706]
  - @openai/agents-core@0.3.9

## 0.3.8

### Patch Changes

- 65880e8: fix(realtime): #820 null values for noise_reduction / transcription / turn_detection are ignored
- d18eb0b: Add regression tests covering agent scenarios
- f2ccd93: fix: whitelist realtime session tool payload to documented fields
- 20cb95f: feat: Add tool input/output guardrails to TS SDK
- ba4a612: fix: #816 preserve falsy turn detection config values
- Updated dependencies [3b368cb]
- Updated dependencies [303e95e]
- Updated dependencies [d18eb0b]
- Updated dependencies [5d9b751]
- Updated dependencies [a0fc1dc]
- Updated dependencies [da82f9c]
- Updated dependencies [20cb95f]
- Updated dependencies [762d98c]
- Updated dependencies [c8a9c1d]
- Updated dependencies [e0ba932]
- Updated dependencies [41c1b89]
- Updated dependencies [b233ea5]
  - @openai/agents-core@0.3.8

## 0.3.7

### Patch Changes

- Updated dependencies [af1c6c9]
  - @openai/agents-core@0.3.7

## 0.3.6

### Patch Changes

- Updated dependencies [af20625]
- Updated dependencies [e89a54a]
- Updated dependencies [c536421]
- Updated dependencies [12d4e44]
- Updated dependencies [b1ca7c3]
- Updated dependencies [f7159aa]
  - @openai/agents-core@0.3.6

## 0.3.5

### Patch Changes

- 1300121: feat(realtime): Add usage field to input audio transcription completed event
- 2a4a696: feat: #762 Add turnInput (optional) to agent_start event hooks
- Updated dependencies [2cb61b0]
- Updated dependencies [2a4a696]
- Updated dependencies [820fbce]
- Updated dependencies [970b086]
- Updated dependencies [dccc9b3]
- Updated dependencies [378d421]
- Updated dependencies [bdbc87d]
- Updated dependencies [dd1a813]
  - @openai/agents-core@0.3.5

## 0.3.4

### Patch Changes

- Updated dependencies [2e09baf]
- Updated dependencies [d1d7842]
- Updated dependencies [c252cb5]
- Updated dependencies [0345a4c]
  - @openai/agents-core@0.3.4

## 0.3.3

### Patch Changes

- 46df17d: fix: #523 transcript removal issue when being interrupted
- d84976a: fix: #675 top-level voice param in realtime session confid does not work
- Updated dependencies [18fec56]
- Updated dependencies [b94432b]
- Updated dependencies [0404173]
- Updated dependencies [ef0a6d8]
- Updated dependencies [22865ae]
  - @openai/agents-core@0.3.3

## 0.3.2

### Patch Changes

- Updated dependencies [184e5d0]
- Updated dependencies [0a808d2]
  - @openai/agents-core@0.3.2

## 0.3.1

### Patch Changes

- 2b57c4e: introduce new shell and apply_patch tools
- Updated dependencies [2b57c4e]
  - @openai/agents-core@0.3.1

## 0.3.0

### Patch Changes

- 642a79b: fix: #639 Type issue with realtime agent handoffs
- 4c1192d: fix: #633 fix a bug where tracingDisabled in realtime config does not work
- 14016fd: feat: #439 add SIP support for realtime agent runner
- 8c93873: fix: #613 Listen to peerConnection state in `OpenAIRealtimeWebRTC` to detect disconnects
- Updated dependencies [1a5326f]
  - @openai/agents-core@0.3.0

## 0.2.1

### Patch Changes

- Updated dependencies [76e5adb]
  - @openai/agents-core@0.2.1

## 0.2.0

### Minor Changes

- 27915f7: feat: #561 support both zod3 and zod4

### Patch Changes

- Updated dependencies [0e01da0]
- Updated dependencies [27915f7]
  - @openai/agents-core@0.2.0

## 0.1.11

### Patch Changes

- Updated dependencies [3417f25]
  - @openai/agents-core@0.1.11

## 0.1.10

### Patch Changes

- cad0baa: Resolved typo with usage events
- Updated dependencies [73ee587]
- Updated dependencies [e0b46c4]
- Updated dependencies [3023dc0]
  - @openai/agents-core@0.1.10

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
