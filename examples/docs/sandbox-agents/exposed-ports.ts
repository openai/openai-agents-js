import { DockerSandboxClient } from '@openai/agents/sandbox/local';

const client = new DockerSandboxClient({
  image: 'node:22-bookworm-slim',
  exposedPorts: [3000],
});
