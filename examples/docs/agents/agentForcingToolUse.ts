import { Agent, tool } from '@openai/agents';
import { z } from 'zod';

const calculatorTool = tool({
  name: 'calculator',
  description: 'Add two numbers.',
  parameters: z.object({ left: z.number(), right: z.number() }),
  execute: async ({ left, right }) => left + right,
});

const agent = new Agent({
  name: 'Strict tool user',
  instructions: 'Always answer using the calculator tool.',
  tools: [calculatorTool],
  modelSettings: { toolChoice: 'required' },
});
