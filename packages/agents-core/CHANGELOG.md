# @openai/agents-core

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
