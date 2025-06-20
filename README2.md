I’ve wired in a “platform‐API” injection layer so you can now plug in your own
WebSocket and WebRTC (or any other) bindings—for React Native or any custom
environment—without hard‐coding it into the core. Here’s what got done:

---

### 1. New injection API (platform.ts)

    * **`setPlatformAPIs(...)` / `getPlatformAPIs()`**
      Allows you to override WebSocket, RTCPeerConnection, mediaDevices, registerGlobals, etc., before creating any sessions or transport layers.
      [packages/agents-realtime/src/platform.ts](/Users/loicchollier/openai-agents-js/packages/agents-realtime/src/platform.ts)

### 2. Shims now respect overrides & support RN

    * **`shims-node.ts`**, **`shims-browser.ts`**, **`shims-react-native.ts`**
      Each shim reads `getPlatformAPIs().WebSocket` first, falling back to `ws`, `globalThis.WebSocket`, or React Native’s `require('react-native').WebSocket` respectively.

      Also expose `isBrowserEnvironment()` and `isReactNative()`.
      [packages/agents-realtime/src/shims/shims-node.ts](/Users/loicchollier/openai-agents-js/packages/agents-realtime/src/shims/shims-node.ts)[packages/agents-realtime/src/

shims/shims-node.ts](/Users/loicchollier/openai-agents-js/packages/agents-realtime/src/shims/shims-node.ts)

packages/agents-realtime/src/shims/shims-browser.ts
(/Users/loicchollier/openai-agents-js/packages/agents-realtime/src/shims/shims-browser.ts)packages/agents-realtime/src/shims/shims-browser.ts
(/Users/loicchollier/openai-agents-js/packages/agents-realtime/src/shims/shims-browser.ts)

packages/agents-realtime/src/shims/shims-react-native.ts
(/Users/loicchollier/openai-agents-js/packages/agents-realtime/src/shims/shims-react-native.ts)packages/agents-realtime/src/shims/shims-react-native.ts
(/Users/loicchollier/openai-agents-js/packages/agents-realtime/src/shims/shims-react-native.ts)

### 3. WebRTC transport uses injected bindings

    * **`openaiRealtimeWebRtc.ts`**
      Inside `connect()`, grab `RTCPeerConnection`, `mediaDevices`, and `registerGlobals` from `getPlatformAPIs()`, call `registerGlobals()` if present, and instantiate with

the injected constructor. Falls back to the native `RTCPeerConnection` /
`navigator.mediaDevices` in browsers.
[packages/agents-realtime/src/openaiRealtimeWebRtc.ts](/Users/loicchollier/openai-agents-js/packages/agents-realtime/src/openaiRealtimeWebRtc.ts)
[packages/agents-realt
ime/src/openaiRealtimeWebRtc.ts](/Users/loicchollier/openai-agents-js/packages/agents-realtime/src/openaiRealtimeWebRtc.ts)

### 4. Public API export

    * **`index.ts`**
      Re‑exported `setPlatformAPIs` and `PlatformAPIs` so consumers can call it directly.
      [packages/agents-realtime/src/index.ts](/Users/loicchollier/openai-agents-js/packages/agents-realtime/src/index.ts)

### 5. Package exports updated for React Native

    * **`package.json`**
      Added a `react-native` conditional export at both the root (“.”) and the `_shims` entry so Metro/Metro‑like bundlers pick up the RN shim.
      [packages/agents-realtime/package.json](/Users/loicchollier/openai-agents-js/packages/agents-realtime/package.json)[packages/agents-realtime/package.json](/Users/loicc

hollier/openai-agents-js/packages/agents-realtime/package.json)

### 6. Docs updated with RN/example snippet

    * **`transport.mdx`**
      Added a “React Native / Custom Environment Bindings” section showing how to call `registerGlobals()` and `setPlatformAPIs()` before creating a session.
      [docs/src/content/docs/guides/voice-agents/transport.mdx](/Users/loicchollier/openai-agents-js/docs/src/content/docs/guides/voice-agents/transport.mdx)

---

#### Usage Example (React Native)

    import { setPlatformAPIs } from '@openai/agents-realtime';
    import { WebSocket } from 'react-native';
    import {
      RTCPeerConnection,
      RTCSessionDescription,
      RTCIceCandidate,
      mediaDevices,
      registerGlobals,
    } from 'react-native-webrtc';

    // 1) Must call once at startup:
    registerGlobals();

    // 2) Inject RN bindings:
    setPlatformAPIs({
      WebSocket,
      RTCPeerConnection,
      RTCSessionDescription,
      RTCIceCandidate,
      mediaDevices,
      registerGlobals,
    });

    // 3) Now create your session as usual:
    import { RealtimeSession, RealtimeAgent } from '@openai/agents-realtime';
    const agent = new RealtimeAgent({ /* ... */ });
    const session = new RealtimeSession(agent);
    await session.connect({ apiKey: '…' });

This lets you keep a single package and simply inject whatever platform
implementations you need. Let me know if you’d like any tweaks!
