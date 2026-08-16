import { run } from '@openai/agents';
import { SandboxAgent } from '@openai/agents/sandbox';
import { DockerSandboxClient } from '@openai/agents/sandbox/local';

const agent = new SandboxAgent({
  name: 'Workspace reviewer',
  model: 'gpt-5.6-sol',
  instructions: 'Inspect the sandbox workspace before answering.',
});

const result = await run(agent, 'Inspect the workspace.', {
  sandbox: {
    client: new DockerSandboxClient({
      image: 'node:22-bookworm-slim',
      // Uncomment to disable networking for the container.
      // Do not combine networkMode: 'none' with exposedPorts.
      // networkMode: 'none',
    }),
  },
});

console.log(result.finalOutput);
