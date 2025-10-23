import { Agent, run, tool } from '@openai/agents';
import { z } from 'zod';

type Weather = {
  city: string;
  temperatureRange: string;
  conditions: string;
};

const getWeather = tool({
  name: 'get_weather',
  description: 'Get the weather for a city.',
  parameters: z.object({ city: z.string() }),
  execute: async ({ city }): Promise<Weather> => {
    return {
      city,
      temperatureRange: '14-20C',
      conditions: 'Sunny with wind.',
    };
  },
});

const agent = new Agent({
  name: 'Hello world',
  instructions: 'You are a helpful agent.',
  tools: [getWeather],
});

async function main() {
  const result = await run(agent, "What's the weather in Tokyo?");
  console.log(result.finalOutput);
  // The weather in Tokyo is sunny with some wind, and the temperature ranges between 14°C and 20°C.
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
