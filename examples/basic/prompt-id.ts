import { parseArgs } from 'node:util';
import { Agent, RunContext, Runner } from '@openai/agents';
import { exampleRunner } from '../tools/example-runner';

/*
NOTE: This example will not work out of the box, because the default prompt ID will not
be available in your project.

To use it, please:
1. Go to https://platform.openai.com/chat/edit
2. Create a new prompt variable, `poem_style`.
3. Create a system prompt with the content:
   Write a poem in {{poem_style}}
4. Run the example with the `--prompt-id` flag.

For an application-owned template that works with either model provider, use
`--local` (optionally with `--dynamic`). Add `--codex` to use stock Codex.
This does not look up a hosted prompt ID; hosted IDs require the default provider.
See https://developers.openai.com/api/docs/guides/prompting/migrate-from-prompt-object
*/

const DEFAULT_PROMPT_ID =
  'pmpt_6965a984c7ac8194a8f4e79b00f838840118c1e58beb3332';
const POEM_STYLES = ['limerick', 'haiku', 'ballad'] as const;
type PoemStyle = (typeof POEM_STYLES)[number];

function pickPoemStyle(): PoemStyle {
  return POEM_STYLES[Math.floor(Math.random() * POEM_STYLES.length)];
}

interface PoemContext {
  poemStyle: PoemStyle;
}

function localInstructions(style: PoemStyle): string {
  const lines = { limerick: 5, haiku: 3, ballad: 8 }[style];
  return `Reply only with a ${style} poem about the user's topic in exactly ${lines} lines, without an explanation or heading.`;
}

async function runLocal(runner: Runner, dynamic: boolean) {
  const context: PoemContext = {
    poemStyle: dynamic ? pickPoemStyle() : 'limerick',
  };
  console.log(`[debug] Local poem_style: ${context.poemStyle}`);
  const agent = new Agent<PoemContext>({
    name: 'Assistant',
    instructions: dynamic
      ? (runContext: RunContext<PoemContext>) =>
          localInstructions(runContext.context.poemStyle)
      : localInstructions(context.poemStyle),
  });
  const result = await runner.run(
    agent,
    'Tell me about recursion in programming.',
    {
      context,
    },
  );
  console.log(result.finalOutput);
}

async function runDynamic(runner: Runner, promptId: string) {
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

  const result = await runner.run(
    agent,
    'Tell me about recursion in programming.',
  );
  console.log(result.finalOutput);
}

async function runStatic(runner: Runner, promptId: string) {
  const agent = new Agent({
    name: 'Assistant',
    prompt: {
      promptId,
      version: '1',
      variables: { poem_style: 'limerick' },
    },
  });

  const result = await runner.run(
    agent,
    'Tell me about recursion in programming.',
  );
  console.log(result.finalOutput);
}

async function main() {
  const args = parseArgs({
    options: {
      dynamic: { type: 'boolean', default: false },
      'prompt-id': { type: 'string' },
      local: { type: 'boolean', default: false },
      codex: { type: 'boolean', default: false },
    },
  });

  if (args.values.local) {
    if (args.values['prompt-id'] !== undefined) {
      throw new Error('--local cannot be combined with --prompt-id.');
    }
    const runner = await exampleRunner(Boolean(args.values.codex));
    await runLocal(runner, Boolean(args.values.dynamic));
    return;
  }

  const promptId = args.values['prompt-id'] ?? DEFAULT_PROMPT_ID;
  if (!promptId) {
    console.error('Please provide a prompt ID via --prompt-id.');
    process.exit(1);
  }

  const runner = await exampleRunner(Boolean(args.values.codex));
  if (args.values.dynamic) {
    await runDynamic(runner, promptId);
  } else {
    await runStatic(runner, promptId);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
