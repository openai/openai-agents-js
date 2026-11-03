import process from 'node:process';
import console from 'node:console';
import { Agent, NativeProvider, tool } from '@openai/agents';
import { z } from 'zod';

const provider = new NativeProvider({ baseUrl: process.env.OPENAI_BASE_URL });
try {
  const greeting = tool({
    name: 'greeting',
    description: 'Greet someone by name.',
    parameters: z.strictObject({ name: z.string() }),
    execute: async ({ name }) => `Hello, ${name}!`,
  });
  const agent = new Agent({
    instructions: 'Use greeting to greet Ada, then return the greeting.',
    tools: [greeting],
    provider,
  });
  console.log((await agent.run('Greet Ada.')).finalOutput);
} finally {
  await provider.close();
}
