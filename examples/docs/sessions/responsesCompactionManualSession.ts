import {
  Agent,
  MemorySession,
  OpenAIResponsesCompactionSession,
  run,
} from '@openai/agents';

const agent = new Agent({
  name: 'Support',
  instructions: 'Answer briefly and keep track of prior context.',
  model: 'gpt-5.2',
});

// Disable auto-compaction to avoid delaying stream completion.
const session = new OpenAIResponsesCompactionSession({
  underlyingSession: new MemorySession(),
  shouldTriggerCompaction: () => false,
});

const result = await run(agent, 'Share the latest ticket update.', {
  session,
  stream: true,
});

// Wait for the streaming run to finish before compacting.
await result.completed;

// Choose force based on your own thresholds or heuristics, between turns or during idle time.
await session.runCompaction({ force: true });
