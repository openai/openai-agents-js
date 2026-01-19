import { parseArgs } from 'node:util';
import { Agent, run } from '@openai/agents';

/*
NOTE: This example will not work out of the box, because the default prompt ID will not
be available in your project.

To use it, please:
1. Go to https://platform.openai.com/chat/edit
2. Create a new prompt variable, `poem_style`.
3. Create a system prompt with the content:
   Write a poem in {{poem_style}}
4. Run the example with the `--prompt-id` flag.
*/

const DEFAULT_PROMPT_ID =
  'pmpt_6965a984c7ac8194a8f4e79b00f838840118c1e58beb3332';
const POEM_STYLES = ['limerick', 'haiku', 'ballad'];

function pickPoemStyle(): string {
  return POEM_STYLES[Math.floor(Math.random() * POEM_STYLES.length)];
}

async function runDynamic(promptId: string) {
  const poemStyle = pickPoemStyle();
  console.log(`[debug] Dynamic poem_style: ${poemStyle}`);

  const agent = new Agent({
    name: 'Assistant',
    prompt: {
      promptId,
      version: '1',
      variables: { poem_style: poemStyle },
    },
  });

  const result = await run(agent, 'Tell me about recursion in programming.');
  console.log(result.finalOutput);
}

async function runStatic(promptId: string) {
  const agent = new Agent({
    name: 'Assistant',
    prompt: {
      promptId,
      version: '1',
      variables: { poem_style: 'limerick' },
    },
  });

  const result = await run(agent, 'Tell me about recursion in programming.');
  console.log(result.finalOutput);
}

async function main() {
  const args = parseArgs({
    options: {
      dynamic: { type: 'boolean', default: false },
      'prompt-id': { type: 'string', default: DEFAULT_PROMPT_ID },
    },
  });

  const promptId = args.values['prompt-id'];
  if (!promptId) {
    console.error('Please provide a prompt ID via --prompt-id.');
    process.exit(1);
  }

  if (args.values.dynamic) {
    await runDynamic(promptId);
  } else {
    await runStatic(promptId);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
