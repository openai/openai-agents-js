import { RealtimeAgent, RealtimeSession, tool } from '@openai/agents/realtime';
import { ScriptedRealtimeTransport } from '@openai/agents/realtime/testing';
import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

test('executes a RealtimeAgent tool call', async () => {
  let lookedUpOrderId: string | undefined;
  const lookupOrder = tool({
    name: 'lookup_order',
    description: 'Looks up an order by ID.',
    parameters: z.object({ orderId: z.string() }),
    execute: async ({ orderId }) => {
      lookedUpOrderId = orderId;
      return `Order ${orderId} has shipped.`;
    },
  });
  const agent = new RealtimeAgent({
    name: 'Order assistant',
    instructions: 'Help customers track their orders.',
    tools: [lookupOrder],
  });
  const transport = new ScriptedRealtimeTransport();
  const session = new RealtimeSession(agent, { transport });
  let markToolOutputReturned!: () => void;
  let rejectToolOutput!: (reason?: unknown) => void;
  const toolOutputReturned = new Promise<void>((resolve, reject) => {
    markToolOutputReturned = resolve;
    rejectToolOutput = reject;
  });
  // Observe a scenario failure that happens before exercise reaches its await.
  // Awaiting the original promise still receives the same rejection.
  void toolOutputReturned.catch(() => undefined);

  await transport.runScenario({
    // Tool execution is asynchronous. Bound the scenario so a missing tool
    // output fails here instead of waiting for the test runner's timeout.
    signal: AbortSignal.timeout(5_000),
    scenario: async ({ expectCall, emit }) => {
      try {
        await expectCall('connect');
        await expectCall('sendMessage', (call) => {
          assert.equal(call.message, 'Where is order 123?');
        });

        // Script the model choosing the agent's tool. This tests how the SDK
        // handles that choice, not whether a real model would make the choice.
        emit('turn_started', {
          type: 'response_started',
          providerData: { response: { id: 'response_1' } },
        });
        emit('function_call', {
          type: 'function_call',
          name: 'lookup_order',
          callId: 'call_1',
          arguments: JSON.stringify({ orderId: 'order_123' }),
          responseId: 'response_1',
        });

        // RealtimeSession runs the actual tool and sends its result back through
        // the transport so the model could continue the response.
        await expectCall('sendFunctionCallOutput', (call) => {
          assert.equal(call.toolCall.callId, 'call_1');
          assert.equal(call.output, 'Order order_123 has shipped.');
          assert.equal(call.startResponse, true);
        });
        markToolOutputReturned();
        await expectCall('close');
      } catch (error) {
        // Unblock exercise so its finally block can close the session.
        rejectToolOutput(error);
        throw error;
      }
    },
    exercise: async () => {
      try {
        await session.connect({ apiKey: 'test' });
        session.sendMessage('Where is order 123?');
        await toolOutputReturned;
      } finally {
        // Clean up even when the scenario fails or reaches its time limit.
        session.close();
      }
    },
  });

  assert.equal(lookedUpOrderId, 'order_123');
  transport.assertComplete();
  transport.assertClosed();
});
