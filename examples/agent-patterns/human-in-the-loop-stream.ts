import { z } from 'zod';
import readline from 'node:readline/promises';
import { Agent, run, tool } from '@openai/agents';

const AUTO_APPROVE_HITL = process.env.AUTO_APPROVE_HITL === '1';

// Prompt user for yes/no confirmation
async function confirm(question: string): Promise<boolean> {
  if (AUTO_APPROVE_HITL) {
    console.log(`[auto-approve] ${question}`);
    return true;
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await rl.question(`${question} (y/n): `);
  rl.close();
  return ['y', 'yes'].includes(answer.trim().toLowerCase());
}

async function main() {
  // Define a tool that requires approval for certain inputs
  const getWeatherTool = tool({
    name: 'get_weather',
    description:
      'Get weather conditions for one city. The result does not include temperature.',
    parameters: z.object({
      city: z.string().describe('City whose weather conditions to retrieve.'),
    }),
    async execute({ city }) {
      return `The weather in ${city} is sunny.`;
    },
  });

  const weatherAgent = new Agent({
    name: 'Weather agent',
    instructions:
      'Use the available tool to report weather conditions for every requested city. Report conditions only, without temperatures.',
    handoffDescription: 'Handles weather-related queries',
    tools: [getWeatherTool],
  });

  const getTemperatureTool = tool({
    name: 'get_temperature',
    description:
      'Get the current temperature for one city. Call separately for each requested city.',
    parameters: z.object({
      city: z.string().describe('City whose current temperature to retrieve.'),
    }),
    needsApproval: async (_ctx, { city }) => city.includes('Oakland'),
    execute: async ({ city }) => {
      return `The temperature in ${city} is 20° Celsius`;
    },
  });

  const mainAgent = new Agent({
    name: 'Main agent',
    instructions:
      'Use the available tools to answer weather questions. Retrieve every requested kind of information for every requested city before answering.',
    tools: [
      getTemperatureTool,
      weatherAgent.asTool({
        toolName: 'ask_weather_agent',
        toolDescription:
          'Get weather conditions for one or more locations. This tool does not return temperatures.',
        // Require approval when the generated input mentions San Francisco.
        needsApproval: async (_ctx, { input }) =>
          input.includes('San Francisco'),
      }),
    ],
  });

  let stream = await run(
    mainAgent,
    'What is the weather and temperature in San Francisco and Oakland?',
    { stream: true },
  );
  stream.toTextStream({ compatibleWithNodeStreams: true }).pipe(process.stdout);
  await stream.completed;

  while (stream.interruptions?.length) {
    console.log(
      'Human-in-the-loop: approval required for the following tool calls:',
    );
    const state = stream.state;
    for (const interruption of stream.interruptions) {
      if (interruption.rawItem.type !== 'function_call') {
        throw new Error(
          'Invalid interruption type: ' + interruption.rawItem.type,
        );
      }
      const ok = await confirm(
        `Agent ${interruption.agent.name} would like to use the tool ${interruption.rawItem.name} with "${interruption.rawItem.arguments}". Do you approve?`,
      );
      if (ok) {
        state.approve(interruption);
      } else {
        state.reject(interruption);
      }
    }

    // Resume execution with streaming output
    stream = await run(mainAgent, state, { stream: true });
    const textStream = stream.toTextStream({ compatibleWithNodeStreams: true });
    textStream.pipe(process.stdout);
    await stream.completed;
  }

  console.log('\n\nDone');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
