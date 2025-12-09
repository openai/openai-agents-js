import { Agent, Runner, tool } from '@openai/agents';
import { z } from 'zod';

const getWeatherTool = tool({
  name: 'get_weather',
  description: 'Get the weather for a given city',
  parameters: z.object({
    city: z.string(),
  }),
  execute: async (input) => {
    return `The weather in ${input.city} is sunny`;
  },
});

const weatherAgent = new Agent({
  name: 'Weather Agent',
  tools: [getWeatherTool],
});

const getLocalNewsTool = tool({
  name: 'get_local_news',
  description: 'Get the local news for today',
  parameters: z.object({
    city: z.string(),
  }),
  execute: async (input) => {
    return `Big news in ${input.city} today: famous local cat won Guinness World Record for loudest purr!`;
  },
});

const newsAgent = new Agent({
  name: 'News Agent',
  instructions: 'You are a news agent that can tell the news for a given city.',
  tools: [getLocalNewsTool],
});

const personalAgent = new Agent({
  name: 'Personal Agent',
  instructions:
    'You are a personal agent that prepares a user for the day. You can use the news agent to get the news for the day, and the weather agent to get the weather for the day.',
  tools: [
    newsAgent.asTool({
      toolName: 'news_agent',
      toolDescription: 'Get the local news for today',
    }),
    weatherAgent.asTool({
      toolName: 'weather_agent',
      toolDescription: 'Get the weather for today',
    }),
  ],
});

const runner = new Runner({
  model: 'gpt-4.1-mini',
  tracingDisabled: true,
});

async function main() {
  const streamedRunResult = await runner.run(
    personalAgent,
    "What's up in Beijing today?",
    {
      stream: true,
      // enable streaming of agent as tool events in the context scope stream
      streamAgentTools: true,
    },
  );

  for await (const event of streamedRunResult) {
    console.log(JSON.stringify(event));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
