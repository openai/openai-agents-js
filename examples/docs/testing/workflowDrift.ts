import { Agent, type Model, Runner, tool } from '@openai/agents';
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
} from '@openai/agents/testing';
import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

function createOrderAgent(model: Model) {
  const lookupOrder = tool({
    name: 'lookup_order',
    description: 'Looks up an order.',
    parameters: z.object({ orderId: z.string() }),
    execute: async ({ orderId }) => `${orderId}: shipped`,
  });

  return new Agent({
    name: 'Order assistant',
    model,
    tools: [lookupOrder],
  });
}

test('preserves the order lookup workflow contract', async (t) => {
  const model = new ScriptedModel([
    [
      functionCall(
        'lookup_order',
        { orderId: 'order_123' },
        { callId: 'call_1' },
      ),
    ],
    [assistantMessage('Order 123 has shipped.')],
  ]);
  // Keep this assertion in teardown so an early workflow exit is reported
  // even when another assertion fails first.
  t.after(() => model.assertComplete());
  const agent = createOrderAgent(model);

  // ScriptedModel replaces model I/O; disable tracing separately so this test
  // makes no network requests.
  const runner = new Runner({ tracingDisabled: true });
  const result = await runner.run(agent, 'Where is order 123?');

  assert.equal(result.finalOutput, 'Order 123 has shipped.');
  assert.equal(model.calls.length, 2);
});
