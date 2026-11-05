import { Agent, run, tool } from '@openai/agents/classic';
import { z } from 'zod';
import { WeatherParameters, WeatherReport } from './schemas.ts';

const getWeather = tool({
  name: 'get_weather',
  description: 'Return a sample temperature in the requested unit.',
  parameters: WeatherParameters,
  execute: ({ city, unit }) => {
    const temperature = unit === 'fahrenheit' ? 71.6 : 22;
    return `${city}: ${temperature} degrees ${unit}`;
  },
});

const zodTool = tool({
  name: 'get_timezone',
  description: 'Look up the city in the sample time zone data.',
  parameters: z.object({ city: z.string() }),
  execute: ({ city }) =>
    city.trim().toLowerCase() === 'tokyo'
      ? 'Asia/Tokyo'
      : `No sample time zone for ${city}.`,
});

const agent = new Agent({
  name: 'Weather assistant',
  instructions: 'Use the weather tool and return a structured weather report.',
  tools: [getWeather, zodTool],
  outputType: WeatherReport,
});

const result = await run(agent, 'What is the weather in Tokyo?');
console.log(result.finalOutput);
