import { z } from 'zod';
import { Agent, tool } from '@openai/agents';

// Example tools
export const weatherTool = tool({
  name: 'get_weather',
  description: 'Get the weather for a given city',
  parameters: z.object({ city: z.string() }),
  execute: async (input) => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    return `The weather in ${input.city} is sunny and 72°F`;
  },
});

export const timeTool = tool({
  name: 'get_time',
  description: 'Get the current time',
  parameters: z.object({}),
  execute: async () => {
    return new Date().toISOString();
  },
});

// Create agents
export const weatherAgent = new Agent({
  name: 'Weather Assistant',
  instructions: 'You are a weather assistant.',
  tools: [weatherTool],
});

export const timeAgent = new Agent({
  name: 'Time Assistant',
  instructions: 'You are a time assistant.',
  tools: [timeTool],
});

// Multi-agent with handoffs
export const mainAgent = Agent.create({
  name: 'Main Assistant',
  instructions:
    'You are a helpful assistant. Use handoffs for specialized tasks.',
  handoffs: [weatherAgent, timeAgent],
});
