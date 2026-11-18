import { Agent, MemorySession, Runner, tool } from '@openai/agents';
import { z } from 'zod';

const previewItinerary = tool({
  name: 'preview_itinerary',
  description: 'Create a simulated itinerary preview. This never books a trip.',
  parameters: z.object({ destination: z.string() }),
  needsApproval: true,
  execute: async ({ destination }) => {
    console.log('[tool] Creating a simulated itinerary preview.');
    // Use a fixed synthetic identifier so the follow-up can recall it.
    return { preview_id: 'preview-paris', destination, booked: false };
  },
});

const agent = new Agent({
  name: 'Trip Planner',
  instructions:
    'For a new trip preview, call preview_itinerary once before responding. Explain that it is a simulation and nothing was booked. For follow-up questions, use the conversation history instead of calling the tool again.',
  tools: [previewItinerary],
});

const runner = new Runner();
const session = new MemorySession();
const result = await runner.run(agent, 'Preview a trip to Paris.', { session });

if (!result.interruptions.length) {
  throw new Error('Expected the itinerary preview to pause for approval.');
}
console.log('Paused for approval.');

// Simulate an explicit human decision for this preview; replace with your UI input.
const simulatedApproval = true;
for (const interruption of result.interruptions) {
  if (simulatedApproval) result.state.approve(interruption);
  else result.state.reject(interruption);
}

// Resume the same run and keep using the same session.
const continuation = await runner.run(agent, result.state, { session });
console.log('Resumed:', continuation.finalOutput);

const followUp = await runner.run(
  agent,
  'What preview ID did we just create? Answer from the conversation history.',
  { session },
);
console.log('Follow-up:', followUp.finalOutput);
