import { Agent, tool } from '@openai/agents';
import z from 'zod';

const getWeather = tool({
  name: 'getWeather',
  description: 'Get the weather for a given city',
  parameters: z.object({
    city: z.string(),
  }),
  execute: async ({ city }) => {
    return `The weather in ${city} is sunny.`;
  },

  needsApproval: true,
});

export const agent = new Agent({
  name: 'Basic Agent',
  instructions: 'You are a basic agent.',
  tools: [getWeather],
});
