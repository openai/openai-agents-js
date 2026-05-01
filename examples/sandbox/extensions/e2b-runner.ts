import { Runner } from '@openai/agents';
import {
  E2BSandboxClient,
  type E2BSandboxType,
} from '@openai/agents-extensions/sandbox/e2b';
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

function parseSandboxType(
  value: string | undefined,
): E2BSandboxType | undefined {
  if (!value) {
    return undefined;
  }
  if (value === 'e2b' || value === 'e2b_code_interpreter') {
    return value;
  }
  throw new Error(
    `--sandbox-type must be "e2b" or "e2b_code_interpreter", received ${value}.`,
  );
}

function buildManifest(): Manifest {
  return new Manifest({
    entries: {
      'README.md': {
        type: 'file',
        content: `# Renewal Notes

This workspace contains a tiny account review packet for manual sandbox testing.
`,
      },
      'customer.md': {
        type: 'file',
        content: `# Customer

- Name: Northwind Health.
- Renewal date: 2026-04-15.
- Risk: unresolved SSO setup.
`,
      },
      'next_steps.md': {
        type: 'file',
        content: `# Next steps

1. Finish the SSO fix.
2. Confirm legal language before procurement review.
`,
      },
    },
  });
}

async function main() {
  requireOpenAIKey();
  requireEnv('E2B_API_KEY');

  const model = getStringArg('--model', DEFAULT_MODEL);
  const question = getStringArg('--question', DEFAULT_QUESTION);
  const sandboxType = parseSandboxType(getOptionalStringArg('--sandbox-type'));
  const template = getOptionalStringArg('--template');
  const timeout = getOptionalNumberArg('--timeout');
  const pauseOnExit = hasFlag('--pause-on-exit');
  if (hasFlag('--workspace-persistence')) {
    throw new Error(
      'E2B sandbox examples do not support --workspace-persistence yet.',
    );
  }
  const stream = hasFlag('--stream');
  const client = new E2BSandboxClient({
    sandboxType,
    template,
    timeout,
    pauseOnExit,
  });
  const agent = new SandboxAgent({
    name: 'E2B Sandbox Assistant',
    model,
    instructions:
      'Answer questions about the sandbox workspace. Inspect the files before answering, keep the response concise, and cite the file names you inspected.',
    defaultManifest: buildManifest(),
    capabilities: [shell()],
  });
  const runner = new Runner({
    workflowName: 'E2B sandbox example',
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
