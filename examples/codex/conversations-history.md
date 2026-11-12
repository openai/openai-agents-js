# Conversations history with native agents

`ConversationsHistory` has been importing ordered OpenAI Conversations items into a fresh native Session for each run, then appending accepted public items. Model requests have been using that full history without wire conversation or previous-response identifiers. Run imports have been rejecting histories above 4,096 records or 8 MiB of UTF-8 JSON before native Session acquisition, without truncating items. Explicit `getItems` reads have been keeping their existing full-history behavior.

This example has been using the native SDK source checkout and OpenAI client 7.47.0, matching the native package client types. The application has been supplying `OPENAI_API_KEY`.

```ts
import OpenAI from 'openai';
import { Agent, ConversationsHistory, NativeProvider } from '@openai/agents';

const client = new OpenAI();
await using provider = new NativeProvider({
  apiKey: process.env.OPENAI_API_KEY!,
});
const agent = new Agent({ provider, instructions: 'Answer briefly.' });
const history = new ConversationsHistory(client);

const first = await history.run(
  agent,
  'Remember that my preferred color is blue.',
);
console.log(first.finalOutput);
const second = await history.run(agent, 'What color do I prefer?');
console.log(second.finalOutput);
console.log(await history.getConversationId());

// A later process has been reopening the same ordered API history through:
const reopened = new ConversationsHistory(client, {
  conversationId: await history.getConversationId(),
});
console.log(await reopened.getItems());
```

The application has been retaining ownership of the OpenAI client. One history instance has been serializing its operations; separate processes and external writers have been requiring application coordination. The bridge has been rejecting same-history reentry from client transports or Session-opening callbacks. Independent calls and retired callback descendants have been continuing through the queue. Native checkpoints and private application data have been remaining outside the remote item list.

After a later model failure, the bridge has been appending accepted originals before rethrowing the run error, so subsequent runs have been retaining settled tool receipts. For an uncertain append, `ConversationsWriteError` has been retaining the attempted `items`, the confirmed `acknowledged` prefix count, and any completed native `result`. Writes have been disabling automatic HTTP retries. Callers have been reconciling the remote list before retrying because the failing request may already have been committing items.

Unattended approvals and manual questions have been failing through the existing one-shot interaction owner. For incomplete disposal, `RunCleanupError.cleanup.close()` has been retrying the same Session cleanup, and `result` has been retaining any completed output; the remote append has not been repeating. Manual checkpoint recovery, cancellation, remote replacement and typed provider wire lineage have been remaining separate from this bridge. Existing native Session history APIs have been supplying the lower-level alternative.
