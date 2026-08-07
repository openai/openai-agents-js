import assert from 'node:assert/strict';
import test from 'node:test';

import OpenAI from 'openai';
import {
  Agent,
  OpenAIChatCompletionsModel,
  OpenAIResponsesModel,
  setTracingDisabled,
  tool,
} from '@openai/agents';
import { z } from 'zod';

import {
  createRunner,
  getToolCalls,
  getToolOutputs,
  integrationModel,
} from '../helpers.mjs';

setTracingDisabled(true);

const client = new OpenAI();
const providers = [
  [
    'Responses',
    new OpenAIResponsesModel(client, integrationModel),
    { maxTokens: 512 },
  ],
  [
    'Chat Completions',
    new OpenAIChatCompletionsModel(client, integrationModel),
    {
      reasoning: { effort: 'none' },
      providerData: {
        max_completion_tokens: 512,
      },
    },
  ],
];

for (const [providerName, model, providerSettings] of providers) {
  test(`${providerName} preserves function tool calls and usage`, async () => {
    const calls = [];
    const packageStatus = tool({
      name: 'package_status',
      description: 'Return a deterministic package status.',
      parameters: z.object({ packageName: z.string() }),
      execute: async ({ packageName }) => {
        calls.push(packageName);
        return 'ready';
      },
    });
    const agent = new Agent({
      name: `Published ${providerName} tool agent`,
      model,
      instructions:
        "Call package_status exactly once with packageName 'openai-agents', then reply exactly PROVIDER_READY.",
      tools: [packageStatus],
      modelSettings: {
        ...providerSettings,
        toolChoice: 'package_status',
      },
    });

    const result = await createRunner().run(agent, 'Check the package.');

    assert.deepEqual(calls, ['openai-agents']);
    assert.equal(result.finalOutput, 'PROVIDER_READY');
    assert.equal(getToolCalls(result, 'package_status').length, 1);
    assert.equal(getToolOutputs(result).length, 1);
    assert.ok(result.state.usage.totalTokens > 0);
  });

  test(`${providerName} preserves structured output`, async () => {
    const outputType = z.object({
      status: z.literal('STRUCTURED_READY'),
      checkpoints: z.array(z.number().int()),
    });
    const agent = new Agent({
      name: `Published ${providerName} structured agent`,
      model,
      instructions: 'Return status STRUCTURED_READY and checkpoints [2, 4, 8].',
      outputType,
      modelSettings: providerSettings,
    });

    const result = await createRunner().run(
      agent,
      'Return the requested structured status.',
    );

    assert.deepEqual(result.finalOutput, {
      status: 'STRUCTURED_READY',
      checkpoints: [2, 4, 8],
    });
    assert.ok(result.state.usage.totalTokens > 0);
  });
}
