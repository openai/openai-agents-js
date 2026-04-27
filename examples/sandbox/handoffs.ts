import { Agent, run, type RunItem } from '@openai/agents';
import { Manifest, SandboxAgent, shell } from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents/sandbox/local';
import {
  DEFAULT_MODEL,
  getStringArg,
  requireOpenAIKey,
  runExampleMain,
} from './support';

const DEFAULT_QUESTION =
  'Review the attached onboarding packet and draft a short internal note for the account executive about what to confirm before kickoff.';

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
  const manifest = new Manifest({
    entries: {
      'customer_background.md': {
        type: 'file',
        content: `# Customer background

- Customer: Bluebird Logistics.
- Region: North America.
- New purchase: analytics workspace plus SSO.
`,
      },
      'kickoff_checklist.md': {
        type: 'file',
        content: `# Kickoff checklist

- Security questionnaire is still in review.
- Two customer admins still need to complete access training.
- Target kickoff date is next Tuesday.
`,
      },
      'implementation_scope.md': {
        type: 'file',
        content: `# Implementation scope

- The customer wants historical data migration for 5 years of records.
- Data engineering support is available only starting next month.
`,
      },
    },
  });

  const client = new UnixLocalSandboxClient();
  const session = await client.create(manifest);

  const accountManager = new Agent({
    name: 'Account Executive Assistant',
    model,
    instructions:
      'You write concise internal updates for account teams. Convert the sandbox review into a short note with a headline, the top risks, and a recommended next step.',
  });

  const sandboxReviewer = new SandboxAgent({
    name: 'Onboarding Packet Reviewer',
    model,
    instructions:
      'Inspect onboarding documents in the sandbox, verify the facts, then hand off to the account executive assistant to draft the final note. Do not answer directly after reviewing the packet. The shell already starts in the workspace root, so use relative paths instead of changing to /workspace.',
    defaultManifest: manifest,
    handoffs: [accountManager],
    capabilities: [shell()],
  });

  const intakeAgent = new Agent({
    name: 'Deal Desk Intake',
    model,
    instructions:
      'You triage internal requests. If a request depends on attached documents, hand off to the onboarding packet reviewer immediately.',
    handoffs: [sandboxReviewer],
  });

  try {
    const result = await run(intakeAgent, question, { sandbox: { session } });

    const toolNames = getToolNames(result.newItems);
    const itemTypes = result.newItems.map((item) => item.type);
    if (!toolNames.includes('exec_command')) {
      throw new Error(`Expected exec_command, saw: ${toolNames.join(', ')}`);
    }
    if (
      !itemTypes.includes('handoff_call_item') &&
      !itemTypes.includes('handoff_output_item') &&
      result.lastAgent?.name !== accountManager.name
    ) {
      throw new Error(`Expected at least one handoff item in the run output.`);
    }
    if (
      typeof result.finalOutput !== 'string' ||
      result.finalOutput.trim().length === 0
    ) {
      throw new Error('Expected a non-empty final output.');
    }

    console.log(`[tools used] ${toolNames.join(', ')}`);
    console.log(result.finalOutput);
  } finally {
    await session.close?.().catch(() => {});
  }
}

await runExampleMain(main);
