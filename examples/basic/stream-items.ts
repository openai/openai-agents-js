import { Agent, run, tool } from '@openai/agents';
import { z } from 'zod';

// Tool that returns a random integer between 1 and 10
const howManyJokesTool = tool({
  name: 'how_many_jokes',
  description: 'Return a random integer between 1 and 10.',
  parameters: z.object({}),
  execute: async () => String(Math.floor(Math.random() * 10) + 1),
});

async function main() {
  const agent = new Agent({
    name: 'Joker',
    instructions:
      'First call the `how_many_jokes` tool, then tell that many jokes.',
    tools: [howManyJokesTool],
  });

  const stream = await run(agent, 'Hello', { stream: true });
  console.log('=== Run starting ===');
  for await (const event of stream.toStream()) {
    // We'll ignore the raw responses event deltas
    if (event.type === 'raw_model_stream_event') {
      continue;
    } else if (event.type === 'agent_updated_stream_event') {
      console.log(`Agent updated: ${event.agent.name}`);
      continue;
    } else if (event.type === 'run_item_stream_event') {
      if (event.item.type === 'tool_call_item') {
        console.log('-- Tool was called');
      } else if (event.item.type === 'tool_call_output_item') {
        console.log(`-- Tool output: ${event.item.output}`);
      } else if (event.item.type === 'message_output_item') {
        console.log(`-- Message output:\n ${event.item.content}`);
      }
    }
  }
  console.log('=== Run complete ===');
  //   === Run starting ===
  //   -- Tool was called
  //   -- Tool output: 7
  //   -- Message output:
  //    Hi! I’m about to tell you 7 jokes. Ready? Here we go:
  //
  //   1. Why don't skeletons fight each other? They don't have the guts!
  //
  //   2. Parallel lines have so much in common. It's a shame they'll never meet.
  //
  //   3. Why did the scarecrow win an award? Because he was outstanding in his field!
  //
  //   4. Why can't you give Elsa a balloon? Because she will let it go!
  //
  //   5. Why did the golfer bring two pairs of pants? In case he got a hole in one!
  //
  //   6. I told my wife she was drawing her eyebrows too high. She looked surprised.
  //
  //   7. Why are elevator jokes so classic and good? They work on many levels!
  //
  //   Hope that made you smile! Would you like a few more, or is there anything else I can do for you?
  //   === Run complete ===
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
