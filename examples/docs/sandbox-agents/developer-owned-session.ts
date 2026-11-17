import { run } from '@openai/agents';
import { Manifest, SandboxAgent } from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents/sandbox/local';

const manifest = new Manifest();
const agent = new SandboxAgent({
  name: 'Workspace reviewer',
  instructions:
    'Run the requested command once in the SDK sandbox workspace and report its output.',
});

const client = new UnixLocalSandboxClient();
const session = await client.create({ manifest });

try {
  await run(agent, 'Run `ls -a` to list the top-level entries.', {
    sandbox: { session },
  });
  await run(agent, 'Run `pwd` to report the workspace path.', {
    sandbox: { session },
  });
} finally {
  await session.close?.();
}
