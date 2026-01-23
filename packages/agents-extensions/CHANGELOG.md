# @openai/agents-extensions

## 0.4.3

### Patch Changes

- e28d181: test: fail on unexpected stdout/stderr in Vitest
- Updated dependencies [657cda6]
- Updated dependencies [e28d181]
- Updated dependencies [709fa6f]
  - @openai/agents-core@0.4.3
  - @openai/agents@0.4.3

## 0.4.2

### Patch Changes

- 605670e: test(realtime,core,extensions): add coverage for approvals, tracing, MCP, and codex helpers
- 3a2bd9e: feat: add AI SDK data/text stream response adapters for streamed runs
- Updated dependencies [d76dcfd]
- Updated dependencies [605670e]
- Updated dependencies [f1b6f7f]
- Updated dependencies [7a1fc88]
- Updated dependencies [3a2bd9e]
- Updated dependencies [9d10652]
  - @openai/agents-core@0.4.2
  - @openai/agents@0.4.2

## 0.4.1

### Patch Changes

- Updated dependencies [60a48d7]
- Updated dependencies [648a461]
- Updated dependencies [6cc01be]
  - @openai/agents-core@0.4.1
  - @openai/agents@0.4.1

## 0.4.0

### Minor Changes

- e8935bf: chore: #868 make @ai-sdk/provider an optional peer dependency to support v2 and v3
- 2bce164: feat: #561 Drop Zod v3 support and require Zod v4 for schema-based tools and outputs

### Patch Changes

- Updated dependencies [2bce164]
- Updated dependencies [4feaaae]
  - @openai/agents@0.4.0
  - @openai/agents-core@0.4.0

## 0.3.9

### Patch Changes

- da85934: Improve Codex tool ergonomics: support onStream event hooks, handle additional Codex item types, and fix output schema/inputs validation.
- da85934: feat: Add experimental codex tool module
- Updated dependencies [f0ad706]
  - @openai/agents-core@0.3.9
  - @openai/agents@0.3.9

## 0.3.8

### Patch Changes

- c6f0211: Fix : correctly extract token counts when AI SDK providers return them as objects instead of numbers (e.g. @ai-sdk/google)
- d18eb0b: Add regression tests covering agent scenarios
- c8a9c1d: fix: #709 Share tracing context across runtimes to prevent Deno aisdk context loss
- a752980: feat: Add ai-sdk v3 support and improve other provider compatibility
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
  - @openai/agents@0.3.8

## 0.3.7

### Patch Changes

- Updated dependencies [af1c6c9]
  - @openai/agents-core@0.3.7
  - @openai/agents@0.3.7

## 0.3.6

### Patch Changes

- Updated dependencies [af20625]
- Updated dependencies [e89a54a]
- Updated dependencies [c536421]
- Updated dependencies [12d4e44]
- Updated dependencies [b1ca7c3]
- Updated dependencies [f7159aa]
  - @openai/agents-core@0.3.6
  - @openai/agents@0.3.6

## 0.3.5

### Patch Changes

- 9e1549a: feat(agents-extensions): #628 add Anthropic extended thinking support
- 2a77585: Improve AI SDK error messages in tracing to include comprehensive error details like responseBody, statusCode, and responseHeaders when tracing is enabled.
- Updated dependencies [2cb61b0]
- Updated dependencies [2a4a696]
- Updated dependencies [820fbce]
- Updated dependencies [970b086]
- Updated dependencies [dccc9b3]
- Updated dependencies [378d421]
- Updated dependencies [bdbc87d]
- Updated dependencies [dd1a813]
  - @openai/agents-core@0.3.5
  - @openai/agents@0.3.5

## 0.3.4

### Patch Changes

- 870cc20: fix: preserve Gemini thought_signature in multi-turn tool calls
- 4ea9550: fix: #708 data: string in an input_image message item does not work with some providers
- Updated dependencies [2e09baf]
- Updated dependencies [d1d7842]
- Updated dependencies [c252cb5]
- Updated dependencies [0345a4c]
  - @openai/agents-core@0.3.4
  - @openai/agents@0.3.4

## 0.3.3

### Patch Changes

- 22865ae: feat: #678 Add a list of per-request usage data to Usage
- Updated dependencies [18fec56]
- Updated dependencies [b94432b]
- Updated dependencies [0404173]
- Updated dependencies [ef0a6d8]
- Updated dependencies [22865ae]
  - @openai/agents-core@0.3.3
  - @openai/agents@0.3.3

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
