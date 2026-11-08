import {
  Agent,
  MemorySession,
  Runner,
  RunState,
  tool,
  type AgentInputItem,
  type Model,
  type RunContext,
} from '@openai/agents/classic';
import { z } from 'zod';
import {
  instructions,
  lookupOrder,
  notifyCustomer,
  routeSupport,
  type SupportContext,
} from './business';

export const answerSchema = z.object({
  orderId: z.string(),
  status: z.string(),
  tracking: z.string(),
});

export function classicSupport(
  model: Model,
  topic: 'shipping' | 'refund' = 'shipping',
) {
  const route = routeSupport(topic);
  return new Agent<SupportContext, typeof answerSchema>({
    name: route,
    model,
    instructions:
      route === 'order-support'
        ? instructions
        : 'Refer this refund to human review. Return the known order facts.',
    outputType: answerSchema,
    tools:
      route === 'order-support'
        ? [
            tool({
              name: 'lookup_order',
              description: 'Look up an order owned by the current customer.',
              parameters: z.object({ orderId: z.string() }),
              execute: ({ orderId }, context?: RunContext<SupportContext>) =>
                lookupOrder(context!.context, orderId),
            }),
            tool({
              name: 'notify_customer',
              errorFunction: () => 'Notification was not sent',
              description:
                'Send the current customer an order notification when permitted.',
              parameters: z.object({ orderId: z.string() }),
              execute: ({ orderId }, context?: RunContext<SupportContext>) =>
                notifyCustomer(context!.context, orderId),
            }),
          ]
        : [],
  });
}

/** Resume a v0 record only on the retained classic runtime. */
export async function continueClassic(
  model: Model,
  context: SupportContext,
  saved: { state: string; history: AgentInputItem[] },
) {
  const agent = classicSupport(model);
  const runner = new Runner({ tracingDisabled: true });
  const state = await RunState.fromString(agent, saved.state);
  await runner.run(agent, state, { context });
  const session = new MemorySession({ initialItems: saved.history });
  return runner.run(agent, 'Recall the order without another notification.', {
    context,
    session,
  });
}

export async function runClassicExample(model: Model, context: SupportContext) {
  const agent = classicSupport(model);
  const runner = new Runner({ tracingDisabled: true });
  const session = new MemorySession();
  const first = await runner.run(agent, 'Find ORDER-42 and notify me.', {
    context,
    session,
  });
  context.canNotify = false; // The application revokes permission for the next turn.
  const second = await runner.run(
    agent,
    'Recall the order and try notifying again.',
    { context, session },
  );
  return {
    first: first.finalOutput,
    second: second.finalOutput,
    state: second.state.toString(),
    history: await session.getItems(),
  };
}
