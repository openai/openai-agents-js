import { Runner } from '@openai/agents';
import { Manifest, SandboxAgent, shell } from '@openai/agents/sandbox';
import { BlaxelSandboxClient } from '@openai/agents-extensions/sandbox/blaxel';
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
const DEFAULT_BLAXEL_WORKSPACE_ROOT = '/workspace';

function buildManifest(): Manifest {
  return new Manifest({
    root: DEFAULT_BLAXEL_WORKSPACE_ROOT,
    entries: {
      'README.md': {
        type: 'file',
        content: `# Blaxel Demo Workspace

This workspace validates the Blaxel sandbox backend.
`,
      },
      'project/status.md': {
        type: 'file',
        content: `# Project Status

- Backend: Blaxel cloud sandbox
- Region: auto-selected
- Features: exec, file I/O, PTY, drives, preview URLs
`,
      },
      'project/tasks.md': {
        type: 'file',
        content: `# Tasks

1. Inspect the workspace files.
2. List all features mentioned in status.md.
3. Summarize in 2-3 sentences.
`,
      },
    },
    environment: {
      DEMO_ENV: 'blaxel-agent-demo',
    },
  });
}

async function main() {
  requireOpenAIKey();
  requireEnv('BL_API_KEY');
  requireEnv('BL_WORKSPACE');

  const model = getStringArg('--model', DEFAULT_MODEL);
  const question = getStringArg('--question', DEFAULT_QUESTION);
  const image = getOptionalStringArg('--image');
  const region = getOptionalStringArg('--region');
  const stream = hasFlag('--stream');
  const client = new BlaxelSandboxClient({ image, region });
  const agent = new SandboxAgent({
    name: 'Blaxel Sandbox Assistant',
    model,
    instructions:
      'Answer questions about the sandbox workspace. Inspect the files before answering, keep the response concise, and cite the file names you inspected.',
    defaultManifest: buildManifest(),
    capabilities: [shell()],
  });
  const runner = new Runner({
    workflowName: 'Blaxel sandbox example',
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
