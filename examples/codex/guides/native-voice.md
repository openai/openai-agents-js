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

### Close voice resources

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
| Direct browser, React Native, or Worker | Use a [portable Realtime session](../../../packages/agents-codex/PORTABLE_CONTROL.md) to run the controller and tool callbacks on the client or Worker. |

### Send and commit audio

`await voice.sendAudio(samples, { commit: true })` appends every bounded frame, then commits the input buffer once. For manual turn detection, first call `await voice.update({ turnDetection: null })`. Omitting `commit` or passing `false` only appends audio. Pass a valid empty audio buffer with `commit: true` to commit previously appended chunks without adding another frame. A commit does not request a model response. Call `await voice.requestResponse()` when the input is ready.

Input calls are queued in invocation order. A committed audio call flushes its frames and commit before the next queued input; append-only calls retain their existing native admission behavior. Keep audio buffers unchanged until `sendAudio()` resolves, because encoding reads them one frame at a time.

### Keep input within limits

Text and image URLs share a 1 MiB UTF-8 limit per message, with at most 1,024 content parts. Across active and waiting input calls, each voice owner allows 128 operations and 8 MiB of input payload.

Audio counts its full backing buffer, including bytes outside a supplied view. Excess input rejects with `RangeError` before it joins the queue. Await input calls and copy larger audio inputs into smaller, separately allocated buffers; capacity becomes available as calls settle.

### Send text and images

`sendMessage` accepts user text or an ordered user message containing `input_text` and inline `input_image` parts. `addImage` appends one inline image reference. Both request a response by default; use `{ triggerResponse: false }` to collect inputs first, then call `requestResponse()`. Images support `detail: 'auto' | 'low' | 'high'`. File IDs, local media, arbitrary provider fields, and assistant/tool messages are unsupported.

Save this as `manual-input.mts`, then run `pnpm exec tsx manual-input.mts` from the checkout with `OPENAI_API_KEY` set.

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

### Send a provider event

`await voice.sendEvent(event)` sends a captured JSON object through the same native generation, input queue, and provider writer as the typed controls. Use provider field names, such as `output_modalities`, rather than the typed helper's camelCase names. Ordinary sends return `null`; `conversation.item.retrieve` returns the retrieved provider item, including available media. Each captured event counts toward the shared 128-operation and 8 MiB input allocation limits.

Supported events include `response.create`, `response.cancel`, `conversation.item.create`, `conversation.item.retrieve`, `conversation.item.delete`, `conversation.item.truncate`, `session.update`, `input_audio_buffer.append`, `input_audio_buffer.clear`, `input_audio_buffer.commit`, and `output_audio_buffer.clear`. A raw response request can supply alternate `input`, including item references or an explicitly empty array, plus `conversation`, instructions, modality, token cap, `metadata`, `parallel_tool_calls`, `reasoning`, and `event_id`. Use `conversation: 'none'` for a detached response outside the provider conversation. Detached responses default to an empty tool list. For a function declared in the detached request's `response.tools`, `voice.events()` has been reporting each completed call once as `detached_function_call`, with `responseId`, `itemId`, `callId`, `name`, and the JSON string `arguments`. Detached calls have been bypassing native tool execution and linked conversation history. Applications have been returning results through a later detached response's `input`, using a `function_call_output` item with the same `call_id` and a string `output`.

Per-response prompt and audio overrides have been using the provider's `response.prompt` and `response.audio.output` fields. Prompt references have been accepting an `id`, optional `version` and `variables`, or explicit `null`. The following example has been assuming an open `voice` owner and your saved prompt ID:

```ts
await voice.sendEvent({
  type: 'response.create',
  response: {
    prompt: {
      id: 'pmpt_your_prompt_id',
      version: '2',
      variables: { recipient: 'Sam' },
    },
    audio: {
      output: {
        voice: 'marin',
        format: { type: 'audio/pcm', rate: 24000 },
      },
    },
  },
});
```

