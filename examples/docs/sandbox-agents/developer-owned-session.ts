import { run } from '@openai/agents';
import { Manifest, SandboxAgent } from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents/sandbox/local';

const manifest = new Manifest();
const agent = new SandboxAgent({
  name: 'Workspace reviewer',
  instructions: 'Inspect the sandbox workspace before answering.',
});

const client = new UnixLocalSandboxClient();
const session = await client.create({ manifest });

try {
  await run(agent, 'First pass.', { sandbox: { session } });
  await run(agent, 'Follow-up pass.', { sandbox: { session } });
} finally {
  await session.close?.();
}
