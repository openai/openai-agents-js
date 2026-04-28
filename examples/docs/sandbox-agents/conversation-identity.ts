import { MemorySession, run } from '@openai/agents';
import { Manifest, SandboxAgent } from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents/sandbox/local';

const manifest = new Manifest();
const agent = new SandboxAgent({
  name: 'Memory-enabled reviewer',
  instructions: 'Inspect the workspace before answering.',
});

const conversation = new MemorySession({ sessionId: 'workspace-review' });
const sandbox = await new UnixLocalSandboxClient().create({ manifest });

try {
  await run(agent, 'Analyze data/leads.csv.', {
    session: conversation,
    sandbox: { session: sandbox },
  });
  await run(agent, 'Write a follow-up recommendation.', {
    session: conversation,
    sandbox: { session: sandbox },
  });
} finally {
  await sandbox.close?.();
}
