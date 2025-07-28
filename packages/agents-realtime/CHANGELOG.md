# @openai/agents-realtime

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
