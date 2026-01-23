# @openai/agents-openai

## 0.4.3

### Patch Changes

- Updated dependencies [657cda6]
- Updated dependencies [e28d181]
- Updated dependencies [709fa6f]
  - @openai/agents-core@0.4.3

## 0.4.2

### Patch Changes

- Updated dependencies [d76dcfd]
- Updated dependencies [605670e]
- Updated dependencies [f1b6f7f]
- Updated dependencies [7a1fc88]
- Updated dependencies [3a2bd9e]
- Updated dependencies [9d10652]
  - @openai/agents-core@0.4.2

## 0.4.1

### Patch Changes

- 60a48d7: Default compaction mode to auto and switch to input when store is false.
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

- 303e95e: feat: Add per-run tracing API key support
- d18eb0b: Add regression tests covering agent scenarios
- fa69dc7: fix: Skip response_format when "text" in Chat Completions calls
- da82f9c: fix: sanitize conversation items for non-OpenAI models in HITL flow
- 4f20c16: fix: Fix chat completions tool calls when content is present
- 7c05117: fix: Add content: null when having tool calls for Chat Completions
- ddccc9d: refactor: #275 simplify streaming state by removing unused index tracking
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

- e89a54a: fix: Add usage data integration to #760 feature addition
- b1ca7c3: feat: Literal unions: preserve completions by narrowing string branches
- f7159aa: feat: Add responses.compact-wired session feature
- 893b6f4: fix(agents-openai): add gpt-image-1-mini and gpt-image-1.5 support to imageGenerationTool
- Updated dependencies [af20625]
- Updated dependencies [e89a54a]
- Updated dependencies [c536421]
- Updated dependencies [12d4e44]
- Updated dependencies [b1ca7c3]
- Updated dependencies [f7159aa]
  - @openai/agents-core@0.3.6

## 0.3.5

### Patch Changes

- 820fbce: feat: track token usage while streaming responses for openai models
- ef324c4: fix: #745 Export OpenAIConversationsSessionOptions
- 6aa0550: fix: support input_file for chat completions when possible
- 5750d8a: fix: propagate providerData for function_calls in chat completions converter
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

- d552b50: Fix streaming tool call arguments when providers like Bedrock return an initial empty `{}` followed by actual arguments, resulting in malformed `{}{...}` JSON.
- Updated dependencies [2e09baf]
- Updated dependencies [d1d7842]
- Updated dependencies [c252cb5]
- Updated dependencies [0345a4c]
  - @openai/agents-core@0.3.4

## 0.3.3

### Patch Changes

- ef0a6d8: feat: Add prompt_cache_retention option to ModelSettings
- 22865ae: feat: #678 Add a list of per-request usage data to Usage
- Updated dependencies [18fec56]
- Updated dependencies [b94432b]
- Updated dependencies [0404173]
- Updated dependencies [ef0a6d8]
- Updated dependencies [22865ae]
  - @openai/agents-core@0.3.3

## 0.3.2

### Patch Changes

- 184e5d0: feat: Add reasoning.effort: none parameter for gpt-5.1
- 0a808d2: fix: Omit tools parameter when prompt ID is set but tools in the agent is absent
- 4734e27: Export usage data from Chat Completions response for trace
- Updated dependencies [184e5d0]
- Updated dependencies [0a808d2]
  - @openai/agents-core@0.3.2

## 0.3.1

### Patch Changes

- 2b57c4e: introduce new shell and apply_patch tools
- Updated dependencies [2b57c4e]
  - @openai/agents-core@0.3.1

## 0.3.0

### Minor Changes

- 1a5326f: feat: fix #272 add memory feature

### Patch Changes

- Updated dependencies [1a5326f]
  - @openai/agents-core@0.3.0

## 0.2.1

### Patch Changes

- 76e5adb: fix: ugprade openai package from v5 to v6
- Updated dependencies [76e5adb]
  - @openai/agents-core@0.2.1

## 0.2.0

### Minor Changes

- 0e01da0: feat: #313 Enable tools to return image/file data to an Agent
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

- 73ee587: fix: #563 enable explicit model override for prompt
- b07a588: fix: #562 invalid model settings when prompt is set in Agent
- Updated dependencies [73ee587]
- Updated dependencies [e0b46c4]
- Updated dependencies [3023dc0]
  - @openai/agents-core@0.1.10

## 0.1.9

### Patch Changes

- 4f27ed5: fix: #558 prompt parameter does not work when being passed via an Agent

## 0.1.8

### Patch Changes

- Updated dependencies [f3d1ff8]
  - @openai/agents-core@0.1.8

## 0.1.7

### Patch Changes

- Updated dependencies [becabb9]
- Updated dependencies [0fd8b6e]
- Updated dependencies [be686e9]
- Updated dependencies [74a6ca3]
  - @openai/agents-core@0.1.7

## 0.1.6

### Patch Changes

- 3115177: Add typed reasoning / text options to ModelSettings
- Updated dependencies [3115177]
- Updated dependencies [8516799]
  - @openai/agents-core@0.1.6

## 0.1.4

### Patch Changes

- Updated dependencies [5f4e139]
- Updated dependencies [9147a6a]
  - @openai/agents-core@0.1.4

## 0.1.3

### Patch Changes

