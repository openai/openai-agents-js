# Native voice with Twilio

Use `bridgeTwilioVoice` to connect a Twilio bidirectional Media Stream to an existing native Agent Session. The application accepts and authenticates the incoming WebSocket, then gives it to the bridge. Complete the [native source setup](building.md) first. Call the function below from your server's authenticated Media Streams handler. Configure the HTTP server and Twilio separately.

```ts
import type { Session } from '@openai/agents';
import { bridgeTwilioVoice } from '@openai/agents/voice/twilio';
import type WebSocket from 'ws';

export async function handleAuthenticatedCall(
  socket: WebSocket,
  session: Session<unknown>,
  signal: AbortSignal,
) {
  await bridgeTwilioVoice({
    socket,
    session,
    signal,
    realtimeOptions: { model: 'gpt-realtime' },
    onEvent(event) {
      if (event.type === 'tool_batch_error') console.error(event.error);
    },
  });
}
```

The bridge uses mono G.711 μ-law at 8 kHz, which Twilio Media Streams require. It fills gaps in incoming media timestamps with silence and skips overlapping samples. After 750 ms without media during detected speech, it sends one second of silence to let voice activity detection finish the utterance. Set `inputAudioInactivityTimeoutMs` to change that interval, or `null` to disable it.

Twilio playback marks determine how much audio the caller has heard. An interruption clears queued audio and reports that playback position to the native conversation. Marks acknowledged after a clear cannot advance the old response. Audio from the next response waits until the current response finishes playback or is interrupted.

`onEvent` is a synchronous observer for the bridge's native Realtime events. The bridge owns the media event iterator. To stop a call, abort `signal` or close the Twilio socket. The returned promise waits for both media connections to close, including a native connection that finishes opening after cancellation. The caller retains ownership of `session` and can continue its text conversation or close it.
