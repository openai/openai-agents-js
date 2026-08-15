import { run } from '@openai/agents';
import { Manifest, SandboxAgent, shell } from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents/sandbox/local';
import {
  DEFAULT_MODEL,
  getStringArg,
  requireOpenAIKey,
  runExampleMain,
} from './support';

function buildManifest() {
  return new Manifest({
    entries: {
      'tasks/a/brief.md': {
        type: 'file',
        content: '# Project Alpha\n\nOwner: Ada\n',
      },
      'tasks/b/brief.md': {
        type: 'file',
        content: '# Project Beta\n\nOwner: Grace\n',
      },
      'shared/context.md': {
        type: 'file',
        content:
          'Both projects use the same developer-owned sandbox session.\n',
      },
    },
  });
}

function buildAgent(name: string, model: string) {
  return new SandboxAgent({
    name,
    model,
    instructions:
      'Read brief.md with exec_command, then report the project name and owner in one sentence. Use relative paths.',
    capabilities: [shell()],
    modelSettings: { toolChoice: 'required' },
  });
}

async function main() {
  requireOpenAIKey();

  const model = getStringArg('--model', DEFAULT_MODEL);
  const client = new UnixLocalSandboxClient();
  const session = await client.create(buildManifest());
  const alphaAgent = buildAgent('Alpha assistant', model);
  const betaAgent = buildAgent('Beta assistant', model);

  try {
    const [alpha, beta] = await Promise.all([
      run(alphaAgent, 'Summarize your assigned project.', {
        sandbox: { session, cwd: 'tasks/a' },
      }),
      run(betaAgent, 'Summarize your assigned project.', {
        sandbox: { session, cwd: 'tasks/b' },
      }),
    ]);

    console.log(`[tasks/a] ${alpha.finalOutput}`);
    console.log(`[tasks/b] ${beta.finalOutput}`);
    console.log(
      '[note] The working directories change relative path resolution; they are not isolation boundaries.',
    );
  } finally {
    await session.close?.().catch(() => {});
  }
}

await runExampleMain(main);
