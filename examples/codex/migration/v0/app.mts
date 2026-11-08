import { Agent, tool, type Model, type RunContext } from '@openai/agents';
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

export function v0Lookup(model: Model) {
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
  return new Agent<SupportContext, typeof answerSchema>({
    name: 'Order support',
    model,
    instructions:
      'Look up the requested order. Return its orderId, status, and tracking. Reuse reviewed facts without tools.',
    tools: [lookupOrder],
    outputType: answerSchema,
  });
}
