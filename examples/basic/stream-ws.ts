/**
 * Responses WebSocket streaming example with function tools, agent-as-tool, and HITL approval.
 *
 * This example enables the OpenAI Responses WebSocket transport and demonstrates:
 * - Streaming output (including reasoning summary deltas when available).
 * - Regular function tools.
 * - An `Agent.asTool(...)` specialist agent.
 * - Human-in-the-loop approval for a sensitive tool call.
 * - A follow-up turn using `previousResponseId`.
 *
 * Required environment variables:
 * - `OPENAI_API_KEY`.
 *
 * Optional environment variables:
 * - `OPENAI_MODEL` (defaults to `gpt-5.2-codex`).
 * - `OPENAI_BASE_URL`.
 * - `OPENAI_WEBSOCKET_BASE_URL`.
 * - `EXAMPLES_INTERACTIVE_MODE=auto` (auto-approve HITL prompts for scripted runs).
 * - `AUTO_APPROVE_HITL=1` (auto-approve HITL prompts).
 */
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import {
  Agent,
  Runner,
  tool,
  withResponsesWebSocketSession,
  withTrace,
} from '@openai/agents';
import { z } from 'zod';

type OrderRecord = {
  order_id: string;
  status: string;
  delivered_days_ago: number;
  amount: number;
  currency: string;
  item: string;
};

const AUTO_MODE = process.env.EXAMPLES_INTERACTIVE_MODE === 'auto';
const AUTO_APPROVE_HITL = process.env.AUTO_APPROVE_HITL === '1';

