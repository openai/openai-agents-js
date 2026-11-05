import { Agent, NativeProvider } from '@openai/agents';
import { agUiResponse } from './ag-ui';
import { ownedVercelResponse } from './vercel';

/** Print a fresh SSE response; this example does not start an HTTP server. */
async function main() {
  if (!process.env.OPENAI_API_KEY)
    throw new Error('Set OPENAI_API_KEY before running this live example.');
  const protocol = process.argv[2] ?? 'vercel';
  if (protocol !== 'vercel' && protocol !== 'ag-ui')
    throw new Error('Choose vercel or ag-ui.');
  await using provider = new NativeProvider();
  const agent = new Agent({
    name: 'Brief assistant',
    instructions: 'Answer briefly in plain text.',
    tools: [],
    provider,
  });
  if (protocol === 'vercel') {
    console.log(
      await (
        await ownedVercelResponse(agent, 'Explain why a rainbow appears.')
      ).text(),
    );
  } else {
    const outputType = agent.outputType;
    await using session = await agent.session();
    const turn = await session.submit('Explain why a rainbow appears.');
    console.log(await agUiResponse(turn, session, outputType).text());
  }
}

if (require.main === module)
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
