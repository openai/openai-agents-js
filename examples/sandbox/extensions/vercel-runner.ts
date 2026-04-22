import { Runner } from '@openai/agents';
import {
  VercelSandboxClient,
  type VercelWorkspacePersistence,
} from '@openai/agents-extensions/sandbox/vercel';
import { Manifest, SandboxAgent, shell } from '@openai/agents/sandbox';
import { finished } from 'node:stream/promises';
import {
  DEFAULT_MODEL,
  getStringArg,
  hasFlag,
  getOptionalNumberArg,
  getOptionalStringArg,
  requireOpenAIKey,
  runExampleMain,
} from '../support';

const DEFAULT_QUESTION =
  'Summarize this cloud sandbox workspace in 2 sentences.';

function parseWorkspacePersistence(
  value: string | undefined,
): VercelWorkspacePersistence {
  if (!value || value === 'tar') {
    return 'tar';
  }
  if (value === 'snapshot') {
    return 'snapshot';
  }
  throw new Error(
    `--workspace-persistence must be "tar" or "snapshot", received ${value}.`,
  );
}

function buildManifest(): Manifest {
  return new Manifest({
    entries: {
      'README.md': {
        type: 'file',
        content: `# Vercel Demo Workspace

This workspace exists to validate the Vercel sandbox backend manually.
`,
      },
      'handoff.md': {
        type: 'file',
        content: `# Handoff

- Customer: Northwind Traders.
- Goal: validate Vercel sandbox exec and persistence flows.
- Current status: non-PTY backend slice is wired and under test.
`,
      },
      'todo.md': {
        type: 'file',
        content: `# Todo

1. Inspect the workspace files.
2. Summarize the current status in two sentences.
`,
      },
    },
  });
}

async function main() {
  requireOpenAIKey();

  const model = getStringArg('--model', DEFAULT_MODEL);
  const question = getStringArg('--question', DEFAULT_QUESTION);
  const runtime = getOptionalStringArg('--runtime');
  const timeoutMs = getOptionalNumberArg('--timeout-ms');
  const workspacePersistence = parseWorkspacePersistence(
    getOptionalStringArg('--workspace-persistence'),
  );
  const stream = hasFlag('--stream');
  const client = new VercelSandboxClient({
    runtime,
    timeoutMs,
    workspacePersistence,
  });
  const agent = new SandboxAgent({
    name: 'Vercel Sandbox Assistant',
    model,
    instructions:
      'Answer questions about the sandbox workspace. Inspect the files before answering, keep the response concise, and cite the file names you inspected.',
    defaultManifest: buildManifest(),
    capabilities: [shell()],
  });
  const runner = new Runner({
    workflowName: 'Vercel sandbox example',
    sandbox: { client },
  });

  if (!stream) {
    const result = await runner.run(agent, question);
    console.log(result.finalOutput);
    return;
  }

  const result = await runner.run(agent, question, { stream: true });
  process.stdout.write('assistant> ');
  const textStream = result.toTextStream({ compatibleWithNodeStreams: true });
  textStream.pipe(process.stdout);
  await finished(textStream);
  await result.completed;
  process.stdout.write('\n');
}

await runExampleMain(main);
