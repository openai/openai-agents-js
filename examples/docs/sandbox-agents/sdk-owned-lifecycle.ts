import { run } from '@openai/agents';
import { SandboxAgent } from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents/sandbox/local';

const agent = new SandboxAgent({
  name: 'Workspace reviewer',
  model: 'gpt-5.5',
  instructions: 'Inspect the sandbox workspace before answering.',
});

const result = await run(agent, 'Inspect the workspace.', {
  sandbox: {
    client: new UnixLocalSandboxClient(),
  },
});

console.log(result.finalOutput);
