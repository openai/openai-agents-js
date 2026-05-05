import { run } from '@openai/agents';
import { Manifest, SandboxAgent } from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents/sandbox/local';

const manifest = new Manifest();
const agent = new SandboxAgent({
  name: 'Workspace reviewer',
  model: 'gpt-5.5',
  instructions: 'Inspect the sandbox workspace before answering.',
});

const client = new UnixLocalSandboxClient();
const session = await client.create({ manifest });

try {
  await run(agent, 'First task.', { sandbox: { session } });
  await run(agent, 'Follow-up task.', { sandbox: { session } });
} finally {
  await session.close?.();
}
