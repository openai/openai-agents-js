import { text, toolCall, withScriptedResponses } from '@openai/agents/testing';
import { dirname, join } from 'node:path';
import { Agent, StdioMCP, type NativeProvider } from '@openai/agents';

/** The application owns the executable, selected file and raw tool names. */
export function catalogAgent(
  provider: NativeProvider,
  options: { audit?: string; selected?: string; failStart?: boolean } = {},
) {
  const peer = join(__dirname, 'catalog-stdio.mjs');
  const args = [peer];
  if (options.audit) args.push('--audit', options.audit);
  if (options.failStart) args.push('--fail-start');
  return new Agent({
    instructions: 'Use catalog lookup to read the price of SKU PAPER.',
    model: 'gpt-5.5',
    provider,
    tools: [
      new StdioMCP({
        name: 'catalog',
        command: process.execPath,
        args,
        cwd: dirname(peer),
        tools: [options.selected ?? 'lookup'],
        startupTimeout: 3,
        executionTimeout: 10,
      }),
    ],
  });
}

/** Join Session cleanup after completion, failure or a finite result deadline. */
export async function runCatalog(provider: NativeProvider) {
  await using session = await catalogAgent(provider).session({});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const turn = await session.submit('How much is PAPER?');
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('Recipe exceeded 20 seconds.')),
        20_000,
      );
    });
    const result = await Promise.race([turn.wait(), deadline]);
    const items = [];
    for await (const item of session.items()) items.push(item);
    return { finalOutput: result.finalOutput, items };
  } finally {
    clearTimeout(timer);
  }
}

/** Run the actual native catalog against a finite local model script. */
export async function scriptedCatalog() {
  return withScriptedResponses(
    [
      [
        toolCall(
          'lookup',
          { sku: 'PAPER' },
          { callId: 'lookup', namespace: 'mcp__catalog' },
        ),
      ],
      [text('It costs 5 dollars.')],
    ],
    async (peer) => {
      const result = await runCatalog(peer.provider);
      if (!peer.toolOutput('lookup')?.includes('PAPER: 5 dollars')) {
        throw new Error(
          'The catalog lookup did not return its synthetic price.',
        );
      }
      return result;
    },
  );
}

if (typeof require !== 'undefined' && require.main === module) {
  if (process.argv.slice(2).join(' ') !== '--mode scripted') {
    console.error('Usage: local-mcp.ts --mode scripted');
    process.exitCode = 1;
  } else {
    scriptedCatalog().then(
      (result) => console.log(result.finalOutput),
      (error: unknown) => {
        console.error(error);
        process.exitCode = 1;
      },
    );
  }
}
