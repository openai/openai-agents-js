# Realtime Next.js Demo

This example combines Next.js with the OpenAI Agents SDK to create a realtime voice agent.

## Run the example

Set the `OPENAI_API_KEY` environment variable and run:

```bash
pnpm examples:realtime-next
```

Open [http://localhost:3000](http://localhost:3000) in your browser and start talking.

## Endpoints

- **`/`**. WebRTC voice demo with the `RealtimeSession` class. See `src/app/page.tsx`.
- **`/websocket`**. The same agent over WebSockets. See `src/app/websocket/page.tsx`.
- **`/raw-client`**. Low-level WebRTC example with `OpenAIRealtimeWebRTC`. See `src/app/raw-client/page.tsx`.
