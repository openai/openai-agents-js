# @openai/agents-core

## 0.1.10

### Patch Changes

- 73ee587: fix: #563 enable explicit model override for prompt
- e0b46c4: fix: improve the compatibility for conversationId / previousResponseId + tool calls

  ref: https://github.com/openai/openai-agents-python/pull/1827

- 3023dc0: Fixes a bug where `onTraceEnd` was called immediately after `onTraceStart` when streaming is enabled

## 0.1.8

### Patch Changes

- f3d1ff8: Revert "feat(mcp): support structuredContent via useStructuredContent; return full CallToolResult"

## 0.1.7

### Patch Changes

- becabb9: fix: #247 logging for a sub-agent w/ stopAtToolNames
- 0fd8b6e: feat: #478 add isEnabled to handoffs & agents as tools
- be686e9: feat(mcp): add structuredContent support behind `useStructuredContent`; return full CallToolResult from `callTool`
  - `MCPServer#callTool` now returns the full `CallToolResult` (was `content[]`), exposing optional `structuredContent`.
  - Add `useStructuredContent` option to MCP servers (stdio/streamable-http/SSE), default `false` to avoid duplicate data by default.
  - When enabled, function tool outputs return JSON strings for consistency with Python SDK implementation.

- 74a6ca3: fix: #526 separate tool_call_item and tool_call_output_item in stream events

## 0.1.6

### Patch Changes

- 3115177: Add typed reasoning / text options to ModelSettings
- 8516799: fix(randomUUID): add fallback when crypto.randomUUID is unavailable

## 0.1.4

### Patch Changes

- 5f4e139: fix: #485 Abort during streaming throws “ReadableStream is locked” in StreamedRunResult
- 9147a6a: feat: #460 Enable to customize the internal runner for an agent as tool

## 0.1.3

### Patch Changes

- 74dd52e: fix: #473 upgrade openai package to the latest and fix breaking errors

## 0.1.2

### Patch Changes

- 01fad84: Fix #243 by enabling unified HITL interruptions from both agents and their agents as tools
- 3d652e8: fix: delay final output until tools complete

## 0.1.1

### Patch Changes

- b4d315b: feat: Fix #412 add optional details data to function tool execution
- a1c43dd: feat: enable mcp exports for cloudflare workers
- 2c43bcc: fix: #417 ensure BrowserEventEmitter off removes listeners

## 0.1.0

### Minor Changes

- f1e2f60: moving realtime to the new GA API and add MCP support

### Patch Changes

- 2260e21: Upgrade openai package to the latest version
- 94f606c: Fix #371 streaming agents not calling agent_end lifecycle hook
- 79a1999: Make docs and comments more consistent using Codex
- 42702c0: #366 Add conversations API support
- ecea142: Fix #374 add connector support
- 2b10adc: Fix #393 add domain filtering and sources to web search tool & upgrade openai package to the latest version
- 8fc01fc: Add a quick opt-in option to switch to gpt-5
- 6f1677c: fix(tracing): Fix #361 include groupId in trace export log message

## 0.0.17

### Patch Changes

- 1cd3266: feat: expose the `history` getter on `RunState` to access input and generated items.
- f825f71: Fix #187 Agent outputType type error with zod@3.25.68+
- 5d247a5: Fix #245 CJS resolution failure

## 0.0.16

### Patch Changes

- 1bb4d86: Fix #233 - eliminate confusion with "input_text" type items with role: "assistant"
- 4818d5e: fix: support snake_case usage fields from OpenAI responses
- 0858c98: fix: prevent crash when importing in cloudflare workers

  An export was missed in https://github.com/openai/openai-agents-js/pull/290 for the workerd shim, this prevents the crash when importing there. Long term we should just add an implementation for cloudflare workers (and I suspect the node implementation might just work)

- 4bfd911: Add custom fetch support to StreamableHTTP MCP transport
- c42a0a9: refactor: restructure mcp tools fetching with options object pattern

