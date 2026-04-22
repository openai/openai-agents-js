import { Runner } from '@openai/agents';
import {
  ModalSandboxClient,
  type ModalWorkspacePersistence,
} from '@openai/agents-extensions/sandbox/modal';
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
): ModalWorkspacePersistence {
  if (!value || value === 'tar') {
    return 'tar';
  }
  throw new Error('--workspace-persistence must be "tar".');
}

function buildManifest(): Manifest {
  return new Manifest({
    entries: {
      'README.md': {
        type: 'file',
        content: `# Modal Demo Workspace

This workspace exists to validate the Modal sandbox backend manually.
`,
      },
      'incident.md': {
        type: 'file',
        content: `# Incident

- Customer: Fabrikam Retail.
- Issue: delayed reporting rollout.
- Primary blocker: incomplete security questionnaire.
`,
      },
      'plan.md': {
        type: 'file',
        content: `# Plan

1. Close the questionnaire.
2. Reconfirm the rollout date with the customer.
`,
      },
    },
  });
}

async function main() {
  requireOpenAIKey();

  const model = getStringArg('--model', DEFAULT_MODEL);
  const question = getStringArg('--question', DEFAULT_QUESTION);
  const appName =
    getOptionalStringArg('--app-name') ?? 'openai-agents-js-sandbox-example';
  const workspacePersistence = parseWorkspacePersistence(
    getOptionalStringArg('--workspace-persistence'),
  );
  const sandboxCreateTimeoutS = getOptionalNumberArg(
    '--sandbox-create-timeout-s',
  );
  const nativeCloudBucketSecretName = getOptionalStringArg(
    '--native-cloud-bucket-secret-name',
  );
  const stream = hasFlag('--stream');
  const client = new ModalSandboxClient({
    appName,
    workspacePersistence,
    sandboxCreateTimeoutS,
    nativeCloudBucketSecretName,
  });
  const agent = new SandboxAgent({
    name: 'Modal Sandbox Assistant',
    model,
    instructions:
      'Answer questions about the sandbox workspace. Inspect the files before answering, keep the response concise, and cite the file names you inspected.',
    defaultManifest: buildManifest(),
    capabilities: [shell()],
  });
  const runner = new Runner({
    workflowName: 'Modal sandbox example',
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