async function confirm(question: string): Promise<boolean> {
  if (AUTO_MODE || AUTO_APPROVE_HITL) {
    console.log(`[auto-approve] ${question}`);
    return true;
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(`${question} (y/n): `);
  rl.close();
  return ['y', 'yes'].includes(answer.trim().toLowerCase());
}

const lookupOrderTool = tool({
  name: 'lookup_order',
  description: 'Return deterministic order data for the demo.',
  parameters: z.object({
    order_id: z.string(),
  }),
  execute: async ({ order_id }): Promise<OrderRecord> => {
    const orders: Record<string, OrderRecord> = {
      'ORD-1001': {
        order_id: 'ORD-1001',
        status: 'delivered',
        delivered_days_ago: 3,
        amount: 49.99,
        currency: 'USD',
        item: 'Wireless Mouse',
      },
      'ORD-2002': {
        order_id: 'ORD-2002',
        status: 'delivered',
        delivered_days_ago: 12,
        amount: 129.0,
        currency: 'USD',
        item: 'Keyboard',
      },
    };

    return (
      orders[order_id] ?? {
        order_id,
        status: 'unknown',
        delivered_days_ago: 999,
        amount: 0,
        currency: 'USD',
        item: 'unknown',
      }
    );
  },
});

const submitRefundTool = tool({
  name: 'submit_refund',
  description: 'Create a refund request. This tool requires approval.',
  needsApproval: true,
  parameters: z.object({
    order_id: z.string(),
    amount: z.number(),
    reason: z.string(),
  }),
  execute: async ({ order_id, amount, reason }) => {
    const ticket =
      order_id === 'ORD-1001' ? 'RF-1001' : `RF-${order_id.slice(-4)}`;
    return {
      refund_ticket: ticket,
      order_id,
      amount,
      reason,
      status: 'approved_pending_processing',
    };
  },
});

async function runStreamedTurn(
  runner: Runner,
  agent: Agent,
  prompt: string,
  previousResponseId?: string,
): Promise<{ responseId: string; finalOutput: string }> {
  console.log(`\nUser: ${prompt}\n`);

  let streamedResult = await runner.run(agent, prompt, {
    stream: true,
    ...(previousResponseId ? { previousResponseId } : {}),
  });

  while (true) {
    let printedReasoning = false;
    let printedOutput = false;

    for await (const event of streamedResult.toStream()) {
      if (event.type === 'raw_model_stream_event') {
        if (event.data.type !== 'model') {
          continue;
        }

        const raw = event.data.event as { type?: string; delta?: string };
        if (raw.type === 'response.reasoning_summary_text.delta') {
          if (!printedReasoning) {
            console.log('Reasoning:');
            printedReasoning = true;
          }
          process.stdout.write(raw.delta ?? '');
        } else if (raw.type === 'response.output_text.delta') {
          if (printedReasoning && !printedOutput) {
            process.stdout.write('\n\n');
          }
          if (!printedOutput) {
            console.log('Assistant:');
            printedOutput = true;
          }
          process.stdout.write(raw.delta ?? '');
        }
        continue;
      }

      if (event.type !== 'run_item_stream_event') {
        continue;
      }

      if (event.item.type === 'tool_call_item') {
        const rawItem = event.item.rawItem as {
          name?: string;
          arguments?: string;
        };
        console.log(
          `\n[tool call] ${rawItem.name ?? 'unknown'}(${rawItem.arguments ?? ''})`,
        );
      } else if (event.item.type === 'tool_call_output_item') {
        console.log(`[tool result] ${JSON.stringify(event.item.output)}`);
      }
    }

    if (printedReasoning || printedOutput) {
      process.stdout.write('\n');
    }

    if (!streamedResult.interruptions?.length) {
      break;
    }

    console.log('\nHuman-in-the-loop: approval required for tool calls.');
    const state = streamedResult.state;
    for (const interruption of streamedResult.interruptions) {
      const approved = await confirm(
        `Approve ${interruption.name} with args ${interruption.arguments ?? '{}'}`,
      );
      if (approved) {
        state.approve(interruption);
      } else {
        state.reject(interruption);
      }
    }

    streamedResult = await runner.run(agent, state, { stream: true });
  }

  if (!streamedResult.lastResponseId) {
    throw new Error('The streamed run completed without a responseId.');
  }

  const finalOutput = String(streamedResult.finalOutput ?? '');
  console.log(`responseId: ${streamedResult.lastResponseId}`);
  console.log(`finalOutput: ${finalOutput}\n`);

  return {
    responseId: streamedResult.lastResponseId,
    finalOutput,
  };
}

async function main() {
  const model = process.env.OPENAI_MODEL ?? 'gpt-5.2-codex';

  const policyAgent = new Agent({
    name: 'RefundPolicySpecialist',
    instructions:
      'You are a refund policy specialist. Orders delivered within 7 days are eligible for a full refund. Older delivered orders are not. Return a short answer with eligibility and a one-line reason.',
    model,
    modelSettings: { maxTokens: 120 },
  });

  const supportAgent = new Agent({
    name: 'SupportAgent',
    instructions:
      'You are a support agent. For refund requests: 1) call lookup_order, 2) call refund_policy_specialist, 3) if the user asked to proceed and the order is eligible, call submit_refund. When asked only for the refund ticket, return only the ticket token (for example RF-1001).',
    model,
    modelSettings: {
      maxTokens: 240,
      reasoning: { effort: 'medium', summary: 'detailed' },
    },
    tools: [
      lookupOrderTool,
      policyAgent.asTool({
        toolName: 'refund_policy_specialist',
        toolDescription:
          'Check refund eligibility and explain the policy decision.',
      }),
      submitRefundTool,
    ],
  });

  try {
    await withResponsesWebSocketSession(async ({ runner }) => {
      await withTrace('Responses WS support example', async () => {
        console.log(`Using model=${model}`);

        const firstTurn = await runStreamedTurn(
          runner,
          supportAgent,
          'Customer wants a refund for order ORD-1001 because the mouse arrived damaged. Check the order, ask the refund policy specialist, and if it is eligible submit the refund. Reply with only the refund ticket.',
        );

        await runStreamedTurn(
          runner,
          supportAgent,
          'What refund ticket did you just create? Reply with only the ticket.',
          firstTurn.responseId,
        );
      });
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes('closed before any response events')
    ) {
      console.log(
        '\nWebSocket mode closed before sending events. This usually means the feature is not enabled for this account or model yet.',
      );
      return;
    }
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
