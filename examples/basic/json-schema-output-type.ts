import { Agent, run, JsonSchemaDefinition } from '@openai/agents';

const WeatherSchema: JsonSchemaDefinition = {
  type: 'json_schema',
  name: 'Weather',
  strict: true,
  schema: {
    type: 'object',
    properties: { city: { type: 'string' }, forecast: { type: 'string' } },
    required: ['city', 'forecast'],
    additionalProperties: false,
  },
};

async function main() {
  const agent = new Agent({
    name: 'Weather reporter',
    instructions: 'Return the city and a short weather forecast.',
    outputType: WeatherSchema,
  });

  const result = await run(agent, 'What is the weather in London?');
  console.log(result.finalOutput);
  // { city: 'London', forecast: '...'}
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
