import { Agent, run, tool, withTrace } from '@openai/agents';
import { z } from 'zod';

async function main() {
  await withTrace('Agents as tools streaming example', async () => {
    let billingLookupCount = 0;
    let streamedEventCount = 0;
    const billingStatusCheckerTool = tool({
      name: 'Billing status checker',
      description:
        'You are a billing agent that answers questions about billing.',
      parameters: z.object({
        customerId: z.string().nullable().optional(),
        question: z.string(),
      }),
      execute: async ({ customerId, question }) => {
        billingLookupCount += 1;
        console.log(`Customer ID: ${customerId} Question: ${question}`);
        if (question.toLowerCase().includes('bill')) {
          return `This customer (ID: ${customerId})'s bill is $100`;
        }
        return `I'm sorry, I can only answer questions about billing.`;
      },
    });

    const subAgent = new Agent({
      name: 'Billing Agent',
      instructions:
        'Call the billing status checker for every billing question before answering.',
      tools: [billingStatusCheckerTool],
    });

    // When you pass either onStream or asTool response's on method, the agent is executed in streaming mode.
    const billingAgentTool = subAgent.asTool({
      toolName: 'billing_agent',
      toolDescription:
        'You are a billing agent that answers questions about billing.',
      // When you pass onStream handler, the agent is executed in streaming mode.
      onStream: (event) => {
        streamedEventCount += 1;
        console.log(
          `### onStream method streaming event from ${event.agent.name} in streaming mode:\n\n` +
            JSON.stringify(event) +
            '\n',
        );
      },
    });
    // Alternative way to listen to streaming events:
    // Event types: raw_model_stream_event, run_item_stream_event, agent_updated_stream_event
    /*
    billingAgentTool.on('raw_model_stream_event', (event) => {
      console.log(
        `### on method streaming event from ${event.agent.name} in streaming mode:\n\n` +
        JSON.stringify(event) +
        '\n',
      );
    });
    */

    const mainAgent = new Agent({
      name: 'Customer Support Agent',
      instructions:
        'You are the customer support agent that calls the billing agent to answer a user question.',
      tools: [billingAgentTool],
    });
    const result = await run(
      mainAgent,
      'Hello, my customer ID is ABC123. How much is my bill for this month?',
    );

    if (billingLookupCount === 0 || streamedEventCount === 0)
      throw new Error(
        'Expected a billing lookup and streamed child-agent events.',
      );
    console.log(`\n### Final response:\n\n${result.finalOutput}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
