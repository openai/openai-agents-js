import { Agent, run } from '@openai/agents';

async function main() {
  const agent = new Agent({
    name: 'Assistant',
    prompt: {
      promptId: 'pmpt_68d50b26524c81958c1425070180b5e10ab840669e470fc7',
      variables: { name: 'Kaz' },
    },
  });

  const result = await run(agent, 'What is your name?');
  console.log(result.finalOutput);
}

if (require.main === module) {
  main().catch(console.error);
}
