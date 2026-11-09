# Native voice

This guide describes the current source branch. Build the SDK and native runtime from the same checkout, or use examples from the exact release you installed. These examples make live API requests.

## Prepare the SDK

Follow [Build the native SDK from source](building.md) before running current-branch examples. That guide lists the Node.js runtime, native build tools, and commands to build the matching workspace packages. Run the commands below from that checkout, with `OPENAI_API_KEY` set. The recording examples do not open a microphone or speaker.

## Start with a recording

Set `OPENAI_API_KEY`, then run from the repository root:

```sh
pnpm exec tsx examples/codex/native-realtime-voice.ts 'Explain a rainbow briefly' 30 > answer.pcm
```

The example opens `Session.realtime()`, sends one text prompt, and records mono PCM16 audio at 24 kHz. The recording lasts at most 30 seconds, including any delegated work. This deadline can cut off a long answer. It is an application recording limit, not a signal that the model finished. Disconnects and failures also end the recording.

The native Session owns Realtime control, tools, history, and cancellation. Closing its Realtime owner joins that owner's delegated work and releases media. It leaves the caller's Session available for text turns. Closing the Session also closes its Realtime owner. Use `await using`, or await `close()` in `finally`. A failed cleanup remains retryable; do not discard the owner after a failed close.

If opening voice fails and its cleanup also fails, the next `session.realtime(...)` call retries the previous owner's cleanup first. A failed retry preserves that owner for another attempt; a successful retry allows the new voice connection. An already open or still opening voice connection continues to reject another owner.

## Choose the audio path

| Path | API and ownership |
| --- | --- |
| Server WebSocket | Omit `transport`. Use `sendText()`, `sendAudio()`, and `events()` on the returned native owner. The application owns recording and playback. |
| Browser WebRTC | The server passes `transport: {type: 'webrtc', offerSdp}` to `Session.realtime()`. Return `answerSdp` only after that call resolves. Keep the Session and its native sideband control open for the call. |
| SIP | Pass `transport: {type: 'sip', callId}` for an already accepted provider call. Closing this owner detaches its sideband; your application still owns hanging up the existing call. |
| Twilio Media Streams | Use the [Twilio bridge](realtime-twilio.md). The application authenticates the incoming socket; the bridge owns media delivery and playback marks. |
| Application transport or model | Set `adapter` to a `NativeRealtimeAdapter`. Do not combine it with a built-in call transport. |

`await voice.sendAudio(samples, { commit: true })` appends every bounded frame, then commits the input buffer once. For manual turn detection, first call `await voice.update({ turnDetection: null })`. Omitting `commit` or passing `false` only appends audio. Pass a valid empty audio buffer with `commit: true` to commit previously appended chunks without adding another frame. A commit does not request a model response. Call `await voice.requestResponse()` when the input is ready. Input calls are queued in invocation order. A committed audio call flushes its frames and commit before the next queued input; append-only calls retain their existing native admission behavior. Keep audio buffers unchanged until `sendAudio()` resolves, because encoding reads them one frame at a time.

Text and image URLs share a 1 MiB UTF-8 limit per message, with at most 1,024 content parts. Across active and waiting input calls, each voice owner allows 128 operations and 8 MiB of input payload. Audio counts its full backing buffer, including bytes outside a supplied view. Excess input rejects with `RangeError` before it joins the queue. Await input calls and copy larger audio inputs into smaller, separately allocated buffers; capacity becomes available as calls settle.

`sendMessage` accepts user text or an ordered user message containing `input_text` and inline `input_image` parts. `addImage` appends one inline image reference. Both request a response by default; use `{ triggerResponse: false }` to collect inputs first, then call `requestResponse()`. Images support `detail: 'auto' | 'low' | 'high'`. File IDs, local media, arbitrary provider fields, and assistant/tool messages are unsupported.

Save this as `manual-input.ts`, then run `pnpm exec tsx manual-input.ts` from the checkout with `OPENAI_API_KEY` set.

```ts
import { Agent, NativeProvider } from '@openai/agents';

await using provider = new NativeProvider();
await using session = await new Agent({
  instructions: 'Describe images.',
  provider,
}).session();
await using voice = await session.realtime();
await voice.update({ outputModality: 'text', toolChoice: 'none' });
await voice.sendMessage(
  {
    type: 'message',
    role: 'user',
    content: [
      { type: 'input_text', text: 'Describe this image.' },
      {
        type: 'input_image',
        image:
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6R8AAAAASUVORK5CYII=',
        detail: 'low',
      },
    ],
  },
  { triggerResponse: false },
);
await voice.requestResponse();
let userItemId: string | undefined;
for await (const event of voice.events()) {
  if (
    event.type === 'conversation_item' &&
    event.role === 'user' &&
    event.status === 'done'
  )
    userItemId = event.itemId;
  if (event.type === 'text' && event.final) console.log(event.text);
  if (event.type === 'response' && event.status === 'done') break;
}
if (userItemId) await voice.deleteConversationItem(userItemId);
```