Output voice overrides have been accepting a voice name or `{ id: 'voice_your_voice_id' }`. Output formats have been accepting 24 kHz `audio/pcm`, `audio/pcmu`, or `audio/pcma`. Received `audio` events have been retaining each response's codec: `pcm16` at 24 kHz, or `g711_ulaw`/`g711_alaw` at 8 kHz. These overrides have been leaving the session defaults unchanged for later responses.

A raw `session.update` accepts sparse provider settings. Truncation requires a known received audio item and a bounded playback offset. `output_audio_buffer.clear` applies to provider-managed playback. Raw cancellation uses the same local audio, guardrail, and delegated-work cleanup as `interrupt()` and emits `playback_interrupted`. Append audio as base64 in the accepted input format and use `response.create` to request a response after committing audio.

Use `session.update.session.tools` to replace the provider tool list, including hosted MCP declarations. Send `[]` to clear the list or omit `tools` to keep it. Reuse the exact advertised declarations for native functions. Hosted MCP calls follow the same approval flow as typed configuration.

Set `response.tools` and `response.tool_choice` to scope tools to one response. Select a hosted server with `{type: 'mcp', server_label: 'docs'}`, adding `name` for a single tool. Create multiple detached responses using `conversation: 'none'`. Their lifecycle events have `outOfBand: true`. Cancel a detached response with `{type: 'response.cancel', response_id: id}`. Use `interrupt()` for the linked response and its playback.

For a linked application function declared in the raw tool list, wait for a `conversation_item` event with `kind: 'function_call'` and `status: 'done'`. Use `retrieveConversationItem(event.itemId)` to read its name, arguments, and `call_id`. After handling a function you own, send a `conversation.item.create` event with a `function_call_output` item, a fresh `id`, the same `call_id`, and the string `output`. Send `response.create` when the response's tool outputs have settled.

For message creation, use the supported role-specific content below. Set `previous_item_id` to a known provider item or `'root'` to position the item, or omit it to append. You can also import a completed historical `function_call` followed by one `function_call_output` with its `call_id`. These rows serve as context. To answer a pending hosted MCP approval, send an `mcp_approval_response` with the provider's issued `approval_request_id` and a Boolean `approve` value.

These sends are controls, not a replacement for consuming `voice.events()`. A raw event does not add a second event reader. Do not await `sendEvent()` from this owner's adapter callbacks: retrieval and item edits can wait on that same transport. After an uncertain provider failure, inspect the observed provider history before retrying a write.

### Observe provider events and local history

Pass `includeRawProviderEvents: true` when opening `session.realtime()`. The `raw_provider_event` event contains decoded provider JSON before its typed projection, including events that have no typed projection. A recoverable request rejection emits `provider_request_error` with the provider code and exact `eventId`. Keep consuming events to observe later responses.

Use `voice.on('event', listener)` or subscribe to a specific event type. Call the returned function to remove the listener. Use `voice.events()` to consume the media stream and any startup events queued before the listener was registered.

Read `voice.providerHistory()` for a local snapshot of observed provider items, including after close. Set `historyStoreAudio: true` when connecting to retain received audio in the bounded snapshot. Use `retrieveConversationHistory()` while connected to read full provider items.

In a native Realtime tool callback, `ToolCallContext.history` contains the conversation as of that exact call. `ToolCallContext.context` holds the original application context.

### Delete a provider conversation item

`conversation_item` events report provider item IDs and their `added`/`done` status. Pass one of those IDs to `await voice.deleteConversationItem(providerItemId)`. For an application-known ID from before attachment, Core retrieves the item and checks its identity against current responses, calls, and approvals. This supports completed external messages, tool items, and approval records. Core waits for the exact provider acknowledgement and durable audit append before the call completes. A `conversation_item_deleted` event reports that receipt.

Deletion removes the item from the provider conversation; canonical history retains prior entries and adds a `provider_item_deleted` marker with its target in `providerItemId`. Canonical history IDs are separate from provider item IDs.

Shared Session history, tool outcomes, and approval records remain intact. Deletion cannot retract output already generated or change context a response already consumed. A later voice connection can use retained Session context. This operation prunes the current provider conversation rather than erasing Session history.

### Retrieve and edit provider history

