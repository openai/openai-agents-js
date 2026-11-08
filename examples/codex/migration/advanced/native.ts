import {
  Agent,
  NativeProvider,
  tool,
  parseSessionState,
  type ToolContext,
} from '@openai/agents';
import { z } from 'zod';
import {
  instructions,
  lookupOrder,
  notifyCustomer,
  routeSupport,
  reviewedFacts,
  type SupportContext,
} from './business';

export const answerSchema = z.strictObject({
  orderId: z.string(),
  status: z.string(),
  tracking: z.string(),
});

export function nativeSupport(
  provider: NativeProvider,
  topic: 'shipping' | 'refund' = 'shipping',
) {
  const route = routeSupport(topic);
  return new Agent<SupportContext, z.infer<typeof answerSchema>>({
    name: route,
    provider,
    model: 'gpt-4.1-mini',
    instructions:
      route === 'order-support'
        ? instructions
        : 'Refer this refund to human review. Return the known order facts.',
    outputType: { mode: 'native', schema: answerSchema },
    tools:
      route === 'order-support'
        ? [
            tool({
              name: 'lookup_order',
              description: 'Look up an order owned by the current customer.',
              parameters: z.strictObject({ orderId: z.string() }),
              execute: (
                { orderId },
                { context }: ToolContext<SupportContext>,
              ) => lookupOrder(context, orderId),
            }),
            tool({
              name: 'notify_customer',
              description:
                'Send the current customer an order notification when permitted.',
              parameters: z.strictObject({ orderId: z.string() }),
              before: ({ context }: ToolContext<SupportContext>) =>
                context.canNotify
                  ? { action: 'allow' }
                  : {
                      action: 'deny',
                      reason: 'Notification permission denied',
                    },
              execute: (
                { orderId },
                { context }: ToolContext<SupportContext>,
              ) => notifyCustomer(context, orderId),
            }),
          ]
        : [],
  });
}

/** A new native conversation owns only native state. Close it before its provider. */
export async function runNativeExample(
  provider: NativeProvider,
  context: SupportContext,
) {
  const agent = nativeSupport(provider);
  let checkpoint;
  let first;
  let second;
  {
    await using session = await agent.session({ context });
    first = (
      await (await session.submit('Find ORDER-42 and notify me.')).wait()
    ).finalOutput;
    context.canNotify = false;
    second = (
      await (
        await session.submit('Recall the order and try notifying again.')
      ).wait()
    ).finalOutput;
    checkpoint = JSON.stringify(await session.saveState());
  }
  // Persist checkpoint in application-owned storage before closing in production.
  await using restored = await agent.session({
    context,
    state: parseSessionState(checkpoint),
  });
  const recalled = (await (await restored.submit('Recall the order.')).wait())
    .finalOutput;
  return { first, second, recalled };
}

/** The caller approves facts; schema validation checks shape, not their truth. */
export async function startNativeFromReviewedFacts(
  provider: NativeProvider,
  facts: unknown,
  context: SupportContext,
) {
  const selected = answerSchema.parse(facts);
  return nativeSupport(provider).run(reviewedFacts(selected), { context });
}
