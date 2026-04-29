import { run, type RunItem } from '@openai/agents';
import { Manifest, SandboxAgent, shell } from '@openai/agents/sandbox';
import { DockerSandboxClient } from '@openai/agents/sandbox/local';
import {
  DEFAULT_DOCKER_IMAGE,
  DEFAULT_MODEL,
  ensureDockerAvailable,
  getStringArg,
  requireOpenAIKey,
  runExampleMain,
} from './support';

const DEFAULT_QUESTION = 'Summarize this sandbox project in 2 sentences.';
const MAX_STREAM_TOOL_OUTPUT_CHARS = 2000;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function formatToolArguments(rawItem: unknown): string | undefined {
  const item = asRecord(rawItem);
  const argumentsValue = item?.arguments;
  if (typeof argumentsValue === 'string' && argumentsValue.length > 0) {
    return argumentsValue;
  }

  const action = asRecord(item?.action);
  const commands = action?.commands;
  if (!Array.isArray(commands)) {
    return undefined;
  }

  const commandText = commands
    .filter((command): command is string => typeof command === 'string')
    .join('; ');
  return commandText.length > 0 ? commandText : undefined;
}

function formatToolCall(rawItem: unknown): string {
  const item = asRecord(rawItem);
  const name = typeof item?.name === 'string' ? item.name : 'tool';
  const argumentsText = formatToolArguments(rawItem);
  return argumentsText
    ? `[tool call] ${name}: ${argumentsText}`
    : `[tool call] ${name}`;
}

function formatToolOutput(output: unknown): string {
  let outputText = String(output);
  if (outputText.length > MAX_STREAM_TOOL_OUTPUT_CHARS) {
    outputText = `${outputText.slice(0, MAX_STREAM_TOOL_OUTPUT_CHARS)}...`;
  }
  return outputText.length > 0
    ? `[tool output]\n${outputText}`
    : '[tool output]';
}

function getToolNames(items: RunItem[]): string[] {
  return items.flatMap((item) => {
    if (item.type !== 'tool_call_item') {
      return [];
    }

    const rawItem = asRecord(item.rawItem);
    return typeof rawItem?.name === 'string' ? [rawItem.name] : [];
  });
}

function buildManifest() {
  return new Manifest({
    entries: {
      'README.md': {
        type: 'file',
        content: `# Demo Project

This sandbox contains a tiny demo project for the Docker sandbox runner.
The goal is to show how Runner can prepare a Docker-backed workspace.
`,
      },
      'src/app.mjs': {
        type: 'file',
        content: `export function greet(name) {
  return \`Hello, \${name}!\`;
}
`,
      },
      'docs/notes.md': {
        type: 'file',
        content: `# Notes

- The example is intentionally minimal.
- The model should inspect files through the shell tool.
`,
      },
    },
  });
}

async function main() {
  requireOpenAIKey();
  ensureDockerAvailable();

  const model = getStringArg('--model', DEFAULT_MODEL);
  const question = getStringArg('--question', DEFAULT_QUESTION);
  const image = getStringArg('--image', DEFAULT_DOCKER_IMAGE);
  const manifest = buildManifest();
  const client = new DockerSandboxClient({ image });
  const session = await client.create(manifest);

  const agent = new SandboxAgent({
    name: 'Docker Sandbox Assistant',
    model,
    instructions:
      'Answer questions about the sandbox workspace. Inspect the project before answering, keep the response concise, and do not guess file names like package.json or pyproject.toml. This demo intentionally contains a tiny workspace.',
    defaultManifest: manifest,
    capabilities: [shell()],
    modelSettings: {
      toolChoice: 'required',
    },
  });

  try {
    console.log(`[image] ${image}`);

    const stream = await run(agent, question, {
      stream: true,
      sandbox: { session },
    });

    let sawTextDelta = false;
    let sawAnyText = false;

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

      if (
        event.name === 'tool_called' &&
        event.item.type === 'tool_call_item'
      ) {
        console.log(formatToolCall(event.item.rawItem));
        continue;
      }

      if (
        event.name === 'tool_output' &&
        event.item.type === 'tool_call_output_item'
      ) {
        console.log(formatToolOutput(event.item.output));
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
    if (!toolNames.includes('exec_command')) {
      throw new Error(`Expected exec_command, saw: ${toolNames.join(', ')}`);
    }
  } finally {
    await session.close?.().catch(() => {});
  }
}

await runExampleMain(main);
