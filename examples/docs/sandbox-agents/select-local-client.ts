import {
  DockerSandboxClient,
  UnixLocalSandboxClient,
} from '@openai/agents/sandbox/local';

const client = process.env.USE_DOCKER
  ? new DockerSandboxClient({ image: 'node:22-bookworm-slim' })
  : new UnixLocalSandboxClient();
