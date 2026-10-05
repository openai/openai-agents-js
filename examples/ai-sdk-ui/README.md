# AI SDK UI Stream Example

This example shows how to convert an Agents SDK streaming run into responses that are compatible with the AI SDK UI data stream and text stream protocols.

## Run the Next.js chat UI

```bash
pnpm -F ai-sdk-ui dev
```

Open http://localhost:3000 for the UI message stream (tool calls and reasoning parts are rendered). Open http://localhost:3000/text for the text-only stream.

This is a local demo, not a production authentication example. Each conversation is bound to its own HttpOnly browser cookie: opening a conversation link in another browser starts a new conversation, and clearing cookies loses access to existing conversations. Both stream views use the same cookie for a given conversation. Browser cookie limits also limit how many conversations this demo can retain. Before hosting this for other users, add your application's authentication and authorization.

## Run the Node.js text stream samples

```bash
pnpm -F ai-sdk-ui start:script-ai-sdk
pnpm -F ai-sdk-ui start:script-simple
```

`ai-sdk.ts` uses `streamText` from the AI SDK, while `simple.ts` streams an Agents SDK run through `createAiSdkTextStreamResponse`.

## Next.js route examples

```ts
import { Agent, run } from '@openai/agents';
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
import { Agent, run } from '@openai/agents';
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
