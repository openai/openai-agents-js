import { Agent, run } from '@openai/agents';

async function main() {
  const agent = new Agent({
    name: 'Assistant',
    prompt: {
      promptId: 'pmpt_684b3b772e648193b92404d7d0101d8a07f7a7903e519946',
      version: '1',
      variables: {
        poem_style: 'limerick',
      },
    },
  });

  const result = await run(agent, 'Write about unrequited love.');
  console.log(result.finalOutput);
}

if (require.main === module) {
  main().catch(console.error);
}
