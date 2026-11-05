import {
  Agent,
  NativeProvider,
  tool,
  type NativeProviderOptions,
} from '@openai/agents';
import { z } from 'zod';

/** Run one greeting with a provider owned by this example. */
export async function runGreeting(
  options: NativeProviderOptions = {},
): Promise<string> {
  await using provider = new NativeProvider(options);
  const greeting = tool({
    name: 'greeting',
    description: 'Greet someone by name.',
    parameters: z.strictObject({ name: z.string() }),
    execute: async ({ name }) => `Hello, ${name}!`,
  });
  const agent = new Agent({
    name: 'Assistant',
    instructions: 'Use greeting to greet the user.',
    tools: [greeting],
    provider,
  });
  const result = await agent.run('Greet Ada.');
  return result.finalOutput;
}

// tsx runs these source examples as CommonJS in this checkout.
if (typeof require !== 'undefined' && require.main === module) {
  runGreeting({ baseUrl: process.env.OPENAI_BASE_URL }).then(
    (greeting) => console.log(greeting),
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
