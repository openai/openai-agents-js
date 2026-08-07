import assert from 'node:assert/strict';
import test from 'node:test';

import {
  Agent,
  MemorySession,
  OpenAIConversationsSession,
  RunState,
  setTracingDisabled,
  tool,
} from '@openai/agents';
import { z } from 'zod';

import {
  createRunner,
  getToolOutputs,
  integrationModel,
  normalizeText,
} from '../helpers.mjs';

setTracingDisabled(true);

for (const approved of [false, true]) {
  test(`tool approval survives serialized state and ${approved ? 'approval' : 'rejection'}`, async () => {
    const calls = [];
    const performAction = tool({
      name: 'perform_action',
      description: 'Perform the deterministic action after explicit approval.',
      parameters: z.object({ action: z.string() }),
      needsApproval: true,
      execute: async ({ action }) => {
        calls.push(action);
        return 'completed';
      },
    });
    const agent = new Agent({
      name: 'Published approval agent',
      model: integrationModel,
      instructions:
        'Call perform_action with action "deploy". If it succeeds reply exactly APPROVED. If it is rejected reply exactly REJECTED.',
      tools: [performAction],
      modelSettings: { maxTokens: 512, toolChoice: 'perform_action' },
    });
    const runner = createRunner();
    const first = await runner.run(agent, 'Perform the deployment.');

    assert.equal(first.interruptions?.length, 1);
    assert.equal(first.interruptions[0].name, 'perform_action');

    const restored = await RunState.fromString(agent, first.state.toString());
    const interruption = restored.getInterruptions()[0];
    if (approved) {
      restored.approve(interruption);
    } else {
      restored.reject(interruption, {
        message: 'The operator rejected deploy.',
      });
    }

    const resumed = await runner.run(agent, restored);

    assert.deepEqual(calls, approved ? ['deploy'] : []);
    assert.equal(resumed.finalOutput, approved ? 'APPROVED' : 'REJECTED');
    assert.ok(getToolOutputs(resumed).length >= 1);
  });
}

test('MemorySession continues without repeating a completed tool call', async () => {
  const calls = [];
  const lookupCodeword = tool({
    name: 'lookup_codeword',
    description: 'Return a deterministic verification codeword.',
    parameters: z.object({ label: z.string() }),
    execute: async ({ label }) => {
      calls.push(label);
      return 'MARIGOLD';
    },
  });
  const agent = new Agent({
    name: 'Published memory session agent',
    model: integrationModel,
    instructions:
      'Use lookup_codeword when explicitly asked. Remember its result for later turns.',
    tools: [lookupCodeword],
    modelSettings: { maxTokens: 384 },
  });
  const session = new MemorySession();
  const runner = createRunner();

  const first = await runner.run(
    agent,
    "Call lookup_codeword with label 'release' and reply only STORED.",
    { session },
  );
  const second = await runner.run(
    agent,
    'What exact codeword did the tool return? Reply with only that word.',
    { session },
  );
  const savedItems = await session.getItems();

  assert.equal(first.finalOutput, 'STORED');
  assert.equal(normalizeText(second.finalOutput), 'MARIGOLD');
  assert.deepEqual(calls, ['release']);
  assert.ok(savedItems.some((item) => item.type === 'function_call_result'));
});

test('previousResponseId continues server-managed response state', async () => {
  const agent = new Agent({
    name: 'Published previous response agent',
    model: integrationModel,
    instructions: 'Follow the requested exact output format.',
    modelSettings: { maxTokens: 256 },
  });
  const runner = createRunner();
  const first = await runner.run(
    agent,
    'Remember that the verification word is ORCHID. Reply only STORED.',
  );

  assert.ok(first.lastResponseId);

  const second = await runner.run(
    agent,
    'What verification word did I ask you to remember? Reply with only that word.',
    { previousResponseId: first.lastResponseId },
  );

  assert.equal(normalizeText(second.finalOutput), 'ORCHID');
  assert.notEqual(second.lastResponseId, first.lastResponseId);
});

test('OpenAIConversationsSession persists and cleans up remote state', async () => {
  const agent = new Agent({
    name: 'Published Conversations session agent',
    model: integrationModel,
    instructions:
      'Remember user-provided values and answer exactly as requested.',
    modelSettings: { maxTokens: 256 },
  });
  const session = new OpenAIConversationsSession();
  const runner = createRunner();

  try {
    const first = await runner.run(
      agent,
      'Remember that the release number is 907. Reply only STORED.',
      { session },
    );
    const conversationId = await session.getSessionId();
    const second = await runner.run(
      agent,
      'What release number did I provide? Reply with only the number.',
      { session },
    );

    assert.equal(first.finalOutput, 'STORED');
    assert.match(conversationId, /^conv_/);
    assert.equal(String(second.finalOutput).trim(), '907');
  } finally {
    await session.clearSession();
  }
});
