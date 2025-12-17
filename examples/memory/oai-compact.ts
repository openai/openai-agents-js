import {
  Agent,
  OpenAIResponsesCompactionSession,
  run,
  withTrace,
} from '@openai/agents';
import { fetchImageData } from './tools';
import { FileSession } from './sessions';

async function main() {
  const session = new OpenAIResponsesCompactionSession({
    model: 'gpt-5.2',
    // This compaction decorator handles only compaction logic.
    // The underlying session is responsible for storing the history.
    underlyingSession: new FileSession(),
    // (optional customization) This example demonstrates the simplest compaction logic,
    // but you can also estimate the context window size using sessionItems (all items)
    // and trigger compaction at the optimal time.
    shouldTriggerCompaction: ({ compactionCandidateItems }) => {
      // Set a low threshold to observe compaction in action.
      return compactionCandidateItems.length >= 4;
    },
  });

  const agent = new Agent({
    name: 'Assistant',
    model: 'gpt-5.2',
    instructions:
      'Keep answers short. This example demonstrates responses.compact with a custom session. For every user turn, call fetch_image_data with the provided label. Do not include raw image bytes or data URLs in your final answer.',
    modelSettings: { toolChoice: 'required' },
    tools: [fetchImageData],
  });

  // To see compaction debug logs, run with:
  // DEBUG=openai-agents:openai:compaction pnpm -C examples/memory start:oai-compact
  await withTrace('memory:compactSession:main', async () => {
    const prompts = [
      'Call fetch_image_data with label "alpha". Then explain compaction in 1 sentence.',
      'Call fetch_image_data with label "beta". Then add a fun fact about space in 1 sentence.',
      'Call fetch_image_data with label "gamma". Then add a fun fact about oceans in 1 sentence.',
      'Call fetch_image_data with label "delta". Then add a fun fact about volcanoes in 1 sentence.',
      'Call fetch_image_data with label "epsilon". Then add a fun fact about deserts in 1 sentence.',
    ];

    for (const prompt of prompts) {
      const result = await run(agent, prompt, { session, stream: true });
      console.log(`\nUser: ${prompt}`);

      for await (const event of result.toStream()) {
        if (event.type === 'raw_model_stream_event') {
          continue;
        }
        if (event.type === 'agent_updated_stream_event') {
          continue;
        }
        if (event.type !== 'run_item_stream_event') {
          continue;
        }

        if (event.item.type === 'tool_call_item') {
          const toolName = (event.item as any).rawItem?.name;
          console.log(`-- Tool called: ${toolName ?? '(unknown)'}`);
        } else if (event.item.type === 'tool_call_output_item') {
          console.log(
            `-- Tool output: ${formatToolOutputForLog((event.item as any).output)}`,
          );
        } else if (event.item.type === 'message_output_item') {
          console.log(`Assistant: ${event.item.content.trim()}`);
        }
      }
      console.log(
        'Usage for the turn:',
        result.state.usage.requestUsageEntries,
      );
    }

    const compactedHistory = await session.getItems();
    console.log('\nHitory including both compaction and newer items:');
    for (const item of compactedHistory) {
      console.log(`- ${item.type}`);
    }

    // You can manually run compaction this way:
    const compactionResult = await session.runCompaction({ force: true });
    console.log('Manual compaction result:', compactionResult);

    const finalHistory = await session.getItems();
    console.log('\nStored history after final compaction:');
    for (const item of finalHistory) {
      console.log(`- ${item.type}`);
    }
  });
}

function formatToolOutputForLog(output: unknown): string {
  if (output === null) {
    return 'null';
  }
  if (output === undefined) {
    return 'undefined';
  }
  if (typeof output === 'string') {
    return output.length > 200 ? `${output.slice(0, 200)}…` : output;
  }
  if (Array.isArray(output)) {
    const parts = output.map((part) => formatToolOutputPartForLog(part));
    return `[${parts.join(', ')}]`;
  }
  if (typeof output === 'object') {
    const keys = Object.keys(output as Record<string, unknown>).sort();
    return `{${keys.slice(0, 10).join(', ')}${keys.length > 10 ? ', …' : ''}}`;
  }
  return String(output);
}

function formatToolOutputPartForLog(part: unknown): string {
  if (!part || typeof part !== 'object') {
    return String(part);
  }
  const record = part as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : 'unknown';
  if (type === 'text' && typeof record.text === 'string') {
    return `text(${record.text.length} chars)`;
  }
  if (type === 'image' && typeof record.image === 'string') {
    return `image(${record.image.length} chars)`;
  }
  return type;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
