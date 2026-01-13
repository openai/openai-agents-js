import {
  Agent,
  tool,
  run,
  ToolsToFinalOutputResult,
  ToolToFinalOutputFunction,
  ModelSettings,
  RunContext,
  FunctionToolResult,
  ToolUseBehavior,
} from '@openai/agents';
import { z } from 'zod';

type Weather = {
  city: string;
  temperature_range: string;
  conditions: string;
};

const getWeather = tool({
  name: 'get_weather',
  description: 'Get the weather for a given city',
  parameters: z.object({
    city: z.string(),
  }),
  execute: async ({ city }): Promise<Weather> => {
    return {
      city,
      temperature_range: '14-20C',
      conditions: 'Sunny with wind',
    };
  },
});

const customToolUseBehavior: ToolToFinalOutputFunction = async (
  _context: RunContext,
  results: FunctionToolResult[],
): Promise<ToolsToFinalOutputResult> => {
  // First function_output result
  console.log(results);
  const outputResult = results.find((r) => r.type === 'function_output');
  if (!outputResult) {
    return { isFinalOutput: false, isInterrupted: undefined };
  }
  const weather = outputResult.output as Weather;
  return {
    isFinalOutput: true,
    isInterrupted: undefined,
    finalOutput: `${weather.city} is ${weather.conditions}.`,
  };
};

async function main(
  toolUseBehaviorOption: 'default' | 'first_tool' | 'custom' = 'default',
) {
  let toolUseBehavior: ToolUseBehavior;
  let modelSettings: ModelSettings = {};

  if (toolUseBehaviorOption === 'default') {
    toolUseBehavior = 'run_llm_again';
    modelSettings = {};
  } else if (toolUseBehaviorOption === 'first_tool') {
    toolUseBehavior = 'stop_on_first_tool';
    modelSettings = { toolChoice: 'required' };
  } else {
    toolUseBehavior = customToolUseBehavior;
    modelSettings = { toolChoice: 'required' };
  }

  const agent = new Agent({
    name: 'Weather agent',
    instructions: 'You are a helpful agent.',
    tools: [getWeather],
    toolUseBehavior,
    modelSettings,
  });

  const result = await run(agent, "What's the weather in Tokyo?");
  console.log(result.finalOutput);
}

// CLI argument parsing
const args = process.argv.slice(2);
let toolUseBehavior: 'default' | 'first_tool' | 'custom' = 'default';
const flagIndex = args.findIndex(
  (arg) => arg === '-t' || arg === '--tool-use-behavior',
);

if (flagIndex !== -1) {
  const value = args[flagIndex + 1];
  if (!value) {
    console.error(
      'Missing value for --tool-use-behavior. Use one of: default, first_tool, custom.',
    );
    process.exit(1);
  }
  if (value === 'default' || value === 'first_tool' || value === 'custom') {
    toolUseBehavior = value;
  } else {
    console.error('Invalid tool use behavior:', value);
    console.error(
      'Valid options: default (send tool outputs back to the model), first_tool (use the first tool result as the final output), custom (run a custom tool use behavior).',
    );
    process.exit(1);
  }
}

main(toolUseBehavior).catch((error) => {
  console.error(error);
  process.exit(1);
});
