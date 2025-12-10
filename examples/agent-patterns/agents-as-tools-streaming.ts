import { Agent, run, tool, withTrace } from '@openai/agents';
import { z } from 'zod';

async function main() {
  await withTrace('Agents as tools streaming example', async () => {
    const billingTool = tool({
      name: 'billing_agent',
      description:
        'You are a billing agent that answers questions about billing.',
      parameters: z.object({ customerId: z.string(), question: z.string() }),
      execute: async ({ customerId, question }) => {
        if (question.toLowerCase().includes('how much is my bill?')) {
          return `This customer (ID: ${customerId})'s bill is $100`;
        }
        return `I'm sorry, I can only answer questions about billing.`;
      },
    });
    const subAgent = new Agent({
      name: 'Billing Agent',
      instructions:
        'You are a billing agent that answers questions about billing.',
      modelSettings: { toolChoice: 'required' },
      tools: [billingTool],
    });

    const mainAgent = new Agent({
      name: 'Customer Support Agent',
      instructions:
        'You are the customer support agent that calls the billing agent to answer a user question.',
      tools: [
        subAgent.asTool({
          toolName: 'billing_agent',
          toolDescription:
            'You are a billing agent that answers questions about billing.',
          // When you pass onStream handler, the agent is executed in streaming mode.
          onStream: (event) => {
            console.log(
              `### Streaming event from ${event.agentName} in streaming mode:\n\n` +
                JSON.stringify(event) +
                '\n',
            );
          },
        }),
      ],
    });
    const result = await run(mainAgent, 'Hello, how much is my bill?');

    console.log(`\n### Final response:\n\n${result.finalOutput}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
