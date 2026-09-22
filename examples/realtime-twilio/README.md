# Realtime Twilio Integration

This example demonstrates how to connect the OpenAI Realtime API to a phone call using Twilio's Media Streams. The script in `index.ts` starts a Fastify server that serves TwiML for incoming calls and creates a WebSocket endpoint for streaming audio. When a call connects, the audio stream is forwarded through a `TwilioRealtimeTransportLayer` to a `RealtimeSession` so the `RealtimeAgent` can respond in real time.

The demo uses a friendly voice assistant with a hosted DeepWiki MCP integration and local sample tools for weather lookups and a secret number helper. Ask the agent to "look that up in DeepWiki" to try the hosted MCP tool.

When a call connects, start speaking after the prompt. To try an interruption, ask the agent for a longer answer and speak while it is responding.

To try it out you must have a Twilio phone number. Set these server-side environment variables before starting the example:

```bash
OPENAI_API_KEY=your-openai-api-key
TWILIO_AUTH_TOKEN=your-primary-twilio-auth-token
TWILIO_PUBLIC_BASE_URL=https://your-public-host.example
```

Use the primary Auth Token for the Twilio account that sends the requests. Keep both credentials on the server. `TWILIO_PUBLIC_BASE_URL` must be an HTTPS origin without credentials, a path prefix, query string, or fragment. An optional trailing slash is accepted. The example refuses to start without these settings.

Expose your localhost with an HTTPS tunnel such as ngrok and set `TWILIO_PUBLIC_BASE_URL` to that tunnel's public origin. Configure the phone number's incoming call URL as `https://your-public-host.example/incoming-call`, using GET or form-encoded POST. Update the environment variable and restart the server whenever the tunnel origin changes. A proxy may terminate TLS before forwarding to the local server, but must preserve the request path, query, form values, and `X-Twilio-Signature` header.

The server uses the official Twilio helper to validate incoming call webhooks and WebSocket upgrades before creating a Realtime session or connecting to OpenAI. Missing or invalid signatures return HTTP 403, including during the WebSocket handshake. If legitimate requests fail, check the account's primary Auth Token and the exact public URL configured in Twilio. Host and forwarded headers never determine the public URL. There is no option to disable authentication for local development.

Media Streams use the configured origin with `wss://` and `/media-stream`. Stream URLs cannot contain query parameters; use Twilio's Stream custom parameters for application metadata. Signature validation authenticates Twilio requests; application-specific caller authorization and replay prevention are outside this example's scope. See [Twilio request validation](https://www.twilio.com/docs/usage/security) and [Stream URL requirements](https://www.twilio.com/docs/voice/twiml/stream).

`index.ts` loads configuration and starts the server. `server.ts` contains the authenticated routes and Realtime session setup.

Start the server with:

```bash
pnpm -F realtime-twilio start
```

For Twilio's standard 8 kHz mono PCMU media format, the transport fills missing inbound media intervals with silence so Realtime voice activity detection can complete a turn even when the phone connection omits silent audio. While speech is active, it waits 750ms for another media message before adding silence. You can tune or disable this fallback when constructing the transport:

```ts
const transport = new TwilioRealtimeTransportLayer({
  twilioWebSocket: connection,
  inputAudioInactivityTimeoutMs: 500, // Set to null to disable the fallback.
});
```

To inspect session events, Twilio media timing and levels, response status, and WebSocket closure details without logging raw audio, start the example with diagnostics enabled:

```bash
DEBUG=diagnostics pnpm -F realtime-twilio start
```
