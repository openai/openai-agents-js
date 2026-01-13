import { styleText } from 'node:util';
import { Agent, run } from '@openai/agents';

const ASSISTANT_PREFIX = styleText(['bgGreen', 'black'], 'Assistant');
const THINKING_PREFIX = styleText(['bgGray', 'black'], 'Thought');

async function main() {
  const agent = new Agent({
    name: 'Agent',
    model: process.env.REASONING_MODEL_NAME || 'gpt-5.2',
    modelSettings: {
      reasoning: { effort: 'high', summary: 'auto' },
      text: { verbosity: 'high' },
    },
  });

  const result = await run(agent, 'How many r are in strawberry?');

  for (const item of result.newItems) {
    if (item.type === 'reasoning_item') {
      for (const entry of item.rawItem.content) {
        if (entry.type === 'input_text') {
          console.log(`${THINKING_PREFIX}: ${entry.text}`);
        }
      }
    }
  }

  console.log(`${ASSISTANT_PREFIX}: ${result.finalOutput}`);
}

main().catch(console.error);
