import {
  Agent,
  MemorySession,
  OpenAIResponsesCompactionSession,
  run,
} from '@openai/agents';

const agent = new Agent({
  name: 'Support',
  instructions: 'Answer briefly and keep track of prior context.',
});

// Disable auto-compaction to avoid delaying stream completion.
const session = new OpenAIResponsesCompactionSession({
  underlyingSession: new MemorySession(),
  shouldTriggerCompaction: () => false,
});

const result = await run(
  agent,
  'Ticket #1234 is waiting for a callback. Acknowledge the update.',
  { session, stream: true },
);

// Wait for the streaming run to finish before compacting.
await result.completed;

// Choose force based on your own thresholds or heuristics, between turns or during idle time.
await session.runCompaction({ force: true });

const followup = await run(agent, 'What is the status of ticket #1234?', {
  session,
});
console.log(followup.finalOutput);
