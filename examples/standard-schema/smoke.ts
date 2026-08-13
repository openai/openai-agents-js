import { Agent, RunContext, tool } from '@openai/agents';
import { WeatherParameters, WeatherReport } from './schemas';

let executedInput: unknown;
const weatherTool = tool({
  name: 'weather',
  description: 'Get weather.',
  parameters: WeatherParameters,
  execute: async (input) => {
    executedInput = input;
    return input;
  },
});

await weatherTool.invoke(
  new RunContext(),
  JSON.stringify({ city: 'Tokyo', unit: null }),
);
if (
  typeof executedInput !== 'object' ||
  executedInput === null ||
  !('unit' in executedInput) ||
  executedInput.unit !== 'celsius'
) {
  throw new Error('Valibot tool parameters were not validated.');
}

const agent = new Agent({
  name: 'Weather',
  instructions: 'Return weather.',
  outputType: WeatherReport,
});
const output = agent.processFinalOutput(
  JSON.stringify({ city: 'Tokyo', temperature: 22, unit: 'celsius' }),
);
if (output.temperature !== 22) {
  throw new Error('Valibot agent output was not validated.');
}
