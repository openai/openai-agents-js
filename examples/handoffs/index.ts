import {
  Agent,
  run,
  tool,
  HandoffInputData,
  handoff,
  withTrace,
  isGpt5Default,
} from '@openai/agents';
import { removeAllTools } from '@openai/agents-core/extensions';
import { z } from 'zod';

// Random number tool
const randomNumberTool = tool({
  name: 'random_number_tool',
  description: 'Return a random integer between 0 and the given maximum.',
  parameters: z.object({
    max: z.number().describe('The maximum value.'),
  }),
  async execute(input: { max: number }) {
    return Math.floor(Math.random() * (input.max + 1)).toString();
  },
});

// Message filter for handoff (removes tool messages and first two history items)
function spanishHandoffMessageFilter(handoffMessageData: HandoffInputData) {
  if (isGpt5Default()) {
    console.log(
      'GPT-5 models do not work if you remove the toll call results, so this filter does nothing.',
    );
    return handoffMessageData;
  }
  // Remove all tool-related messages
  return removeAllTools(handoffMessageData);
}

const firstAgent = new Agent({
  name: 'First Assistant',
  instructions: 'Be extremely concise.',
  tools: [randomNumberTool],
});

const spanishAgent = new Agent({
  name: 'Spanish Assistant',
  instructions: 'You only speak Spanish and are extremely concise.',
  handoffDescription: 'A Spanish-speaking assistant.',
});

const secondAgent = new Agent({
  name: 'Second Assistant',
  instructions:
    'Be a helpful assistant. If the user speaks Spanish, handoff to the Spanish assistant.',
  handoffs: [
    handoff(spanishAgent, { inputFilter: spanishHandoffMessageFilter }),
  ],
});

async function main() {
  withTrace('Handoffs example', async () => {
    // 1. Send a regular message to the first agent
    console.log('Step 1: Send a regular message to the first agent');
    let result = await run(firstAgent, 'Hi, my name is Sora.');
    console.log('Step 1 done');

    // 2. Ask it to generate a number
    console.log('Step 2: Ask it to generate a number');
    result = await run(firstAgent, [
      ...result.history,
      {
        content: 'Can you generate a random number between 0 and 100?',
        role: 'user',
      },
    ]);
    console.log('Step 2 done');

    // 3. Call the second agent
    console.log('Step 3: Call the second agent');
    result = await run(secondAgent, [
      ...result.history,
      {
        content: "I live in New York City. What's the population of the city?",
        role: 'user',
      },
    ]);
    console.log('Step 3 done');

    // 4. Cause a handoff to occur
    console.log('Step 4: Cause a handoff to occur');
    result = await run(secondAgent, [
      ...result.history,
      {
        content: 'Por favor habla en español. ¿Cuál es mi nombre y dónde vivo?',
        role: 'user',
      },
    ]);
    console.log('Step 4 done');

    console.log('\n===Final messages===\n');

    for (const message of result.history) {
      console.log(JSON.stringify(message, null, 2));
    }
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
