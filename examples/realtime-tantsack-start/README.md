# Realtime TanStack Start Demo

This example shows how to combine TanStack Start with the OpenAI Agents SDK to create a realtime voice agent using TanStack Router for routing.

## Run the example

Set the `OPENAI_API_KEY` environment variable and run:

```bash
pnpm examples:realtime-tantsack-start
```

Open [http://localhost:3000](http://localhost:3000) in your browser and start talking.

## Endpoints

- **`/`** – Realtime voice demo with agent handoffs, tools, and guardrails using the `RealtimeSession` class. Code in `src/routes/index.tsx`.
