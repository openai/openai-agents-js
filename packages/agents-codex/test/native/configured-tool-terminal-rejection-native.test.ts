import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  GuardrailTripwire,
  NativeProvider,
  isFunctionApprovalRequest,
  tool,
} from '../../src';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
afterEach(() => ModelServer.closeAll());
async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-terminal-policy',
    supportsWebsockets: false,
  });
}
it('redacts a rejected approved configured result once before successor sampling', async () => {
  const rootModel = new ModelServer([
    [
      call(
        'nested_child',
        { input: 'approve one effect' },
        { callId: 'configured-parent-call' },
      ),
    ],
    [message('SUCCESSOR_ALLOWED')],
  ]);
  const childModel = new ModelServer([
    [call('child_effect', {}, { callId: 'approved-child-effect' })],
    [message('CHILD_TERMINAL_RESULT')],
  ]);
  await using rootProvider = await providerFor(rootModel);
  await using childProvider = await providerFor(childModel);
  let effects = 0;
  let trip = true;
  const checked: string[] = [];
  const child = new Agent({
    model: 'gpt-5.5',
    provider: childProvider,
    instructions: 'Run one approved effect.',
    tools: [
      tool({
        name: 'child_effect',
        parameters: z.object({}),
        needsApproval: true,
        execute: () => {
          effects++;
          return 'APPROVED_EFFECT_ONCE';
        },
      }),
    ],
  });
  const parent = new Agent({
    model: 'gpt-5.5',
    provider: rootProvider,
    instructions: 'Return the configured child result.',
    tools: [child.asTool({ toolName: 'nested_child' })],
    toolBatchCompletion: () => ({
      action: 'finish',
      output: 'CHILD_TERMINAL_RESULT',
    }),
    outputGuardrails: [
      {
        name: 'parent-final',
        callback(context) {
          checked.push(String(context.finalOutput));
          return { tripwireTriggered: trip };
        },
      },
    ],
  });
  await using session = await parent.session();
  const turn = await session.submit('Run child.');
  const done = turn.wait();
  void done.catch(() => {});
  let approved = false;
  for await (const request of session.interactions()) {
    if (isFunctionApprovalRequest(request)) {
      await session.respond(request.approve());
      approved = true;
      break;
    }
  }
  expect(approved).toBe(true);
  await expect(done).rejects.toBeInstanceOf(GuardrailTripwire);
  expect(effects).toBe(1);
  expect(checked).toEqual(['CHILD_TERMINAL_RESULT']);
  const placeholder =
    'Native terminal tool output withheld by completion policy';
  const rejected = (await Array.fromAsync(session.items())).filter(
    (item) =>
      item.type === 'function_call_output' &&
      item.callId === 'configured-parent-call',
  );
  expect(rejected).toHaveLength(1);
  expect(rejected[0]).toMatchObject({ output: placeholder });
  trip = false;
  expect(
    (
      await (
        await session.submit('Continue without repeating the approved effect.')
      ).wait()
    ).finalOutput,
  ).toBe('SUCCESSOR_ALLOWED');
  const input = rootModel.requests[1].input as JsonObject[];
  const outputs = input.filter(
    (item) =>
      item.type === 'function_call_output' &&
      item.call_id === 'configured-parent-call',
  );
  expect(outputs).toHaveLength(1);
  expect(outputs[0].output).toBe(placeholder);
  expect(JSON.stringify(input)).not.toContain('CHILD_TERMINAL_RESULT');
  expect(effects).toBe(1);
  expect(childModel.requests).toHaveLength(2);
  expect(rootModel.requests).toHaveLength(2);
  expect(checked).toEqual(['CHILD_TERMINAL_RESULT', 'SUCCESSOR_ALLOWED']);
  const after = (await Array.fromAsync(session.items())).filter(
    (item) =>
      item.type === 'function_call_output' &&
      item.callId === 'configured-parent-call',
  );
  expect(after).toHaveLength(1);
  expect(after[0]).toMatchObject({ output: placeholder });
  rootModel.assertExhausted();
  childModel.assertExhausted();
}, 30000);
