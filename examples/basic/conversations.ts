import { Agent, run } from '@openai/agents';
import OpenAI from 'openai';

async function main() {
  const client = new OpenAI();

  console.log('### New conversation:\n');
  const newConvo = await client.conversations.create({});
  console.log(`New conversation: ${JSON.stringify(newConvo, null, 2)}`);
  const conversationId = newConvo.id;

  const agent = new Agent({
    name: 'Assistant',
    instructions: 'You are a helpful assistant. be VERY concise.',
  });

  // Set the conversation ID for the runs
  console.log('\n### Agent runs:\n');
  const runOptions = { conversationId };
  let result = await run(
    agent,
    'What is the largest country in South America?',
    runOptions,
  );
  console.log(`First run: ${result.finalOutput}`); // e.g., Brazil
  result = await run(agent, 'What is the capital of that country?', runOptions);
  console.log(`Second run: ${result.finalOutput}`); // e.g., Brasilia

  console.log('\n### Conversation items:\n');
  const convo = await client.conversations.items.list(conversationId);
  for await (const page of convo.iterPages()) {
    for (const item of page.getPaginatedItems()) {
      // desc order
      console.log(JSON.stringify(item, null, 2));
    }
  }
}
if (require.main === module) {
  main().catch(console.error);
}
