import { Agent, NativeProvider, tool, type ToolContext } from '@openai/agents';
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

export const answerSchema = z.strictObject({
  orderId: z.string(),
  status: z.string(),
  tracking: z.string(),
});
export type OrderAnswer = z.infer<typeof answerSchema>;

export function nativeLookup(provider: NativeProvider) {
  const lookupOrder = tool({
    name: 'lookup_order',
    description: 'Read an order owned by the current customer.',
    parameters: z.strictObject({ orderId: z.string() }),
    execute: ({ orderId }, { context }: ToolContext<SupportContext>) => {
      const order = context.orders.find(
        (order) =>
          order.orderId === orderId && order.customerId === context.customerId,
      );
      if (!order) throw new Error('Order is unavailable to this customer');
      return {
        orderId: order.orderId,
        status: order.status,
        tracking: order.tracking,
      };
    },
  });
  return new Agent<SupportContext, OrderAnswer>({
    name: 'Order support',
    provider,
    model: 'gpt-4.1-mini',
    instructions:
      'Look up the requested order. Return its orderId, status, and tracking. Reuse reviewed facts without tools.',
    tools: [lookupOrder],
    outputType: { mode: 'native', schema: answerSchema },
  });
}
