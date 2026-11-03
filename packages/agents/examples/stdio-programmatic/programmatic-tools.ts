import {
  customToolCall,
  text,
  withScriptedResponses,
} from '@openai/agents/testing';
import { z } from 'zod';
import {
  Agent,
  tool,
  type NativeProvider,
  type ToolCallInfo,
  type ToolContext,
} from '@openai/agents';

export interface Sales {
  calls: ToolCallInfo[];
  regions: string[];
}

/** Application callbacks supply data; the bundled V8 host aggregates it. */
export function salesAgent(provider: NativeProvider) {
  return new Agent<Sales>({
    instructions:
      'Use JavaScript exec to call regional_sales for north and south. Parse the JSON tool strings, keep paper rows, sum their amounts and print the total. Report that total. Do not invent sales.',
    model: 'gpt-5.5',
    provider,
    programmaticToolCalling: true,
    tools: [
      tool({
        name: 'regional_sales',
        description: 'Read synthetic sales rows; amounts are whole dollars.',
        parameters: z.strictObject({ region: z.enum(['north', 'south']) }),
        execute({ region }, context: ToolContext<Sales>) {
          if (context.call) context.context.calls.push(context.call);
          context.context.regions.push(region);
          return region === 'north'
            ? [
                { product: 'pencil', amount: 12 },
                { product: 'paper', amount: 30 },
              ]
            : [
                { product: 'pencil', amount: 8 },
                { product: 'paper', amount: 20 },
              ];
        },
      }),
    ],
  });
}

export const aggregateCode = `
const north = JSON.parse(await tools.regional_sales({region: "north"}));
const south = JSON.parse(await tools.regional_sales({region: "south"}));
const paper = [...north, ...south].filter(row => row.product === "paper");
text(paper.reduce((sum, row) => sum + row.amount, 0));
`;

/** Join Session cleanup after completion, failure or a finite result deadline. */
export async function runSales(
  provider: NativeProvider,
  context: Sales = { calls: [], regions: [] },
) {
  await using session = await salesAgent(provider).session({ context });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const turn = await session.submit(
      'What are total paper sales across both regions?',
    );
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('Recipe exceeded 20 seconds.')),
        20_000,
      );
    });
    const result = await Promise.race([turn.wait(), deadline]);
    const items = [];
    for await (const item of session.items()) items.push(item);
    return { finalOutput: result.finalOutput, items, context };
  } finally {
    clearTimeout(timer);
  }
}

/** Script model selection while V8 and application tools execute normally. */
export async function scriptedSales() {
  return withScriptedResponses(
    [
      [customToolCall('exec', aggregateCode, { callId: 'aggregate' })],
      [text('Paper sales total 50 dollars.')],
    ],
    async (peer) => {
      const result = await runSales(peer.provider);
      if (
        result.context.regions.join(',') !== 'north,south' ||
        !peer.toolOutput('aggregate')?.includes('50')
      ) {
        throw new Error('The V8 cell did not aggregate both regional results.');
      }
      return result;
    },
  );
}

if (typeof require !== 'undefined' && require.main === module) {
  if (process.argv.slice(2).join(' ') !== '--mode scripted') {
    console.error('Usage: programmatic-tools.ts --mode scripted');
    process.exitCode = 1;
  } else {
    scriptedSales().then(
      (result) => console.log(result.finalOutput),
      (error: unknown) => {
        console.error(error);
        process.exitCode = 1;
      },
    );
  }
}