`conversation_item` events report provider item IDs and their `added`/`done` status. Pass one of those IDs to `await voice.deleteConversationItem(providerItemId)`. Core checks dependencies and waits for the exact provider acknowledgement and durable audit append before the call completes. A `conversation_item_deleted` event reports that receipt. Deletion removes the item from the provider conversation; canonical history retains prior entries and adds a `provider_item_deleted` marker with its target in `providerItemId`. Canonical history IDs are separate from provider item IDs.

Shared Session history, tool outcomes, and approval records remain intact. Deletion cannot retract output already generated or change context a response already consumed. A later voice connection can use retained Session context. This operation prunes the current provider conversation rather than erasing Session history.

Use `await voice.retrieveConversationItem(providerItemId)` to retrieve a known provider item with its available media, including an item from before SIP attachment. Retrieving an ID absent from the observed history does not add it to that history's order. `await voice.retrieveConversationHistory()` retrieves available media for IDs observed during this connection, in observed order, and can return large payloads. It cannot discover items from before SIP attachment. These explicit requests are separate from the synchronous `voice.history` audit view.

`await voice.updateHistory(items)` reconciles the observed portion of the provider conversation with an array of provider items. It cannot erase unobserved items, including SIP items from before attachment. Core validates the requested replacement before sending changes and waits for provider acknowledgements. Pass provider item IDs and provider content shapes, including audio or image content where supported. Only supported system, user, and assistant message rows are editable. Retain tool, MCP, and approval rows with their exact content and order; messages cannot move across these rows. As with deletion, canonical audit history, background work, and retained context for subsequent Session turns remain intact. An interrupted edit or a provider failure after some acknowledgements can leave partial provider edits. If the connection remains active, retrieve the observed history before retrying.

Created or changed messages use the provider's role-specific content types: `input_text` for system messages; `input_text`, `input_audio`, or `input_image` for user messages; and `output_text` for assistant messages. Existing assistant audio can be retained but cannot be created through this API. Keep existing provider item IDs and give new messages unique IDs.

Edits preserve known provider predecessors. An edit that needs an unknown insertion position fails before sending changes. Adding items to an empty observed history appends them to the provider conversation.

Each history operation has an 8 MiB budget for estimated retained JSON storage, including string and container overhead. An update counts its requested replacement and retrieved provider items together. Exceeding this budget rejects the operation before writes and leaves the call active.

History validation errors and interruptions caused by concurrent input or responses leave the call active. Provider errors, transport failures, and acknowledgement timeouts close the voice owner; the closed owner cannot retrieve history.

Native execution runs on the server. Browser code can import `NativeVoiceWebRTC` from `@openai/agents/voice/browser`. Its `connect({exchangeSdp})` callback sends the offer to your authenticated server and returns the server's answer. The helper owns browser media only; its data-channel observations cannot execute native tools or approve work. Keep server credentials out of the browser. Close the server owner when the application call ends; closing browser media alone does not replace server cleanup.

SIP calls must be accepted and configured before attachment. On your server, call `await session.buildRealtimeSipConfig({ model, voice, instructions })` to build the call-accept request body from the same native configuration pipeline as `session.realtime()`. The builder includes the captured Agent instructions, tools, and handoffs, and prepares Session-owned MCP tools when `tools` is omitted. It does not accept the call, open voice media, or resolve voice credentials. Send its result to your call-accept endpoint, then attach the same Session with `await session.realtime({ transport: { type: 'sip', callId } })`. Regenerate the body if you change the Session or its configuration before accepting the call. The builder preserves supported SIP VAD tuning, including `threshold`, `prefixPaddingMs`, and `silenceDurationMs`.

Configure hosted MCP follow-ups by passing `automaticallyTriggerResponseForMcpToolCalls` when attaching with `session.realtime()`. The HTTP accept body cannot carry this SDK option, so `buildRealtimeSipConfig()` does not accept it.

Do not pass initial `model`, `voice`, or `instructions` overrides with the SIP transport. Nonempty client audio is rejected; an empty audio buffer with `{ commit: true }` can control audio already buffered by the provider. Closing an SDK-created WebRTC owner also hangs up its created call.

WebRTC SDP offers are limited to 1 MiB of UTF-8 text. Oversized offers are rejected before credentials are resolved or a connection is opened.

### Keep server control open

This recipe runs on the Node.js application server. `publishAnswer` sends the SDP answer through your authenticated endpoint. `serveCall` consumes `voice.events()`, routes application decisions, and returns when the call ends. The server function stays running after it sends the answer.

