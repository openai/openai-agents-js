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
  // these guardrails are optional
  inputGuardrails: [
    {
      name: 'get_weather_input_guardrail',
      run: async ({ toolCall }) => {
        console.log(`tool input: ${toolCall.arguments}`);
        const toolArgs = JSON.parse(toolCall.arguments);
        if (toolArgs.city.toLowerCase() !== 'tokyo') {
          return {
            behavior: {
              type: 'rejectContent',
              message: 'I can help you only for cities in Japan.',
            },
          };
        }
        return { behavior: { type: 'allow' } };
      },
    },
  ],
  outputGuardrails: [
    {
      name: 'get_weather_output_guardrail',
      run: async ({ output }) => {
        console.log(`tool output: ${JSON.stringify(output)}`);
        return { behavior: { type: 'allow' } };
      },
    },
  ],
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

  // console.log(JSON.stringify(result.toolInputGuardrailResults));
  // [{"guardrail":{"type":"tool_input","name":"get_weather_guardrail"},"output":{"behavior":{"type":"allow"}}}]

  const result2 = await run(agent, "What's the weather in San Francisco?");
  console.log(result2.finalOutput);
  // I’m only able to provide weather information for cities in Japan. If you’re interested in the weather for a Japanese city, please let me know which one!

  // console.log(JSON.stringify(result2.toolInputGuardrailResults));
  // [{"guardrail":{"type":"tool_input","name":"get_weather_guardrail"},"output":{"behavior":{"type":"rejectContent","message":"I can help you only for cities in Japan."}}}]
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
