import { z } from '@openai/zod';
import { Agent, run, tool, ToolCallError } from '@openai/agents';

const unstableTool = tool({
  name: 'get_weather (unstable)',
  description: 'Get the weather for a given city',
  parameters: z.object({ city: z.string() }),
  errorFunction: (_, error) => {
    throw error; // the built-in error handler returns string instead
  },
  execute: async () => {
    throw new Error('Failed to get weather');
  },
});

const stableTool = tool({
  name: 'get_weather (stable)',
  description: 'Get the weather for a given city',
  parameters: z.object({ city: z.string() }),
  execute: async (input) => {
    return `The weather in ${input.city} is sunny`;
  },
});

const agent = new Agent({
  name: 'Data agent',
  instructions: 'You are a data agent',
  tools: [unstableTool],
});

async function main() {
  try {
    const result = await run(agent, 'What is the weather in Tokyo?');
    console.log(result.finalOutput);
  } catch (e) {
    if (e instanceof ToolCallError) {
      console.error(`Tool call failed: ${e}`);
      // If you want to retry the execution with different settings,
      // you can reuse the runner's latest state this way:
      if (e.state) {
        agent.tools = [stableTool]; // fallback
        const result = await run(agent, e.state);
        console.log(result.finalOutput);
      }
    } else {
      throw e;
    }
  }
}

main().catch(console.error);
