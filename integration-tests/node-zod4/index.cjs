// @ts-check

const {
  Agent,
  run,
  tool,
  setTraceProcessors,
  ConsoleSpanExporter,
  BatchTraceProcessor,
} = require('@openai/agents');

const { z } = require('zod');

setTraceProcessors([new BatchTraceProcessor(new ConsoleSpanExporter())]);

const getWeatherTool = tool({
  name: 'get_weather',
  description: 'Get the weather for a given city',
  parameters: z.object({ city: z.string() }),
  execute: async (input) => {
    return `The weather in ${input.city} is sunny`;
  },
});

const agent = new Agent({
  name: 'Test Agent',
  instructions:
    'You will always only respond with "Hello there!". Not more not less.',
  tools: [getWeatherTool],
});

async function main() {
  const result = await run(agent, 'Hey there!');
  console.log(`[RESPONSE]${result.finalOutput}[/RESPONSE]`);
}

main().catch(console.error);
