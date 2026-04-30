import { run, tool, type RunItem } from '@openai/agents';
import { Manifest, SandboxAgent, shell } from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents/sandbox/local';
import { z } from 'zod';
import {
  DEFAULT_MODEL,
  getStringArg,
  requireOpenAIKey,
  runExampleMain,
} from './support';

const DEFAULT_QUESTION =
  'Review this enterprise renewal request. Tell me who needs to approve the discount, whether security review is still open, and the most important note for the account team.';

const discountApprovalTool = tool({
  name: 'get_discount_approval_path',
  description:
    'Return the approver required for a proposed discount percentage.',
  parameters: z.object({
    discount_percent: z
      .number()
      .int()
      .describe('The requested discount percentage.'),
  }),
  execute: async ({ discount_percent }: { discount_percent: number }) => {
    if (discount_percent <= 10) {
      return 'The account executive can approve discounts up to 10 percent.';
    }
    if (discount_percent <= 15) {
      return 'The regional sales director must approve discounts from 11 to 15 percent.';
    }
    return 'Finance and the regional sales director must both approve discounts above 15 percent.';
  },
});

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
      'renewal_request.md': {
        type: 'file',
        content: `# Renewal request

- Customer: Contoso Manufacturing.
- Requested discount: 14 percent.
- Renewal term: 12 months.
- Requested close date: March 28.
`,
      },
      'account_notes.md': {
        type: 'file',
        content: `# Account notes

- The customer expanded usage in two plants this quarter.
- Security review for the new data export workflow was opened last week.
- Procurement wants a final approval map before they send the order form.
`,
      },
      'reference_policy.md': {
        type: 'file',
        content: `# Reference policy

- Discount requests from 11 to 15 percent require regional sales director approval.
- Security review must be complete before the order form can be sent.
- Account teams should call out open security review before procurement sends documents.
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
    name: 'Renewal Review Assistant',
    model,
    instructions:
      'Review renewal requests. Inspect the sandbox files, call `get_discount_approval_path` for the requested discount, check the reference policy file, and keep the answer concise and business-ready. Mention the files you used.',
    defaultManifest: manifest,
    tools: [discountApprovalTool],
    capabilities: [shell()],
  });

  try {
    const result = await run(agent, question, {
      maxTurns: 12,
      sandbox: { session },
    });

    const toolNames = getToolNames(result.newItems);
    for (const expected of ['exec_command', 'get_discount_approval_path']) {
      if (!toolNames.includes(expected)) {
        throw new Error(`Expected ${expected}, saw: ${toolNames.join(', ')}`);
      }
    }

    console.log(`[tools used] ${toolNames.join(', ')}`);
    console.log(result.finalOutput);
  } finally {
    await session.close?.().catch(() => {});
  }
}

await runExampleMain(main);
