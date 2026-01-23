# @openai/agents-core

## 0.4.3

### Patch Changes

- 657cda6: fix(agents-core): #905 detach abort listeners after streaming completion
- e28d181: test: fail on unexpected stdout/stderr in Vitest
- 709fa6f: test(agents-core): silence expected MCP server error logs in tests

## 0.4.2

### Patch Changes

- d76dcfd: fix: prefer error handler output for agent tools (ref #896)
- 605670e: test(realtime,core,extensions): add coverage for approvals, tracing, MCP, and codex helpers
- f1b6f7f: feat(agents-core): add maxTurns error handlers with runData snapshots
- 7a1fc88: feat: add MCPServers lifecycle helper
- 3a2bd9e: feat: add AI SDK data/text stream response adapters for streamed runs
- 9d10652: fix(agents-core): prefer run tracing config when resuming run state

## 0.4.1

### Patch Changes

- 60a48d7: Default compaction mode to auto and switch to input when store is false.
- 648a461: fix: handle legacy fileId fallback and expand coverage
- 6cc01be: fix: #723 handle invalid JSON in tool call arguments gracefully to prevent agent crashes

## 0.4.0

### Minor Changes

- 2bce164: feat: #561 Drop Zod v3 support and require Zod v4 for schema-based tools and outputs
- 4feaaae: feat(agents-core): update gpt-5.1/5.2 defaults and reasoning effort types

## 0.3.9

### Patch Changes

- f0ad706: fix(agents-core): #670 set subclass error names

## 0.3.8

### Patch Changes

- 3b368cb: fix: #829 Ensure generated declarations are type-checked and expose PreparedInputWithSessionResult
- 303e95e: feat: Add per-run tracing API key support
- d18eb0b: Add regression tests covering agent scenarios
- 5d9b751: fix: #799 Expose raw input and validation error in tool parsing failures
- a0fc1dc: feat: #794 Expose `ToolInputParameters` and `ToolOptions` from the top-level exports so wrappers can import the tool types
- da82f9c: fix: sanitize conversation items for non-OpenAI models in HITL flow
- 20cb95f: feat: Add tool input/output guardrails to TS SDK
- 762d98c: fix: Refactor run.ts/runImplementation.ts internals
- c8a9c1d: fix: #709 Share tracing context across runtimes to prevent Deno aisdk context loss
- e0ba932: fix: opt-in run state enhancement for #813
- 41c1b89: fix: terminate streamable HTTP MCP sessions safely with typed guard
- b233ea5: fix: Fix streaming cancellation to abort promptly and resolve completion on cancel

## 0.3.7

### Patch Changes

- af1c6c9: fix: Fix a bug where MCP servers don't use clientSessionTimeoutSeconds (re-fix for #781)

## 0.3.6

### Patch Changes

- af20625: fix: Fix a bug where MCP servers don't use clientSessionTimeoutSeconds
- e89a54a: fix: Add usage data integration to #760 feature addition
- c536421: fix: #775 tracing: previousSpan is not correctly set
- 12d4e44: fix: Enable creating and disposing Computer per request ref: #663
- b1ca7c3: feat: Literal unions: preserve completions by narrowing string branches
- f7159aa: feat: Add responses.compact-wired session feature

## 0.3.5

### Patch Changes

- 2cb61b0: feat: Add onStream handler to agents as tools
- 2a4a696: feat: #762 Add turnInput (optional) to agent_start event hooks
- 820fbce: feat: track token usage while streaming responses for openai models
- 970b086: chore(deps): bump @modelcontextprotocol/sdk from 1.12.1 to 1.24.0
- dccc9b3: fix: #753 Emit agent_tool_end event when function tools throw errors
- 378d421: fix: #701 prevent duplicate function_call items in session history after resuming from interruption
- bdbc87d: fix: event data adjustment for #749
- dd1a813: SpanData types are exported from distribution types for use when writing custom TracingExporters and Tracingprocessors

## 0.3.4

### Patch Changes

- 2e09baf: fix: #699 Forward fetch parameter to SSEClientTransport in MCPServerSSE
- d1d7842: feat: Add ToolOptions to agents-core package export
- c252cb5: feat: #713 Access tool call items in an output guardrail
- 0345a4c: feat: #695 Customizable MCP list tool caching

## 0.3.3

### Patch Changes

- 18fec56: feat: #679 Add runInParallel option to input guardrail initialization
- b94432b: fix: #683 Failing to run MCP servers when deserializing run state data
- 0404173: fix: #316 developer-friendly message for output type errors
- ef0a6d8: feat: Add prompt_cache_retention option to ModelSettings
- 22865ae: feat: #678 Add a list of per-request usage data to Usage

## 0.3.2

### Patch Changes

- 184e5d0: feat: Add reasoning.effort: none parameter for gpt-5.1
- 0a808d2: fix: Omit tools parameter when prompt ID is set but tools in the agent is absent

## 0.3.1

### Patch Changes

- 2b57c4e: introduce new shell and apply_patch tools

## 0.3.0

### Minor Changes

- 1a5326f: feat: fix #272 add memory feature

## 0.2.1

### Patch Changes

- 76e5adb: fix: ugprade openai package from v5 to v6

## 0.2.0

### Minor Changes

- 0e01da0: feat: #313 Enable tools to return image/file data to an Agent
- 27915f7: feat: #561 support both zod3 and zod4

## 0.1.11

### Patch Changes

- 3417f25: fix: #597 hostedMcpTool fails to send authorization parameter to Responses API

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
