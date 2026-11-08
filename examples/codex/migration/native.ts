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

const answerSchema = z.strictObject({
  orderId: z.string(),
  status: z.string(),
  tracking: z.string(),
});
export type OrderAnswer = z.infer<typeof answerSchema>;

export async function runNativeLookup(
  provider: NativeProvider,
  context: SupportContext,
): Promise<OrderAnswer> {
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
  const agent = new Agent<SupportContext, OrderAnswer>({
    name: 'Order support',
    provider,
    model: 'gpt-4.1-mini',
    instructions:
      'Look up ORDER-42 and return its orderId, status, and tracking.',
    tools: [lookupOrder],
    outputType: { mode: 'native', schema: answerSchema },
  });
  const result = await agent.run('Where is ORDER-42?', { context });
  return result.finalOutput;
}
