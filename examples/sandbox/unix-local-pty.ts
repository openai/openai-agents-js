import { run, type RunItem } from '@openai/agents';
import { Manifest, shell, SandboxAgent } from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents/sandbox/local';
import {
  DEFAULT_MODEL,
  getStringArg,
  requireOpenAIKey,
  runExampleMain,
} from './support';

const DEFAULT_QUESTION =
  'Start a long-running Node.js process with tty=true, login=false, and shell=/bin/sh that reads newline-delimited expressions from stdin and prints the evaluated result for each line. In that same session, send `5 + 5`, then `10 + 5`, exit cleanly, and briefly report the outputs.';

function getToolCallName(rawItem: {
  name?: unknown;
  callId?: unknown;
  id?: unknown;
}): string {
  return typeof rawItem.name === 'string' ? rawItem.name : 'tool';
}

function getToolCallId(rawItem: {
  callId?: unknown;
  id?: unknown;
}): string | undefined {
  if (typeof rawItem.callId === 'string' && rawItem.callId.length > 0) {
    return rawItem.callId;
  }
  return typeof rawItem.id === 'string' && rawItem.id.length > 0
    ? rawItem.id
    : undefined;
}

function extractSessionId(output: string): number | null {
  const match = output.match(/Process running with session ID (\d+)/);
  if (!match) {
    return null;
  }
  return Number.parseInt(match[1] ?? '', 10);
}

function getToolNames(items: RunItem[]): string[] {
  return items.flatMap((item) => {
    if (item.type !== 'tool_call_item') {
      return [];
    }

    const rawItem = item.rawItem as { name?: unknown };
    return typeof rawItem.name === 'string' ? [rawItem.name] : [];
  });
}

async function main() {
  requireOpenAIKey();

  const model = getStringArg('--model', DEFAULT_MODEL);
  const question = getStringArg('--question', DEFAULT_QUESTION);
  const manifest = new Manifest({
    entries: {
      'README.md': {
        type: 'file',
        content: `# Unix-local PTY Agent Example

This workspace is used by examples/sandbox/unix-local-pty.ts.
`,
      },
    },
  });

  const client = new UnixLocalSandboxClient();
  const session = await client.create(manifest);

  const agent = new SandboxAgent({
    name: 'Unix-local PTY Demo',
    model,
    instructions:
      'Complete the task through the shell capability. Keep the final answer concise. When process state matters, start a single interactive program with tty=true and continue using write_stdin instead of launching a second process. Use login=false and shell=/bin/sh to avoid shell startup noise. Prefer a long-running Node.js process that reads lines from stdin and prints results, rather than relying on a terminal-specific REPL prompt. The shell already starts in the workspace root, so use relative paths instead of changing to /workspace.',
    defaultManifest: manifest,
    capabilities: [shell()],
  });

  try {
    const stream = await run(agent, question, {
      stream: true,
      sandbox: { session },
    });

    let sawTextDelta = false;
    let sawAnyText = false;
    const toolNamesByCallId = new Map<string, string>();

    for await (const event of stream) {
      if (
        event.type === 'raw_model_stream_event' &&
        event.data.type === 'output_text_delta'
      ) {
        if (!sawTextDelta) {
          process.stdout.write('assistant> ');
          sawTextDelta = true;
        }
        process.stdout.write(event.data.delta);
        sawAnyText = true;
        continue;
      }

      if (event.type !== 'run_item_stream_event') {
        continue;
      }

      if (sawTextDelta) {
        process.stdout.write('\n');
        sawTextDelta = false;
      }

      if (event.name === 'tool_called') {
        const rawItem = event.item.rawItem as {
          name?: unknown;
          callId?: unknown;
          id?: unknown;
        };
        const toolName = getToolCallName(rawItem);
        const callId = getToolCallId(rawItem);
        if (callId && toolName) {
          toolNamesByCallId.set(callId, toolName);
        }
        console.log(`[tool call] ${toolName}`);
        continue;
      }

      if (
        event.name === 'tool_output' &&
        event.item.type === 'tool_call_output_item'
      ) {
        const rawItem = event.item.rawItem as {
          callId?: unknown;
          id?: unknown;
        };
        const callId = getToolCallId(rawItem);
        const toolName = toolNamesByCallId.get(callId ?? '') ?? 'tool';
        const sessionId = extractSessionId(String(event.item.output));
        const suffix = sessionId === null ? '' : ` (session ${sessionId})`;
        console.log(`[tool output] ${toolName}${suffix}`);
      }
    }

    await stream.completed;

    if (sawTextDelta) {
      process.stdout.write('\n');
    }
    if (!sawAnyText) {
      console.log(stream.finalOutput);
    }

    const toolNames = getToolNames(stream.newItems);
    if (
      !toolNames.includes('exec_command') ||
      !toolNames.includes('write_stdin')
    ) {
      throw new Error(
        `Expected exec_command and write_stdin, saw: ${toolNames.join(', ')}`,
      );
    }
  } finally {
    await session.close?.().catch(() => {});
  }
}

await runExampleMain(main);
