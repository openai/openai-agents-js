import { Agent, MemorySession, Runner } from '@openai/agents';

const agent = new Agent({
  name: 'Trip Planner',
  instructions: 'Plan trips and ask for approval before booking anything.',
});

const runner = new Runner();
const session = new MemorySession();

const result = await runner.run(agent, 'Search the itinerary', {
  session,
});

if (result.interruptions?.length) {
  // ... collect user feedback, then resume the agent in a later turn.
  for (const interruption of result.interruptions) {
    result.state.approve(interruption);
  }

  const continuation = await runner.run(agent, result.state, { session });
  console.log(continuation.finalOutput);
}
