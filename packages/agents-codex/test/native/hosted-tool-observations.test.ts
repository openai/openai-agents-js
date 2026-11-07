import { expect, it } from 'vitest';
import {
  ObservationBuffer,
  type ObservedEvent,
  type ObservationOptions,
} from '../../src/runtime/observation';
import type { JsonObject } from '../../src/runtime/binding';
import type { HostedToolItem } from '../../src/runtime/hosted-tools';

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
async function collect(
  buffer: ObservationBuffer,
  options?: ObservationOptions,
): Promise<ObservedEvent[]> {
  const result: ObservedEvent[] = [];
  for await (const event of buffer.events(options)) result.push(event);
  return result;
}

it('delivers complete partial images larger than 100 KiB to opted-in readers', async () => {
  const buffer = new ObservationBuffer('session');
  const event = partial('a'.repeat(150_000));
  buffer.append(event);
  buffer.finish('closed');
  const first = await collect(buffer, { includeExecutionDetails: true });
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
  expect(
    await collect(buffer, { includeExecutionDetails: true }),
  ).toContainEqual(expect.objectContaining({ event: event.event }));
});

it('evicts the oldest event when retained partial payloads exceed 32 MiB', async () => {
  const buffer = new ObservationBuffer('session');
  const payload = 'a'.repeat(12 * 1024 * 1024);
  for (let index = 0; index < 3; index++)
    buffer.append(partial(payload, { partial_image_index: index }));
  buffer.finish('closed');
  const events = await collect(buffer, { includeExecutionDetails: true });
  expect(events[0].type).toBe('gap');
  expect(
    events.flatMap((event) =>
      event.type === 'hosted_tool_call_progress'
        ? [event.event.partial_image_index]
        : [],
    ),
  ).toEqual([1, 2]);
});

const hostedItems: HostedToolItem[] = [
  {
    type: 'file_search_call',
    id: 'search',
    turn_id: 'turn',
    turnId: 'turn',
    status: 'completed',
    queries: ['private query'],
    results: [{ text: 'private file' }],
    provider_data: { future_field: 'private data' },
  },
  {
    type: 'code_interpreter_call',
    id: 'code',
    turn_id: 'turn',
    turnId: 'turn',
    status: 'completed',
    container_id: 'private container',
    code: 'private code',
    outputs: [{ logs: 'private output' }],
    provider_data: { future_field: 'private data' },
  },
  {
    type: 'image_generation_call',
    id: 'image',
    turn_id: 'turn',
    turnId: 'turn',
    status: 'completed',
    result: 'private image',
    revised_prompt: 'private prompt',
    provider_data: { future_field: 'private data' },
  },
];

it.each(hostedItems)(
  'redacts $type completion payloads unless explicitly enabled',
  async (item) => {
    const buffer = new ObservationBuffer('session');
    buffer.append({
      type: 'hosted_tool_item_completed',
      turnId: 'turn',
      submissionId: 'submission',
      item,
    });
    buffer.finish('closed');
    for (const options of [
      undefined,
      { includeExecutionDetails: false },
      Object.create({ includeExecutionDetails: true }) as ObservationOptions,
    ]) {
      const [event] = await collect(buffer, options);
      expect(event).toEqual({
        type: 'hosted_tool_item_completed',
        sessionId: 'session',
        sequence: 1,
        turnId: 'turn',
        submissionId: 'submission',
        item: {
          type: item.type,
          id: item.id,
          turn_id: item.turn_id,
          turnId: item.turnId,
          status: item.status,
        },
      });
    }
    const [detailed] = await collect(buffer, { includeExecutionDetails: true });
    expect(detailed).toMatchObject({ sequence: 1, item });
    if (
      detailed.type !== 'hosted_tool_item_completed' ||
      !('provider_data' in detailed.item)
    )
      throw new Error('Expected detailed hosted item');
    detailed.item.provider_data.future_field = 'changed by reader';
    expect(
      await collect(buffer, { includeExecutionDetails: true }),
    ).toContainEqual(expect.objectContaining({ sequence: 1, item }));
  },
);

it.each([
  partial('private image', { future_field: 'private data' }),
  partial('', {
    type: 'response.code_interpreter_call_code.delta',
    delta: 'private code',
  }),
  partial('', {
    type: 'response.file_search_call.searching',
    results: ['private result'],
  }),
])(
  'redacts $event.type progress payloads unless explicitly enabled',
  async (progress) => {
    const buffer = new ObservationBuffer('session');
    buffer.append(progress);
    buffer.finish('closed');
    for (const options of [
      undefined,
      { includeExecutionDetails: false },
      Object.create({ includeExecutionDetails: true }) as ObservationOptions,
    ]) {
      expect((await collect(buffer, options))[0]).toEqual({
        ...progress,
        sessionId: 'session',
        sequence: 1,
        event: { type: progress.event.type },
      });
    }
    expect(
      await collect(buffer, { includeExecutionDetails: true }),
    ).toContainEqual(
      expect.objectContaining({ event: progress.event, sequence: 1 }),
    );
  },
);

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
