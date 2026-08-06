import assert from 'node:assert/strict';
import test from 'node:test';

import OpenAI from 'openai';
import {
  Agent,
  MaxTurnsExceededError,
  OpenAIResponsesModel,
  retryPolicies,
  setTracingDisabled,
  tool,
} from '@openai/agents';
import { z } from 'zod';

import { createRunner, getToolOutputs, integrationModel } from '../helpers.mjs';

setTracingDisabled(true);

test('a model retry reaches the real API without duplicating session input', async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  const client = new OpenAI({
    maxRetries: 0,
    fetch: async (...args) => {
      attempts += 1;
      if (attempts === 1) {
        throw new TypeError('Controlled integration transport failure.');
      }
      return originalFetch(...args);
    },
  });
  const model = new OpenAIResponsesModel(client, integrationModel);
  const agent = new Agent({
    name: 'Published real retry agent',
    model,
    instructions: 'Reply exactly RETRY_RECOVERED.',
    modelSettings: {
      maxTokens: 256,
      retry: {
        maxRetries: 1,
        backoff: {
          initialDelayMs: 0,
          maxDelayMs: 0,
          multiplier: 1,
          jitter: false,
        },
        policy: retryPolicies.networkError(),
      },
    },
  });

  const result = await createRunner().run(agent, 'Recover exactly once.');

  assert.equal(attempts, 2);
  assert.equal(result.finalOutput, 'RETRY_RECOVERED');
  assert.equal(result.state.usage.requests, 2);
});

test('a pre-aborted run makes no model request or tool side effect', async () => {
  let requests = 0;
  let toolCalls = 0;
  const client = new OpenAI({
    maxRetries: 0,
    fetch: async () => {
      requests += 1;
      throw new Error('The model request must not run.');
    },
  });
  const sideEffect = tool({
    name: 'side_effect',
    description: 'Record a side effect.',
    parameters: z.object({ value: z.string() }),
    execute: async () => {
      toolCalls += 1;
      return 'done';
    },
  });
  const agent = new Agent({
    name: 'Published cancelled agent',
    model: new OpenAIResponsesModel(client, integrationModel),
    tools: [sideEffect],
  });
  const controller = new AbortController();
  controller.abort(new Error('Controlled cancellation.'));

  await assert.rejects(
    createRunner().run(agent, 'Do work.', { signal: controller.signal }),
    /abort|cancel/i,
  );
  assert.equal(requests, 0);
  assert.equal(toolCalls, 0);
});

test('maxTurns preserves the completed tool side effect and resumable state', async () => {
  const calls = [];
  const checkpoint = tool({
    name: 'checkpoint',
    description: 'Record a deterministic checkpoint.',
    parameters: z.object({ value: z.string() }),
    execute: async ({ value }) => {
      calls.push(value);
      return 'CHECKPOINT_READY';
    },
  });
  const agent = new Agent({
    name: 'Published max-turn agent',
    model: integrationModel,
    instructions:
      "Call checkpoint exactly once with value 'release', then reply exactly COMPLETE.",
    tools: [checkpoint],
    modelSettings: { maxTokens: 256, toolChoice: 'checkpoint' },
  });

  let caught;
  try {
    await createRunner().run(agent, 'Record the checkpoint.', { maxTurns: 1 });
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof MaxTurnsExceededError);
  assert.deepEqual(calls, ['release']);
  assert.ok(caught.state);
  assert.equal(
    getToolOutputs({ newItems: caught.state._generatedItems }).length,
    1,
  );
  assert.equal(caught.state.usage.requests, 1);
});
