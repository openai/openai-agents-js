import {
  Agent,
  NativeProvider,
  tool,
  type NativeProviderOptions,
} from '@openai/agents';
import { z } from 'zod';

function lookupPrice(price: string) {
  return tool({
    name: 'lookup_price',
    description: 'Read the current price of a product.',
    parameters: z.strictObject({ product: z.string() }),
    execute: ({ product }) => `${product}: ${price} USD`,
  });
}

/** Replace a callback between completed turns without replacing the Session. */
export async function runToolUpdates(
  options: NativeProviderOptions = {},
): Promise<{ before: string; after: string }> {
  await using provider = new NativeProvider(options);
  const agent = new Agent({
    instructions:
      'Use lookup_price for every price question, then report the current price.',
    tools: [lookupPrice('5.00')],
    provider,
  });
  await using session = await agent.session();

  const first = await session.submit('What is the price of the notebook?');
  const before = await first.wait();

  // Replace the callback for the admitted name and await acknowledgement.
  await session.update({ tools: [lookupPrice('4.00')] });

  const second = await session.submit('What is the price of the notebook now?');
  const after = await second.wait();
  return { before: before.finalOutput, after: after.finalOutput };
}

// tsx runs these source examples as CommonJS in this checkout.
if (typeof require !== 'undefined' && require.main === module) {
  runToolUpdates({ baseUrl: process.env.OPENAI_BASE_URL }).then(
    ({ before, after }) => {
      console.log('Before:', before);
      console.log('After:', after);
    },
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
