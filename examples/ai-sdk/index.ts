import { Agent, ModelSettings, Runner, tool } from '@openai/agents';
import { aisdk, AiSdkModel } from '@openai/agents-extensions/ai-sdk';
import { z } from 'zod';

export async function runAgents(
  model: AiSdkModel,
  modelSettings: ModelSettings,
) {
  const lookedUpCities: string[] = [];

  const getWeatherTool = tool({
    name: 'get_weather',
    description: 'Get the weather for one or more cities.',
    parameters: z.object({
      cities: z.array(z.string()).min(1),
    }),
    execute: ({ cities }) => {
      lookedUpCities.push(...cities);
      return cities.map((city) => `${city}: sunny`).join('\n');
    },
  });

  const dataAgent = new Agent({
    name: 'Weather Data Agent',
    instructions: 'You answer weather questions.',
    handoffDescription: 'Looks up weather for one or more cities.',
    tools: [getWeatherTool],
    toolUseBehavior: 'stop_on_first_tool',
    model, // Using the AI SDK model for this agent
    modelSettings: {
      ...modelSettings,
      toolChoice: 'required',
    },
  });

  const agent = new Agent({
    name: 'Helpful Assistant',
    instructions: 'Delegate weather requests to the available specialist.',
    handoffs: [dataAgent],
    model, // Using the AI SDK model for this agent
    modelSettings: {
      ...modelSettings,
      toolChoice: 'required',
    },
  });

  const runner = new Runner({
    traceMetadata: {
      userId: 'u_123',
      chatType: 'support',
    },
  });
  const result = await runner.run(
    agent,
    'What is the weather in San Francisco and Oakland?',
  );

  if (!result.newItems.some((item) => item.type === 'handoff_call_item')) {
    throw new Error('Expected the weather request to be handed off.');
  }

  const normalizedCities = lookedUpCities.map((city) =>
    city.trim().toLowerCase(),
  );
  if (
    !normalizedCities.includes('san francisco') ||
    !normalizedCities.includes('oakland')
  ) {
    throw new Error(
      `Expected weather lookups for San Francisco and Oakland, saw: ${lookedUpCities.join(', ')}.`,
    );
  }

  console.log(`[workflow] cities=${lookedUpCities.join(',')}`);
  console.log(result.finalOutput);
}

import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import { google } from '@ai-sdk/google';

(async function () {
  const openRouter = createOpenRouter({
    apiKey: process.env.OPENROUTER_API_KEY,
  });
  const _gptOSS = aisdk(openRouter('openai/gpt-oss-120b'));
  const _gpt = aisdk(openai('gpt-5.4'));
  const _claude = aisdk(anthropic('claude-sonnet-4-5'));
  const _gemini = aisdk(google('gemini-3-flash-preview'));
  void _gptOSS;
  void _gpt;
  void _claude;
  void _gemini;
  // Switch the model to use for testing
  const model = _gptOSS;

  const modelSettings: ModelSettings =
    model === _claude
      ? {
          providerData: {
            providerOptions: {
              anthropic: { thinking: { type: 'enabled', budgetTokens: 10000 } },
            },
          },
        }
      : {};

  await runAgents(model, modelSettings);
})();
