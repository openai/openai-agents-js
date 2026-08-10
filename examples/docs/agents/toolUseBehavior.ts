import { Agent, tool } from '@openai/agents';
import { z } from 'zod';

const calculatorTool = tool({
  name: 'calculator',
  description: 'Evaluate a numeric expression.',
  parameters: z.object({ expression: z.string() }),
  execute: async ({ expression }) => expression,
});

const agent = new Agent({
  name: 'Calculator agent',
  instructions: 'Use the calculator tool to answer arithmetic questions.',
  tools: [calculatorTool],
  toolUseBehavior: 'stop_on_first_tool',
});

console.log(agent.name);
