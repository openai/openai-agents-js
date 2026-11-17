import { Agent, MemorySession, run } from '@openai/agents';

const agent = new Agent({
  name: 'Assistant',
  instructions: 'Reply very concisely.',
});
const session = new MemorySession();

const first = await run(agent, 'What city is the Golden Gate Bridge in?', {
  session,
});
console.log(first.finalOutput);
// -> "San Francisco"

const second = await run(agent, 'What state is it in?', { session });
console.log(second.finalOutput);
// -> "California"
