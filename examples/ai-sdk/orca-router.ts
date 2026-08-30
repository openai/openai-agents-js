import { Agent, ModelSettings, Runner, tool } from '@openai/agents';
import { aisdk, AiSdkModel } from '@openai/agents-extensions/ai-sdk';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { z } from 'zod';

// OrcaRouter is an OpenAI-compatible AI gateway, so the standard AI SDK
// openai-compatible provider is all we need to expose its models as named,
// first-class providers in the Agents SDK.
const orcaRouter = createOpenAICompatible({
  name: 'orcarouter',
  baseURL: 'https://api.orcarouter.ai/v1',
  apiKey: process.env.ORCAROUTER_API_KEY,
});

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
    model, // Using the OrcaRouter-backed AI SDK model for this agent
    modelSettings: {
      ...modelSettings,
      toolChoice: 'required',
    },
  });

  const agent = new Agent({
    name: 'Helpful Assistant',
    instructions: 'Delegate weather requests to the available specialist.',
    handoffs: [dataAgent],
    model, // Using the OrcaRouter-backed AI SDK model for this agent
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

(async function () {
  // Switch the model to use for testing, e.g. `orcarouter('deepseek/deepseek-v4-flash')`.
  const model = aisdk(orcaRouter('orcarouter/fusion'));
  await runAgents(model, {});
})();
