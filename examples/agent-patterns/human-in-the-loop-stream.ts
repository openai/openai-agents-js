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
  const APPROVER_NAME = 'Kaz';
  const temperatureParams = z.object({
    city: z.string(),
    approver: z.string().nullable().optional(),
  });

  // Define a tool that requires approval for certain inputs
  const getWeatherTool = tool({
    name: 'get_weather',
    description: 'Get the weather for a given city',
    parameters: z.object({ city: z.string() }),
    async execute({ city }) {
      return `The weather in ${city} is sunny.`;
    },
  });

  const weatherAgent = new Agent({
    name: 'Weather agent',
    instructions: 'You provide weather information.',
    handoffDescription: 'Handles weather-related queries',
    tools: [getWeatherTool],
  });

  const getTemperatureTool = tool({
    name: 'get_temperature',
    description: 'Get the temperature for a given city',
    parameters: temperatureParams,
    needsApproval: async (_ctx, { city }) => city.includes('Oakland'),
    execute: async ({ city, approver }) => {
      const approvedBy = approver ? ` Approved by ${approver}.` : '';
      return `The temperature in ${city} is 20° Celsius.${approvedBy}`;
    },
  });

  const mainAgent = new Agent({
    name: 'Main agent',
    instructions:
      'You are a general assistant. For weather questions, call the weather agent tool with a short input string and then answer.',
    tools: [
      getTemperatureTool,
      weatherAgent.asTool({
        toolName: 'ask_weather_agent',
        toolDescription:
          'Ask the weather agent about locations by passing a short input.',
        // Require approval when the generated input mentions San Francisco.
        needsApproval: async (_ctx, { input }) =>
          input.includes('San Francisco'),
      }),
    ],
  });

  let stream = await run(
    mainAgent,
    'Please check both San Francisco and Oakland, and do not consider the task complete until you have provided the weather and temperature for both cities.',
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
        if (interruption.name === 'get_temperature') {
          const parsedArgs = temperatureParams.parse(
            JSON.parse(interruption.rawItem.arguments),
          );
          const overrideArguments = { ...parsedArgs, approver: APPROVER_NAME };
          console.log(
            `Injecting approver="${APPROVER_NAME}" into the approved tool call.`,
          );
          state.approve(interruption, { overrideArguments });
        } else {
          state.approve(interruption);
        }
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
