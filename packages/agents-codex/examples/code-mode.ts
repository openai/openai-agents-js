import {
  Agent,
  NativeProvider,
  tool,
  type NativeProviderOptions,
} from '@openai/agents';
import { z } from 'zod';

/** Aggregate several application results in the bundled JavaScript Code Mode host. */
export async function runCodeMode(options: NativeProviderOptions = {}) {
  await using provider = new NativeProvider(options);
  const regionalSales = tool({
    name: 'regional_sales',
    description: 'Read synthetic sales rows; amounts are whole dollars.',
    parameters: z.strictObject({ region: z.enum(['north', 'south']) }),
    execute: ({ region }) =>
      region === 'north'
        ? [
            { product: 'pencil', amount: 12 },
            { product: 'paper', amount: 30 },
          ]
        : [
            { product: 'pencil', amount: 8 },
            { product: 'paper', amount: 20 },
          ],
  });
  const agent = new Agent({
    instructions:
      'Use JavaScript exec to call regional_sales for north and south. ' +
      'Parse the JSON tool strings, keep paper rows, and sum their amounts. ' +
      'Print the total from the code cell, then report it. Do not invent sales.',
    model: 'gpt-5.5',
    tools: [regionalSales],
    programmaticToolCalling: true,
    provider,
  });
  return (await agent.run('What are total paper sales across both regions?'))
    .finalOutput;
}

if (typeof require !== 'undefined' && require.main === module) {
  runCodeMode({ baseUrl: process.env.OPENAI_BASE_URL }).then(
    console.log,
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