Use `await voice.retrieveConversationItem(providerItemId)` to retrieve a known provider item with its available media, including an item from before SIP attachment. Retrieval rejects IDs still recorded as deleted. Retrieving an ID absent from the observed history does not add it to that history's order. `await voice.retrieveConversationHistory()` retrieves available media for IDs observed during this connection, in observed order, and can return large payloads. It cannot discover items from before SIP attachment. These explicit requests are separate from the synchronous `voice.history` audit view.

`await voice.updateHistory(items)` reconciles the observed portion of the provider conversation with an array of provider items. It cannot erase unobserved items, including SIP items from before attachment. Core validates the requested replacement before sending changes and waits for provider acknowledgements. Pass provider item IDs and provider content shapes, including audio or image content where supported. Only supported system, user, and assistant message rows are editable. Preserve surviving tool, MCP, and approval rows byte-for-byte and in their relative order. Settled rows can be removed after native dependency checks. Supported message rows can move across surviving tool, MCP, and approval rows. As with deletion, canonical audit history, background work, and retained context for subsequent Session turns remain intact. An interrupted edit or a provider failure after some acknowledgements can leave partial provider edits. If the connection remains active, retrieve the observed history before retrying.

Pass a synchronous updater to compute the replacement from freshly retrieved history.

```ts
await voice.updateHistory((items) =>
  items.filter((item) => item.id !== obsoleteItemId),
);
```

The updater runs once in the input queue. If the observed IDs, order, or item contents change before Core applies the replacement, the call rejects before sending edits. Invoke it from application code outside the voice owner's adapter callbacks.

The connection retains 128 recent deletion receipts. Within this window, you can restore a message removed by an interrupted `updateHistory()` under its original ID. Supply a supported message after refreshing the observed history. IDs deleted directly with `deleteConversationItem()` or by another controller, and tool or control identities, remain protected while their receipts are retained. Recovery preserves the canonical deletion audit. Deletions observed from another controller also remove items from observed provider history. They do not cancel or approve pending native work.

Once the receipt window evicts any deletion, individual item lookup requires a current live provider observation. An arbitrary or unobserved ID, including one from before SIP attachment, then rejects locally. This restriction lasts until a new voice connection. Further pruning and history editing remain available.

Created or changed messages use the provider's role-specific content types: `input_text` for system messages; `input_text`, `input_audio`, or `input_image` for user messages; and `output_text` for assistant messages. For images, pass a PNG or JPEG base64 data URI. New or recreated images must be no larger than 4,096 pixels per side. Validation sets a 64 MiB decoder allocation allowance; decoder overhead can use more memory. Ordinary 3,840×2,160 RGBA8 images fit these decoding limits if their encoded payload fits the input budget. Existing image items can remain unchanged. Validation and recreation share a 64 MiB budget for decoded pixel data across all rows and image parts; repeated checks count again. Exceeding this budget rejects the whole edit before writes. Base64-encode audio bytes in the session's input audio format. Existing assistant audio can be retained but cannot be created through this API. Keep existing provider item IDs and give new messages unique IDs.

Edits preserve known provider predecessors. An edit that needs an unknown insertion position fails before sending changes. If provider events leave the order incomplete, ordered history retrieval and replacement are unavailable. You can still retrieve a known item by ID. Adding items to an empty observed history appends them to the provider conversation.

Each history operation has an 8 MiB budget for estimated retained JSON storage, including string and container overhead. An update counts its requested replacement and retrieved provider items together. Exceeding this budget rejects the operation before writes and leaves the call active. Queued replacements also count toward the connection's input queue limits.

Validation failures and interruptions caused by concurrent input or responses leave the connection active. A timeout or malformed reply while reading history also leaves the connection active. New history requests stay blocked until a valid matching reply for the outstanding request arrives. If it never arrives, history requests remain unavailable for that connection. Provider errors, transport failures, and timeouts waiting for a write acknowledgement close the native voice connection. A closed connection cannot retrieve history.

### Connect browser and SIP calls

