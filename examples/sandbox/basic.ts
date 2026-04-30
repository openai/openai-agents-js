import { run, type RunItem } from '@openai/agents';
import { Manifest, SandboxAgent, shell } from '@openai/agents/sandbox';
import {
  DockerSandboxClient,
  UnixLocalSandboxClient,
} from '@openai/agents/sandbox/local';
import {
  DEFAULT_DOCKER_IMAGE,
  DEFAULT_MODEL,
  ensureDockerAvailable,
  getStringArg,
  hasFlag,
  requireOpenAIKey,
  runExampleMain,
} from './support';

const DEFAULT_QUESTION = 'Summarize this sandbox project in 2 sentences.';
const DEFAULT_BASIC_DOCKER_IMAGE =
  process.env.SANDBOX_EXAMPLE_DOCKER_IMAGE ?? 'python:3.14-slim';

function buildManifest(backendLabel: string) {
  return new Manifest({
    entries: {
      'README.md': {
        type: 'file',
        content: `# Demo Project

This sandbox contains a tiny demo project for the ${backendLabel} sandbox runner.
The goal is to show how the SDK can prepare a sandbox workspace.
`,
      },
      'src/app.py': {
        type: 'file',
        content: `def greet(name: str) -> str:
    return f"Hello, {name}!"
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

  const useDocker = hasFlag('--docker');
  const model = getStringArg('--model', DEFAULT_MODEL);
  const question = getStringArg('--question', DEFAULT_QUESTION);
  const image = getStringArg(
    '--image',
    useDocker ? DEFAULT_BASIC_DOCKER_IMAGE : DEFAULT_DOCKER_IMAGE,
  );
  const backendLabel = useDocker ? 'Docker' : 'Unix-local';
  const manifest = buildManifest(backendLabel);
  const client = useDocker
    ? (() => {
        ensureDockerAvailable();
        return new DockerSandboxClient({ image });
      })()
    : new UnixLocalSandboxClient();
  const session = await client.create(manifest);

  const agent = new SandboxAgent({
    name: `${backendLabel} Sandbox Assistant`,
    model,
    instructions:
      'Answer questions about the sandbox workspace. Inspect the project once before answering, keep the response concise, do not guess file names like package.json or pyproject.toml, and remember that this demo intentionally contains a tiny workspace.',
    defaultManifest: manifest,
    capabilities: [shell()],
  });

  try {
    const result = await run(agent, question, { sandbox: { session } });
    const toolNames = getToolNames(result.newItems);
    if (!toolNames.includes('exec_command')) {
      throw new Error(`Expected exec_command, saw: ${toolNames.join(', ')}`);
    }
    console.log(`[backend] ${backendLabel}`);
    console.log(`[tools used] ${toolNames.join(', ')}`);
    console.log(result.finalOutput);
  } finally {
    await session.close?.().catch(() => {});
  }
}

await runExampleMain(main);
