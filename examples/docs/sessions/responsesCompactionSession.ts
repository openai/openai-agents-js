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

// Wrap any Session to trigger responses.compact once history grows beyond your threshold.
const session = new OpenAIResponsesCompactionSession({
  // You can pass any Session implementation except OpenAIConversationsSession
  underlyingSession: new MemorySession(),
  // (optional) The model used for calling responses.compact API
  model: 'gpt-5.2',
  // (optional) your custom logic here
  shouldTriggerCompaction: ({ compactionCandidateItems }) => {
    return compactionCandidateItems.length >= 12;
  },
});

await run(agent, 'Summarize order #8472 in one sentence.', { session });
await run(agent, 'Remind me of the shipping address.', { session });

// Compaction runs automatically after each persisted turn. You can also force it manually.
await session.runCompaction({ force: true });
