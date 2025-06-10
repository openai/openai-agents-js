import { styleText } from 'node:util';
import { Agent, run } from '@openai/agents';

const ASSISTANT_PREFIX = styleText(['bgGreen', 'black'], 'Assistant');
const THINKING_PREFIX = styleText(['bgGray', 'black'], 'Thought');

async function main() {
  const agent = new Agent({
    name: 'Agent',
    model: 'o3',
    modelSettings: {
      providerData: {
        reasoning: {
          effort: 'high',
          summary: 'auto',
        },
      },
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
