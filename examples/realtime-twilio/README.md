# Realtime Twilio Integration

This example demonstrates how to connect the OpenAI Realtime API to a phone call using Twilio's Media Streams.
The script in `index.ts` starts a Fastify server that serves TwiML for incoming calls and creates a WebSocket
endpoint for streaming audio. When a call connects, the audio stream is forwarded through a
`TwilioRealtimeTransportLayer` to a `RealtimeSession` so the `RealtimeAgent` can respond in real time.

The demo agent mirrors the [realtime-next](../realtime-next) example. It includes the same MCP integrations
(`dnd` and `deepwiki`) as well as local sample tools for weather lookups and a secret number helper. Ask the
agent to "look that up in Deep Wiki" or "roll a Dungeons and Dragons character" to try the hosted MCP tools.

To try it out you must have a Twilio phone number.
Expose your localhost with a tunneling service such as ngrok and set the phone number's incoming call URL to `https://<your-tunnel-url>/incoming-call`.

Start the server with:

```bash
pnpm -F realtime-twilio start
```
