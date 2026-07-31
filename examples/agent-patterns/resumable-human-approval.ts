import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Agent, RunState, run, tool } from '@openai/agents';
import { z } from 'zod';

type Command = 'request' | 'status' | 'approve' | 'reject' | 'cleanup';

type PendingApprovalFile = {
  createdAt: string;
  agentName: string;
  toolName: string | undefined;
  arguments: string | undefined;
  runStateHash: string;
  instructions: string;
};

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const stateDir = path.join(currentDir, '.approval-state');
const runStatePath = path.join(stateDir, 'run-state.json');
const pendingApprovalPath = path.join(stateDir, 'pending-approval.json');

const amountUsdSchema = z
  .number()
  .positive()
  .describe('The expense amount in USD. It must be stated by the user.');

const expenseReportSchema = z.object({
  merchant: z.string(),
  amountUsd: amountUsdSchema,
  category: z.string(),
  businessPurpose: z.string(),
  policyNote: z.string(),
});

type ExpenseReport = z.infer<typeof expenseReportSchema>;

function hashString(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function getSubmissionKey(report: ExpenseReport) {
  return hashString(
    JSON.stringify({
      merchant: report.merchant,
      amountUsd: report.amountUsd,
      category: report.category,
      businessPurpose: report.businessPurpose,
    }),
  ).slice(0, 12);
}

const prepareExpenseReport = tool({
  name: 'prepare_expense_report',
  description: 'Prepare an expense report draft from a short description.',
  parameters: z.object({
    merchant: z.string().describe('The merchant or counterparty.'),
    amountUsd: amountUsdSchema,
    businessPurpose: z.string().describe('The business purpose.'),
  }),
  outputSchema: expenseReportSchema,
  execute: async ({ merchant, amountUsd, businessPurpose }) => {
    return {
      merchant,
      amountUsd,
      category: 'Meals and entertainment',
      businessPurpose,
      policyNote:
        amountUsd > 100
          ? 'Expenses over $100 require manager approval before submission.'
          : 'This expense can be submitted without manager approval.',
    };
  },
});

const submitExpenseReport = tool({
  name: 'submit_expense_report',
  description: 'Submit a prepared expense report.',
  parameters: expenseReportSchema,
  needsApproval: async (_ctx, { amountUsd }) => amountUsd > 100,
  outputSchema: z.object({
    confirmationId: z.string(),
    status: z.literal('submitted'),
    submittedAmountUsd: z.number(),
  }),
  execute: async (report) => {
    const submissionKey = getSubmissionKey(report);
    return {
      confirmationId: `exp_demo_${submissionKey}`,
      status: 'submitted' as const,
      submittedAmountUsd: report.amountUsd,
    };
  },
});

const agent = new Agent({
  name: 'Expense approval assistant',
  instructions: `
You help employees prepare and submit expense reports.
If the merchant, amount, or business purpose is missing, ask for the missing details and do not call any tools.
For each request, first call prepare_expense_report.
Then call submit_expense_report with the prepared report.
If the submission is rejected, tell the user the draft was not submitted and summarize what needs review.
Keep the final answer to two short sentences.
  `.trim(),
  tools: [prepareExpenseReport, submitExpenseReport],
});

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureNoPendingApproval() {
  if (await fileExists(pendingApprovalPath)) {
    throw new Error(
      [
        'A pending approval already exists.',
        'Run one of:',
        '  pnpm examples:resumable-human-approval status',
        '  pnpm examples:resumable-human-approval approve',
        '  pnpm examples:resumable-human-approval reject',
        '  pnpm examples:resumable-human-approval cleanup',
      ].join('\n'),
    );
  }
}

async function writePendingApproval(state: RunState<any, any>) {
  const interruptions = state.getInterruptions();
  if (interruptions.length !== 1) {
    throw new Error(
      `Expected exactly one pending approval, found ${interruptions.length}.`,
    );
  }

  const [interruption] = interruptions;
  const serializedState = JSON.stringify(state, null, 2);
  const pendingApproval: PendingApprovalFile = {
    createdAt: new Date().toISOString(),
    agentName: interruption.agent.name,
    toolName: interruption.name,
    arguments: interruption.arguments,
    runStateHash: hashString(serializedState),
    instructions:
      'Review the pending tool call, then run approve or reject to resume the serialized run.',
  };

  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(runStatePath, serializedState, 'utf-8');
  await fs.writeFile(
    pendingApprovalPath,
    `${JSON.stringify(pendingApproval, null, 2)}\n`,
    'utf-8',
  );

  console.log(`Approval required for ${interruption.name}.`);
  console.log(
    `Saved run state to ${path.relative(process.cwd(), runStatePath)}.`,
  );
  console.log(`Run this later: pnpm examples:resumable-human-approval approve`);
}

async function readPendingApproval(): Promise<PendingApprovalFile> {
  try {
    return JSON.parse(await fs.readFile(pendingApprovalPath, 'utf-8'));
  } catch {
    throw new Error(
      'No pending approval found. Run request to start a resumable approval.',
    );
  }
}

async function loadPendingState(
  expectedHash: string,
): Promise<RunState<unknown, typeof agent>> {
  try {
    const serializedState = await fs.readFile(runStatePath, 'utf-8');
    if (hashString(serializedState) !== expectedHash) {
      throw new Error(
        'Saved approval metadata does not match the saved run state. Run cleanup before starting a new request.',
      );
    }
    return RunState.fromString(agent, serializedState);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith('Saved approval metadata')
    ) {
      throw error;
    }
    throw new Error(
      'No saved run state found. Run request to start a resumable approval.',
    );
  }
}

