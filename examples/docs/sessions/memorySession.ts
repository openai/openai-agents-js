import { Agent, MemorySession, run } from '@openai/agents/classic';

const agent = new Agent({
  name: 'TourGuide',
  instructions: 'Answer with compact travel facts.',
});

const session = new MemorySession();
const result = await run(agent, 'What city is the Golden Gate Bridge in?', {
  session,
});

console.log(result.finalOutput);
