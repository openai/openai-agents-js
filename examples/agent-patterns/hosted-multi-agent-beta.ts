import OpenAI from 'openai';
import {
  Agent,
  isOpenAIResponsesRawModelStreamEvent,
  run,
  tool,
} from '@openai/agents';
import {
  OpenAIHostedMultiAgentModel,
  getHostedAgentMetadata,
} from '@openai/agents-openai/experimental/hosted-multi-agent';
import { z } from 'zod';

const records = {
  alpha: { estimatedWeeks: 6, risk: 'medium' },
  beta: { estimatedWeeks: 8, risk: 'low' },
} as const;

const getProposal = tool({
  name: 'get_proposal',
  description: 'Return deterministic details for a proposal.',
  parameters: z.object({ proposal: z.enum(['alpha', 'beta']) }),
  execute: async ({ proposal }, _context, details) => {
    const metadata = getHostedAgentMetadata(details);
    console.log(
      `local tool caller=${metadata?.agentName ?? 'unknown'} call_id=${details?.toolCall?.callId ?? 'unknown'} proposal=${proposal}`,
    );
    return records[proposal];
  },
});

const hostedItemTypes = new Set([
  'multi_agent_call',
  'multi_agent_call_output',
  'agent_message',
]);

function logHostedItem(item: unknown): void {
  if (!item || typeof item !== 'object') {
    return;
  }

  const type = (item as { type?: unknown }).type;
  const metadata = getHostedAgentMetadata(item);
  const isSubagentMessage =
    type === 'message' && metadata?.agentName !== '/root';
  if (
    typeof type === 'string' &&
    (hostedItemTypes.has(type) || isSubagentMessage)
  ) {
    console.log(
      `hosted item type=${type} agent=${metadata?.agentName ?? 'unknown'}`,
    );
  }
}

function getMode(): 'stream' | 'nonstream' {
  const modeIndex = process.argv.indexOf('--mode');
  const mode = modeIndex === -1 ? undefined : process.argv[modeIndex + 1];
  if (mode === 'stream' || mode === 'nonstream') {
    return mode;
  }
  if (mode !== undefined) {
    throw new Error('Use --mode stream or --mode nonstream.');
  }
  return process.argv.includes('--stream') ? 'stream' : 'nonstream';
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      'Set OPENAI_API_KEY and ensure the project has hosted Multi-agent beta access.',
    );
  }

  const model = new OpenAIHostedMultiAgentModel(new OpenAI(), 'gpt-5.6-sol');
  try {
    const agent = new Agent({
      name: 'Hosted proposal coordinator',
      model,
      tools: [getProposal],
      instructions:
        'Create two subagents. Ask one to inspect proposal alpha and the other to inspect proposal beta. Each subagent must call get_proposal for its assigned proposal. Wait for both, then compare their duration and risk in one concise root final answer.',
    });
    const prompt = 'Compare proposal alpha with proposal beta.';

    if (getMode() === 'stream') {
      const streamed = await run(agent, prompt, { stream: true });
      for await (const event of streamed) {
        if (
          isOpenAIResponsesRawModelStreamEvent(event) &&
          event.data.event.type === 'response.output_item.done'
        ) {
          logHostedItem(event.data.event.item);
        }
      }
      console.log(`\nFinal response:\n${streamed.finalOutput}`);
      return;
    }

    const result = await run(agent, prompt);
    console.log(`Final response:\n${result.finalOutput}`);
  } finally {
    await model.close();
  }
}

main().catch((error) => {
  console.error(
    'Hosted Multi-agent example failed. Verify beta access and the selected model.',
  );
  console.error(error);
  process.exit(1);
});
