import { Agent, NativeProvider, webSearch } from '@openai/agents';

async function main() {
  await using provider = new NativeProvider();
  const researcher = new Agent({
    instructions:
      'Research the question using the admitted search tool. Attribute facts to the sources actually returned.',
    model: 'gpt-5.5',
    provider,
    tools: [webSearch({ mode: 'cached', route: 'standalone' })],
  });
  const result = await researcher.run(
    process.argv[2] ??
      'Find the official Node.js documentation for async disposal.',
  );
  console.log(result.finalOutput);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
