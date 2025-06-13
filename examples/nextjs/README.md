# Realtime Next.js Demo

This example shows how to combine Next.js with the OpenAI Agents SDK to create a realtime voice agent.

## Run the example

Set the `OPENAI_API_KEY` environment variable and run:

```bash
pnpm examples:realtime-next
```

Open [http://localhost:3000](http://localhost:3000) in your browser and start talking.

## Endpoints

- **`/`** – WebRTC voice demo using the `RealtimeSession` class. Code in `src/app/page.tsx`.
- **`/websocket`** – Same agent over WebSockets. Code in `src/app/websocket/page.tsx`.
- **`/raw-client`** – Low-level WebRTC example using `OpenAIRealtimeWebRTC`. Code in `src/app/raw-client/page.tsx`.