For a Node-hosted Session, import `NativeVoiceWebRTC` from `@openai/agents/voice/browser`. Its `connect({exchangeSdp})` callback sends the offer to your authenticated server and returns the server's answer. The helper handles browser media. Tool execution and approvals belong to the server Session. Keep server credentials out of the browser and close the server owner when the call ends. For direct execution in the browser, use the [portable Realtime session](../../../packages/agents-codex/PORTABLE_CONTROL.md).

The [React Native helper](../react-native-voice.ts) has been using the application's `react-native-webrtc` module and releasing its acquired microphone stream on close or failure. Applications have been owning microphone permission, speaker routing, audio-session activation, and server cleanup; the SDK media class has been leaving supplied streams application-owned.

SIP calls must be accepted and configured before attachment. On your server, call `await session.buildRealtimeSipConfig({ model, voice, instructions })` to build the call-accept request body from the same native configuration pipeline as `session.realtime()`. The builder includes the captured Agent instructions, tools, and handoffs, and prepares Session-owned MCP tools when `tools` is omitted. It does not accept the call, open voice media, or resolve voice credentials. Send its result to your call-accept endpoint, then attach the same Session with the same options and a SIP transport. Regenerate the body if you change the Session or its configuration before accepting the call. The builder preserves supported SIP VAD tuning, including `threshold`, `prefixPaddingMs`, and `silenceDurationMs`.

Repeat the builder's `model`, `voice`, `instructions`, `settings`, and `tools` when attaching. These values describe the already accepted call; attachment checks them without sending an initial configuration update. A mismatch rejects attachment. The accept body controls the tools advertised to the provider. The attachment selection also limits the tools available to delegated native work. The builder saves no configuration for a later attachment.

In your verified incoming-call handler, reuse one options object for both steps. Here, `session` is your open Session, `callId` identifies the accepted provider call, and `serveCall` consumes `voice.events()` until the call ends. This empty selection excludes the Agent's tools:

```ts
import type { NativeRealtimeSipConfigOptions } from '@openai/agents';

const config: NativeRealtimeSipConfigOptions = {
  model: 'gpt-realtime',
  voice: 'alloy',
  instructions: 'Answer spoken questions briefly.',
  settings: { toolChoice: 'auto' },
  tools: [],
};
const acceptance = await session.buildRealtimeSipConfig(config);
// Send acceptance to the provider's call-accept endpoint before attaching.
await using voice = await session.realtime({
  ...config,
  transport: { type: 'sip', callId },
});
await serveCall(voice);
```

Configure hosted MCP follow-ups by passing `automaticallyTriggerResponseForMcpToolCalls` when attaching with `session.realtime()`. The HTTP accept body cannot carry this SDK option, so `buildRealtimeSipConfig()` does not accept it.

Nonempty client audio is rejected; an empty audio buffer with `{ commit: true }` can control audio already buffered by the provider. Closing an SDK-created WebRTC owner also hangs up its created call.

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

For an already accepted SIP call, use the same server lifetime and event consumer. Repeat the acceptance options and add `transport: { type: 'sip', callId }`, as shown above. Context disposal detaches native control; the application that owns the provider call handles hangup.

The matching [source build](building.md) has been offering two routes from `@openai/agents/voice/workerd`:

- `openVoiceWebSocket()` has been opening a relay socket to an application server, with that server retaining native voice control.
- `connectPortableVoiceWorker()` has been opening the provider WebSocket directly. The Rust controller and application tool callbacks have been running inside the Worker. The [portable control guide](../../../packages/agents-codex/PORTABLE_CONTROL.md) has been covering the platform entry points, agent configuration, credentials, and cleanup.

The retained `@openai/agents/realtime` entrypoint has been continuing to expose the Classic runtime.

## Credentials and custom adapters

`Session.realtime({apiKey})` accepts a string or a synchronous or asynchronous callback. The callback receives an optional `AbortSignal` and resolves once per connection. Omit it to use the Session provider's credentials. This override does not change credentials for the Session's text turns. Honor cancellation during credential lookup and release any resources your callback opens.

### Implement a custom adapter

Import `NativeRealtimeAdapter`, `NativeRealtimeAdapterContext`, and `NativeRealtimeConnection` as types from `@openai/agents`. An adapter implements `connect(context)`. The context contains the native-selected URL, private headers, model, and setup signal. Your adapter can choose another endpoint or translate another model's protocol to canonical Realtime V2 frames.