```ts
import { Agent, NativeProvider } from '@openai/agents';
import type { NativeRealtimeSession } from '@openai/agents';

export async function serveWebRtc(
  offerSdp: string,
  publishAnswer: (answer: string) => Promise<void>,
  serveCall: (voice: NativeRealtimeSession) => Promise<void>,
) {
  await using provider = new NativeProvider();
  const agent = new Agent({
    provider,
    instructions: 'Answer spoken questions briefly.',
  });
  await using session = await agent.session();
  await using voice = await session.realtime({
    transport: { type: 'webrtc', offerSdp },
  });
  if (!voice.answerSdp) throw new Error('WebRTC startup returned no answer.');
  await publishAnswer(voice.answerSdp);
  await serveCall(voice);
}
```

Browser code creates its media helper with an audio element. Call `connect()` from the application's start-call action, and close both browser media and server control when the call ends:

```ts
import { NativeVoiceWebRTC } from '@openai/agents/voice/browser';
import type { VoiceSdpExchange } from '@openai/agents/voice/browser';

export async function startBrowserCall(
  audioElement: HTMLAudioElement,
  exchangeSdp: VoiceSdpExchange,
) {
  const media = new NativeVoiceWebRTC({ audioElement });
  await media.connect({ exchangeSdp });
  return media; // The application calls media.close() and ends server control.
}
```

For an already accepted SIP call, use the same server lifetime and event consumer with `transport: { type: 'sip', callId }`. Context disposal detaches native control; the application that owns the provider call handles hangup.

`@openai/agents/voice/workerd` supplies a socket relay helper for an application server. It does not load or run the native runtime in the Worker. The retained `@openai/agents/realtime` entrypoint continues to expose the Classic runtime.

## Credentials and custom adapters

`Session.realtime({apiKey})` accepts a string or a synchronous or asynchronous callback. The callback receives an optional `AbortSignal` and resolves once per connection. Omit it to use the Session provider's credentials. This override does not change credentials for the Session's text turns. Honor cancellation during credential lookup and release any resources your callback opens.

Import `NativeRealtimeAdapter`, `NativeRealtimeAdapterContext`, and `NativeRealtimeConnection` as types from `@openai/agents`. An adapter implements `connect(context)`. The context contains the native-selected URL, private headers, model, and setup signal. Your adapter can choose another endpoint or translate another model's protocol to canonical Realtime V2 frames.

Return a connection with `incoming: AsyncIterable<string>`, `send(frame: string): Promise<void>`, and `close(): Promise<void>`. Incoming and outgoing I/O must work independently. Honor the setup signal and clean partial resources before rejecting. `close()` must release resources and wake pending sends and incoming iteration. Cleanup must support retries. Do not await the owning Session's close from an adapter callback; the application controls that outer lifetime. Never log connection headers or credential values.

Run the complete [custom adapter example](../native-realtime-adapter.ts):

```sh
pnpm exec tsx examples/codex/native-realtime-adapter.ts 'Explain a rainbow briefly' > adapter-answer.pcm
```

It implements the factory, incoming iterator, send, and cleanup methods with the workspace's existing `ws` dependency. It preserves one WebSocket message per iterator value and forwards canonical frames unchanged to the native-selected endpoint. Output is a fixed window of mono PCM16 at 24 kHz without a file header. It does not translate another model's protocol.

Call `update()`, `approveHostedMcp()`, `deleteConversationItem()`, and `sendAudio(..., { commit: true })` from application code outside this owner's adapter callbacks. They need the same ordered transport and reject calls from its active callbacks. An adapter callback can submit nested text when no committed audio call is pending. Once a committed audio call is waiting or running, callbacks also reject nested input behind it. This includes a commit waiting to start in the input queue.

