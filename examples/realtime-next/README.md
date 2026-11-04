# Realtime Next.js Demo

This example combines Next.js with the OpenAI Agents SDK to create a realtime voice agent.

## Run the example

Set `OPENAI_API_KEY` in your local shell, then generate a short-lived client secret:

```bash
pnpm -F realtime-next generate-token
```

Copy the printed secret and run:

```bash
pnpm examples:realtime-next
```

Open [http://localhost:3000](http://localhost:3000), select **Connect**, and paste the secret when prompted. Generate a new secret for each later connection after it expires.

The browser cannot ask this app to mint a secret. Keep `OPENAI_API_KEY` on the server. If you deploy this example beyond local development, restrict access and protect its other server actions with your application's authentication and rate limits.

## Endpoints

- **`/`**. WebRTC voice demo with the `RealtimeSession` class. See `src/app/page.tsx`.
- **`/websocket`**. The same agent over WebSockets. See `src/app/websocket/page.tsx`.
- **`/raw-client`**. Low-level WebRTC example with `OpenAIRealtimeWebRTC`. See `src/app/raw-client/page.tsx`.
