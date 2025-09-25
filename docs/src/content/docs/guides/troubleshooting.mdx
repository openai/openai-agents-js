---
title: Troubleshooting
description: Learn how to troubleshoot issues with the OpenAI Agents SDK.
---

## Supported environments

The OpenAI Agents SDK is supported on the following server environments:

- Node.js 22+
- Deno 2.35+
- Bun 1.2.5+

### Limited support

- **Cloudflare Workers**: The Agents SDK can be used in Cloudflare Workers, but currently comes with some limitations:
  - The SDK current requires `nodejs_compat` to be enabled
  - Traces need to be manually flushed at the end of the request. [See the tracing guide](/openai-agents-js/guides/tracing#export-loop-lifecycle) for more details.
  - Due to Cloudflare Workers' limited support for `AsyncLocalStorage` some traces might not be accurate
  - Outbound WebSocket connections must use a fetch-based upgrade (not the global `WebSocket` constructor). For Realtime, use the Cloudflare transport in `@openai/agents-extensions` (`CloudflareRealtimeTransportLayer`).
- **Browsers**:
  - Tracing is currently not supported in browsers
- **v8 isolates**:
  - While you should be able to bundle the SDK for v8 isolates if you use a bundler with the right browser polyfills, tracing will not work
  - v8 isolates have not been extensively tested

## Debug logging

If you are running into problems with the SDK, you can enable debug logging to get more information about what is happening.

Enable debug logging by setting the `DEBUG` environment variable to `openai-agents:*`.

```bash
DEBUG=openai-agents:*
```

Alternatively, you can scope the debugging to specific parts of the SDK:

- `openai-agents:core` — for the main execution logic of the SDK
- `openai-agents:openai` — for the OpenAI API calls
- `openai-agents:realtime` — for the Realtime Agents components
