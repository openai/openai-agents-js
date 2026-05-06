import { run } from '@openai/agents';
import { gitRepo, SandboxAgent } from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents/sandbox/local';

const agent = new SandboxAgent({
  name: 'Workspace Assistant',
  model: 'gpt-5.5',
  instructions: 'Inspect the repo before changing files.',
  defaultManifest: {
    entries: { repo: gitRepo({ repo: 'openai/openai-agents-js' }) },
  },
});

const result = await run(
  agent,
  'Inspect the repo README and summarize what this project does.',
  { sandbox: { client: new UnixLocalSandboxClient() } },
);

console.log(result.finalOutput);
