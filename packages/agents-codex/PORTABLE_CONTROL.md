# Portable Realtime control prototype

This source checkout includes a Rust control prototype for browsers and Workers. The Rust module admits function calls, requests approval, tracks output publication, and schedules a response after tool results. The JavaScript driver supplies physical I/O and invokes callbacks selected by Rust.

The prototype has its own `PortableVoiceSession` interface. It does not yet project native `Agent` and `Session` configuration. Existing `Session.realtime()` and media helpers remain available.

## Build the module

From the repository root, install the Rust target and build the reviewed module:

```sh
rustup target add wasm32-unknown-unknown --toolchain 1.95.0
RUSTUP_TOOLCHAIN=1.95.0 pnpm -F @openai/agents-codex native:portable
```

You can pass `--source /path/to/codex-git-repository` and `--rmcp-source /path/to/rust-sdk-git-repository` to use local repositories containing the pinned revisions. The build verifies the full patch series before compilation. It writes `native/codex-realtime-control.wasm` and `native/portable-build-receipt.json` into both SDK packages. The receipt records the source identities, compiler version, and artifact hash.

Load `@openai/agents/voice/control.wasm` with your host's WebAssembly loader. The loader must produce a `WebAssembly.Module`. For example, a Worker bundler can import the `.wasm` asset as a compiled module. Browser bundlers can expose the asset URL for `WebAssembly.compileStreaming(fetch(assetUrl))`.

## Connect a Worker

This function runs inside a Worker. Its caller supplies the compiled module and a server-side provider API key. It returns the connected session; the caller must eventually await `session.close()`.

```ts
import { NativeVoiceControl } from '@openai/agents/voice/portable';
import { connectPortableVoiceWorker } from '@openai/agents/voice/workerd';

export async function connectVoice(module: WebAssembly.Module, apiKey: string) {
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
          parameters: { type: 'object' },
          needsApproval: true,
          execute: () => 'Example label',
        },
      ],
      onApproval: async () => false,
    },
  });
}
```

`connectPortableVoiceWorker()` opens the provider WebSocket directly. It resolves after the provider accepts configuration and the physical configuration send completes. Configuration acceptance times out after 10 seconds. A tool with `needsApproval: true` runs only after `onApproval` returns `true`; an absent handler denies approval. Tool callbacks receive parsed arguments and an `AbortSignal` and must return text.

For browser WebRTC, use `connectPortableVoiceBrowser()` from `@openai/agents/voice/browser`. Supply a short-lived client credential, a `NativeVoiceControl`, and media options. Keep standard API keys on your server. `createPeerConnection`, `getUserMedia`, and `onRemoteStream` let the application supply media objects without global browser shims.

## Current limits

The prototype supports function tools and text input. It does not yet implement native Agent projection, full schema validation, guardrails, handoffs, profile changes, history replacement, settings updates, interruption, or deletion. It stops accepting calls after 256 retained function IDs. Provider cancellation, an incomplete response, or speech during active work retires the prototype generation. Create a new generation after close or a protocol failure.

Closing aborts callbacks and waits for their promises to settle. Callbacks must observe cancellation. A callback must not await closing its own session.

The WebRTC adapter has focused media and factory tests; real peer negotiation remains unverified. React Native media factories avoid global shims, but a supported on-device Rust binding is still required when the runtime cannot execute WebAssembly. These media hooks do not establish mobile agent execution support.
