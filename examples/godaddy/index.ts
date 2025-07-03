import { Agent, Runner } from '@openai/agents';
import { helloWorld } from '@openai/agents-extensions-godaddy';

const agent = new Agent({
  name: 'Assistant',
  instructions: 'You are a helpful assistant',
});

async function main() {
  const runner = new Runner({
    groupId: 'My group',
    traceMetadata: { user_id: '123' },
  });
  const result = await runner.run(
    agent,
    'Write a haiku about recursion in programming.',
  );

  console.log(result.finalOutput);

  const result2 = helloWorld();
  console.log(result2);
}

main();