- 74dd52e: fix: #473 upgrade openai package to the latest and fix breaking errors
- Updated dependencies [74dd52e]
  - @openai/agents-core@0.1.3

## 0.1.2

### Patch Changes

- 7fa0434: Refactor audio extraction logic in converter
- Updated dependencies [01fad84]
- Updated dependencies [3d652e8]
  - @openai/agents-core@0.1.2

## 0.1.1

### Patch Changes

- Updated dependencies [b4d315b]
- Updated dependencies [a1c43dd]
- Updated dependencies [2c43bcc]
  - @openai/agents-core@0.1.1

## 0.1.0

### Patch Changes

- 2260e21: Upgrade openai package to the latest version
- 47a28ad: Fix a bug where responses api does not accept both outputType and verbosity parameter for gpt-5
- 42702c0: #366 Add conversations API support
- ecea142: Fix #374 add connector support
- 2b10adc: Fix #393 add domain filtering and sources to web search tool & upgrade openai package to the latest version
- 8fc01fc: Add a quick opt-in option to switch to gpt-5
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

- 1bb4d86: Fix #233 - eliminate confusion with "input_text" type items with role: "assistant"
- a51105b: Pass through strict flag for function tools when using completion
- 4818d5e: fix: support snake_case usage fields from OpenAI responses
- Updated dependencies [1bb4d86]
- Updated dependencies [4818d5e]
- Updated dependencies [0858c98]
- Updated dependencies [4bfd911]
- Updated dependencies [c42a0a9]
  - @openai/agents-core@0.0.16

## 0.0.15

### Patch Changes

- 7b437d9: feat: add reasoning handling in chat completions
- Updated dependencies [5f7d0d6]
- Updated dependencies [7b437d9]
- Updated dependencies [b65315f]
- Updated dependencies [0fe38c0]
  - @openai/agents-core@0.0.15

## 0.0.14

### Patch Changes

- b6c7e9d: Fix codeInterpreterTool run replay by correctly using container_id from providerData (fixes #253)
- Updated dependencies [08dd469]
- Updated dependencies [d9c4ddf]
- Updated dependencies [fba44d9]
  - @openai/agents-core@0.0.14

## 0.0.13

### Patch Changes

- Updated dependencies [bd463ef]
  - @openai/agents-core@0.0.13

## 0.0.12

### Patch Changes

- fe5fb97: Handle function call messages with empty content in Chat Completions
- ad05c65: fix: if prompt is not specified return undefined - fixes #159
- 886e25a: Add input_fidelity parameter support to image generation tool
- 046f8cc: Fix typos across repo
- 40dc0be: Fix #216 Publicly accessible PDF file URL is not yet supported in the input_file content data
- Updated dependencies [af73bfb]
- Updated dependencies [046f8cc]
- Updated dependencies [ed66acf]
- Updated dependencies [40dc0be]
  - @openai/agents-core@0.0.12

## 0.0.11

### Patch Changes

- a153963: Tentative fix for #187 : Lock zod version to <=3.25.67
- Updated dependencies [a60eabe]
- Updated dependencies [a153963]
- Updated dependencies [17077d8]
  - @openai/agents-core@0.0.11

## 0.0.10

### Patch Changes

- 4adbcb5: Fix #140 by resolving built-in tool call item compatibility
- Updated dependencies [c248a7d]
- Updated dependencies [ff63127]
- Updated dependencies [9c60282]
- Updated dependencies [f61fd18]
- Updated dependencies [c248a7d]
  - @openai/agents-core@0.0.10

## 0.0.9

### Patch Changes

- Updated dependencies [9028df4]
- Updated dependencies [ce62f7c]
  - @openai/agents-core@0.0.9

## 0.0.8

### Patch Changes

- 6e1d67d: Add OpenAI Response object on ResponseSpanData for other exporters.
- 9e6db14: Adding support for prompt configuration to agents
- 0565bf1: Add details to output guardrail execution
- fc99390: Fix Azure streaming annotation handling
- Updated dependencies [6e1d67d]
- Updated dependencies [52eb3f9]
- Updated dependencies [9e6db14]
- Updated dependencies [0565bf1]
- Updated dependencies [52eb3f9]
  - @openai/agents-core@0.0.8

## 0.0.7

### Patch Changes

- 77c603a: Add allowed_tools and headers to hosted mcp server factory method
- 2fae25c: Add hosted MCP server support
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

- adeb218: Ignore empty tool list when calling LLM
- cbd4deb: feat: handle unknown hosted tools in responses model
- Updated dependencies [544ed4b]
  - @openai/agents-core@0.0.5

## 0.0.4

### Patch Changes

- ded675a: chore(openai): add more accurate debug logging
- Updated dependencies [25165df]
- Updated dependencies [6683db0]
- Updated dependencies [78811c6]
- Updated dependencies [426ad73]
  - @openai/agents-core@0.0.4

## 0.0.3

### Patch Changes

- 0474de9: Fix incorrect handling of chat completions mode for handoff
- Updated dependencies [d7fd8dc]
- Updated dependencies [284d0ab]
  - @openai/agents-core@0.0.3

## 0.0.2

### Patch Changes

- b4942fa: Fix #5 setDefaultOpenAIClient issue in agents-openai package
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
