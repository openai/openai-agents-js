import { Agent, handoff, tool, webSearchTool } from '@openai/agents';
import { z } from 'zod';

export const getWeather = tool({
  name: 'get_weather',
  description: 'Get the weather for a given city.',
  parameters: z.object({
    city: z.string().describe('City name to look up.'),
  }),
  execute: async ({ city }) => {
    return `The weather in ${city} is sunny with light clouds.`;
  },
});

export const customerSupportAgent = new Agent({
  name: 'Customer Support Agent',
  handoffDescription: 'Handles billing, refunds, and account access issues.',
  model: 'gpt-5.2',
  modelSettings: {
    reasoning: { effort: 'low', summary: 'concise' },
    text: { verbosity: 'low' },
  },
  tools: [webSearchTool()],
  instructions:
    'You are a customer support specialist. Be empathetic, ask clarifying questions, and outline next steps for billing or account issues. When you get an inquiry, you must introduce yourself as an expert.',
});

export const agent = new Agent({
  name: 'Sky Guide',
  model: 'gpt-5.2',
  modelSettings: {
    reasoning: { effort: 'none' },
    text: { verbosity: 'low' },
  },
  instructions:
    'You are a friendly astronomy guide. Use get_weather for weather questions and hand off billing or account issues to customer support.',
  tools: [getWeather],
  handoffs: [handoff(customerSupportAgent)],
});