## 0.0.15

### Patch Changes

- 5f7d0d6: Add run context to handoff input filter to align with Python SDK
- 7b437d9: feat: add reasoning handling in chat completions
- b65315f: feat: add timeout parameter to callTool method
- 0fe38c0: feat: add sse server implementation for mcp

## 0.0.14

### Patch Changes

- 08dd469: agents-core, agents-realtime: add MCP tool-filtering support (fixes #162)
- d9c4ddf: include JsonSchema definitions in mcpTool inputSchema
- fba44d9: Fix #246 by exposing RunHandoffOutputItem type

## 0.0.13

### Patch Changes

- bd463ef: Fix #219 MCPServer#invalidateToolsCache() not exposed while being mentioned in the documents

## 0.0.12

### Patch Changes

- af73bfb: Rebinds cached tools to the current MCP server to avoid stale tool invocation (fixes #195)
- 046f8cc: Fix typos across repo
- ed66acf: Fixes handling of `agent_updated_stream_event` in run implementation and adds corresponding test coverage.
- 40dc0be: Fix #216 Publicly accessible PDF file URL is not yet supported in the input_file content data

## 0.0.11

### Patch Changes

- a60eabe: Fix #131 Human in the Loop MCP approval fails
- a153963: Tentative fix for #187 : Lock zod version to <=3.25.67
- 17077d8: Fix #175 by removing internal system.exit calls

## 0.0.10

### Patch Changes

- c248a7d: Fix #138 by checking the unexpected absence of state.currentAgent.handoffs
- ff63127: Fix #129 The model in run config should be used over an agent's default setting
- 9c60282: Fix a bug where some of the exceptions thrown from runImplementation.ts could be unhandled
- f61fd18: Don't enable `cacheToolsList` per default for MCP servers
- c248a7d: Fix #138 by checking the unexpected absence of currentAgent.handoffs

## 0.0.9

### Patch Changes

- 9028df4: Adjust Usage object to accept empty data
- ce62f7c: Fix #117 by adding groupId, metadata to trace data

## 0.0.8

### Patch Changes

- 6e1d67d: Add OpenAI Response object on ResponseSpanData for other exporters.
- 52eb3f9: fix(interruptions): avoid double outputting function calls for approval requests
- 9e6db14: Adding support for prompt configuration to agents
- 0565bf1: Add details to output guardrail execution
- 52eb3f9: fix(interruptions): avoid accidental infinite loop if all interruptions were not cleared. expose interruptions helper on state

## 0.0.7

### Patch Changes

- 0580b9b: Add remote MCP server (Streamable HTTP) support
- 77c603a: Add allowed_tools and headers to hosted mcp server factory method
- 1fccdca: Publishes types that were marked as internal but caused build errors when not exported in typings.
- 2fae25c: Add hosted MCP server support

## 0.0.6

### Patch Changes

- 2c6cfb1: Pass through signal to model call
- 36a401e: Add force flush to global provider. Consistently default disable logging loop in Cloudflare Workers and Browser

## 0.0.5

### Patch Changes

- 544ed4b: Continue agent execution when function calls are pending

## 0.0.4

### Patch Changes

- 25165df: fix: Process hangs on SIGINT because `process.exit` is never called
- 6683db0: fix(shims): Naively polyfill AsyncLocalStorage in browser
- 78811c6: fix(shims): Bind crypto to randomUUID
- 426ad73: ensure getTransferMessage returns valid JSON

## 0.0.3

### Patch Changes

- d7fd8dc: Export CURRENT_SCHEMA_VERSION constant and use it when serializing run state.
- 284d0ab: Update internal module in agents-core to accept a custom logger

## 0.0.2

### Patch Changes

- a2979b6: fix: ensure process.on exists and is a function before adding event handlers

## 0.0.1

### Patch Changes

- aaa6d08: Initial release

## 0.0.1-next.0

### Patch Changes

- Initial release
