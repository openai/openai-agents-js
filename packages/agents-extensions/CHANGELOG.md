# @openai/agents-extensions

## 0.3.2

### Patch Changes

- Updated dependencies [184e5d0]
- Updated dependencies [0a808d2]
  - @openai/agents-core@0.3.2
  - @openai/agents@0.3.2

## 0.3.1

### Patch Changes

- 2b57c4e: introduce new shell and apply_patch tools
- Updated dependencies [2b57c4e]
  - @openai/agents-core@0.3.1
  - @openai/agents@0.3.1

## 0.3.0

### Patch Changes

- b3148a2: Fix open ai compatible models misuse '' in tools arguments call when an empty object is the valid option
- Updated dependencies [1a5326f]
  - @openai/agents-core@0.3.0
  - @openai/agents@0.3.0

## 0.2.1

### Patch Changes

- Updated dependencies [76e5adb]
  - @openai/agents-core@0.2.1
  - @openai/agents@0.2.1

## 0.2.0

### Minor Changes

- 0e01da0: feat: #313 Enable tools to return image/file data to an Agent
- 27915f7: feat: #561 support both zod3 and zod4

### Patch Changes

- Updated dependencies [0e01da0]
- Updated dependencies [27915f7]
  - @openai/agents-core@0.2.0
  - @openai/agents@0.2.0

## 0.1.5

### Patch Changes

- 2dfb4fd: feat: add factory-based Cloudflare support.
  - Realtime (WebSocket): add `createWebSocket` and `skipOpenEventListeners` options to enable
    custom socket creation and connection state control for specialized runtimes.
  - Extensions: add `CloudflareRealtimeTransportLayer`, which performs a `fetch()`-based WebSocket
    upgrade on Cloudflare/workerd and integrates via the WebSocket factory.
  - @openai/agents@0.1.5

## 0.1.2

### Patch Changes

- ffcd204: fix: #239 enable to pass toolChoice through ai-sdk
  - @openai/agents@0.1.2

## 0.1.0

### Minor Changes

- 2e6933a: Fix #283 #291 #300 migrate ai-sdk/provider to v2
- f1e2f60: moving realtime to the new GA API and add MCP support

### Patch Changes

- 03ebbaa: Loosen the `@openai/agents` dep's version range
- Updated dependencies [80e1fc1]
- Updated dependencies [2260e21]
- Updated dependencies [79a1999]
  - @openai/agents@0.1.0

## 0.0.17

### Patch Changes

- f825f71: Fix #187 Agent outputType type error with zod@3.25.68+
- 5d247a5: Fix #245 CJS resolution failure
- Updated dependencies [f825f71]
- Updated dependencies [5d247a5]
  - @openai/agents@0.0.17

## 0.0.16

### Patch Changes

- 1bb4d86: Fix #233 - eliminate confusion with "input_text" type items with role: "assistant"
- 191b82a: fix: the aisdk extension should grab output when toolCalls is a blank array

  When the output of a provider includes an empty tool calls array, we'd mistakenly skip over the text result. This patch checks for that condition.

- b487db1: Fix: clamp and floor `audio_end_ms` in interrupts to prevent Realtime API error with fractional speeds (#315)
  - @openai/agents@0.0.16

## 0.0.15

### Patch Changes

- @openai/agents@0.0.15

## 0.0.14

### Patch Changes

- 63e534b: Fix #259 Failing to send trace data with usage for ai-sdk models
  - @openai/agents@0.0.14

## 0.0.13

### Patch Changes

- @openai/agents@0.0.13

## 0.0.12

### Patch Changes

- f6e68f4: fix(realtime-ws): stop accidental cancellation error
  - @openai/agents@0.0.12

## 0.0.11

### Patch Changes

- a153963: Tentative fix for #187 : Lock zod version to <=3.25.67
- 0664056: Add tracing usage telemetry to aiSdk
  - @openai/agents@0.0.11

## 0.0.10

### Patch Changes

- 955e6f1: Fix #152 empty arguments parsing error in ai-sdk extension
- 787968b: fix: use web standard event apis for twilio websocket
- Updated dependencies [787968b]
  - @openai/agents@0.0.10

## 0.0.9

### Patch Changes

- fb9ca4f: fix(aisdk): make providerData less opinionated and pass to content
  - @openai/agents@0.0.9

## 0.0.8

### Patch Changes

- ef64938: fix(aisdk): handle non number token values
- 0565bf1: Add details to output guardrail execution
  - @openai/agents@0.0.8

## 0.0.7

### Patch Changes

- @openai/agents@0.0.7

## 0.0.6

### Patch Changes

- @openai/agents@0.0.6

## 0.0.5

### Patch Changes

- @openai/agents@0.0.5

## 0.0.4

### Patch Changes

- 0f4850e: Fix #34 by adjusting the internals of ai-sdk integration
  - @openai/agents@0.0.4

## 0.0.3

### Patch Changes

- @openai/agents@0.0.3

## 0.0.2

### Patch Changes

- @openai/agents@0.0.2

## 0.0.1

### Patch Changes

- aaa6d08: Initial release
- Updated dependencies [aaa6d08]
  - @openai/agents@0.0.1

## 0.0.1-next.0

### Patch Changes

- Initial release
- Updated dependencies
  - @openai/agents@0.0.1-next.0
