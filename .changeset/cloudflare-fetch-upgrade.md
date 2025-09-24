---
'@openai/agents-realtime': patch
'@openai/agents-extensions': patch
---

feat: add factory-based Cloudflare support.

- Realtime (WebSocket): add `createWebSocket` and `skipOpenEventListeners` options to enable
  custom socket creation and connection state control for specialized runtimes.
- Extensions: add `CloudflareRealtimeTransportLayer`, which performs a `fetch()`-based WebSocket
  upgrade on Cloudflare/workerd and integrates via the WebSocket factory.
