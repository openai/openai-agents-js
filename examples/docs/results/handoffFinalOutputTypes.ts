import { Agent, run } from '@openai/agents';
import { z } from '@openai/zod';

const refundAgent = new Agent({
  name: 'Refund Agent',
  instructions:
    'You are a refund agent. You are responsible for refunding customers.',
  outputType: z.object({
    refundApproved: z.boolean(),
  }),
});

const orderAgent = new Agent({
  name: 'Order Agent',
  instructions:
    'You are an order agent. You are responsible for processing orders.',
  outputType: z.object({
    orderId: z.string(),
  }),
});

const triageAgent = Agent.create({
  name: 'Triage Agent',
  instructions:
    'You are a triage agent. You are responsible for triaging customer issues.',
  handoffs: [refundAgent, orderAgent],
});

const result = await run(triageAgent, 'I need to a refund for my order');

const output = result.finalOutput;
// ^? { refundApproved: boolean } | { orderId: string } | string | undefined
