# AI SDK UI Stream Example

Follow the [classic example setup](../README.md) to install dependencies and build the SDK before running these commands.

This example shows how to convert an Agents SDK streaming run into responses that are compatible with the AI SDK UI data stream and text stream protocols.

This private example uses AI SDK 7 with `@ai-sdk/react` 4 and `@ai-sdk/openai` 4. The published Agents SDK extension continues to support AI SDK 6 and 7; this example migration does not require existing consumers to upgrade. Applications choosing to upgrade should follow the [AI SDK 7 migration guide](https://ai-sdk.dev/docs/migration-guides/migration-guide-7-0).

## Run the Next.js chat UI

Set `OPENAI_API_KEY` and a random `AI_SDK_UI_DEMO_ACCESS_TOKEN` of at least 32 characters in the server environment. For example, generate the access token with `openssl rand -hex 32`. Run:

```bash
pnpm -F ai-sdk-ui dev
```

Open http://localhost:3000 for the UI message stream (tool calls and reasoning parts are rendered). Open http://localhost:3000/text for the text-only stream. When the browser prompts for credentials, enter `demo` as the username and the configured access token as the password.

The access token admits one demo operator. Keep it on the server and use HTTPS outside localhost. Both pages and all API routes require these credentials, including when the browser already owns a conversation. The server rejects browser requests from other origins, including other ports on localhost, even after sign-in. Links or embedded requests from another site return HTTP 403; open the demo URL directly in the address bar to sign in or resume. Same-origin navigation and direct CLI requests remain supported.

This local demo binds each conversation to its own HttpOnly browser cookie. Opening a conversation link in another browser starts a new conversation, and clearing cookies loses access. Both stream views share ownership for a given conversation, and separate tabs can create conversations independently. Before hosting this for other users, add your application's authentication and authorization.

Each server process allows 32 retained or pending conversations and 32 creation attempts per hour, including failed attempts. Conversations expire one hour after creation. The next admitted session request deletes expired provider conversations once their active streams and history reads finish. Failed deletions retain their slots and retry after one minute. The demo also allows 20 model runs per conversation, 60 per hour across conversations, four concurrent runs, and one active run per conversation. Chat request bodies are limited to 64 KiB. Exhausted limits return HTTP 429; expired conversations return HTTP 404. The in-memory ownership records and limits reset on server restart and do not coordinate across instances. Restarting loses access to existing conversations and their cleanup records; it does not delete those provider conversations. These controls are not a deployment-wide spending limit. Use provider project budgets for an additional cost boundary.

## Run the Node.js text stream samples

```bash
pnpm -F ai-sdk-ui start:script-ai-sdk
pnpm -F ai-sdk-ui start:script-simple
```

`ai-sdk.ts` uses `streamText` from the AI SDK, while `simple.ts` streams an Agents SDK run through `createAiSdkTextStreamResponse`.

## Next.js route examples

```ts
import { Agent, run } from '@openai/agents/classic';
import { createAiSdkUiMessageStreamResponse } from '@openai/agents-extensions/ai-sdk-ui';

export async function POST() {
  const agent = new Agent({
    name: 'Assistant',
    instructions: 'Reply with a short answer.',
  });

  const stream = await run(agent, 'Hello there.', { stream: true });
  return createAiSdkUiMessageStreamResponse(stream);
}
```

```ts
import { Agent, run } from '@openai/agents/classic';
import { createAiSdkTextStreamResponse } from '@openai/agents-extensions/ai-sdk-ui';

export async function POST() {
  const agent = new Agent({
    name: 'Assistant',
    instructions: 'Reply with a short answer.',
  });

  const stream = await run(agent, 'Hello there.', { stream: true });
  return createAiSdkTextStreamResponse(stream);
}
```

## Runtime requirements

Use Node.js 22.18 or later within the 22.x line, Node.js 24.x, or Node.js 26 or later. The following commands execute TypeScript directly with Node.js: `start:script-simple`, `start:script-ai-sdk`.