Return a connection with `incoming: AsyncIterable<string>`, `send(frame: string): Promise<void>`, and `close(): Promise<void>`. Incoming and outgoing I/O must work independently. Honor the setup signal and clean partial resources before rejecting. `close()` must release resources and wake pending sends and incoming iteration. Cleanup must support retries. Do not await the owning Session's close from an adapter callback; the application controls that outer lifetime. Never log connection headers or credential values.

Run the complete [custom adapter example](../native-realtime-adapter.ts):

```sh
pnpm exec tsx examples/codex/native-realtime-adapter.ts 'Explain a rainbow briefly' > adapter-answer.pcm
```

It implements the factory, incoming iterator, send, and cleanup methods with the workspace's existing `ws` dependency. It preserves one WebSocket message per iterator value and forwards canonical frames unchanged to the native-selected endpoint. Output is a fixed window of mono PCM16 at 24 kHz without a file header. It does not translate another model's protocol.

### Keep adapter callbacks independent

Call `update()`, `approveHostedMcp()`, `deleteConversationItem()`, `sendEvent()`, and `sendAudio(..., { commit: true })` from application code outside this owner's adapter callbacks. They share the ordered transport and reject calls from its active callbacks. A pending committed audio call or raw event also blocks nested input from adapter callbacks. This includes operations waiting to start in the input queue.

