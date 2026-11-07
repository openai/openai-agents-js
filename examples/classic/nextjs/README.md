# Next.js Demo

Follow the [classic example setup](../README.md) to install dependencies and build the SDK before running these commands.

This Next.js application pauses tool execution for human approval and stores pending runs in memory. It waits for each run to finish before returning its response.

## Run the example

Set `OPENAI_API_KEY` and `NEXTJS_DEMO_ACCESS_TOKEN` in the server environment. Choose a random access token with at least 32 characters. Run:

```bash
pnpm -F nextjs dev
```

Open [http://localhost:3000](http://localhost:3000), enter the demo access token, and ask `What is the weather in San Francisco and Oakland?`

The server keeps demo sessions and interrupted runs in memory. Sessions expire after one hour. Each session can start 20 model runs, and each server process admits at most 60 model runs per hour. Replace this demo token and in-memory store with your application's authentication and durable session storage when adapting the example for a deployed application.

Chat requests can include up to 256 KiB of input and conversation history. If a request exceeds that limit, select **Start a new conversation** to clear the chat and keep using the same demo session.

## Endpoints

- **`/`** – The basic example that actually handles receiving the approval requests and sending messages to the API. Code in `src/app/page.tsx`.
- **`/api/basic`** – The endpoint that gets triggered to run the agent. Code in `src/app/api/basic/route.ts`.

## Other files

- `src/components/Approvals.tsx` — renders the approval dialog
- `src/agents.ts` — contains the basic Agent configuration
- `src/db.ts` — contains the mock database implementation
- `src/demoSession.ts` — checks demo sessions and model-run limits
