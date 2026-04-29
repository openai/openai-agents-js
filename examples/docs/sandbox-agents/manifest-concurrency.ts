import { run } from '@openai/agents';
import { SandboxAgent } from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents/sandbox/local';

const agent = new SandboxAgent({
  name: 'Repository inspector',
  instructions: 'Inspect the repository before answering.',
});

await run(agent, 'Inspect the repo.', {
  sandbox: {
    client: new UnixLocalSandboxClient(),
    concurrencyLimits: {
      manifestEntries: 4,
      localDirFiles: 16,
    },
  },
});
