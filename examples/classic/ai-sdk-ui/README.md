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

### Sign in and open a conversation

The access token admits one demo operator. Keep it on the server and use HTTPS outside localhost. Both pages and all API routes require these credentials, including when the browser already owns a conversation.

Open the demo URL directly in the address bar to sign in or resume. The server rejects browser requests from other origins, including other ports on localhost, even after sign-in. Links or embedded requests from another site return HTTP 403. Same-origin navigation and direct CLI requests remain supported.

Each conversation has its own HttpOnly browser cookie. Both stream views share ownership for that conversation, and separate tabs can create conversations independently. Opening a conversation link in another browser starts a new conversation. Clearing cookies loses access to existing conversations.

Before hosting this for other users, add your application's authentication and authorization.

### Demo limits

The server enforces these limits:

| Resource | Limit |
| --- | --- |
| Retained or pending conversations | 32 per server process |
| Conversation creation attempts, including failed attempts | 32 per hour per server process |
| Model runs for one conversation | 20 |
| Model runs across conversations | 60 per hour per server process |
| Concurrent model runs | Four per server process; one per conversation |
| Chat request body | 64 KiB |

Exhausted conversation and model-run limits return HTTP 429. Oversized chat bodies return HTTP 413. Conversations expire one hour after creation; requests for expired conversations return HTTP 404.

### Expiry, cleanup, and server restarts

Admitted conversation-creation requests trigger cleanup of expired provider conversations once their active streams and history reads finish. Failed deletions retain their slots. Cleanup can retry after one minute when another conversation-creation request is admitted.

The ownership records and limits live in memory. They reset on server restart and do not coordinate across instances. Restarting loses access to existing conversations and their cleanup records, while those provider conversations remain stored.

These controls apply to individual demo processes. Use provider project budgets for an additional cost boundary across your deployment.

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
