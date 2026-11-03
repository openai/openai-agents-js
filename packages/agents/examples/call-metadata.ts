import { z } from 'zod';
import { Agent, tool } from '@openai/agents';

/** Run with the application's normal provider credentials. */
async function main() {
  const agent = new Agent({
    instructions: 'Use lookup to read a key.',
    model: 'gpt-5.5',
    tools: [
      tool({
        name: 'lookup',
        parameters: z.object({ key: z.string() }),
        execute({ key }, context) {
          if (context.call) {
            console.log({
              tool: context.call.tool.name,
              route: context.call.route,
              providerCallId: context.call.callId,
              nestedCallId: context.call.nestedCallId,
            });
          }
          return { key, found: true };
        },
      }),
    ],
  });
  try {
    const result = await agent.run('Read the example key.');
    console.log(result.finalOutput);
  } finally {
    await agent.provider.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
