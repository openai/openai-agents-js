import { run, type RunItem } from '@openai/agents';
import { Manifest, SandboxAgent, shell } from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents/sandbox/local';
import {
  DEFAULT_MODEL,
  getStringArg,
  requireOpenAIKey,
  runExampleMain,
} from './support';

const DEFAULT_QUESTION =
  'Review this renewal packet. Summarize the customer situation, likely blockers, and the next two account-team actions.';

function getToolNames(items: RunItem[]): string[] {
  return items.flatMap((item) => {
    if (item.type !== 'tool_call_item') {
      return [];
    }

    const rawItem = item.rawItem as { name?: unknown };
    return typeof rawItem.name === 'string' ? [rawItem.name] : [];
  });
}

function buildManifest() {
  return new Manifest({
    entries: {
      'account_brief.md': {
        type: 'file',
        content: `# Northwind Health

- Segment: Mid-market healthcare analytics provider.
- Annual contract value: $148,000.
- Renewal date: 2026-04-15.
- Executive sponsor: Director of Data Operations.
`,
      },
      'renewal_request.md': {
        type: 'file',
        content:
          'Northwind requested a 12 percent discount in exchange for a two-year renewal. They also want a 45-day implementation timeline for a new reporting workspace.\n',
      },
      'implementation_risks.md': {
        type: 'file',
        content: `# Delivery risks

- Security questionnaire for the new reporting workspace is not complete.
- Customer procurement requires final legal language by April 1.
`,
      },
    },
  });
}

async function main() {
  requireOpenAIKey();

  const model = getStringArg('--model', DEFAULT_MODEL);
  const question = getStringArg('--question', DEFAULT_QUESTION);
  const manifest = buildManifest();
  const client = new UnixLocalSandboxClient();
  const session = await client.create(manifest);

  const agent = new SandboxAgent({
    name: 'Unix Local Renewal Analyst',
    model,
    instructions:
      'Inspect the Unix-local sandbox workspace before answering. Keep the response concise, business-focused, and cite the file names that support each conclusion. Use relative paths because the shell starts in the workspace root.',
    defaultManifest: manifest,
    capabilities: [shell()],
  });

  try {
    const listing = await session.execCommand?.({
      cmd: 'find . -maxdepth 2 -type f | sort',
      shell: '/bin/sh',
      login: false,
      yieldTimeMs: 500,
    });
    console.log('[workspace files]');
    console.log(listing);

    const result = await run(agent, question, {
      sandbox: { session },
    });
    const toolNames = getToolNames(result.newItems);
    if (!toolNames.includes('exec_command')) {
      throw new Error(`Expected exec_command, saw: ${toolNames.join(', ')}`);
    }

    console.log(`[tools used] ${toolNames.join(', ')}`);
    console.log(result.finalOutput);
  } finally {
    await session.close?.().catch(() => {});
  }
}

await runExampleMain(main);
