import { expect, it } from 'vitest';
import {
  ObservationBuffer,
  type ObservationInput,
} from '../../src/runtime/observation';

const search = (id: string, characters: number) =>
  ({
    type: 'search_item_completed',
    submissionId: 'submission',
    turnId: 'turn',
    item: {
      type: 'web_search_call',
      id,
      turnId: 'turn',
      status: 'completed',
      action: {
        type: 'search',
        query: 'chart',
        queries: null,
        sources: [{ type: 'url', url: 'https://example.test/chart' }],
      },
      results: [{ type: 'image', data: 'x'.repeat(characters) }],
    },
  }) satisfies ObservationInput;

it('retains search metadata and earlier events when one detail payload exceeds 16 MiB', async () => {
  const buffer = new ObservationBuffer('session');
  buffer.append({ type: 'warning', message: 'earlier' });
  const input = search('large', 16 * 1024 * 1024 + 1);
  buffer.append(input);
  buffer.finish('closed');
  const defaults = await Array.fromAsync(buffer.events());
  expect(defaults.map((event) => event.type)).toEqual([
    'warning',
    'search_item_completed',
    'session_ended',
  ]);
  expect(defaults[1]).toMatchObject({
    item: { id: 'large', action: input.item.action },
  });
  expect(defaults[1]).not.toHaveProperty('item.results');
  const detailed = await Array.fromAsync(
    buffer.events({ includeExecutionDetails: true }),
  );
  expect(detailed.map((event) => event.type)).toEqual([
    'warning',
    'gap',
    'session_ended',
  ]);
  expect(detailed[1]).toMatchObject({ sequence: 2, firstSequence: 2 });
  expect(input.item.results[0].data).toHaveLength(16 * 1024 * 1024 + 1);
});

it('drops only the oldest search details under the 32 MiB aggregate budget', async () => {
  const buffer = new ObservationBuffer('session');
  buffer.append({ type: 'warning', message: 'earlier' });
  for (const id of ['first', 'second', 'third'])
    buffer.append(search(id, 12 * 1024 * 1024));
  buffer.finish('closed');
  const defaults = await Array.fromAsync(buffer.events());
  expect(defaults.map((event) => event.type)).toEqual([
    'warning',
    'search_item_completed',
    'search_item_completed',
    'search_item_completed',
    'session_ended',
  ]);
  for (const event of defaults)
    expect(event).not.toHaveProperty('item.results');
  const detailed = await Array.fromAsync(
    buffer.events({ includeExecutionDetails: true }),
  );
  expect(detailed.map((event) => event.type)).toEqual([
    'warning',
    'gap',
    'search_item_completed',
    'search_item_completed',
    'session_ended',
  ]);
  expect(detailed[1]).toMatchObject({ sequence: 2, firstSequence: 2 });
  expect(
    detailed.flatMap((event) =>
      event.type === 'search_item_completed' ? [event.item.id] : [],
    ),
  ).toEqual(['second', 'third']);
  expect(detailed[2]).toHaveProperty(
    'item.results.0.data',
    'x'.repeat(12 * 1024 * 1024),
  );
});

it.each([false, true])(
  'preserves unbounded search details with a bounded repair producer=%s',
  async (repair) => {
    const buffer = new ObservationBuffer('session', { retention: 'all' });
    const producer = repair ? new ObservationBuffer('repair') : buffer;
    if (repair) producer.linkRepairParent(buffer, 'parent');
    const input = search('large', 16 * 1024 * 1024 + 1);
    producer.append(input);
    if (repair) producer.finish('closed');
    buffer.finish('closed');
    const detailed = await Array.fromAsync(
      buffer.events({ includeExecutionDetails: true }),
    );
    expect(detailed.map((event) => event.type)).toEqual([
      'search_item_completed',
      'session_ended',
    ]);
    expect(detailed[0]).toMatchObject({ item: input.item });
    const defaults = await Array.fromAsync(buffer.events());
    expect(defaults[0]).toMatchObject({ item: { id: 'large' } });
    expect(defaults[0]).not.toHaveProperty('item.results');
  },
);
