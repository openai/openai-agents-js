import { Agent, run } from '@openai/agents';

const url =
  'https://images.unsplash.com/photo-1505761671935-60b3a7427bad?auto=format&fit=crop&w=400&q=80';

async function main() {
  const agent = new Agent({
    name: 'Assistant',
    instructions: 'You are a helpful assistant.',
  });

  const result = await run(agent, [
    {
      role: 'user',
      content: [
        {
          type: 'input_image',
          image: url,
          providerData: {
            detail: 'auto',
          },
        },
      ],
    },
    {
      role: 'user',
      content: 'What do you see in this image?',
    },
  ]);

  console.log(result.finalOutput);
  // This image features the clock tower commonly known as Big Ben attached to the Palace of Westminster in London, captured against a clear blue sky. The ornate architecture and the clock face stand out prominently above surrounding buildings, with a hint of passing traffic below.
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
