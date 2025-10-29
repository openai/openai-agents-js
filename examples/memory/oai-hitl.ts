import { z } from 'zod';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
  Agent,
  OpenAIConversationsSession,
  RunResult,
  RunToolApprovalItem,
  run,
  tool,
} from '@openai/agents';

import type { Interface as ReadlineInterface } from 'node:readline/promises';

const customerDirectory: Record<
  string,
  { name: string; phone: string; tier: string; notes: string }
> = {
  '101': {
    name: 'Amina K.',
    phone: '+1-415-555-1010',
    tier: 'gold',
    notes: 'Prefers SMS follow ups and values concise summaries.',
  },
  '104': {
    name: 'Diego L.',
    phone: '+1-415-555-2040',
    tier: 'platinum',
    notes:
      'Recently reported sync issues. Flagged for a proactive onboarding call.',
  },
  '205': {
    name: 'Morgan S.',
    phone: '+1-415-555-3205',
    tier: 'standard',
    notes: 'Interested in automation tutorials sent last week.',
  },
};

const lookupCustomerProfile = tool({
  name: 'lookup_customer_profile',
  description:
    'Look up stored profile details for a customer by their internal id.',
  parameters: z.object({
    id: z
      .string()
      .describe('The internal identifier for the customer to retrieve.'),
  }),
  async needsApproval() {
    return true;
  },
  async execute({ id }) {
    const record = customerDirectory[id];
    if (!record) {
      return `No customer found for id ${id}.`;
    }
    return `Customer ${record.name} (tier ${record.tier}) can be reached at ${record.phone}. Notes: ${record.notes}`;
  },
});

function formatToolArguments(interruption: RunToolApprovalItem): string {
  const args = interruption.rawItem.arguments;
  if (!args) {
    return '';
  }
  if (typeof args === 'string') {
    return args;
  }
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

async function promptYesNo(
  rl: ReadlineInterface,
  question: string,
): Promise<boolean> {
  const answer = await rl.question(`${question} (y/n): `);
  const normalized = answer.trim().toLowerCase();
  return normalized === 'y' || normalized === 'yes';
}

async function resolveInterruptions<TContext, TAgent extends Agent<any, any>>(
  rl: ReadlineInterface,
  agent: TAgent,
  initialResult: RunResult<TContext, TAgent>,
  session: OpenAIConversationsSession,
): Promise<RunResult<TContext, TAgent>> {
  let result = initialResult;
  while (result.interruptions?.length) {
    for (const interruption of result.interruptions) {
      const args = formatToolArguments(interruption);
      const approved = await promptYesNo(
        rl,
        `Agent ${interruption.agent.name} wants to call ${interruption.rawItem.name} with ${args || 'no arguments'}`,
      );
      if (approved) {
        result.state.approve(interruption);
        console.log('Approved tool call.');
      } else {
        result.state.reject(interruption);
        console.log('Rejected tool call.');
      }
    }

    result = await run(agent, result.state, { session });
  }

  return result;
}

async function main() {
  const agent = new Agent({
    name: 'Memory HITL assistant',
    instructions:
      'You assist support agents. Always consult the lookup_customer_profile tool before answering customer questions so your replies include stored notes. Keep responses under three sentences.',
    modelSettings: { toolChoice: 'required' },
    tools: [lookupCustomerProfile],
  });

  const session = new OpenAIConversationsSession();
  const rl = readline.createInterface({ input, output });

  console.log(
    'Enter a message to chat with the agent. Submit an empty line to exit.',
  );

  while (true) {
    const userMessage = await rl.question('You: ');
    if (!userMessage.trim()) {
      break;
    }

    let result = await run(agent, userMessage, { session });
    result = await resolveInterruptions(rl, agent, result, session);

    const reply = result.finalOutput ?? '[No final output produced]';
    console.log(`Assistant: ${reply}`);
    console.log();
  }

  rl.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
