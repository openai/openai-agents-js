import {
  Agent,
  Runner,
  tool,
  type Model,
  type RunContext,
} from '@openai/agents';
import { z } from 'zod';

export interface SupportContext {
  customerId: string;
  orders: readonly {
    customerId: string;
    orderId: string;
    status: string;
    tracking: string;
  }[];
}

const answerSchema = z.object({
  orderId: z.string(),
  status: z.string(),
  tracking: z.string(),
});

export async function runV0Lookup(model: Model, context: SupportContext) {
  const lookupOrder = tool({
    name: 'lookup_order',
    description: 'Read an order owned by the current customer.',
    parameters: z.object({ orderId: z.string() }),
    execute: ({ orderId }, run?: RunContext<SupportContext>) => {
      const order = run!.context.orders.find(
        (order) =>
          order.orderId === orderId &&
          order.customerId === run!.context.customerId,
      );
      if (!order) throw new Error('Order is unavailable to this customer');
      return {
        orderId: order.orderId,
        status: order.status,
        tracking: order.tracking,
      };
    },
  });
  const agent = new Agent<SupportContext, typeof answerSchema>({
    name: 'Order support',
    model,
    instructions:
      'Look up ORDER-42 and return its orderId, status, and tracking.',
    tools: [lookupOrder],
    outputType: answerSchema,
  });
  const result = await new Runner({ tracingDisabled: true }).run(
    agent,
    'Where is ORDER-42?',
    { context },
  );
  return result.finalOutput;
}
