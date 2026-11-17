import { z } from 'zod';
import { Agent, run, tool } from '@openai/agents';
import { aisdk, AiSdkModel } from '@openai/agents-extensions/ai-sdk';

export async function runAgents(model: AiSdkModel) {
  let weatherCalls = 0;
  const getWeatherTool = tool({
    name: 'get_weather',
    description: 'Get the weather for a given city',
    parameters: z.object({ city: z.string() }),
    async execute({ city }) {
      weatherCalls += 1;
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

  let streamedText = '';
  for await (const text of stream.toTextStream()) {
    streamedText += text;
    process.stdout.write(text);
  }
  if (weatherCalls === 0 || !streamedText.trim()) {
    throw new Error(
      'Expected a weather tool result and streamed response text.',
    );
  }
  console.log();
}

import { openai } from '@ai-sdk/openai';
// import { anthropic } from '@ai-sdk/anthropic';
// import { google } from '@ai-sdk/google';

(async function () {
  const model = aisdk(openai('gpt-5.4-mini'));
  // const model = aisdk(anthropic('claude-sonnet-4-20250514'));
  // const model = aisdk(google('gemini-2.5-flash'));
  await runAgents(model);
})();
