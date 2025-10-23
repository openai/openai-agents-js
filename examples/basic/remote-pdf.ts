import { Agent, run } from '@openai/agents';

const url = 'https://www.berkshirehathaway.com/letters/2024ltr.pdf';

async function main() {
  const agent = new Agent({
    name: 'Assistant',
    instructions: 'You are a helpful assistant.',
  });

  const result = await run(agent, [
    {
      role: 'user',
      content: [{ type: 'input_file', file: url }],
    },
    {
      role: 'user',
      content: 'Can you summarize the letter?',
    },
  ]);

  console.log(result.finalOutput);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
