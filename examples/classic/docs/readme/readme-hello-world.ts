import { Agent, run } from '@openai/agents/classic';

async function main() {
  const agent = new Agent({
    name: 'Assistant',
    instructions: 'You are a helpful assistant',
  });
  const result = await run(
    agent,
    'Write a haiku about recursion in programming.',
  );
  console.log(result.finalOutput);
  // Code within the code,
  // Functions calling themselves,
  // Infinite loop's dance.
}

main().catch(console.error);
