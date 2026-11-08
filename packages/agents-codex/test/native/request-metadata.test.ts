import { expect, it } from 'vitest';
import { decodeRequestMetadata } from '../../src/runtime/request-metadata';
import { ObservationBuffer } from '../../src/runtime/observation';

function payload(reasoning_effort: unknown = null) {
  return {
    type: 'model_request_dispatching',
    request_id: 'request',
    thread_id: 'thread',
    turn_id: 'turn',
    model: 'resolved-model',
    reasoning_effort,
    reasoning_summary: null,
    service_tier: null,
    wire: 'responses',
    transport: 'http_sse',
  };
}
it.each([
  [null, null],
  [{ kind: 'text', value: 'future-effort' }, 'future-effort'],
  [{ kind: 'text', value: '18446744073709551616' }, '18446744073709551616'],
  [{ kind: 'integer', decimal: '9007199254740991' }, 9007199254740991],
  [{ kind: 'integer', decimal: '9007199254740992' }, 9007199254740992n],
  [{ kind: 'integer', decimal: '9007199254740993' }, 9007199254740993n],
  [{ kind: 'integer', decimal: '18446744073709551615' }, 18446744073709551615n],
  [{ kind: 'integer', decimal: '0' }, 0],
])('preserves exact bridge scalar kind %#', (raw, expected) => {
  const event = decodeRequestMetadata(payload(raw), 'submission');
  expect(event?.type).toBe('model_request_dispatching');
  if (event?.type !== 'model_request_dispatching')
    throw new Error('missing metadata');
  expect(event.reasoningEffort).toBe(expected);
  const buffer = new ObservationBuffer('observer');
  expect(Object.isFrozen(buffer.append(event))).toBe(true);
});
it.each([
  9007199254740993n,
  '9007199254740993',
  true,
  { kind: 'integer', decimal: '01' },
  { kind: 'integer', decimal: '-1' },
  { kind: 'integer', decimal: '18446744073709551616' },
  { kind: 'integer', decimal: '١' },
  { kind: 'integer', decimal: '1', body: 'private' },
  { kind: 'text', value: 1 },
  { kind: 'unknown', value: 'x' },
])('drops malformed passive scalar without failure %#', (raw) => {
  expect(decodeRequestMetadata(payload(raw), 'submission')).toBeNull();
});
it('drops extra or malformed fields and links only the exact retained occurrence key', () => {
  for (const value of [
    { ...payload(), body: 'private' },
    { ...payload(), transport: 'unknown' },
    { ...payload(), service_tier: {} },
    { ...payload(), turn_id: null },
  ])
    expect(decodeRequestMetadata(value, 'submission')).toBeNull();
  expect(
    decodeRequestMetadata(
      {
        type: 'model_response_linked',
        request_id: 'request',
        thread_id: 'thread',
        turn_id: 'turn',
        response_observation_id: 'occurrence',
      },
      'original-submission',
    ),
  ).toEqual({
    type: 'model_response_linked',
    requestId: 'request',
    threadId: 'thread',
    turnId: 'turn',
    responseObservationId: 'occurrence',
    submissionId: 'original-submission',
  });
});
it('keeps existing reader closure and bounded gap behavior with bigint effort', async () => {
  const buffer = new ObservationBuffer('observer');
  const event = decodeRequestMetadata(
    payload({ kind: 'integer', decimal: '9007199254740993' }),
    'submission',
  )!;
  const reader = buffer.events({});
  await reader.return?.();
  for (let i = 0; i < 300; i++) buffer.append(event);
  buffer.finish('closed');
  const events = [];
  for await (const value of buffer.events({})) events.push(value);
  expect(events[0].type).toBe('gap');
  expect(
    events.some(
      (value) =>
        value.type === 'model_request_dispatching' &&
        value.reasoningEffort === 9007199254740993n,
    ),
  ).toBe(true);
});

it('preserves Decisions request dispatch metadata', () => {
  expect(
    decodeRequestMetadata(
      { ...payload(), wire: 'decisions', transport: 'http_json' },
      'submission',
    ),
  ).toMatchObject({
    type: 'model_request_dispatching',
    wire: 'decisions',
    transport: 'http_json',
    model: 'resolved-model',
  });
  expect(
    decodeRequestMetadata({ ...payload(), wire: 'unknown' }, 'submission'),
  ).toBeNull();
});
