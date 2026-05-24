import { Runner } from '@openai/agents';
import {
  TensorlakeSandboxClient,
  type TensorlakeWorkspacePersistence,
} from '@openai/agents-extensions/sandbox/tensorlake';
import { Manifest, SandboxAgent, shell } from '@openai/agents/sandbox';
import { finished } from 'node:stream/promises';
import {
  DEFAULT_MODEL,
  getStringArg,
  hasFlag,
  getOptionalNumberArg,
  getOptionalStringArg,
  requireEnv,
  requireOpenAIKey,
  runExampleMain,
} from '../support';

const DEFAULT_QUESTION =
  'Summarize this cloud sandbox workspace in 2 sentences.';

function parseWorkspacePersistence(
  value: string | undefined,
): TensorlakeWorkspacePersistence | undefined {
  if (!value) return undefined;
  if (value === 'tar' || value === 'snapshot') return value;
  throw new Error(
    `--workspace-persistence must be "tar" or "snapshot", received ${value}.`,
  );
}

const DISK_MB_MIN = 10240;
const DISK_MB_MAX = 102400;

function validateDiskMb(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < DISK_MB_MIN || value > DISK_MB_MAX) {
    throw new Error(
      `--disk-mb must be an integer between ${DISK_MB_MIN} (10 GiB) and ${DISK_MB_MAX} (100 GiB) inclusive, received ${value}.`,
    );
  }
  return value;
}

function buildManifest(): Manifest {
  return new Manifest({
    entries: {
      'README.md': {
        type: 'file',
        content: `# Tensorlake Demo Workspace

This workspace exists to validate the Tensorlake sandbox backend manually.
`,
      },
      'customer.md': {
        type: 'file',
        content: `# Customer

- Name: Acme Robotics.
- Renewal date: 2026-04-15.
- Risk: unfinished SSO migration.
`,
      },
      'next_steps.md': {
        type: 'file',
        content: `# Next steps

1. Finish the SSO migration.
2. Confirm legal language before procurement review.
`,
      },
    },
  });
}

async function main() {
  requireOpenAIKey();
  requireEnv('TENSORLAKE_API_KEY');

  const model = getStringArg('--model', DEFAULT_MODEL);
  const question = getStringArg('--question', DEFAULT_QUESTION);
  const name = getOptionalStringArg('--name');
  const image = getOptionalStringArg('--image');
  const cpus = getOptionalNumberArg('--cpus');
  const memoryMb = getOptionalNumberArg('--memory-mb');
  const diskMb = validateDiskMb(getOptionalNumberArg('--disk-mb'));
  const timeoutSecs = getOptionalNumberArg('--timeout-secs');
  const suspendOnExit = hasFlag('--suspend-on-exit');
  const workspacePersistence = parseWorkspacePersistence(
    getOptionalStringArg('--workspace-persistence'),
  );
  const stream = hasFlag('--stream');

  const client = new TensorlakeSandboxClient({
    name,
    image,
    cpus,
    memoryMb,
    diskMb,
    timeoutSecs,
    suspendOnExit,
    workspacePersistence,
  });
  const agent = new SandboxAgent({
    name: 'Tensorlake Sandbox Assistant',
    model,
    instructions:
      'Answer questions about the sandbox workspace. Inspect the files before answering, keep the response concise, and cite the file names you inspected.',
    defaultManifest: buildManifest(),
    capabilities: [shell()],
  });
  const runner = new Runner({
    workflowName: 'Tensorlake sandbox example',
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
