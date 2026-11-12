import { expect, it } from 'vitest';
import {
  CODEX_REVISION,
  parseSessionState,
  isManualSessionState,
} from '../src/runtime/state';

const state = (receipt: unknown) => ({
  format_version: 3,
  codex_revision: CODEX_REVISION,
  source_session_id: 'root',
  history: [],
  root_metadata: {},
  manual_continuation: {
    turn_id: 'turn',
    reply_order: ['completed', 'pending'],
    accepted_replies: { completed: receipt },
    pending_manual: [{ call_id: 'pending', name: 'lookup', arguments: '{}' }],
  },
  manual_context: { instructions: null, result_schemas: [], usage: null },
});

it.each(['function_call_output', 'custom_tool_call_output'])(
  'retains the canonical %s envelope and handoff metadata in a manual continuation',
  (type) => {
    const receipt = {
      type: 'response_item',
      payload: { type, call_id: 'completed', output: 'accepted' },
      metadata: {
        sdk_agent_handoff: {
          source: { profile_id: 'agent_0', epoch: 1 },
          target_profile_id: 'agent_1',
        },
      },
    };
    const parsed = parseSessionState(JSON.stringify(state(receipt)));
    expect(isManualSessionState(parsed)).toBe(true);
    if (!isManualSessionState(parsed))
      throw new Error('expected manual continuation');
    expect(parsed.manual_continuation.accepted_replies.completed).toEqual(
      receipt,
    );
    expect(() =>
      parseSessionState(
        JSON.stringify(
          state({
            ...receipt,
            call_id: 'completed',
            payload: { ...receipt.payload, call_id: 'wrong' },
          }),
        ),
      ),
    ).toThrow('original call ID');
  },
);

it('retains legacy text and bare native receipts while rejecting non-output envelopes', () => {
  for (const receipt of [
    'accepted',
    { type: 'function_call_output', call_id: 'completed', output: 'accepted' },
  ])
    expect(() =>
      parseSessionState(JSON.stringify(state(receipt))),
    ).not.toThrow();
  expect(() =>
    parseSessionState(
      JSON.stringify(
        state({
          type: 'response_item',
          payload: {
            type: 'message',
            call_id: 'completed',
            output: 'not a tool result',
          },
        }),
      ),
    ),
  ).toThrow();
});

it('rejects a saved hosted prompt reference in an accepted manual envelope', () => {
  const receipt = {
    type: 'response_item',
    payload: {
      type: 'function_call_output',
      call_id: 'completed',
      output: 'accepted',
    },
    metadata: {
      sdk_agent_profile: {
        profile_id: 'agent_0',
        epoch: 1,
        model: {
          model: 'gpt-5',
          request_controls: {
            hosted_prompt: { reference: { id: 'pmpt_saved' } },
          },
        },
      },
    },
  };
  expect(() => parseSessionState(JSON.stringify(state(receipt)))).toThrow();
});
