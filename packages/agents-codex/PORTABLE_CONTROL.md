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
      sessionSettings: { output_modalities: ['text'] },
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

## Input, interruption, and usage

`sessionSettings` has been forwarding provider-format session fields through the configuration acceptance check. The named `model`, `instructions`, and `tools` options have been controlling their corresponding fields.

The following helper has been submitting an image/text message and an audio segment before requesting a response:

```ts
import type { PortableVoiceSession } from '@openai/agents/voice/portable';

export function submitInputs(
  session: PortableVoiceSession,
  imageDataUrl: string,
  audio: ArrayBuffer,
): void {
  session.sendMessage(
    [
      { type: 'input_text', text: 'Describe this image and audio.' },
      { type: 'input_image', image_url: imageDataUrl },
    ],
    { triggerResponse: false },
  );
  session.sendAudio(audio, { commit: true });
  session.requestResponse();
}
```

Message/text input bounds: 8 MiB of native UTF-8 command JSON and the existing 8 MiB host queue/256-frame budget, including escaping, image extension fields and pending frames. Optional response creation: conservative frame reservation, even when Rust later coalesces it. Input capture has been evaluating getters/`toJSON()` once; capacity rejection has been raising synchronous `RangeError` before encoding or native mutation, with the session still usable for smaller inputs or retry after pending sends settle. Unsupported lone-surrogate Unicode: nonfatal `TypeError` before native dispatch.

Audio input has been following the format in the accepted provider configuration. `commitAudio()` and `clearAudio()` have been controlling buffered input independently; committing audio has not been starting a response automatically.

`sendAudio()` idle-queue segment limits: 3,145,692 raw bytes, or 3,145,665 with `commit: true`. Pending frames: smaller available capacity within the existing 8 MiB host queue and 256-frame limit. Capacity checks before encoding against both the native command limit and all resulting append/commit frames; synchronous `RangeError` on rejection, with the session still usable. Larger inputs: application-owned smaller segments, followed by `commitAudio()`, or retry after earlier sends settle.

`interrupt()` has been cancelling the active provider response while keeping the session available for more input. Previously admitted tool callbacks from completed responses have been retaining their authority to finish. Local audio playback and playback-position truncation have been remaining application responsibilities.

The `usage` getter has been accumulating reported counters from terminal provider responses, including cancelled responses, and retaining them after close. Missing counters have been remaining unknown. Vendor-specific fields have been remaining available in the original `onEvent` payload. Each getter call has been returning a separate snapshot.

## Current limits

Pending capabilities: native Agent projection, full schema validation, guardrails, handoffs, profile changes, history replacement, settings updates, and deletion. The prototype has been retaining at most 256 function IDs. Recent-terminal replay defense: 256 finished response identities, plus unfinished callback batches. Older terminal identities: eviction without stopping a healthy session; no arbitrary historical-ID deduplication guarantee. Valid cancelled, failed, and incomplete response receipts have been keeping the session available. Protocol failures have been closing the generation.

Closing aborts callbacks and waits for their promises to settle. Callbacks must observe cancellation. A callback must not await closing its own session.

The WebRTC adapter has focused media and factory tests; real peer negotiation remains unverified. React Native media factories avoid global shims, but a supported on-device Rust binding is still required when the runtime cannot execute WebAssembly. These media hooks do not establish mobile agent execution support.
