import { Agent, run, tool } from '@openai/agents';
import { z } from 'zod';
import { WeatherParameters, WeatherReport } from './schemas';

const getWeather = tool({
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  parameters: WeatherParameters,
  execute: async ({ city, unit }) => `${city}: 22 degrees ${unit}`,
});

const zodTool = tool({
  name: 'get_timezone',
  description: 'Get the timezone for a city.',
  parameters: z.object({ city: z.string() }),
  execute: async ({ city }) => `${city}: UTC`,
});

const agent = new Agent({
  name: 'Weather assistant',
  instructions: 'Use the weather tool and return a structured weather report.',
  tools: [getWeather, zodTool],
  outputType: WeatherReport,
});

async function main() {
  const result = await run(agent, 'What is the weather in Tokyo?');
  console.log(result.finalOutput);
}

main().catch(console.error);
