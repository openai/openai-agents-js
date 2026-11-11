import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, NativeProvider, tool } from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

it('returns only the owned tool sequence and its handoff Agents', async () => {
  const effects: string[] = [];
  const lookup = tool({
    name: 'lookup',
    parameters: z.object({ key: z.string() }),
    execute({ key }) {
      effects.push(key);
      return `value:${key}`;
    },
  });
  const server = new ModelServer([
    [message('previous answer')],
    [call('transfer_to_b', {}, { callId: 'handoff-a-b' })],
    [call('lookup', { key: 'current' }, { callId: 'lookup-current' })],
    [message('current answer')],
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-produced-items',
    supportsWebsockets: false,
  });
  const target = new Agent({
    name: 'B',
    instructions: 'Use lookup.',
    tools: [lookup],
  });
  const source = new Agent({
    name: 'A',
    instructions: 'Transfer to B.',
    provider,
    handoffs: [target],
  });
  const first = await source.run('previous input', { returnState: true });
  expect(first.items).toBeUndefined();
  expect(first.state).toBeDefined();

  const completed = await source.run('current input', {
    state: first.state,
    returnHistory: true,
    returnItems: true,
  });
  expect(completed.finalOutput).toBe('current answer');
  expect(completed.history).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'message',
        role: 'assistant',
        content: [
          expect.objectContaining({
            type: 'output_text',
            text: 'previous answer',
          }),
        ],
      }),
    ]),
  );
  const items = completed.items ?? [];
  expect(
    items.map(({ item }) => [
      item.type,
      'callId' in item ? item.callId : undefined,
    ]),
  ).toEqual([
    ['function_call', 'handoff-a-b'],
    ['function_call_output', 'handoff-a-b'],
    ['function_call', 'lookup-current'],
    ['function_call_output', 'lookup-current'],
    ['message', undefined],
  ]);
  for (const entry of items.slice(0, 2)) expect(entry.agent).toBe(source);
  for (const entry of items.slice(2)) expect(entry.agent).toBe(target);
  expect(items[1].handoffTarget).toBe(target);
  expect(effects).toEqual(['current']);
  expect(server.requests).toHaveLength(4);
});

it('bounds the original tool output after the turn completes', async () => {
  const effects: string[] = [];
  const lookup = tool({
    name: 'lookup',
    parameters: z.object({}),
    execute() {
      effects.push('executed');
      return 'x'.repeat(8 * 1024 * 1024);
    },
  });
  const server = new ModelServer([
    [call('lookup', {}, { callId: 'large-output' })],
    [message('finished')],
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-produced-items',
    supportsWebsockets: false,
  });
  const agent = new Agent({
    instructions: 'Use lookup.',
    tools: [lookup],
    provider,
  });

  await expect(
    agent.run('lookup', { returnItems: true }),
  ).rejects.toMatchObject({
    name: 'NativeError',
    message: 'Produced run items exceed the one-shot result limit',
  });
  expect(effects).toEqual(['executed']);
  expect(server.requests).toHaveLength(2);
});
