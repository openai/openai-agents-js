import assert from 'node:assert/strict';
import test from 'node:test';

import {
  Agent,
  setTracingDisabled,
  tool,
  toolNamespace,
  toolSearchTool,
} from '@openai/agents';
import { z } from 'zod';

import {
  createRunner,
  getToolCalls,
  getToolOutputs,
  integrationModel,
} from '../helpers.mjs';

setTracingDisabled(true);

test('tool search loads and executes a deferred namespaced tool', async () => {
  const calls = [];
  const lookupCustomer = tool({
    name: 'lookup_customer',
    description: 'Find a customer release readiness status.',
    parameters: z.object({ customerId: z.string() }),
    deferLoading: true,
    execute: async ({ customerId }) => {
      calls.push(customerId);
      return 'READY';
    },
  });
  const namespaced = toolNamespace({
    name: 'customer_support',
    description: 'Look up customer release readiness and support records.',
    tools: [lookupCustomer],
  });
  const agent = new Agent({
    name: 'Published deferred tool search agent',
    model: integrationModel,
    instructions:
      "Find the customer support tool, call lookup_customer with customerId 'customer-42', then reply exactly SEARCH_READY.",
    tools: [...namespaced, toolSearchTool()],
    modelSettings: { maxTokens: 768, parallelToolCalls: false },
  });

  const result = await createRunner().run(
    agent,
    'Find and run the deferred customer lookup.',
    { maxTurns: 5 },
  );

  assert.deepEqual(calls, ['customer-42']);
  assert.equal(result.finalOutput, 'SEARCH_READY');
  assert.ok(
    result.newItems.some((item) => item.type === 'tool_search_call_item'),
  );
  assert.ok(
    result.newItems.some((item) => item.type === 'tool_search_output_item'),
  );
  assert.equal(getToolCalls(result).length >= 1, true);
  assert.equal(getToolOutputs(result).length >= 1, true);
});

test('tool search routes identical names by namespace without collisions', async () => {
  const calls = [];
  const billingLookup = tool({
    name: 'lookup',
    description: 'Look up customer billing status.',
    parameters: z.object({ customerId: z.string() }),
    deferLoading: true,
    execute: async ({ customerId }) => {
      calls.push(`billing:${customerId}`);
      return 'BILLING_READY';
    },
  });
  const shippingLookup = tool({
    name: 'lookup',
    description: 'Look up customer package shipping status.',
    parameters: z.object({ customerId: z.string() }),
    deferLoading: true,
    execute: async ({ customerId }) => {
      calls.push(`shipping:${customerId}`);
      return 'SHIPPING_READY';
    },
  });
  const agent = new Agent({
    name: 'Published namespaced tool routing agent',
    model: integrationModel,
    instructions:
      "Find the shipping namespace tool named lookup and call it exactly once with customerId 'customer-42'. Do not use billing. Reply exactly SHIPPING_READY.",
    tools: [
      ...toolNamespace({
        name: 'billing',
        description: 'Billing records.',
        tools: [billingLookup],
      }),
      ...toolNamespace({
        name: 'shipping',
        description: 'Package shipping records.',
        tools: [shippingLookup],
      }),
      toolSearchTool(),
    ],
    modelSettings: { maxTokens: 768, parallelToolCalls: false },
  });

  const result = await createRunner().run(
    agent,
    "Check the customer's shipping status.",
    { maxTurns: 5 },
  );

  assert.deepEqual(calls, ['shipping:customer-42']);
  assert.equal(result.finalOutput, 'SHIPPING_READY');
});
