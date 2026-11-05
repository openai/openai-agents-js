import { Agent, Runner, tool, type Model } from '@openai/agents/classic';
import { z } from 'zod';
import { specialistRequest } from './delegation';

const orders = new Map([
  ['A0042', 'Shipped. Expected delivery: September 15.'],
  ['A0043', 'Processing. No shipping date confirmed.'],
]);

export function createOrderAgent(model: string | Model = 'gpt-6-luna') {
  const lookupOrder = tool({
    name: 'lookup_order',
    description: 'Look up an order in the fictional demo database.',
    parameters: z.strictObject({ order_id: z.string() }),
    execute: async ({ order_id }) =>
      JSON.stringify({
        order_id,
        status: orders.get(order_id) ?? 'Order not found.',
      }),
  });
  return new Agent({
    name: 'Order specialist',
    model,
    instructions:
      'Handle order questions using lookup_order. These are fictional demo orders. ' +
      'Ask for clarification if the order ID or request is unclear. ' +
      'Return a brief factual answer including the order ID. Never claim to change an order.',
    tools: [lookupOrder],
  });
}

/** Run one independent specialist task and retain the original five-model-turn limit. */
export async function askOrderAgent(
  agent: Agent,
  request: string,
  signal: AbortSignal,
  runner = new Runner(),
): Promise<string> {
  signal.throwIfAborted();
  // No tool timeouts or detached tool work: Runner settlement joins this sample's callback.
  const result = await runner.run(agent, request, { maxTurns: 5, signal });
  signal.throwIfAborted();
  if (result.interruptions.length)
    return 'The specialist requires approval. This demo does not execute approved actions.';
  return result.finalOutput ?? 'The specialist did not return an answer.';
}

export function sessionConfig(
  backendModel = 'gpt-6-luna',
): Record<string, unknown> {
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
          'and latest corrections in a self-contained request. Use the returned facts ' +
          "without inventing an order status. Associate results with their order IDs and the user's latest request.",
        parallel_tool_calls: false,
        tools: [
          {
            type: 'function',
            name: 'ask_order_agent',
            description:
              'Ask the order specialist about fictional demo orders.',
            parameters: z.toJSONSchema(specialistRequest, {
              target: 'draft-7',
            }),
            strict: true,
          },
        ],
      },
    },
  };
}
