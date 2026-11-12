import { expect, it } from 'vitest';
import {
  CODEX_REVISION,
  isManualSessionState,
  nativeCheckpoint,
  parseSessionState,
} from '../src/runtime/state';

function saved(originalInput?: unknown) {
  return {
    format_version: 3,
    codex_revision: CODEX_REVISION,
    source_session_id: 'root',
    history: [],
    root_metadata: {},
    manual_continuation: {
      turn_id: 'turn',
      reply_order: ['pending'],
      accepted_replies: {},
      pending_manual: [{ call_id: 'pending', name: 'lookup', arguments: '{}' }],
    },
    manual_context: {
      instructions: null,
      result_schemas: [],
      usage: null,
      ...(originalInput === undefined ? {} : { original_input: originalInput }),
    },
  };
}

it.each([
  '',
  'exact original string',
  {
    role: 'user',
    type: 'message',
    content: [{ type: 'input_text', text: 'exact original message' }],
  },
])(
  'retains the caller envelope without making it native replay input: %j',
  (input) => {
    const state = parseSessionState(JSON.stringify(saved(input)));
    if (!isManualSessionState(state))
      throw new Error('Expected manual checkpoint');
    expect(state.manual_context.original_input).toEqual(input);
    expect(nativeCheckpoint(state)).not.toContain('original_input');
  },
);

it.each([
  null,
  5,
  { role: 'assistant', content: 'unavailable' },
  { role: 'user', content: [], extra: true },
])('rejects an invalid diagnostic caller envelope: %j', (input) => {
  expect(() => parseSessionState(JSON.stringify(saved(input)))).toThrow(
    'Invalid original run input',
  );
});

it('retains an older checkpoint without inventing a diagnostic origin', () => {
  const state = parseSessionState(JSON.stringify(saved()));
  if (!isManualSessionState(state))
    throw new Error('Expected manual checkpoint');
  expect(Object.hasOwn(state.manual_context, 'original_input')).toBe(false);
});