async function cleanupStateFiles() {
  await fs.rm(stateDir, { recursive: true, force: true });
}

async function requestApproval() {
  await ensureNoPendingApproval();

  const expenseRequest =
    process.argv.slice(3).join(' ').trim() ||
    'Create and submit an expense report for a $480 client dinner with Acme Corp.';

  const result = await run(agent, expenseRequest);

  if (!result.interruptions?.length) {
    console.log('Run completed without requiring approval.');
    console.log(result.finalOutput);
    return;
  }

  await writePendingApproval(result.state);
}

async function showStatus() {
  if (!(await fileExists(pendingApprovalPath))) {
    console.log(
      'No pending approval found. Run request to start a resumable approval.',
    );
    return;
  }

  const pendingApproval = await readPendingApproval();
  console.log('Pending approval:');
  console.log(JSON.stringify(pendingApproval, null, 2));
  const savedStateMatches = await fs
    .readFile(runStatePath, 'utf-8')
    .then(
      (savedState) => hashString(savedState) === pendingApproval.runStateHash,
    )
    .catch(() => false);
  if (!savedStateMatches) {
    console.log(
      'Warning: saved approval metadata does not match the run state file. Run cleanup before starting a new request.',
    );
  }
  if (!(await fileExists(runStatePath))) {
    console.log(
      'Warning: saved approval metadata exists, but the run state file is missing. Run cleanup before starting a new request.',
    );
  }
}

async function resumeWithDecision(decision: 'approve' | 'reject') {
  const pendingApproval = await readPendingApproval();
  const state = await loadPendingState(pendingApproval.runStateHash);
  const interruptions = state.getInterruptions();

  if (interruptions.length !== 1) {
    throw new Error(
      `Expected exactly one pending approval, found ${interruptions.length}.`,
    );
  }

  const [interruption] = interruptions;
  if (decision === 'approve') {
    state.approve(interruption);
    console.log(`Approved ${pendingApproval.toolName}.`);
  } else {
    state.reject(interruption, {
      message:
        'The manager rejected this expense submission. Do not submit it; explain what remains for review.',
    });
    console.log(`Rejected ${pendingApproval.toolName}.`);
  }

  const result = await run(agent, state);

  if (result.interruptions?.length) {
    await writePendingApproval(result.state);
    return;
  }

  await cleanupStateFiles();
  console.log('Resumed run.');
  console.log(`Final output: ${result.finalOutput}`);
}

function parseCommand(): Command {
  const command = process.argv[2] as Command | undefined;
  if (
    command === 'request' ||
    command === 'status' ||
    command === 'approve' ||
    command === 'reject' ||
    command === 'cleanup'
  ) {
    return command;
  }

  throw new Error(
    [
      'Usage:',
      '  pnpm examples:resumable-human-approval request',
      "  pnpm examples:resumable-human-approval request 'Create and submit an expense report for a $480 client dinner with Acme Corp.'",
      '  pnpm examples:resumable-human-approval status',
      '  pnpm examples:resumable-human-approval approve',
      '  pnpm examples:resumable-human-approval reject',
      '  pnpm examples:resumable-human-approval cleanup',
    ].join('\n'),
  );
}

async function main() {
  const command = parseCommand();

  if (command === 'request') {
    await requestApproval();
  } else if (command === 'status') {
    await showStatus();
  } else if (command === 'approve') {
    await resumeWithDecision('approve');
  } else if (command === 'reject') {
    await resumeWithDecision('reject');
  } else {
    await cleanupStateFiles();
    console.log('Removed saved approval state.');
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
