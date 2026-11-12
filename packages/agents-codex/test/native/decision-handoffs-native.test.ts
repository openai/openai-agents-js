import { afterEach, expect, it } from 'vitest';
import {
  Agent,
  DecisionHandoff,
  NativeProvider,
  type DecisionRequest,
} from '../../src';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
afterEach(() => ModelServer.closeAll());
async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-decision-handoff',
    supportsWebsockets: false,
  });
}
function instructions(request: JsonObject): string {
  return JSON.stringify(request.input);
}
it('selects the native handoff target during invocation while preserving the orchestrating model and Session', async () => {
  const server = new ModelServer([
    [
      call(
        'route_issue',
        { input: 'explicit routing request' },
        { callId: 'route' },
      ),
    ],
    [message('resolved')],
    [message('continued')],
  ]);
  await using provider = await providerFor(server);
  const billing = new Agent({ instructions: 'BILLING_ONLY' });
  const technical = new Agent({ instructions: 'TECHNICAL_ONLY' });
  const requests: DecisionRequest[] = [];
  await using session = await new Agent({
    instructions: 'SOURCE_ONLY',
    model: 'gpt-5.5',
    provider,
    handoffs: [
      new DecisionHandoff({
        name: 'route_issue',
        description: 'Route to a specialist',
        question: 'Which specialist?',
        targets: { billing, technical },
      }),
    ],
    decisions: {
      async getDecision(request) {
        requests.push(request);
        return { value: 'technical' };
      },
    },
  }).session();
  const turn = await session.submit('PRIVATE_TRANSCRIPT');
  expect((await turn.wait()).finalOutput).toBe('resolved');
  expect(requests).toHaveLength(1);
  expect(requests[0].input).toBe('explicit routing request');
  expect(JSON.stringify(requests)).not.toContain('PRIVATE_TRANSCRIPT');
  expect(server.requests.every((request) => request.model === 'gpt-5.5')).toBe(
    true,
  );
  expect(instructions(server.requests[0])).toContain('SOURCE_ONLY');
  expect(instructions(server.requests[1])).toContain('TECHNICAL_ONLY');
  expect(instructions(server.requests[1])).not.toContain('BILLING_ONLY');
  expect(await session.getActiveAgent()).toBe(technical);
  expect((await (await session.submit('Continue')).wait()).finalOutput).toBe(
    'continued',
  );
  expect(instructions(server.requests[2])).toContain('TECHNICAL_ONLY');
  const produced = await turn.wait();
  expect(produced.turn.sessionId).toBe(session.id);
  server.assertExhausted();
}, 20_000);

it('refuses a Decisions result outside the captured roster without transferring', async () => {
  const server = new ModelServer([
    [call('route_issue', { input: 'route' }, { callId: 'route' })],
  ]);
  await using provider = await providerFor(server);
  const target = new Agent({ instructions: 'TARGET_ONLY' });
  await using session = await new Agent({
    instructions: 'SOURCE_ONLY',
    provider,
    handoffs: [
      new DecisionHandoff({
        name: 'route_issue',
        description: 'Route',
        question: 'Where?',
        targets: { target },
      }),
    ],
    decisions: {
      async getDecision() {
        return { value: 'outside' };
      },
    },
  }).session();
  await expect((await session.submit('Begin')).wait()).rejects.toThrow();
  expect(await session.getActiveAgent()).not.toBe(target);
  expect(server.requests).toHaveLength(1);
  server.assertExhausted();
}, 20_000);

it('joins Decisions cancellation without activating its selected specialist', async () => {
  const server = new ModelServer([
    [call('route_issue', { input: 'route' }, { callId: 'route' })],
  ]);
  await using provider = await providerFor(server);
  const target = new Agent({ instructions: 'TARGET_ONLY' });
  const entered = Promise.withResolvers<void>();
  let joined = false;
  await using session = await new Agent({
    instructions: 'SOURCE_ONLY',
    provider,
    handoffs: [
      new DecisionHandoff({
        name: 'route_issue',
        description: 'Route',
        question: 'Where?',
        targets: { target },
      }),
    ],
    decisions: {
      async getDecision(_request, { signal }) {
        entered.resolve();
        try {
          await new Promise<void>((resolve) => {
            if (signal?.aborted) resolve();
            else
              signal?.addEventListener('abort', () => resolve(), {
                once: true,
              });
          });
          signal?.throwIfAborted();
          return { value: 'target' };
        } finally {
          joined = true;
        }
      },
    },
  }).session();
  const turn = await session.submit('Begin');
  await entered.promise;
  await turn.cancel();
  await expect(turn.wait()).rejects.toThrow();
  expect(joined).toBe(true);
  expect(await session.getActiveAgent()).not.toBe(target);
  expect(server.requests).toHaveLength(1);
  server.assertExhausted();
}, 20_000);

it('preserves first-request ownership for different handoff tools sharing a call ID', async () => {
  const server = new ModelServer([
    [
      call('route_first', { input: 'first' }, { callId: 'shared' }),
      call('route_second', { input: 'second' }, { callId: 'shared' }),
    ],
    [message('first target')],
  ]);
  await using provider = await providerFor(server);
  const first = new Agent({ instructions: 'FIRST_ONLY' });
  const second = new Agent({ instructions: 'SECOND_ONLY' });
  const inputs: string[] = [];
  await using session = await new Agent({
    instructions: 'SOURCE_ONLY',
    provider,
    handoffs: [
      new DecisionHandoff({
        name: 'route_first',
        description: 'First',
        question: 'Where?',
        targets: { target: first },
      }),
      new DecisionHandoff({
        name: 'route_second',
        description: 'Second',
        question: 'Where?',
        targets: { target: second },
      }),
    ],
    decisions: {
      async getDecision(request) {
        inputs.push(String(request.input));
        return { value: 'target' };
      },
    },
  }).session();
  expect((await (await session.submit('Begin')).wait()).finalOutput).toBe(
    'first target',
  );
  expect(inputs).toEqual(['first']);
  expect(await session.getActiveAgent()).toBe(first);
  expect(instructions(server.requests[1])).toContain('FIRST_ONLY');
  expect(instructions(server.requests[1])).not.toContain('SECOND_ONLY');
  server.assertExhausted();
}, 20_000);
