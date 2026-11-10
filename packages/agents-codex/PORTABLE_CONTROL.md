# Direct Realtime sessions in JavaScript

Use a portable Realtime session to run agent instructions, tools, approvals, handoffs, and guardrails in a browser, React Native app, Worker, or Node.js process. The Rust controller owns response and tool state. The application supplies credentials, callbacks, and audio I/O. Use the [native voice guide](../../examples/codex/guides/native-voice.md) for voice attached to a file-backed Node.js `Session`.

## Load a matching controller

Use the controller artifact from the same SDK version as the JavaScript package. For a source checkout, install workspace dependencies and run `pnpm -F @openai/agents-codex native:portable`. The build verifies the pinned Rust patch series and writes the Wasm and Hermes artifacts and build receipt into both SDK packages. To use local Git repositories containing the pinned revisions, pass `--source /path/to/codex` and `--rmcp-source /path/to/rust-sdk`.

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

`session.usage` has been retaining the reported speech-model counts after close. Tool callbacks have been receiving those counts in their tool context. Providers can omit individual usage counters.

A tool callback receives validated arguments, an `AbortSignal`, and context for its exact call. Return text from the callback. Tools with `needsApproval: true` require an affirmative decision from `onApproval`. An absent handler denies approval.

Await `session.close()` in your end-call action or a `finally` block. Close releases owned media or the socket and aborts pending callbacks. Cooperate with each callback's cancellation signal. Invoke close from the outer application rather than from a callback that close has to join.

## Input and cancellation limits

Input admission has been enforcing an 8 MiB UTF-8 limit for native commands and wire frames, plus a shared 8 MiB UTF-16 budget and 256-frame limit for outstanding transport sends. `sendAudio()` has been accepting base64 chunks up to 256 KiB. Text escaping, Unicode, image extension fields, and generated response metadata have been contributing to these limits.

Capacity rejection has been throwing `RangeError` before native input mutation. The session has been remaining usable for a retry after outstanding sends finish. JSON capture has been making one serialization pass over caller values and rejecting invalid Unicode before native input.

`cancel()` has been binding cancellation to the default response already received at the call boundary, including events still waiting for a send receipt. Cancellation has also been suppressing received default tool work awaiting terminal admission, without sending an unnecessary provider cancellation for an already completed response. The provider cancellation frame has been retaining its explicit response or guardrail target. Correlated nonfatal cancellation errors have been remaining observable provider events without closing the session.

Replay fences have been retaining up to 256 recent retired response IDs and 256 recent completed response IDs, including a protected active cancellation target. Response processing has been continuing after eviction. No historical-ID deduplication guarantee outside those windows.
