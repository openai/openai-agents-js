import OpenAI from 'openai';
import { Agent, run, tool, type RunResult } from '@openai/agents';
import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/*                                   TOOLS                                    */
/* -------------------------------------------------------------------------- */

const getWeatherTool = tool({
  name: 'get_weather',
  description: 'Get the current weather for a given city',
  parameters: z.object({
    city: z.string().min(1),
  }),
  strict: true,
  async execute({ city }) {
    // Mocked response – replace with real API later
    return `The weather in ${city} is sunny.`;
  },
});

/* -------------------------------------------------------------------------- */
/*                                   AGENT                                    */
/* -------------------------------------------------------------------------- */

function createAssistantAgent() {
  return new Agent({
    name: 'Assistant',
    instructions: `
You are a helpful assistant.
Be concise, accurate, and context-aware.
`,
    tools: [getWeatherTool],
  });
}

/* -------------------------------------------------------------------------- */
/*                              CONVERSATION API                              */
/* -------------------------------------------------------------------------- */

async function createConversation(client: OpenAI): Promise<string> {
  const conversation = await client.conversations.create({});
  return conversation.id;
}

async function runAgent(
  agent: Agent,
  prompt: string,
  conversationId: string,
): Promise<RunResult> {
  return run(agent, prompt, { conversationId });
}

/* -------------------------------------------------------------------------- */
/*                                   MAIN                                     */
/* -------------------------------------------------------------------------- */

async function main() {
  const client = new OpenAI();
  const agent = createAssistantAgent();

  console.log('\n🚀 Starting new conversation...\n');
  const conversationId = await createConversation(client);

  const prompts = [
    'What is the largest country in South America?',
    'What is the capital of that country?',
    'What is the weather in the city today?',
    'Can you share the same information about the smallest country’s capital in South America?',
  ];

  for (const [index, prompt] of prompts.entries()) {
    const result = await runAgent(agent, prompt, conversationId);
    console.log(`Step ${index + 1}: ${result.finalOutput}`);
  }

  console.log('\n📜 Conversation history:\n');
  const items = await client.conversations.items.list(conversationId);

  for await (const page of items.iterPages()) {
    for (const item of page.getPaginatedItems()) {
      console.log(JSON.stringify(item, null, 2));
    }
  }
}

main().catch((error) => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
