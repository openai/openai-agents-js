import { Runner } from '@openai/agents';
import { DaytonaSandboxClient } from '@openai/agents-extensions/sandbox/daytona';
import { Manifest, SandboxAgent, shell } from '@openai/agents/sandbox';
import { finished } from 'node:stream/promises';
import {
  DEFAULT_MODEL,
  getStringArg,
  hasFlag,
  requireEnv,
  requireOpenAIKey,
  runExampleMain,
} from '../support';

const DEFAULT_QUESTION =
  'Summarize this cloud sandbox workspace in 2 sentences.';
const DEFAULT_DAYTONA_WORKSPACE_ROOT = '/home/daytona/workspace';

function buildManifest(): Manifest {
  return new Manifest({
    root: DEFAULT_DAYTONA_WORKSPACE_ROOT,
    entries: {
      'README.md': {
        type: 'file',
        content: `# Daytona Demo Workspace

This workspace exists to validate the Daytona sandbox backend manually.
`,
      },
      'launch.md': {
        type: 'file',
        content: `# Launch

- Customer: Contoso Logistics.
- Goal: validate the remote sandbox agent path.
- Current status: Daytona backend smoke and app-server connectivity are passing.
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
  requireEnv('DAYTONA_API_KEY');

  const model = getStringArg('--model', DEFAULT_MODEL);
  const question = getStringArg('--question', DEFAULT_QUESTION);
  const pauseOnExit = hasFlag('--pause-on-exit');
  const stream = hasFlag('--stream');
  const client = new DaytonaSandboxClient({ pauseOnExit });
  const agent = new SandboxAgent({
    name: 'Daytona Sandbox Assistant',
    model,
    instructions:
      'Answer questions about the sandbox workspace. Inspect the files before answering, keep the response concise, and cite the file names you inspected.',
    defaultManifest: buildManifest(),
    capabilities: [shell()],
  });
  const runner = new Runner({
    workflowName: 'Daytona sandbox example',
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
