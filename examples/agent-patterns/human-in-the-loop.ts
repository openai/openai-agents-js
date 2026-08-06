import { z } from 'zod';
import readline from 'node:readline/promises';
import fs from 'node:fs/promises';
import { Agent, run, tool, RunState, RunResult } from '@openai/agents';

const getWeatherTool = tool({
  name: 'get_weather',
  description:
    'Get weather conditions for one city. The result does not include temperature.',
  parameters: z.object({
    city: z.string().describe('City whose weather conditions to retrieve.'),
  }),
  execute: async ({ city }) => {
    return `The weather in ${city} is sunny`;
  },
});

// A specialist sub-agent that we will expose as a tool.
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

// Main agent that can call the weather agent as a tool.
const agent = new Agent({
  name: 'Basic test agent',
  instructions:
    'Use the available tools to answer weather questions. Retrieve every requested kind of information for every requested city before answering.',
  tools: [
    getTemperatureTool,
    weatherAgent.asTool({
      toolName: 'ask_weather_agent',
      toolDescription:
        'Get weather conditions for one or more locations. This tool does not return temperatures.',
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
    'What is the weather and temperature in San Francisco and Oakland?',
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
