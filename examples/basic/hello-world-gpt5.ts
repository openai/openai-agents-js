import { Agent, run } from '@openai/agents';

async function main() {
  const agent = new Agent({
    name: 'GPT-5 Assistant',
    model: 'gpt-5',
    instructions: "You're a helpful assistant.",
    modelSettings: {
      providerData: {
        reasoning: { effort: 'minimal' },
        text: { verbosity: 'low' },
      },
    },
  });

  const result = await run(agent, 'Tell me about recursion in programming.');
  console.log(result.finalOutput);
}

if (require.main === module) {
  main().catch(console.error);
}
