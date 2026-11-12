# Direct Realtime sessions in JavaScript

Use a portable Realtime session to run agent instructions, tools, approvals, handoffs, and guardrails in a browser, React Native app, Worker, or Node.js process. The Rust controller tracks responses and tool calls. Your application supplies credentials, callbacks, and audio input and output. For Realtime attached to a Node.js `Session`, see the [native voice guide](../../examples/codex/guides/native-voice.md).

## Load a matching controller

Portable Realtime requires the current [source build](../../examples/codex/guides/building.md). Use the controller artifact from the same build as the JavaScript package. From a checkout with workspace dependencies installed, run `pnpm -F @openai/agents-codex native:portable` to build the Wasm and Hermes controllers. To use local Git repositories containing the pinned revisions, pass `--source /path/to/codex` and `--rmcp-source /path/to/rust-sdk`.

For browsers, Workers, and Node.js, load `@openai/agents/voice/control.wasm` through the host's asset loader. Pass its compiled `WebAssembly.Module` to `new NativeVoiceControl(module)`. A browser bundler can expose the asset URL for `WebAssembly.compileStreaming(fetch(assetUrl))`. A Worker bundler can import the asset as a compiled module. Create a new controller for each connection.

## Connect a browser

Have your authenticated application server issue a short-lived Realtime client credential. Call this function from the browser's start-call action so it can request microphone access and play remote audio.

```ts
import { connectPortableVoiceBrowser } from '@openai/agents/voice/browser';
import { NativeVoiceControl } from '@openai/agents/voice/portable';

export async function connectBrowser(
  module: WebAssembly.Module,
  clientSecret: string,
) {
  const { session } = await connectPortableVoiceBrowser({
    control: new NativeVoiceControl(module),
    apiKey: clientSecret,
    agent: {
      model: 'gpt-realtime-1.5',
      instructions: 'Answer spoken questions briefly.',
    },
    media: {},
  });
  return session;
}
```

The SDK acquires microphone audio and plays the remote stream. Pass `media.audioElement` to choose the output element or `media.onRemoteStream` to handle playback yourself. The SDK stops tracks it acquires on close. If you supply `media.mediaStream`, stop its tracks in your application. Keep standard API keys on the server.

## Connect React Native

Import `createHermesVoiceControl` for an on-device controller that runs without a global WebAssembly implementation. Supply the peer connection and microphone stream from your app's `react-native-webrtc` installation. Your app owns microphone permission, audio routing, and stream cleanup.

```ts
import { createHermesVoiceControl } from '@openai/agents/voice/control.hermes';
import {
  connectPortableVoiceReactNative,
  type NativeVoiceMediaStream,
  type NativeVoiceWebRTCOptions,
} from '@openai/agents/voice/react-native';

export async function connectMobile<Stream extends NativeVoiceMediaStream>(
  clientSecret: string,
  media: NativeVoiceWebRTCOptions<Stream>,
) {
  const { session } = await connectPortableVoiceReactNative({
    control: createHermesVoiceControl(),
    apiKey: clientSecret,
    agent: {
      model: 'gpt-realtime-1.5',
      instructions: 'Answer spoken questions briefly.',
    },
    media,
  });
  return session;
}
```

Pass the acquired stream as `mediaStream`, construct the native peer in `createPeerConnection`, and handle the received stream through `onRemoteStream`. The SDK closes the peer when the session closes. Stop your microphone tracks even if connecting throws. The [React Native media example](../../examples/codex/react-native-voice.ts) shows a peer factory and stream ownership.

For text-only WebRTC, set `media: { enableAudio: false, createPeerConnection }` and `agent.settings: { output_modalities: ['text'] }`. The connector uses the data channel for text, with no local or remote audio.

## Connect a Worker

Pass a compiled controller module and a Worker secret. The Worker opens the provider WebSocket and executes the tool callbacks. Connect your own audio source and playback sink to the Worker.

```ts
import { NativeVoiceControl } from '@openai/agents/voice/portable';
import { connectPortableVoiceWorker } from '@openai/agents/voice/workerd';

export async function connectWorker(
  module: WebAssembly.Module,
  apiKey: string,
  onApproval: (name: string) => Promise<boolean>,
) {
  return connectPortableVoiceWorker({
    control: new NativeVoiceControl(module),
    apiKey,
    agent: {
      model: 'gpt-realtime-1.5',
      instructions: 'Answer briefly.',
      tools: [
        {
          name: 'current_label',
          description: 'Read the current application label.',
          parameters: { type: 'object', additionalProperties: false },
          needsApproval: true,
          execute: () => 'Example label',
        },
      ],
      onApproval: ({ name }) => onApproval(name),
    },
  });
}
```

Use `sendAudio(base64Audio)` to append audio in the configured input format. Use `commitAudio()` for manual input boundaries. Subscribe to `provider_event` to receive the provider's output audio events. In Node.js, import `connectPortableVoiceWebSocket` from `@openai/agents/voice/portable` and pass a socket factory that uses the URL and headers supplied by the connector.

## Run and close a session

The connectors resolve after configuration is accepted. Use `sendText()` to send a text prompt, `updateAgent()` to change the active agent, and `session.on(type, listener)` to observe events. Call the returned function to remove the listener. Read `session.history` for the observed provider items. Pass `storeAudio: true` in the initial agent options if you need bounded audio retention.

`session.usage` retains the reported speech-model counts after close. Tool callbacks receive those counts in their context. Providers can omit individual usage counters.

A tool callback receives validated arguments, an `AbortSignal`, and context for its exact call. Return text or another JSON value. The connector sends non-string values as JSON text. Return `backgroundResult(value)` to publish a result without requesting a model follow-up. Import it from the same entry point as the connector.

Tools with `needsApproval: true` require an affirmative decision from `onApproval`. An absent handler denies approval. A tool's `before` callback can deny execution and use the denial reason as tool output. Its `after` callback can replace output or return the same value to preserve a prior `backgroundResult` decision. Use `errorFunction` to format argument and execution failures for the model. Setting it to `null` disables that recovery and lets the failure close the connection.

Await `session.close()` in your end-call action or a `finally` block. Close releases owned media or the socket and aborts pending callbacks. Cooperate with each callback's cancellation signal. Invoke close from the outer application rather than from a callback that close has to join.

Use `await session.sendEvent(event)` to send supported provider events through the same controller. `conversation.item.retrieve` returns the provider item. Other supported sends return `null`. Raw `session.update` applies supplied settings after provider acknowledgement. Use `updateAgent()` for model and tool catalog changes. Set `automaticallyTriggerResponseForMcpToolCalls: false` in the initial agent options to disable automatic hosted MCP follow-ups.

## Input and cancellation limits

Keep each native command and wire frame within 8 MiB of UTF-8. Escaping, Unicode, extension fields, and generated response metadata count toward that limit. `sendAudio()` accepts up to 256 KiB of base64 text per call. Outstanding sends share a budget of 8 MiB of UTF-16 and 256 frames.

If a send exceeds capacity, it throws `RangeError` before changing the session's input. Retry after outstanding sends finish. The SDK serializes caller values once and rejects invalid Unicode before submitting input.

`cancel()` targets the default response the SDK has received when you call it, including events still waiting for a send receipt. It suppresses pending tool work for that response. The SDK sends a provider cancellation for an active response and preserves any explicit response or guardrail target. You can observe correlated nonfatal cancellation errors through `provider_event` while the session stays open.

The SDK tracks up to 256 retired and 256 completed response IDs, including an active cancellation target. Deduplication applies to IDs in those windows.
