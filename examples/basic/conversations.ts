import { Agent, run, tool } from '@openai/agents';
import OpenAI from 'openai';
import z from 'zod';

async function main() {
  const client = new OpenAI();

  console.log('### New conversation:\n');
  const newConvo = await client.conversations.create({});
  console.log(`New conversation: ${JSON.stringify(newConvo, null, 2)}`);
  const conversationId = newConvo.id;

  const getWeatherTool = tool({
    name: 'get_weather',
    description: 'Get the weather for a given city',
    parameters: z.object({ city: z.string() }),
    strict: true,
    async execute({ city }) {
      return `The weather in ${city} is sunny.`;
    },
  });

  const agent = new Agent({
    name: 'Assistant',
    instructions: 'You are a helpful assistant. be VERY concise.',
    tools: [getWeatherTool],
  });

  // Set the conversation ID for the runs
  console.log('\n### Agent runs:\n');
  const options = { conversationId };
  let result = await run(
    agent,
    'What is the largest country in South America?',
    options,
  );
  // First run: The largest country in South America is Brazil.
  console.log(`First run: ${result.finalOutput}`);
  result = await run(agent, 'What is the capital of that country?', options);
  // Second run: The capital of Brazil is Brasília.
  console.log(`Second run: ${result.finalOutput}`);

  result = await run(agent, 'What is the weather in the city today?', options);
  // Third run: The weather in Brasília today is sunny.
  console.log(`Third run: ${result.finalOutput}`);

  result = await run(
    agent,
    `Can you share the same information about the smallest country's capital in South America?`,
    options,
  );
  // Fourth run: The smallest country in South America is Suriname. Its capital is Paramaribo. The weather in Paramaribo today is sunny.
  console.log(`Fourth run: ${result.finalOutput}`);

  console.log('\n### Conversation items:\n');
  const convo = await client.conversations.items.list(conversationId);
  for await (const page of convo.iterPages()) {
    for (const item of page.getPaginatedItems()) {
      // desc order
      console.log(JSON.stringify(item, null, 2));
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
