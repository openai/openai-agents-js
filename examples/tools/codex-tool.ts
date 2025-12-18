import {
  Agent,
  run,
  withTrace,
  type RunItem,
  type RunToolCallOutputItem,
} from '@openai/agents';
import {
  codexTool,
  type CodexOutputSchemaDescriptor,
} from '@openai/agents-extensions';

type CodexToolOutput = {
  threadId: string | null;
  response: string;
  usage: Record<string, unknown> | null;
};

function ensureEnvironmentVariables(): void {
  const requiredVariables = ['OPENAI_API_KEY'];
  const missing = requiredVariables.filter((name) => !process.env[name]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`,
    );
  }
}

function isCodexToolOutputItem(
  item: RunItem,
): item is RunToolCallOutputItem & { output: CodexToolOutput } {
  if (item.type !== 'tool_call_output_item' || item.rawItem.name !== 'codex') {
    return false;
  }

  const output = item.output as unknown;
  if (typeof output !== 'object' || output === null) {
    return false;
  }

  const maybeOutput = output as Partial<CodexToolOutput>;
  return (
    typeof maybeOutput.response === 'string' &&
    (typeof maybeOutput.threadId === 'string' || maybeOutput.threadId === null)
  );
}

const codexStructuredOutput: CodexOutputSchemaDescriptor = {
  title: 'CodexToolResult',
  properties: [
    {
      name: 'summary',
      description: 'High-level summary of Codex actions and findings.',
      schema: {
        type: 'string',
      },
    },
    {
      name: 'commands',
      description:
        'Commands executed by Codex, in the order they were invoked.',
      schema: {
        type: 'array',
        items: {
          type: 'string',
        },
      },
    },
  ],
  required: ['summary'],
};

async function main(): Promise<void> {
  ensureEnvironmentVariables();

  const agent = new Agent({
    name: 'Codex tool orchestrator',
    instructions:
      'You route workspace automation tasks through the codex tool. Always call the codex tool at least once before responding, and use it to run commands or inspect files before summarizing the results.',
    tools: [codexTool({ outputSchema: codexStructuredOutput })],
  });

  const task =
    'Call the codex tool with an inputs array containing a text item that asks to run `ls -1` in the current directory, then summarize the output for the user.';

  const result = await withTrace('Codex tool example', async () => {
    console.log('Starting Codex tool run...\n');
    return run(agent, task);
  });

  console.log(`Agent response:\n${String(result.finalOutput ?? '')}\n`);

  const codexOutput = result.newItems.find(isCodexToolOutputItem);
  if (codexOutput) {
    const { threadId, response, usage } = codexOutput.output;
    console.log('Codex tool call returned:');
    console.log(`  Thread ID: ${threadId ?? 'not provided'}`);
    console.log(`  Response: ${response}`);
    if (usage) {
      console.log('  Usage:', usage);
    }
  } else {
    console.warn('The Codex tool did not produce a structured result.');
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
