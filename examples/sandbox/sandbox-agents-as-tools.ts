import { Agent, run, tool, type RunItem } from '@openai/agents';
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
  'Review the Acme renewal materials and give me a short recommendation for the deal desk. Include pricing risk, rollout risk, and the most important next step.';

const PricingPacketReview = z.object({
  requested_discount_percent: z.number().int(),
  requested_term_months: z.number().int(),
  pricing_risk: z.enum(['low', 'medium', 'high']),
  summary: z.string(),
  recommended_next_step: z.string(),
  evidence_files: z.array(z.string()).min(1),
});

const RolloutRiskReview = z.object({
  rollout_risk: z.enum(['low', 'medium', 'high']),
  summary: z.string(),
  blockers: z.array(z.string()),
  recommended_next_step: z.string(),
  evidence_files: z.array(z.string()).min(1),
});

const discountApprovalRuleTool = tool({
  name: 'get_discount_approval_rule',
  description: 'Return the internal approver required for a proposed discount.',
  parameters: z.object({
    discount_percent: z.number().int(),
  }),
  execute: async ({ discount_percent }: { discount_percent: number }) => {
    if (discount_percent <= 10) {
      return 'Discounts up to 10 percent can be approved by the account executive.';
    }
    if (discount_percent <= 15) {
      return 'Discounts from 11 to 15 percent require regional sales director approval.';
    }
    return 'Discounts above 15 percent require finance and regional sales director approval.';
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

async function main() {
  requireOpenAIKey();

  const model = getStringArg('--model', DEFAULT_MODEL);
  const question = getStringArg('--question', DEFAULT_QUESTION);

  const pricingManifest = new Manifest({
    entries: {
      'pricing_summary.md': {
        type: 'file',
        content: `# Pricing summary

- Current annual contract: $220,000.
- Requested renewal term: 24 months.
- Requested discount: 15 percent.
- Account executive target discount band: 8 to 10 percent.
`,
      },
      'commercial_notes.md': {
        type: 'file',
        content: `# Commercial notes

- The customer expanded from 120 to 170 paid seats in the last 6 months.
- Procurement asked for one final concession to close before quarter end.
`,
      },
    },
  });
  const rolloutManifest = new Manifest({
    entries: {
      'rollout_plan.md': {
        type: 'file',
        content: `# Rollout plan

- Customer wants a 30-day rollout for three new regional teams.
- Regional admins have not completed training yet.
- SSO migration is scheduled for the second week of the rollout.
`,
      },
      'support_history.md': {
        type: 'file',
        content: `# Support history

- Two high-priority onboarding tickets were closed in the last quarter.
- No open production incidents.
- Customer success manager asked for a phased launch if the contract closes.
`,
      },
    },
  });

  const client = new UnixLocalSandboxClient();
  const pricingSession = await client.create(pricingManifest);
  const rolloutSession = await client.create(rolloutManifest);

  const pricingAgent = new SandboxAgent({
    name: 'Pricing Packet Reviewer',
    model,
    instructions:
      'Inspect renewal pricing documents and return a structured commercial review. Extract the exact requested discount percent and renewal term from pricing_summary.md, use the shell tool before answering, keep every field grounded in the files you inspected, and use relative paths because the shell already starts in the workspace root.',
    defaultManifest: pricingManifest,
    capabilities: [shell()],
    outputType: PricingPacketReview,
  });

  const rolloutAgent = new SandboxAgent({
    name: 'Rollout Risk Reviewer',
    model,
    instructions:
      'Inspect rollout plans and return a structured delivery review. Use the shell tool before answering, keep the output tightly grounded in the rollout documents, list only blockers and evidence files that appear in the workspace, and use relative paths because the shell already starts in the workspace root.',
    defaultManifest: rolloutManifest,
    capabilities: [shell()],
    outputType: RolloutRiskReview,
  });

  const orchestrator = new Agent({
    name: 'Revenue Operations Coordinator',
    model,
    instructions:
      'You coordinate renewal reviews. Before answering, you must use all three tools: review_pricing_packet, review_rollout_risk, and get_discount_approval_rule. Use the exact requested_discount_percent field from review_pricing_packet when calling get_discount_approval_rule, and keep the final recommendation grounded in the tool outputs.',
    tools: [
      pricingAgent.asTool({
        toolName: 'review_pricing_packet',
        toolDescription:
          'Inspect the pricing packet and summarize commercial risk.',
        customOutputExtractor(result: { finalOutput?: unknown }) {
          return JSON.stringify(result.finalOutput);
        },
        runConfig: {
          sandbox: { session: pricingSession },
          tracingDisabled: true,
          workflowName: 'Pricing packet review',
        },
        runOptions: {
          maxTurns: 8,
        },
      }),
      rolloutAgent.asTool({
        toolName: 'review_rollout_risk',
        toolDescription:
          'Inspect the rollout packet and summarize implementation risk.',
        customOutputExtractor(result: { finalOutput?: unknown }) {
          return JSON.stringify(result.finalOutput);
        },
        runConfig: {
          sandbox: { session: rolloutSession },
          tracingDisabled: true,
          workflowName: 'Rollout risk review',
        },
        runOptions: {
          maxTurns: 8,
        },
      }),
      discountApprovalRuleTool,
    ],
  });

  try {
    const result = await run(orchestrator, question, {});

    const toolNames = getToolNames(result.newItems);
    for (const expectedTool of [
      'review_pricing_packet',
      'review_rollout_risk',
      'get_discount_approval_rule',
    ]) {
      if (!toolNames.includes(expectedTool)) {
        throw new Error(
          `Expected ${expectedTool}, saw: ${toolNames.join(', ')}`,
        );
      }
    }

    console.log(`[tools used] ${toolNames.join(', ')}`);
    console.log(result.finalOutput);
  } finally {
    await pricingSession.close?.().catch(() => {});
    await rolloutSession.close?.().catch(() => {});
  }
}

await runExampleMain(main);
