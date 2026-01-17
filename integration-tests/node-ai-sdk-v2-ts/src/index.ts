import { Agent, run, tool } from '@openai/agents';
import { aisdk } from '@openai/agents-extensions';
import { z } from 'zod';
import { openai } from '@ai-sdk/openai';

export async function main() {
  const getWeatherTool = tool({
    name: 'get_weather',
    description: 'Get the weather for a given city',
    parameters: z.object({ city: z.string() }),
    execute: async ({ city }) => `The weather in ${city} is sunny`,
  });

  const agent = new Agent({
    name: 'AI SDK v2 Test Agent',
    instructions:
      'You are a helpful assistant. When you need to get the weather, you must use tools.',
    tools: [getWeatherTool],
    model: aisdk(openai('gpt-5.2')),
    modelSettings: {
      providerData: {
        providerOptions: {
          openai: {
            reasoningEffort: 'low',
            textVerbosity: 'low',
          },
        },
      },
    },
  });

  const result = await run(
    agent,
    'Hello what is the weather in San Francisco?',
  );
  console.log(`[AISDK_V2_RESPONSE]${result.finalOutput}[/AISDK_V2_RESPONSE]`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
