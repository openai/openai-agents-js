/** Scoped function callback recipe: one caller-owned quota per run. */
import { Agent, NativeProvider, tool, type ToolContext } from '@openai/agents';
import { z } from 'zod';

interface Quota {
  remaining: number;
}

const lookup = tool({
  name: 'lookup',
  description: 'Look up information about a record.',
  parameters: z.object({ record: z.string() }),
  result: z.string(),
  before: ({ context }: ToolContext<Quota>) => {
    // Checking and spending a credit are synchronous, so calls sharing this
    // context in the event loop cannot spend the same credit.
    if (context.remaining === 0)
      return { action: 'deny', reason: 'Callback quota reached' };
    context.remaining -= 1;
    return { action: 'allow' };
  },
  execute: ({ record }) => `Information about ${record}`,
});

async function main() {
  await using provider = new NativeProvider();
  const agent = new Agent<Quota>({
    instructions: 'Use lookup to answer.',
    provider,
    tools: [lookup],
  });
  const result = await agent.run('Look up two records, then a third.', {
    context: { remaining: 2 },
  });
  console.log(result.finalOutput);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
