import { z } from 'zod';
import { Agent, run, tool } from '@openai/agents';
import { aisdk, AiSdkModel } from './ai-sdk-v1';

export async function runAgents(model: AiSdkModel) {
  const getWeatherTool = tool({
    name: 'get_weather',
    description: 'Get the weather for a given city',
    parameters: z.object({ city: z.string() }),
    async execute({ city }) {
      return `The weather in ${city} is sunny`;
    },
  });

  const agent = new Agent({
    name: 'Weather agent',
    instructions: 'You provide weather information.',
    tools: [getWeatherTool],
    model,
  });

  const stream = await run(agent, 'What is the weather in San Francisco?', {
    stream: true,
  });

  for await (const text of stream.toTextStream()) {
    process.stdout.write(text);
  }
  console.log();
}

import { openai } from '@ai-sdk/openai';
// import { anthropic } from '@ai-sdk/anthropic';
// import { google } from '@ai-sdk/google';

(async function () {
  const model = aisdk(openai('gpt-4.1-nano'));
  // const model = aisdk(anthropic('claude-sonnet-4-20250514'));
  // const model = aisdk(google('gemini-2.5-flash'));
  await runAgents(model);
})();
