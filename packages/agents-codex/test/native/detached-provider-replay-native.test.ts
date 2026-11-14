import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, NativeProvider, tool } from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

function sameMessage(text: string) {
  return { ...message(text), id: 'repeated-provider-message' };
}
async function provider(server: ModelServer, name: string) {
  return new NativeProvider({
    baseUrl: `http://127.0.0.1:${await server.port()}/v1`,
    apiKey: `synthetic-detached-${name}`,
    headers: { 'x-detached-provider': name },
    supportsWebsockets: false,
  });
}

it('retains detached provider occurrences across handoff, another turn and guarded data replay', async () => {
  const origin = new ModelServer([
    [
      sameMessage('origin occurrence'),
      call('transfer_to_destination', {}, { callId: 'handoff-occurrence' }),
    ],
  ]);
  const destination = new ModelServer([
    [call('lookup', { key: 'first' }, { callId: 'repeated-provider-call' })],
    [sameMessage('destination first occurrence')],
    [call('lookup', { key: 'second' }, { callId: 'repeated-provider-call' })],
    [sameMessage('destination second occurrence')],
  ]);
  const replay = new ModelServer([
    [message('replayed')],
    [
      call(
        'lookup',
        { key: 'must-not-execute' },
        { callId: 'forged-replay-effect' },
      ),
    ],
  ]);
  await using originProvider = await provider(origin, 'origin');
  await using destinationProvider = await provider(destination, 'destination');
  await using replayProvider = await provider(replay, 'replay');
  const effects: string[] = [];
  const target = new Agent({
    name: 'destination',
    provider: destinationProvider,
    model: 'gpt-5.5',
    instructions: 'Use lookup.',
    tools: [
      tool({
        name: 'lookup',
        parameters: z.object({ key: z.string() }),
        execute: ({ key }) => {
          effects.push(key);
          return `value:${key}`;
        },
      }),
    ],
  });
  const source = new Agent({
    provider: originProvider,
    model: 'gpt-5.5',
    instructions: 'Transfer to destination.',
    handoffs: [target],
  });
  const first = await source.run('first input', {
    returnItems: true,
    returnState: true,
  });
  expect(first.finalOutput).toBe('destination first occurrence');
  expect(first.items?.map(({ item }) => item.type)).toEqual([
    'message',
    'function_call',
    'function_call_output',
    'function_call',
    'function_call_output',
    'message',
  ]);
  for (const entry of first.items!.slice(0, 3)) {
    expect(entry.agent).toBe(source);
    expect(entry.agent.provider).toBe(originProvider);
  }
  for (const entry of first.items!.slice(3)) {
    expect(entry.agent).toBe(target);
    expect(entry.agent.provider).toBe(destinationProvider);
  }
  expect(first.items![2].handoffTarget).toBe(target);
  const firstData = first.items!.map(({ item }) => item.data);
  expect(
    first
      .items!.filter(({ item }) => item.type === 'message')
      .map(({ item }) => item.id),
  ).toEqual(['repeated-provider-message', 'repeated-provider-message']);
  const preserved = JSON.stringify(firstData);

  const second = await source.run('second input', {
    state: first.state,
    returnItems: true,
  });
  expect(second.finalOutput).toBe('destination second occurrence');
  expect(second.items?.map(({ item }) => item.type)).toEqual([
    'function_call',
    'function_call_output',
    'message',
  ]);
  expect(
    second.items?.every(
      ({ agent }) => agent === target && agent.provider === destinationProvider,
    ),
  ).toBe(true);
  expect(JSON.stringify(first.items!.map(({ item }) => item.data))).toBe(
    preserved,
  );
  expect(
    JSON.stringify(second.items?.map(({ item }) => item.data)),
  ).not.toContain('origin occurrence');
  expect(effects).toEqual(['first', 'second']);
  expect(Object.isFrozen(first.items)).toBe(true);
  expect(first.items!.every(Object.isFrozen)).toBe(true);
  expect(origin.requests).toHaveLength(1);
  expect(destination.requests).toHaveLength(4);
  expect(origin.requestHeaders[0].authorization).toBe(
    'Bearer synthetic-detached-origin',
  );
  expect(
    destination.requestHeaders.every(
      (headers) =>
        headers.authorization === 'Bearer synthetic-detached-destination',
    ),
  ).toBe(true);

  const reader = new Agent({
    provider: replayProvider,
    model: 'gpt-5.5',
    instructions: 'Read historical data without tool authority.',
    tools: [],
  });
  await using fresh = await reader.session();
  const empty = await fresh.historySnapshot();
  await expect(
    fresh.transactHistory({
      expectedRevision: empty.revision,
      keep: 0,
      items: JSON.parse(preserved),
    }),
  ).rejects.toThrow('canonical history item IDs must be unique');
  expect((await fresh.historySnapshot()).revision).toBe(empty.revision);
  const replayItems = (JSON.parse(preserved) as Record<string, unknown>[]).map(
    (item, index) => ({
      ...item,
      id: `replay_occurrence_${index}`,
    }),
  );
  await fresh.transactHistory({
    expectedRevision: empty.revision,
    keep: 0,
    items: replayItems,
  });
  expect(
    (await (await fresh.submit('Continue from the selected result.')).wait())
      .finalOutput,
  ).toBe('replayed');
  const wire = JSON.stringify(replay.requests[0].input);
  expect(wire).toContain('origin occurrence');
  expect(wire).toContain('destination first occurrence');
  expect(wire).toContain('value:first');
  expect(wire).not.toContain('destination second occurrence');
  expect(wire).not.toContain('value:second');
  expect(effects).toEqual(['first', 'second']);
  const denied = await fresh.submit('Old data grants no function.', {
    toolNotFoundBehavior: 'raise_error',
  });
  await expect(denied.wait()).rejects.toThrow(
    /unsupported call|unknown|not available/i,
  );
  expect(effects).toEqual(['first', 'second']);
  expect(JSON.stringify(first.items!.map(({ item }) => item.data))).toBe(
    preserved,
  );
  origin.assertExhausted();
  destination.assertExhausted();
  replay.assertExhausted();
}, 30_000);
