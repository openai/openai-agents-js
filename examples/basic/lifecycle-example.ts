import { Agent, run, tool, Usage } from '@openai/agents';
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
  let eventCounter = 0;
  function toPrintableUsage(usage: Usage): string {
    if (!usage) return 'No usage info';
    return (
      `${usage.requests ?? 0} requests, ` +
      `${usage.inputTokens ?? 0} input tokens, ` +
      `${usage.outputTokens ?? 0} output tokens, ` +
      `${usage.totalTokens ?? 0} total tokens`
    );
  }

  agent.on('agent_start', (ctx, agent) => {
    eventCounter++;
    console.log(
      `### ${eventCounter}: ${agent.name} started. Usage: ${toPrintableUsage(ctx?.usage)}`,
    );
  });
  agent.on('agent_end', (ctx, output) => {
    eventCounter++;
    console.log(
      `### ${eventCounter}: ${agent.name} ended with output ${JSON.stringify(output)}. Usage: ${toPrintableUsage(ctx?.usage)}`,
    );
  });
  agent.on('agent_tool_start', (ctx, tool, { toolCall }) => {
    eventCounter++;
    const args = toolCall.type === 'function_call' ? toolCall.arguments : '';
    console.log(
      `### ${eventCounter}: Tool ${tool.name} (args: ${args}) started. Usage: ${toPrintableUsage(ctx?.usage)}`,
    );
  });
  agent.on('agent_tool_end', (ctx, tool, result, { toolCall }) => {
    eventCounter++;
    const args = toolCall.type === 'function_call' ? toolCall.arguments : '';
    console.log(
      `### ${eventCounter}: Tool ${tool.name} (args: ${args}) ended with result ${JSON.stringify(result)}. Usage: ${toPrintableUsage(ctx?.usage)}`,
    );
  });
  agent.on('agent_handoff', (ctx, nextAgent) => {
    eventCounter++;
    console.log(
      `### ${eventCounter}: Handoff from ${agent.name} to ${nextAgent.name}. Usage: ${toPrintableUsage(ctx?.usage)}`,
    );
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