The native runtime still checks configuration acknowledgements, tool authority, response ordering, and history. A translating adapter must implement the applicable [Realtime client events](https://developers.openai.com/api/reference/resources/realtime/client-events) and [server events](https://developers.openai.com/api/reference/resources/realtime/server-events), including configuration acknowledgements and actual response/item IDs. Replacing I/O does not bypass these checks.

## Settings, tools, and live Agents

Use `settings` for typed audio formats, transcription, VAD, voice, speed, prompt references, and provider tracing. `update()` accepts sparse settings: omitted fields keep their values. A declared codec does not convert your audio. PCM16 uses mono 24 kHz samples; G.711 uses mono 8 kHz bytes. Use the event's format and identity when playing audio.

`settings.toolChoice` accepts `'auto'`, `'none'`, `'required'`, or `{ type: 'function', name: 'lookup' }`. A named choice must already be advertised by the captured active source; it adds no permission and retains native tool policies and approvals. Omission preserves the current choice. Before a handoff or update removes that function, call `await voice.update({ toolChoice: 'auto' })`; incompatible replacements fail before publication.

Omit Realtime `tools` to inherit the captured active Agent's function tools and handoffs. An explicit list must contain the original admitted function objects. It also limits tools used by `background_agent`; `[]` excludes the Agent's tools and handoffs from direct calls and delegated backend turns. The reserved `background_agent` and `remain_silent` controls remain available; delegation still obeys the empty backend tool selection. The list is captured when Realtime opens, so later Session default updates cannot widen it. After an application tool update is acknowledged on the same Agent, graph voice selections based on that Agent's original function declarations resolve to the current replacement bindings. Mono Sessions also retain function declarations admitted by earlier successful tool updates. Switching to another Agent without that original identity makes delegation fail; its same-name tool cannot replace the missing capability. Ordinary graph `Session.submit()` still requires current function objects. Native tool policies and application approvals still apply. `background_agent` delegates work to the same native Session. It returns only accepted final text, including any output validation or repair. A non-string final output fails instead of being serialized for speech.

Declare reachable `Agent.handoffs` before opening the Session. The graph keeps original Agent identities. `await session.getActiveAgent()` reads the native active Agent, and idle `Session.update({agent})` activates a captured Agent. Activation applies that Agent's declaration defaults. An idle tool update changes the active defaults; an explicit per-operation tool selection remains a ceiling across later handoffs. Compatible output formats and shared Session runtime grants are required across the graph. Restore binds fresh caller-supplied Agent and tool objects, not saved callback implementations.

A function can return `backgroundResult(value)` to publish its accepted result without requesting a model follow-up. Output policies can replace that decision. Hosted MCP tools are configured separately in `settings.hostedMcpTools`, with a URL or connector ID. Handle `hosted_mcp_approval_requested` by passing that exact issued event to `approveHostedMcp(event, {approve, reason})`. Clones and cross-session requests are invalid. Issued approval requests are not auto-approved. `automaticallyTriggerResponseForMcpToolCalls` defaults to true and controls hosted MCP follow-ups.

Incoming native Realtime events share an 8 MiB queue budget for wire text and estimated storage for decoded and derived values. Oversized frames, dense JSON structures, deeply nested values, or a full queue terminate the voice connection. Consume events promptly to release queue capacity.

SDK output events share a 2 MiB queue budget with conservative string-storage estimates.

Canonical transcript history has a separate 8 MiB estimated storage limit. History and guardrail transcripts also have cumulative work limits; exceeding a limit terminates the voice connection. History accounting lasts for the voice owner's lifetime, even when you consume events promptly.

Hosted MCP catalogs are limited to 1,024 tools. Catalog events share a 2 MiB queue budget, including estimated storage for schema structures and strings. Oversized catalogs, deeply nested schemas, or a full queue terminate the voice connection. Keep server tool lists and schemas small, and consume events promptly to release queue capacity.

Realtime speech itself streams before completion. Optional `outputGuardrails` check text and can interrupt the exact response, but some audio may already have played. Report actual playback with `reportPlayback()`. On `playback_interrupted`, discard queued audio for `retiredResponseIds`. This differs from the accepted-final-text rule for native backend delegation.

Report playback progress while audio plays. When playback bookkeeping reaches its limit, it can release older completed content that has finished playing or was interrupted. Playback reports for released content are no longer accepted.

## Separate transcription and synthesis

Run [voice.ts](../voice.ts) for a PCM file → native Session → PCM file pipeline. Supply raw mono PCM16 at 24 kHz without a WAV header:

```sh
pnpm exec tsx examples/codex/voice.ts input.pcm spoken-answer.pcm
```

`VoicePipeline` takes one workflow and one speech provider. `NativeSessionVoiceWorkflow` waits for accepted final string output before synthesis, retaining the caller's history and approval policy. Its optional second constructor argument captures an operation tool selection: `new NativeSessionVoiceWorkflow(session, [lookup])` allows only that original admitted tool, and `new NativeSessionVoiceWorkflow(session, [])` selects no tools. Omit the argument to use Session defaults for each transcription.

The OpenAI speech provider accepts mono 24 kHz PCM16 or normalized float32 input. Streaming input uses explicit `{type: 'commit'}` boundaries; EOF commits remaining audio. It does not add VAD. `transcriptionSettings` applies to static/file transcription only. Configure synthesis, voice IDs, ordered text splitting, output dtype, synchronous transforms, and sample buffering through the provider and pipeline options. Synthesis stays serial, and each synthesis boundary flushes its buffered tail. The caller owns its input source, playback, and Session lifetime.
