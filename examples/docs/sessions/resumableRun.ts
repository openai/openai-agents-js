import { Agent, MemorySession, Runner, tool } from '@openai/agents/classic';
import { z } from 'zod';

const searchItinerary = tool({
  name: 'search_itinerary',
  description: 'Search the sample itinerary.',
  parameters: z.object({}),
  needsApproval: true,
  execute: () => 'Sample itinerary: Paris, November 3.',
});

const agent = new Agent({
  name: 'Trip Planner',
  instructions: 'Use search_itinerary to find the sample itinerary.',
  tools: [searchItinerary],
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
