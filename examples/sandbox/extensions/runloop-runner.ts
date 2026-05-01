import { Runner } from '@openai/agents';
import { RunloopSandboxClient } from '@openai/agents-extensions/sandbox/runloop';
import { Manifest, SandboxAgent, shell } from '@openai/agents/sandbox';
import { finished } from 'node:stream/promises';
import {
  DEFAULT_MODEL,
  getStringArg,
  hasFlag,
  getOptionalStringArg,
  requireEnv,
  requireOpenAIKey,
  runExampleMain,
} from '../support';

const DEFAULT_QUESTION =
  'Summarize this cloud sandbox workspace in 2 sentences.';
const DEFAULT_RUNLOOP_WORKSPACE_ROOT = '/home/user';
const DEFAULT_RUNLOOP_ROOT_WORKSPACE_ROOT = '/root';

function buildManifest(root: string): Manifest {
  return new Manifest({
    root,
    entries: {
      'README.md': {
        type: 'file',
        content: `# Runloop Demo Workspace

This workspace exists to validate the Runloop sandbox backend manually.
`,
      },
      'launch.md': {
        type: 'file',
        content: `# Launch

- Customer: Contoso Logistics.
- Goal: validate the remote sandbox agent path.
- Current status: Runloop backend smoke and app-server connectivity are passing.
`,
      },
      'tasks.md': {
        type: 'file',
        content: `# Tasks

1. Inspect the workspace files.
2. Summarize the setup and any notable status in two sentences.
`,
      },
    },
  });
}

async function main() {
  requireOpenAIKey();
  requireEnv('RUNLOOP_API_KEY');

  const model = getStringArg('--model', DEFAULT_MODEL);
  const question = getStringArg('--question', DEFAULT_QUESTION);
  const pauseOnExit = hasFlag('--pause-on-exit');
  const blueprintName = getOptionalStringArg('--blueprint-name');
  const root = hasFlag('--root');
  const stream = hasFlag('--stream');
  const client = new RunloopSandboxClient({
    blueprintName,
    pauseOnExit,
    userParameters: root ? { username: 'root', uid: 0 } : undefined,
  });
  const agent = new SandboxAgent({
    name: 'Runloop Sandbox Assistant',
    model,
    instructions:
      'Answer questions about the sandbox workspace. Inspect the files before answering, keep the response concise, and cite the file names you inspected.',
    defaultManifest: buildManifest(
      root
        ? DEFAULT_RUNLOOP_ROOT_WORKSPACE_ROOT
        : DEFAULT_RUNLOOP_WORKSPACE_ROOT,
    ),
    capabilities: [shell()],
  });
  const runner = new Runner({
    workflowName: 'Runloop sandbox example',
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
