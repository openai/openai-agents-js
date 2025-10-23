import { z } from 'zod';
import { Agent, run, tool } from '@openai/agents';

const Weather = z.object({
  city: z.string(),
  result: z.string(),
});
type Weather = z.infer<typeof Weather>;

const getWeatherTool = tool({
  name: 'get_weather',
  description: 'Get the weather for a given city',
  parameters: z.object({ city: z.string() }),
  execute: async ({ city }): Promise<Weather> => ({ city, result: 'sunny' }),
});

const saySomethingTool = tool({
  name: 'say_something',
  description: 'Say something',
  parameters: z.object({}),
  execute: async () => 'Thanks for asking!',
});

const instructions =
  'You know everything about the weather. Call get_weather to get the weather first. You must call say_something before final output.';

const agent = new Agent({
  name: 'Data agent',
  instructions,
  toolUseBehavior: { stopAtToolNames: ['get_weather'] },
  outputType: Weather,
  tools: [getWeatherTool, saySomethingTool],
});

const agent2 = new Agent({
  name: 'Data agent',
  instructions,
  outputType: Weather,
  tools: [getWeatherTool, saySomethingTool],
});

const agent3 = new Agent({
  name: 'Data agent',
  instructions,
  outputType: 'text',
  tools: [getWeatherTool, saySomethingTool],
});

async function main() {
  const input = 'What is the weather in San Francisco?';
  const result = await run(agent, input);
  const finalOutput = result.finalOutput;
  // { city: 'San Francisco', result: 'sunny' }
  console.log(finalOutput);

  const result2 = await run(agent2, input);
  const finalOutput2 = result2.finalOutput;
  // {
  //   city: 'San Francisco',
  //   result: 'The weather in San Francisco is sunny. Thanks for asking!'
  // }
  console.log(finalOutput2);

  const result3 = await run(agent3, input);
  const finalOutput3 = result3.finalOutput;
  // The weather in San Francisco is sunny. Thanks for asking!
  console.log(finalOutput3);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
