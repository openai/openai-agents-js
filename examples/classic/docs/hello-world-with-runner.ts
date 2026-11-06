import { Agent, Runner } from '@openai/agents/classic';

const agent = new Agent({
  name: 'Assistant',
  instructions: 'You are a helpful assistant',
});

// You can pass custom configuration to the runner
const runner = new Runner();

const result = await runner.run(
  agent,
  'Write a haiku about recursion in programming.',
);
console.log(result.finalOutput);

// Code within the code,
// Functions calling themselves,
// Infinite loop's dance.
