import {
  Agent,
  MemorySession,
  OpenAIResponsesCompactionSession,
  run,
  withTrace,
} from '@openai/agents';
import { fetchImageData } from './tools';

async function main() {
  const session = new OpenAIResponsesCompactionSession({
    model: 'gpt-5.2',
    // If store: false in modelSettings, auto switches to input mode.
    // compactionMode: 'input',
    // Use a local session store because the server is stateless when store is false.
    underlyingSession: new MemorySession(),
    // Auto mode chooses input compaction when store is false.
    // Set a low threshold to observe compaction in action.
    shouldTriggerCompaction: ({ compactionCandidateItems }) =>
      compactionCandidateItems.length >= 4,
  });

  const agent = new Agent({
    name: 'Assistant',
    model: 'gpt-5.2',
    instructions:
      'Keep answers short. This example demonstrates responses.compact with input mode and store=false. For every user turn, call fetch_image_data with the provided label. Do not include raw image bytes or data URLs in your final answer.',
    modelSettings: {
      toolChoice: 'required',
      // When you disable store, auto compaction mode is used.
      store: false,
    },
    tools: [fetchImageData],
  });

  // To see compaction debug logs, run: DEBUG=openai-agents:openai:compaction pnpm -C examples/memory start:oai-compact-stateless.
  await withTrace('memory:compactSession:stateless', async () => {
    const prompts = [
      'Call fetch_image_data with label "alpha". Then explain compaction in 1 sentence.',
      'Call fetch_image_data with label "beta". Then add a fun fact about space in 1 sentence.',
      'Call fetch_image_data with label "gamma". Then add a fun fact about oceans in 1 sentence.',
      'Call fetch_image_data with label "delta". Then add a fun fact about volcanoes in 1 sentence.',
      'Call fetch_image_data with label "epsilon". Then add a fun fact about deserts in 1 sentence.',
    ];

    for (const prompt of prompts) {
      const result = await run(agent, prompt, { session });
      console.log(`\nUser: ${prompt}`);
      console.log(`Assistant: ${result.finalOutput}`);
      console.log(
        'Usage for the turn:',
        result.state.usage.requestUsageEntries,
      );
    }

    const compactedHistory = await session.getItems();
    console.log('\nHistory including compaction and newer items:');
    for (const item of compactedHistory) {
      console.log(`- ${item.type}`);
    }

    // You can manually run compaction without a response id in input mode.
    const compactionResult = await session.runCompaction({ force: true });
    console.log('Manual compaction result:', compactionResult);

    const finalHistory = await session.getItems();
    console.log('\nStored history after final compaction:');
    for (const item of finalHistory) {
      console.log(`- ${item.type}`);
    }
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
