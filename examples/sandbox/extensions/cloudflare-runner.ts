import { Runner } from '@openai/agents';
import { CloudflareSandboxClient } from '@openai/agents-extensions/sandbox/cloudflare';
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

// Set CLOUDFLARE_SANDBOX_WORKER_URL to a Worker that implements the bridge API.
// See README.md in this directory for the required endpoints and authentication.

function buildManifest(): Manifest {
  return new Manifest({
    entries: {
      'README.md': {
        type: 'file',
        content: `# Cloudflare Demo Workspace

This workspace exists to validate the Cloudflare sandbox backend manually.
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
  const workerUrl =
    getOptionalStringArg('--worker-url') ??
    requireEnv('CLOUDFLARE_SANDBOX_WORKER_URL');
  const apiKey =
    getOptionalStringArg('--api-key') ?? process.env.CLOUDFLARE_SANDBOX_API_KEY;
  const stream = hasFlag('--stream');
  const client = new CloudflareSandboxClient({ workerUrl, apiKey });
  const agent = new SandboxAgent({
    name: 'Cloudflare Sandbox Assistant',
    model,
    instructions:
      'Answer questions about the sandbox workspace. Inspect the files before answering, keep the response concise, and cite the file names you inspected.',
    defaultManifest: buildManifest(),
    capabilities: [shell()],
  });
  const runner = new Runner({
    workflowName: 'Cloudflare sandbox example',
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
