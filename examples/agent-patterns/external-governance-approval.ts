import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import readline from 'node:readline/promises';
import { Agent, run, RunResult, RunState, tool } from '@openai/agents';
import { z } from 'zod';

type ExportCustomerRecordsInput = {
  accountId: string;
  destination: string;
  recordLimit: number;
  containsPii: boolean;
};

type GovernanceActionEnvelope = {
  actionHash: string;
  toolName: string;
  callId: string;
  proposedAction: string;
  arguments: ExportCustomerRecordsInput;
};

type GovernanceDecision = {
  verdict: 'allow' | 'require_approval' | 'deny';
  reason: string;
  actionHash: string;
  decisionId: string;
};

const EXTERNAL_GOVERNANCE_URL = process.env.EXTERNAL_GOVERNANCE_URL;
const AUTO_APPROVE_EXTERNAL_GOVERNANCE =
  process.env.AUTO_APPROVE_EXTERNAL_GOVERNANCE === '1' ||
  process.env.AUTO_APPROVE_HITL === '1';
const STATE_PATH = 'external-governance-result.json';
const DECISION_CACHE_PATH = 'external-governance-decisions.json';
const decisionsByCallId = new Map<string, GovernanceDecision>();
const decisionsByActionHash = new Map<string, GovernanceDecision>();

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }

  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function buildActionEnvelope(
  input: ExportCustomerRecordsInput,
  callId?: string,
): GovernanceActionEnvelope {
  const toolName = 'export_customer_records';
  const normalizedCallId = callId ?? 'unknown-call';
  const proposedAction = `Export up to ${input.recordLimit} customer records for account ${input.accountId} to ${input.destination}.`;
  const actionHash = sha256(
    stableStringify({
      toolName,
      callId: normalizedCallId,
      proposedAction,
      arguments: input,
    }),
  );

  return {
    actionHash,
    toolName,
    callId: normalizedCallId,
    proposedAction,
    arguments: input,
  };
}

async function reviewWithExternalGovernance(
  envelope: GovernanceActionEnvelope,
): Promise<GovernanceDecision> {
  if (EXTERNAL_GOVERNANCE_URL) {
    const response = await fetch(EXTERNAL_GOVERNANCE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope),
    });

    if (!response.ok) {
      throw new Error(
        `External governance checkpoint returned ${response.status}.`,
      );
    }

    const decision = (await response.json()) as GovernanceDecision;
    assertDecisionMatchesEnvelope(decision, envelope);
    return decision;
  }

  const verdict =
    envelope.arguments.containsPii || envelope.arguments.recordLimit > 10
      ? 'require_approval'
      : 'allow';

  return {
    verdict,
    actionHash: envelope.actionHash,
    decisionId: `local-${envelope.actionHash.slice(0, 12)}`,
    reason:
      verdict === 'allow'
        ? 'The mock checkpoint classified the action as low risk.'
        : 'The mock checkpoint requires approval before exporting customer data.',
  };
}

function assertDecisionMatchesEnvelope(
  decision: GovernanceDecision,
  envelope: GovernanceActionEnvelope,
) {
  if (decision.actionHash !== envelope.actionHash) {
    throw new Error(
      'External governance returned a decision for a different action.',
    );
  }
}

async function loadDecisionCache(): Promise<
  Record<string, GovernanceDecision>
