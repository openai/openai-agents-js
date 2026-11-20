import { Agent, run, tool } from '@openai/agents';
import { z } from 'zod';

export const orderRequest = z.strictObject({
  request: z
    .string()
    .min(1)
    .describe(
      'A self-contained request including the order ID and latest corrections.',
    ),
});

export function createOrderAgent(model: Agent['model'] = 'gpt-5.6-luna') {
  return new Agent({
    name: 'Order specialist',
    model,
    instructions:
      'Handle order questions using lookup_order. These are fictional demo orders. ' +
      'Ask for clarification if the order ID or request is unclear. ' +
      'Return a brief factual answer including the order ID. Never claim to change an order.',
    tools: [
      tool({
        name: 'lookup_order',
        description: 'Look up an order in the fictional demo database.',
        parameters: z.object({ order_id: z.string() }),
        execute: async ({ order_id }) => {
          const orders: Record<string, string> = {
            A0042: 'Shipped. Expected delivery: September 15.',
            A0043: 'Processing. No shipping date confirmed.',
          };
          return JSON.stringify({
            order_id,
            status: Object.prototype.hasOwnProperty.call(orders, order_id)
              ? orders[order_id]
              : 'Order not found.',
          });
        },
      }),
    ],
  });
}

export async function askOrderAgent(
  agent: Agent,
  request: string,
  signal: AbortSignal,
) {
  const result = await run(agent, request, { maxTurns: 5, signal });
  if (result.interruptions.length) {
    return 'The specialist requires approval. This demo does not execute approved actions.';
  }
  return result.finalOutput ?? 'The specialist returned no answer.';
}

export function sessionConfig(backendModel = 'gpt-5.6-luna') {
  return {
    model: 'gpt-live-1.1',
    wake_policy: { type: 'speech' },
    idle_timeout_s: 20,
    instructions:
      "Help with fictional demo orders and questions that need web search. Keep replies brief and use the caller's language unless they request another one.\n\n" +
      'Backchannel policy: Acknowledge naturally without speaking over the caller.\n\n' +
      'Interruption policy: Stop speaking when the caller interrupts and listen.\n\n' +
      'Delegation policy: The backend can look up order status but cannot change orders. ' +
      'Delegate order status questions and corrections that change the order ID. ' +
      'Use the earlier ID to resolve partial corrections when clear, and ask for clarification before delegating if the order ID is unclear. ' +
      'Wait for the backend result before reporting order status. ' +
      'Also delegate explicit web search requests and questions that need current public information. ' +
      'Wait for the search result before answering them.',
    delegation: {
      type: 'responses',
      responses: {
        model: backendModel,
        instructions:
          'Use ask_order_agent for order questions. Include the order ID, relevant context, ' +
          'and latest corrections in a self-contained request. Use the returned facts without ' +
          "inventing an order status. Associate results with their order IDs and the user's latest request. " +
          'Use web_search for explicit search requests and current public information. ' +
          'Cite the web sources you use in search answers.',
        parallel_tool_calls: false,
        tools: [
          {
            type: 'function',
            name: 'ask_order_agent',
            description:
              'Ask the order specialist about fictional demo orders.',
            parameters: z.toJSONSchema(orderRequest),
            strict: true,
          },
          { type: 'web_search' },
        ],
      },
    },
  };
}
