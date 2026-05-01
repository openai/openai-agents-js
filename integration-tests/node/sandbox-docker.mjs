// @ts-check

import { getGlobalTraceProvider, run } from '@openai/agents';
import { Manifest, SandboxAgent, shell } from '@openai/agents/sandbox';
import { DockerSandboxClient } from '@openai/agents/sandbox/local';

const manifest = new Manifest({
  entries: {
    'README.md': {
      type: 'file',
      content: '# Docker Sandbox\n\nmarker: docker-node\n',
    },
    'scripts/marker.sh': {
      type: 'file',
      content: '#!/bin/sh\nprintf "docker-node-command\\n"\n',
      executable: true,
    },
  },
});

const client = new DockerSandboxClient({
  image:
    process.env.SANDBOX_INTEGRATION_DOCKER_IMAGE ?? 'node:22-bookworm-slim',
});
const session = await client.create(manifest);
const agent = new SandboxAgent({
  name: 'Docker sandbox smoke',
  instructions:
    'Inspect README.md, run scripts/marker.sh, and respond exactly with [SANDBOX_RESPONSE]docker-node:docker-node-command[/SANDBOX_RESPONSE].',
  defaultManifest: manifest,
  capabilities: [shell()],
  modelSettings: {
    toolChoice: 'required',
  },
});

try {
  const result = await run(agent, 'Run the docker sandbox smoke check.', {
    maxTurns: 8,
    sandbox: { session },
  });
  const toolNames = result.newItems.flatMap((item) => {
    if (item.type !== 'tool_call_item') {
      return [];
    }
    const rawItem = /** @type {{ name?: unknown }} */ (item.rawItem);
    return typeof rawItem.name === 'string' ? [rawItem.name] : [];
  });

  console.log(`[SANDBOX_TOOLS]${toolNames.join(',')}[/SANDBOX_TOOLS]`);
  console.log(String(result.finalOutput));
} finally {
  await session.close?.();
  await getGlobalTraceProvider().shutdown();
}
