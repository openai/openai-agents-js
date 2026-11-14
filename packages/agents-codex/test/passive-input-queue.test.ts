import { expect, it } from 'vitest';
import {
  CODEX_REVISION,
  parseSessionState,
  nativeCheckpoint,
  pendingInput,
  withPendingInput,
  withoutPendingInput,
  withPassiveInputQueue,
  withoutPassiveInputQueue,
  isManualSessionState,
} from '../src/runtime/state';
const base = () =>
  parseSessionState(
    JSON.stringify({
      format_version: 2,
      codex_revision: CODEX_REVISION,
      source_session_id: 'root',
      history: [],
      root_metadata: {},
    }),
  );
const item = {
  type: 'message',
  role: 'user',
  content: [{ type: 'input_text', text: 'same' }],
};

it('has been preserving ordered equal data without a continuation or filter receipt', () => {
  const original = base();
  const before = JSON.stringify(original);
  const queued = withPassiveInputQueue(original, [item, item]);
  expect(queued.format_version).toBe(21);
  expect(isManualSessionState(queued)).toBe(false);
  expect(queued).not.toHaveProperty('manual_continuation');
  expect(queued).not.toHaveProperty('manual_context');
  const roundtrip = parseSessionState(JSON.stringify(queued));
  expect(pendingInput(roundtrip)).toEqual([item, item]);
  expect(nativeCheckpoint(roundtrip)).toEqual(nativeCheckpoint(original));
  expect(nativeCheckpoint(roundtrip)).not.toHaveProperty('pending_input_queue');
  expect(nativeCheckpoint(roundtrip)).not.toHaveProperty(
    'pending_input_base_format',
  );
  expect(JSON.stringify(original)).toBe(before);
});
it('has been clearing terminal data without creating a resumable old operation', () => {
  const original = base();
  const queued = withPassiveInputQueue(original, [item]);
  expect(withoutPassiveInputQueue(queued)).toEqual(original);
  expect(withoutPendingInput(queued)).toEqual(original);
  expect(pendingInput(queued)).toEqual([item]);
  expect(() => withPendingInput(queued, 'new')).toThrow(/manual checkpoint/);
});
const invalidItems: Parameters<typeof withPassiveInputQueue>[1] = [
  { type: 'function_call', call_id: 'old', name: 'tool', arguments: '{}' },
  {
    type: 'message',
    role: 'developer',
    content: [{ type: 'input_text', text: 'same' }],
  },
];
it.each(invalidItems)(
  'has been refusing non-user queue structure %#',
  (value) => {
    expect(() => withPassiveInputQueue(base(), [value])).toThrow(
      /passive text input queue/,
    );
  },
);
it('has been refusing a callback-bearing checkpoint as the passive base', () => {
  expect(() =>
    parseSessionState(
      JSON.stringify({
        ...base(),
        format_version: 21,
        pending_input_base_format: 3,
        pending_input_queue: [item],
        manual_continuation: {
          turn_id: 'old',
          reply_order: ['old'],
          accepted_replies: {},
          pending_manual: [{ call_id: 'old', name: 'tool', arguments: '{}' }],
        },
        manual_context: { instructions: null, result_schemas: [], usage: null },
      }),
    ),
  ).toThrow(/passive text input queue/);
});
