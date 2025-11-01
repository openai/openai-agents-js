import { OpenAIConversationsSession } from '@openai/agents';
import type { AgentInputItem } from '@openai/agents-core';

// Replace OpenAIConversationsSession with any other Session implementation that
// supports get/add/pop/clear if you store history elsewhere.
const session = new OpenAIConversationsSession({
  conversationId: 'conv_123', // Resume an existing conversation if you have one.
});

const history = await session.getItems();
console.log(`Loaded ${history.length} prior items.`);

const followUp: AgentInputItem[] = [
  {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'Let’s continue later.' }],
  },
];
await session.addItems(followUp);

const undone = await session.popItem();

if (undone?.type === 'message') {
  console.log(undone.role); // "user"
}

await session.clearSession();
