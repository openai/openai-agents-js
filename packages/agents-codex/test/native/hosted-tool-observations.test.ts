import { expect, it } from 'vitest';
import {
  ObservationBuffer,
  type ObservedEvent,
} from '../../src/runtime/observation';
import type { JsonObject } from '../../src/runtime/binding';

const partial = (payload: string, extra: JsonObject = {}) => ({
  type: 'hosted_tool_call_progress' as const,
  turnId: 'turn',
  submissionId: 'submission',
  threadId: 'thread',
  itemId: 'image',
  event: {
    type: 'response.image_generation_call.partial_image',
    item_id: 'image',
    output_index: 2,
    sequence_number: 7,
    partial_image_index: 0,
    partial_image_b64: payload,
    ...extra,
  },
});
async function collect(buffer: ObservationBuffer): Promise<ObservedEvent[]> {
  const result: ObservedEvent[] = [];
  for await (const event of buffer.events()) result.push(event);
  return result;
}

it('delivers complete partial images larger than 100 KiB through the normal public iterator', async () => {
  const buffer = new ObservationBuffer('session');
  const event = partial('a'.repeat(150_000));
  buffer.append(event);
  buffer.finish('closed');
  const first = await collect(buffer);
  expect(first).toContainEqual(
    expect.objectContaining({
      type: event.type,
      itemId: 'image',
      event: event.event,
    }),
  );
  const delivered = first.find(
    (item) => item.type === 'hosted_tool_call_progress',
  )!;
  if (delivered.type !== 'hosted_tool_call_progress')
    throw new Error('Missing partial image');
  delivered.event.partial_image_b64 = 'changed by reader';
  expect(await collect(buffer)).toContainEqual(
    expect.objectContaining({ event: event.event }),
  );
});

it('evicts the oldest event when retained partial payloads exceed 32 MiB', async () => {
  const buffer = new ObservationBuffer('session');
  const payload = 'a'.repeat(12 * 1024 * 1024);
  for (let index = 0; index < 3; index++)
    buffer.append(partial(payload, { partial_image_index: index }));
  buffer.finish('closed');
  const events = await collect(buffer);
  expect(events[0].type).toBe('gap');
  expect(
    events.flatMap((event) =>
      event.type === 'hosted_tool_call_progress'
        ? [event.event.partial_image_index]
        : [],
    ),
  ).toEqual([1, 2]);
});

it.each([
  ['payload above 16 MiB', () => partial('a'.repeat(16 * 1024 * 1024 + 1))],
  [
    'metadata above 65,536 characters',
    () => partial('small', { future_metadata: 'a'.repeat(65_536) }),
  ],
  [
    'unrecognized event payload',
    () => partial('a'.repeat(150_000), { type: 'response.future_event' }),
  ],
])('reports a gap without truncation for %s', async (_name, makeEvent) => {
  const buffer = new ObservationBuffer('session');
  buffer.append(makeEvent());
  buffer.finish('closed');
  const events = await collect(buffer);
  expect(events[0].type).toBe('gap');
  expect(
    events.some((event) => event.type === 'hosted_tool_call_progress'),
  ).toBe(false);
});
