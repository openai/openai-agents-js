import assert from 'node:assert/strict';
import test from 'node:test';

import { Agent, handoff, setTracingDisabled, tool } from '@openai/agents';
import { z } from 'zod';

import {
  createRunner,
  getToolCalls,
  getToolOutputs,
  hasRawModelEvent,
  integrationModel,
  runAgent,
} from '../helpers.mjs';

setTracingDisabled(true);

for (const stream of [false, true]) {
  test(`handoffs preserve the active agent and tool ownership (${stream ? 'streaming' : 'non-streaming'})`, async () => {
    const calls = [];
    const lookupTicket = tool({
      name: 'lookup_ticket',
      description: 'Return the deterministic status for a support ticket.',
      parameters: z.object({ ticket: z.string() }),
      execute: async ({ ticket }) => {
        calls.push(ticket);
        return 'resolved';
      },
    });
    const specialist = new Agent({
      name: 'Published support specialist',
      model: integrationModel,
      instructions:
        "Call lookup_ticket exactly once with ticket 'CASE-42', then answer exactly HANDOFF_RESOLVED.",
      tools: [lookupTicket],
      modelSettings: { maxTokens: 512 },
    });
    const coordinator = new Agent({
      name: 'Published handoff coordinator',
      model: integrationModel,
      instructions:
        'Immediately transfer this support ticket to the support specialist.',
      handoffs: [handoff(specialist)],
      modelSettings: {
        maxTokens: 512,
        toolChoice: 'transfer_to_Published_support_specialist',
      },
    });
    const executed = await runAgent(
      createRunner(),
      coordinator,
      'Resolve support ticket CASE-42.',
      { stream },
    );
    const result = stream ? executed.result : executed;
    const callsBySpecialist = getToolCalls(result, 'lookup_ticket').filter(
      (item) => item.agent === specialist,
    );
    const outputsBySpecialist = getToolOutputs(result).filter(
      (item) => item.agent === specialist,
    );

    assert.deepEqual(calls, ['CASE-42']);
    assert.equal(result.finalOutput, 'HANDOFF_RESOLVED');
    assert.equal(result.lastAgent, specialist);
    assert.equal(callsBySpecialist.length, 1);
    assert.equal(outputsBySpecialist.length, 1);
    if (stream) {
      assert.ok(hasRawModelEvent(executed.events));
      assert.ok(
        executed.events.some(
          (event) => event.type === 'agent_updated_stream_event',
        ),
      );
    }
  });
}

test('an agent exposed as a tool returns through the outer agent', async () => {
  const worker = new Agent({
    name: 'Published nested worker',
    model: integrationModel,
    instructions: 'Reply with exactly INNER:42.',
    modelSettings: { maxTokens: 256 },
  });
  const coordinator = new Agent({
    name: 'Published nested coordinator',
    model: integrationModel,
    instructions:
      'Call ask_worker exactly once. After it returns, reply exactly OUTER:42.',
    tools: [
      worker.asTool({
        toolName: 'ask_worker',
        toolDescription: 'Ask the worker for the deterministic answer.',
      }),
    ],
    modelSettings: { maxTokens: 512, toolChoice: 'ask_worker' },
  });

  const result = await createRunner().run(
    coordinator,
    'Use the nested worker.',
  );

  assert.equal(result.finalOutput, 'OUTER:42');
  assert.equal(result.lastAgent, coordinator);
  assert.equal(getToolCalls(result, 'ask_worker').length, 1);
  assert.equal(getToolOutputs(result).length, 1);
});
