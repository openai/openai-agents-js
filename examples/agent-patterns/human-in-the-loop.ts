import { z } from 'zod';
import readline from 'node:readline/promises';
import fs from 'node:fs/promises';
import { Agent, run, tool, RunState, RunResult } from '@openai/agents';

const getWeatherTool = tool({
  name: 'get_weather',
  description: 'Get the weather for a given city',
  parameters: z.object({
    city: z.string(),
  }),
  execute: async ({ city }) => {
    return `The weather in ${city} is sunny`;
  },
});

// A specialist sub-agent that we will expose as a tool.
const weatherAgent = new Agent({
  name: 'Weather agent',
  instructions: 'You provide concise weather information based on the input.',
  handoffDescription: 'Handles weather-related queries',
  tools: [getWeatherTool],
});

const getTemperatureTool = tool({
  name: 'get_temperature',
  description: 'Get the temperature for a given city',
  parameters: z.object({
    city: z.string(),
  }),
  needsApproval: async (_ctx, { city }) => city.includes('Oakland'),
  execute: async ({ city }) => {
    return `The temperature in ${city} is 20° Celsius`;
  },
});

// Main agent that can call the weather agent as a tool.
const agent = new Agent({
  name: 'Basic test agent',
  instructions:
    'You are a basic agent. For weather questions, use the weather agent tool with an appropriate input string and then answer.',
  tools: [
    getTemperatureTool,
    weatherAgent.asTool({
      toolName: 'ask_weather_agent',
      toolDescription:
        'Ask the weather agent about a location. Pass a short input string.',
      // Demonstrate approvals at the agent-as-tool level.
      // Require approval when the input mentions San Francisco.
      needsApproval: async (_ctx, { input }) => input.includes('San Francisco'),
    }),
  ],
});

const AUTO_APPROVE_HITL = process.env.AUTO_APPROVE_HITL === '1';

async function confirm(question: string) {
  if (AUTO_APPROVE_HITL) {
    console.log(`[auto-approve] ${question}`);
    return true;
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const answer = await rl.question(`${question} (y/n): `);
  const normalizedAnswer = answer.toLowerCase();
  rl.close();
  return normalizedAnswer === 'y' || normalizedAnswer === 'yes';
}

async function main() {
  let result: RunResult<unknown, Agent<unknown, any>> = await run(
    agent,
    'What is the weather and temperature in San Francisco and Oakland? Use available tools as needed.',
  );
  let hasInterruptions = result.interruptions?.length > 0;
  while (hasInterruptions) {
    // storing
    await fs.writeFile(
      'result.json',
      JSON.stringify(result.state, null, 2),
      'utf-8',
    );

    // from here on you could run things on a different thread/process

    // reading later on
    const storedState = await fs.readFile('result.json', 'utf-8');
    const state = await RunState.fromString(agent, storedState);

    for (const interruption of result.interruptions) {
      const confirmed = await confirm(
        `Agent ${interruption.agent.name} would like to use the tool ${interruption.name} with "${interruption.arguments || 'no arguments'}". Do you approve?`,
      );

      if (confirmed) {
        state.approve(interruption);
      } else {
        state.reject(interruption);
      }
    }

    // resume execution of the current state
    result = await run(agent, state);
    hasInterruptions = result.interruptions?.length > 0;
  }

  console.log(result.finalOutput);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
