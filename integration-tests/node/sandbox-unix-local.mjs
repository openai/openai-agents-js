// @ts-check

import { getGlobalTraceProvider, run } from '@openai/agents';
import { Manifest, SandboxAgent, shell } from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents/sandbox/local';

const manifest = new Manifest({
  entries: {
    'README.md': {
      type: 'file',
      content: '# Unix Local Sandbox\n\nmarker: unix-local-node\n',
    },
    'scripts/marker.sh': {
      type: 'file',
      content: '#!/bin/sh\nprintf "unix-local-node-command\\n"\n',
      executable: true,
    },
  },
});

const client = new UnixLocalSandboxClient();
const session = await client.create(manifest);
const agent = new SandboxAgent({
  name: 'Unix local sandbox smoke',
  instructions:
    'Inspect README.md, run scripts/marker.sh, and respond exactly with [SANDBOX_RESPONSE]unix-local-node:unix-local-node-command[/SANDBOX_RESPONSE].',
  defaultManifest: manifest,
  capabilities: [shell()],
  modelSettings: {
    toolChoice: 'required',
  },
});

try {
  const result = await run(agent, 'Run the unix-local sandbox smoke check.', {
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
