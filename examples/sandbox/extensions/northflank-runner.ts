import { Runner } from '@openai/agents';
import { NorthflankSandboxClient } from '@openai/agents-extensions/sandbox/northflank';
import { Manifest, SandboxAgent, shell } from '@openai/agents/sandbox';
import { finished } from 'node:stream/promises';
import {
  DEFAULT_MODEL,
  getOptionalStringArg,
  getStringArg,
  hasFlag,
  requireEnv,
  requireOpenAIKey,
  runExampleMain,
} from '../support';

const DEFAULT_QUESTION =
  'Summarize this cloud sandbox workspace in 2 sentences.';

const DEFAULT_IMAGE = 'docker.io/library/ubuntu:24.04';

function buildManifest(): Manifest {
  return new Manifest({
    root: '/workspace',
    entries: {
      'README.md': {
        type: 'file',
        content: `# Northflank Demo Workspace

This workspace exists to validate the Northflank sandbox backend manually.
`,
      },
      'release_notes.md': {
        type: 'file',
        content: `# Release notes

- Northflank sandbox provider lives in @openai/agents-extensions/sandbox/northflank.
- Each session runs as a single-replica deployment service; exec calls are pinned to the running pod.
- Pod storage is ephemeral by default. Pass \`workspacePersistence: 'volume'\` to attach a Northflank volume at the workspace root, or \`'tar'\` to snapshot the workspace into session state on stop().
`,
      },
      'todo.md': {
        type: 'file',
        content: `# Try these prompts

1. List every Markdown file in this workspace and show the first heading of each.
2. Add a new note called \`hello.md\` that greets the operator by name.
3. Run \`uname -a\` and report what kernel the sandbox is running on.
`,
      },
    },
  });
}

async function main() {
  requireOpenAIKey();
  const apiToken = requireEnv('NF_API_TOKEN');
  const projectId = requireEnv('NF_PROJECT_ID');

  const model = getStringArg('--model', DEFAULT_MODEL);
  const question = getStringArg('--question', DEFAULT_QUESTION);
  const image = getStringArg('--image', DEFAULT_IMAGE);
  const teamId = getOptionalStringArg('--team');
  const pauseOnExit = hasFlag('--pause-on-exit');
  const stream = hasFlag('--stream');
  const persistenceArg = getOptionalStringArg('--persistence');
  const workspacePersistence =
    persistenceArg === 'volume' || persistenceArg === 'tar'
      ? persistenceArg
      : undefined;
  if (persistenceArg && !workspacePersistence) {
    throw new Error(
      `--persistence must be one of: volume, tar (got "${persistenceArg}")`,
    );
  }

  const client = new NorthflankSandboxClient({
    apiToken,
    projectId,
    image,
    teamId,
    // Keep ubuntu alive — its default CMD exits immediately.
    docker: { customEntrypoint: 'sleep', customCommand: 'infinity' },
    pauseOnExit,
    workspacePersistence,
    readyTimeoutMs: 4 * 60 * 1000,
  });

  const agent = new SandboxAgent({
    name: 'Northflank Sandbox Assistant',
    model,
    instructions:
      'Answer questions about the sandbox workspace. Inspect the files before answering, keep the response concise, and cite the file names you inspected.',
    defaultManifest: buildManifest(),
    capabilities: [shell()],
  });
  const runner = new Runner({
    workflowName: 'Northflank sandbox example',
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
