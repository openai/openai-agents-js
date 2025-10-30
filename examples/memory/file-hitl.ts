import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
  Agent,
  RunResult,
  RunToolApprovalItem,
  run,
  withTrace,
} from '@openai/agents';

import type { Interface as ReadlineInterface } from 'node:readline/promises';
import { FileSession } from './sessions';
import { createLookupCustomerProfileTool, fetchImageData } from './tools';

const customerDirectory: Record<string, string> = {
  '101':
    'Customer Kaz S. (tier gold) can be reached at +1-415-555-AAAA. Notes: Prefers SMS follow ups and values concise summaries.',
  '104':
    'Customer Yu S. (tier platinum) can be reached at +1-415-555-BBBB. Notes: Recently reported sync issues. Flagged for a proactive onboarding call.',
  '205':
    'Customer Ken S. (tier standard) can be reached at +1-415-555-CCCC. Notes: Interested in automation tutorials sent last week.',
};

const lookupCustomerProfile = createLookupCustomerProfileTool({
  directory: customerDirectory,
  transientErrorMessage:
    'Simulated CRM outage for the first lookup. Please retry the tool call.',
});
lookupCustomerProfile.needsApproval = async () => true;

const instructions =
  'You assist support agents. For every user turn you must call lookup_customer_profile and fetch_image_data before responding so replies include stored notes and the sample image. If a tool reports a transient failure, request approval and retry the same call once before responding. Keep responses under three sentences.';

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
  session: FileSession,
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
  await withTrace('memory:file-hitl:main', async () => {
    const agent = new Agent({
      name: 'File HITL assistant',
      instructions,
      modelSettings: { toolChoice: 'required' },
      tools: [lookupCustomerProfile, fetchImageData],
    });

    const session = new FileSession({ dir: './tmp' });
    const sessionId = await session.getSessionId();
    const rl = readline.createInterface({ input, output });

    console.log(`Session id: ${sessionId}`);
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
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