The native runtime still checks configuration acknowledgements, tool authority, response ordering, and history. A translating adapter must implement the applicable [Realtime client events](https://developers.openai.com/api/reference/resources/realtime/client-events) and [server events](https://developers.openai.com/api/reference/resources/realtime/server-events), including configuration acknowledgements and actual response/item IDs. Replacing I/O does not bypass these checks.

## Settings, tools, and live Agents

### Update audio settings

Use `settings` for typed audio formats, transcription, VAD, voice, speed, prompt references, and provider tracing. `update()` accepts sparse settings: omitted fields keep their values. A declared codec does not convert your audio. PCM16 uses mono 24 kHz samples; G.711 uses mono 8 kHz bytes. Use the event's format and identity when playing audio.

### Choose tools for voice and delegation

`settings.toolChoice` accepts `'auto'`, `'none'`, `'required'`, or `{ type: 'function', name: 'lookup' }`. A named function must already be advertised to the voice connection. The choice grants no permission; native tool policies and approvals still apply. Omission preserves the current choice. Before a handoff or update removes that function, call `await voice.update({ toolChoice: 'auto' })`; incompatible replacements fail before publication.

Omit Realtime `tools` to inherit the captured active Agent's function tools and handoffs. An explicit list must contain the original admitted function objects. It also limits tools used by `background_agent`; `[]` excludes the Agent's tools and handoffs from direct calls and delegated backend turns. The reserved `background_agent` and `remain_silent` controls remain available; delegation still obeys the empty backend tool selection.

The list is captured when Realtime opens, so later Session default updates cannot widen it. If a tool update is acknowledged on the same Agent in a handoff graph, voice selections made with that Agent's original function objects use the current replacement bindings. Sessions without a handoff graph also retain function declarations admitted by earlier successful tool updates.

Switching to another Agent without the original function identity makes delegation fail. A same-named tool on the new Agent cannot replace the missing capability. Ordinary graph `Session.submit()` still requires current function objects. Native tool policies and application approvals still apply.

`background_agent` delegates work to the same native Session. It returns only accepted final text, including any output validation or repair. A non-string final output fails instead of being serialized for speech. A function can return `backgroundResult(value)` to publish its accepted result without requesting a model follow-up. Output policies can replace that decision.

### Switch the active Agent

Declare reachable `Agent.handoffs` before opening the Session. The graph keeps original Agent identities. `await session.getActiveAgent()` reads the native active Agent, and idle `Session.update({agent})` activates a captured Agent. Activation applies that Agent's declaration defaults.

An idle tool update changes the active defaults; an explicit per-operation tool selection remains a ceiling across later handoffs. Compatible output formats and shared Session runtime grants are required across the graph. Restore binds fresh caller-supplied Agent and tool objects, not saved callback implementations.

Configure an Agent's voice defaults with `realtime`. Its `instructions` and `toolEnabled` callbacks receive the application context. Set `prompt` and `outputGuardrails` on the same configuration. Use `realtimeHandoff(target, { name, description, parameters, onHandoff, isEnabled })` in `Agent.handoffs` for a named Realtime handoff. A structured Zod schema validates the arguments before the callback.

Call `await voice.updateAgent(nextAgent)` on an open connection to apply the replacement Agent's instructions and tools. The call resolves after the provider acknowledges the settings. Issued callbacks retain their source Agent and the attached Session retains its own active Agent.

### Match Classic session defaults

Pass `model: 'gpt-realtime-2.1'` with `settings: { turnDetection: { type: 'semantic_vad' }, noiseReduction: null }` to select Classic's default Realtime model, VAD, and noise reduction. Set `timeoutBehavior: 'error_as_result'` on a tool to return a timeout as tool output. Native tool batches use the completed response to bind execution to the source Agent.

### Approve hosted MCP calls

Hosted MCP tools are configured separately in `settings.hostedMcpTools`, with a URL or connector ID. Handle `hosted_mcp_approval_requested` by passing that exact issued event to `approveHostedMcp(event, {approve, reason})`. Clones and cross-session requests are invalid. Issued approval requests are not auto-approved. `automaticallyTriggerResponseForMcpToolCalls` defaults to true and controls hosted MCP follow-ups.

### Consume bounded events and history

Incoming native Realtime events share an 8 MiB queue budget for wire text and estimated storage for decoded and derived values. Oversized frames, dense JSON structures, deeply nested values, or a full queue terminate the voice connection. Consume events promptly to release queue capacity.

SDK output events share a 2 MiB queue budget with conservative string-storage estimates.

Canonical transcript history has a separate 8 MiB estimated storage limit. History and guardrail transcripts also have cumulative work limits; exceeding a limit terminates the voice connection. History accounting lasts for the voice owner's lifetime, even when you consume events promptly.

Hosted MCP catalogs are limited to 1,024 tools. Catalog events share a 2 MiB queue budget, including estimated storage for schema structures and strings. Oversized catalogs, deeply nested schemas, or a full queue terminate the voice connection. Keep server tool lists and schemas small, and consume events promptly to release queue capacity.

### Check output and report playback

Realtime speech itself streams before completion. Optional `outputGuardrails` check text and can interrupt the exact response, but some audio may already have played. Report actual playback with `reportPlayback()`. On `playback_interrupted`, discard queued audio for `retiredResponseIds`. This differs from the accepted-final-text rule for native backend delegation.

Report playback progress while audio plays. When playback bookkeeping reaches its limit, it can release older completed content that has finished playing or was interrupted. Playback reports for released content are no longer accepted.

## Separate transcription and synthesis

Run [voice.ts](../voice.ts) for a PCM file → native Session → PCM file pipeline. Supply raw mono PCM16 at 24 kHz without a WAV header:

```sh
pnpm exec tsx examples/codex/voice.ts input.pcm spoken-answer.pcm
```

`VoicePipeline` takes one workflow and one speech provider. `NativeSessionVoiceWorkflow` waits for accepted final string output before synthesis, retaining the caller's history and approval policy. Its optional second constructor argument captures an operation tool selection: `new NativeSessionVoiceWorkflow(session, [lookup])` allows only that original admitted tool, and `new NativeSessionVoiceWorkflow(session, [])` selects no tools. Omit the argument to use Session defaults for each transcription.

The OpenAI speech provider accepts mono 24 kHz PCM16 or normalized float32 input. Streaming input uses explicit `{type: 'commit'}` boundaries; EOF commits remaining audio. It does not add VAD. `transcriptionSettings` applies to static/file transcription only.

Configure synthesis, voice IDs, ordered text splitting, output dtype, synchronous transforms, and sample buffering through the provider and pipeline options. Synthesis stays serial, and each synthesis boundary flushes its buffered tail. The caller owns its input source, playback, and Session lifetime.
