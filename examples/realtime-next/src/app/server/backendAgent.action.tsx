'use server';

import { Agent, Runner, user } from '@openai/agents/classic';
import { type RealtimeItem } from '@openai/agents/realtime';
import { z } from 'zod';

const backendAgent = new Agent({
  name: 'Refund Agent',
  instructions:
    'You are a specialist on handling refund requests and detect fraud. You are given a request and you need to determine if the request is valid and if it is, you need to handle it.',
  model: 'gpt-5.4',
  outputType: z.object({
    refundApproved: z.boolean(),
    refundReason: z.string(),
    fraud: z.boolean(),
  }),
});

const runner = new Runner();
let remainingRefundRequests = 20;

export async function handleRefundRequest(
  request: string,
  history: RealtimeItem[] = [],
) {
  if (process.env.NODE_ENV !== 'development') {
    throw new Error('The refund demo is available only in local development.');
  }
  if (typeof request !== 'string' || request.length > 2000) {
    throw new Error('Refund request must be at most 2000 characters.');
  }
  if (!Array.isArray(history) || history.length > 30) {
    throw new Error('Refund history must contain at most 30 items.');
  }
  const historyJson = JSON.stringify(history, null, 2);
  if (historyJson.length > 12000) {
    throw new Error('Refund history must be at most 12000 characters.');
  }
  if (remainingRefundRequests <= 0) {
    throw new Error('Refund demo request limit reached. Restart the demo to reset it.');
  }
  remainingRefundRequests--;

  const input = [
    user(
      `
Request: ${request}

## Past Conversation History
${historyJson}
      `.trim(),
    ),
  ];
  const result = await runner.run(backendAgent, input);
  console.log(result.output);
  return JSON.stringify(result.finalOutput);
}