> {
  try {
    return JSON.parse(
      await fs.readFile(DECISION_CACHE_PATH, 'utf-8'),
    ) as Record<string, GovernanceDecision>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

async function persistDecision(
  envelope: GovernanceActionEnvelope,
  decision: GovernanceDecision,
) {
  assertDecisionMatchesEnvelope(decision, envelope);
  decisionsByCallId.set(envelope.callId, decision);
  decisionsByActionHash.set(envelope.actionHash, decision);

  const cache = await loadDecisionCache();
  cache[`call:${envelope.callId}`] = decision;
  cache[`action:${envelope.actionHash}`] = decision;
  await fs.writeFile(
    DECISION_CACHE_PATH,
    JSON.stringify(cache, null, 2),
    'utf-8',
  );
}

async function findDecision(
  envelope: GovernanceActionEnvelope,
): Promise<GovernanceDecision | undefined> {
  const inMemory =
    decisionsByCallId.get(envelope.callId) ??
    decisionsByActionHash.get(envelope.actionHash);
  if (inMemory) {
    assertDecisionMatchesEnvelope(inMemory, envelope);
    return inMemory;
  }

  const cache = await loadDecisionCache();
  const persisted =
    cache[`call:${envelope.callId}`] ?? cache[`action:${envelope.actionHash}`];
  if (!persisted) {
    return undefined;
  }

  assertDecisionMatchesEnvelope(persisted, envelope);
  decisionsByCallId.set(envelope.callId, persisted);
  decisionsByActionHash.set(envelope.actionHash, persisted);
  return persisted;
}

const exportCustomerRecords = tool({
  name: 'export_customer_records',
  description:
    'Export a bounded set of customer records to an internal destination.',
  parameters: z.object({
    accountId: z.string(),
    destination: z.string(),
    recordLimit: z.number().int().positive(),
    containsPii: z.boolean(),
  }),
  needsApproval: async (_context, input, callId) => {
    const envelope = buildActionEnvelope(input, callId);
    const decision = await reviewWithExternalGovernance(envelope);
    await persistDecision(envelope, decision);

    console.log('\nExternal governance decision');
    console.log(`- verdict: ${decision.verdict}`);
    console.log(`- decision_id: ${decision.decisionId}`);
    console.log(`- action_hash: ${decision.actionHash}`);
    console.log(`- reason: ${decision.reason}\n`);

    return decision.verdict !== 'allow';
  },
  execute: async (input, _context, details) => {
    const callId = details?.toolCall?.callId ?? 'unknown-call';
    const envelope = buildActionEnvelope(input, callId);
    const decision = await findDecision(envelope);

    if (!decision) {
      throw new Error(
        'No governance decision was recorded for this action; failing closed.',
      );
    }

    if (decision.verdict === 'deny') {
      throw new Error(`Blocked by external governance: ${decision.reason}`);
    }

    return {
      exported: input.recordLimit,
      accountId: input.accountId,
      destination: input.destination,
      governanceDecisionId: decision.decisionId,
      actionHash: envelope.actionHash,
    };
  },
});

const agent = new Agent({
  name: 'Governed export agent',
  instructions:
    'You help operations teams export customer records. Use the export tool when asked, and keep the final response concise.',
  tools: [exportCustomerRecords],
});

async function confirm(question: string): Promise<boolean> {
  if (AUTO_APPROVE_EXTERNAL_GOVERNANCE) {
    console.log(`[auto-approve] ${question}`);
    return true;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await rl.question(`${question} (y/n): `);
  rl.close();

  return ['y', 'yes'].includes(answer.toLowerCase());
}

async function main() {
  let result: RunResult<unknown, Agent<unknown, any>> = await run(
    agent,
    'Export 25 customer records for account acme-123 to the internal compliance drive. The export contains PII.',
  );

  while (result.interruptions?.length > 0) {
    await fs.writeFile(
      STATE_PATH,
      JSON.stringify(result.state, null, 2),
      'utf-8',
    );

    const storedState = await fs.readFile(STATE_PATH, 'utf-8');
    const state = await RunState.fromString(agent, storedState);

    for (const interruption of result.interruptions) {
      const confirmed = await confirm(
        `Approve ${interruption.name} with ${interruption.arguments ?? 'no arguments'}?`,
      );

      if (confirmed) {
        state.approve(interruption);
      } else {
        state.reject(interruption, {
          message: 'Rejected after external governance review.',
        });
      }
    }

    result = await run(agent, state);
  }

  console.log(result.finalOutput);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
