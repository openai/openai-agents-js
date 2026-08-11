import { Agent, tool } from '@openai/agents';
import { z } from 'zod';

const calculatorTool = tool({
  name: 'calculator',
  description: 'Add two numbers.',
  parameters: z.object({ left: z.number(), right: z.number() }),
  execute: async ({ left, right }) => left + right,
});

const agent = new Agent({
  name: 'Calculator agent',
  instructions: 'Use the calculator tool to answer arithmetic questions.',
  tools: [calculatorTool],
  toolUseBehavior: 'stop_on_first_tool',
});
