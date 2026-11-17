import { run } from '@openai/agents';
import { SandboxAgent } from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents/sandbox/local';

const agent = new SandboxAgent({
  name: 'Workspace inspector',
  instructions:
    'Run the requested command once in the SDK sandbox workspace and report its output.',
});

await run(agent, 'Run `ls -a` to list the top-level entries.', {
  sandbox: {
    client: new UnixLocalSandboxClient(),
    concurrencyLimits: {
      manifestEntries: 4,
      localDirFiles: 16,
    },
  },
});
