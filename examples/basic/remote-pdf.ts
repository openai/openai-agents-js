import { Agent, run } from '@openai/agents';

const URL = 'https://www.berkshirehathaway.com/letters/2024ltr.pdf';

async function main() {
  const agent = new Agent({
    name: 'Assistant',
    instructions: 'You are a helpful assistant.',
  });

  const result = await run(agent, [
    {
      role: 'user',
      content: [{ type: 'input_file', file: URL }],
    },
    {
      role: 'user',
      content: 'Can you summarize the letter?',
    },
  ]);

  console.log(result.finalOutput);
}

if (require.main === module) {
  main().catch(console.error);
}
