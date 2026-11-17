import { Agent, run } from '@openai/agents';

const agent = new Agent({
  name: 'Assistant',
  instructions: 'Reply very concisely.',
});

const first = await run(agent, 'What city is the Golden Gate Bridge in?');
console.log(first.finalOutput);
// -> "San Francisco"

const second = await run(agent, [
  ...first.history,
  { role: 'user', content: 'What state is it in?' },
]);
console.log(second.finalOutput);
// -> "California"
