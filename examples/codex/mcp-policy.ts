import { Agent, HttpMCP, NativeProvider } from '@openai/agents';

type Context = { allowedKeys: ReadonlySet<string> };

async function main() {
  const url = process.env.MCP_URL;
  if (!url) throw new Error('Set MCP_URL to your record server.');
  const records = new HttpMCP<Context>({
    name: 'records',
    url,
    tools: ['lookup'],
    approvalMode: 'preapproved',
    before({ originalArguments }) {
      const key = originalArguments.key;
      if (typeof key !== 'string') return { action: 'allow' };
      return {
        action: 'replaceArguments',
        arguments: { key: `public:${key}` },
      };
    },
    approval({ context, effectiveArguments, signal }) {
      signal.throwIfAborted();
      if (effectiveArguments.key === 'public:blocked') {
        // Request an explicit turn stop instead of local denial.
        return { action: 'stop', reason: 'Application record policy' };
      }
      return (
        typeof effectiveArguments.key === 'string' &&
        context.allowedKeys.has(effectiveArguments.key)
      );
    },
  });
  const agent = new Agent<Context>({
    instructions: 'Use records.lookup to read the requested key.',
    model: 'gpt-5.5',
    provider: new NativeProvider({ baseUrl: process.env.OPENAI_BASE_URL }),
    tools: [records],
  });
  try {
    const result = await agent.run('Read the example record.', {
      context: { allowedKeys: new Set(['public:example']) },
    });
    console.log(result.finalOutput);
  } finally {
    await agent.provider.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
