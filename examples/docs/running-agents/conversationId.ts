import { Agent, run } from '@openai/agents';
import { OpenAI } from 'openai';

const agent = new Agent({
  name: 'Assistant',
  instructions: 'Reply very concisely.',
});

async function main() {
  // Create a server-managed conversation:
  const client = new OpenAI();
  const { id: conversationId } = await client.conversations.create({});

  const first = await run(agent, 'What city is the Golden Gate Bridge in?', {
    conversationId,
  });
  console.log(first.finalOutput);
  // -> "San Francisco"

  const second = await run(agent, 'What state is it in?', { conversationId });
  console.log(second.finalOutput);
  // -> "California"
}

main().catch(console.error);
