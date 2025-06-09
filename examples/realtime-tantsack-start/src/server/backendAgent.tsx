import { Agent, Runner, user } from '@openai/agents';
import { type RealtimeItem } from '@openai/agents/realtime';
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';

const backendAgent = new Agent({
  name: 'Refund Agent',
  instructions:
    'You are a specialist on handling refund requests and detect fraud. You are given a request and you need to determine if the request is valid and if it is, you need to handle it.',
  model: 'o4-mini',
  outputType: z.object({
    refundApproved: z.boolean(),
    refundReason: z.string(),
    fraud: z.boolean(),
  }),
});

const runner = new Runner();

export async function handleRefundRequest(
  request: string,
  history: RealtimeItem[] = [],
) {
  const input = [
    user(
      `
Request: ${request}

## Past Conversation History
${JSON.stringify(history, null, 2)}
      `.trim(),
    ),
  ];
  const result = await runner.run(backendAgent, input);
  console.log(result.output);
  return JSON.stringify(result.finalOutput);
}

// We need to use a server function to handle the request because the request is coming
// from the client and we need to validate the request before we can handle it.
export const handleRefundRequestServerFn = createServerFn()
  .validator((data: { history: RealtimeItem[]; request: string }) => data)
  .handler(async ({ data }) => {
    const { history, request } = data;

    return handleRefundRequest(request, history);
  });
