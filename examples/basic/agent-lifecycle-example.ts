import { Agent, run, tool } from '@openai/agents';
import { z } from 'zod';

const randomNumberTool = tool({
  name: 'random_number',
  description: 'Generate a random number up to the provided maximum.',
  parameters: z.object({ max: z.number() }),
  execute: async ({ max }: { max: number }) => {
    return Math.floor(Math.random() * (max + 1)).toString();
  },
});

const multiplyByTwoTool = tool({
  name: 'multiply_by_two',
  description: 'Simple multiplication by two.',
  parameters: z.object({ x: z.number() }),
  execute: async ({ x }: { x: number }) => {
    return (x * 2).toString();
  },
});

const multiplyAgent = new Agent({
  name: 'Multiply Agent',
  instructions: 'Multiply the number by 2 and then return the final result.',
  tools: [multiplyByTwoTool],
  outputType: z.object({ number: z.number() }),
});

const startAgent = new Agent({
  name: 'Start Agent',
  instructions:
    "Generate a random number. If it's even, stop. If it's odd, hand off to the multiply agent.",
  tools: [randomNumberTool],
  outputType: z.object({ number: z.number() }),
  handoffs: [multiplyAgent],
});

function attachHooks(agent: Agent<any, any>) {
  agent.on('agent_start', (_ctx, agent) => {
    console.log(`${agent.name} started`);
  });
  agent.on('agent_end', (_ctx, output) => {
    console.log(`${agent.name} ended with output ${output}`);
  });
  agent.on('agent_handoff', (_ctx, nextAgent) => {
    console.log(`${agent.name} handed off to ${nextAgent.name}`);
  });
  agent.on('agent_tool_start', (_ctx, tool) => {
    console.log(`${agent.name} started tool ${tool.name}`);
  });
  agent.on('agent_tool_end', (_ctx, tool, output) => {
    console.log(`${agent.name} tool ${tool.name} ended with output ${output}`);
  });
}

attachHooks(startAgent);
attachHooks(multiplyAgent);

async function main() {
  const result = await run(startAgent, 'Generate a random number up to 10');
  console.log(result.finalOutput);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
