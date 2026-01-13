import { Agent, run, tool, user, withTrace } from '@openai/agents';
import type { AgentInputItem } from '@openai/agents';
import { createInterface } from 'node:readline/promises';
import { z } from 'zod';

const autoMode = process.env.EXAMPLES_INTERACTIVE_MODE === 'auto';

async function ask(prompt: string, fallback: string) {
  if (autoMode) return fallback;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const message = await rl.question(prompt);
  rl.close();
  return message;
}

const getWeatherTool = tool({
  name: 'get_weather',
  description: 'Get the weather for a given city',
  parameters: z.object({
    demo: z.string(),
  }),
  execute: async (input) => {
    return `The weather in ${input.demo} is sunny`;
  },
});

const weatherAgent = new Agent({
  name: 'Weather Agent',
  handoffDescription: 'Knows everything about the weather but nothing else.',
  tools: [getWeatherTool],
});

const agent = new Agent({
  name: 'Basic test agent',
  instructions: 'You are a basic agent',
  handoffDescription: 'An expert on everything but the weather.',
  handoffs: [weatherAgent],
});

weatherAgent.handoffs.push(agent);

let history: AgentInputItem[] = [];
let latestAgent: Agent = agent;

async function main() {
  console.log('Type exit() to leave');
  await withTrace('Chat Session', async () => {
    while (true) {
      const message = await ask('> ', 'What is the weather in Tokyo?');
      if (message === 'exit()') {
        return;
      }
      history.push(user(message));
      const result = await run(latestAgent, history);

      console.log(`[${latestAgent.name}] ${result.finalOutput}`);

      if (result.lastAgent) {
        latestAgent = result.lastAgent;
      }
      history = result.history;
      if (autoMode) return; // single turn in auto mode
    }
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
