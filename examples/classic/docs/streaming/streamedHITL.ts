import { createInterface } from 'node:readline/promises';
import { Agent, run, tool } from '@openai/agents/classic';
import { z } from 'zod';

const lookupOrder = tool({
  name: 'lookup_order',
  description: 'Look up the status of a sample order.',
  parameters: z.object({ orderId: z.string() }),
  needsApproval: true,
  execute: ({ orderId }) => `Sample order ${orderId} has shipped.`,
});

async function confirm(question: string): Promise<boolean> {
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await terminal.question(`${question} (y/n): `);
    return ['y', 'yes'].includes(answer.trim().toLowerCase());
  } finally {
    terminal.close();
  }
}

const agent = new Agent({
  name: 'Order assistant',
  instructions:
    'Use lookup_order to check the requested order. Respect a denial.',
  tools: [lookupOrder],
});

let stream = await run(agent, 'Look up order A123.', { stream: true });
stream.toTextStream({ compatibleWithNodeStreams: true }).pipe(process.stdout);
await stream.completed;

while (stream.interruptions?.length) {
  console.log(
    'Human-in-the-loop: approval required for the following tool calls:',
  );
  const state = stream.state;
  for (const interruption of stream.interruptions) {
    const approved = await confirm(
      `Agent ${interruption.agent.name} would like to use the tool ${interruption.name} with "${interruption.arguments}". Do you approve?`,
    );
    if (approved) {
      state.approve(interruption);
    } else {
      state.reject(interruption);
    }
  }

  // Resume execution with streaming output
  stream = await run(agent, state, { stream: true });
  const textStream = stream.toTextStream({ compatibleWithNodeStreams: true });
  textStream.pipe(process.stdout);
  await stream.completed;
}
