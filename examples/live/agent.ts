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
    model: 'gpt-live-1',
    instructions:
      'Help with fictional demo orders. Delegate order questions to the backend. ' +
      'Keep spoken replies brief. Ask for missing information. ' +
      'If the user corrects an order ID, ask the backend about the corrected order.',
    delegation: {
      type: 'responses',
      responses: {
        model: backendModel,
        instructions:
          'Use ask_order_agent for order questions. Include the order ID, relevant context, ' +
          'and latest corrections in a self-contained request. Use the returned facts without ' +
          "inventing an order status. Associate results with their order IDs and the user's latest request.",
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
        ],
      },
    },
  };
}
