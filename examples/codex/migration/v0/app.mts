import {
  Agent,
  MemorySession,
  Runner,
  tool,
  type Model,
  type RunContext,
} from '@openai/agents';
import { z } from 'zod';
import {
  instructions,
  lookupOrder,
  notifyCustomer,
  routeSupport,
  type SupportContext,
} from '../business.ts';

export const answerSchema = z.object({
  orderId: z.string(),
  status: z.string(),
  tracking: z.string(),
});

export function v0Support(
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

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
} from '@openai/agents/testing';
import { answer, applicationContext } from '../business.ts';

export async function qualifyV0(directory: string) {
  const model = new ScriptedModel([
    [
      functionCall(
        'lookup_order',
        { orderId: 'ORDER-42' },
        { callId: 'lookup-1' },
      ),
    ],
    [
      functionCall(
        'notify_customer',
        { orderId: 'ORDER-42' },
        { callId: 'notify-1' },
      ),
    ],
    [assistantMessage(JSON.stringify(answer))],
    [
      functionCall(
        'notify_customer',
        { orderId: 'ORDER-42' },
        { callId: 'denied-1' },
      ),
    ],
    [assistantMessage(JSON.stringify(answer))],
  ]);
  const agent = v0Support(model);
  const context = applicationContext();
  const session = new MemorySession();
  const runner = new Runner({ tracingDisabled: true });
  const first = await runner.run(agent, 'Find ORDER-42 and notify me.', {
    context,
    session,
  });
  assert.deepEqual(first.finalOutput, answer);
  assert.deepEqual(context.notifications, ['ORDER-42']);
  context.canNotify = false;
  const second = await runner.run(
    agent,
    'Recall the order and try notifying again.',
    { context, session },
  );
  assert.deepEqual(second.finalOutput, answer);
  assert(JSON.stringify(model.calls[3].request.input).includes('TRACK-42'));
  assert(
    JSON.stringify(model.calls[4].request.input).includes(
      'Notification was not sent',
    ),
  );
  assert.deepEqual(context.lookups, ['ORDER-42']);
  assert.deepEqual(context.notifications, ['ORDER-42']);
  model.assertComplete();
  await mkdir(directory, { recursive: true });
  await writeFile(
    resolve(directory, 'classic-state.json'),
    JSON.stringify({
      facts: answerSchema.parse(second.finalOutput),
      state: second.state.toString(),
      history: await session.getItems(),
    }),
  );
  console.log('v0 order workflow passed; saved classic-state.json');
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await qualifyV0(resolve(process.argv[2] ?? 'records'));
}
