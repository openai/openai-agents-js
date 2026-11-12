import { expect, it, vi } from 'vitest';
import {
  CODEX_REVISION,
  parseSessionState,
  pendingInput,
  withPendingInput,
} from '../src/runtime/state';
import type { JsonObject } from '../src/runtime/binding';
vi.mock('../src/runtime/media', async (original) => ({
  ...(await original<typeof import('../src/runtime/media')>()),
  MAX_AUDIO_INPUT_BYTES: 192,
}));
function saved(extra = {}) {
  return parseSessionState(
    JSON.stringify({
      format_version: 3,
      codex_revision: CODEX_REVISION,
      source_session_id: 'root',
      history: [],
      root_metadata: {},
      manual_continuation: {
        turn_id: 'turn',
        reply_order: ['pending'],
        accepted_replies: {},
        pending_manual: [
          { call_id: 'pending', name: 'lookup', arguments: '{}' },
        ],
      },
      manual_context: { instructions: null, result_schemas: [], usage: null },
      ...extra,
    }),
  );
}

it.each(['message', 'function_call_output', 'custom_tool_call_output'])(
  'bounds the whole retained staged audio batch at construction and load (%s)',
  (type) => {
    const part = {
      type: 'input_audio',
      audio_url: 'data:audio/wav;base64,AA==',
    };
    const item: JsonObject =
      type === 'message'
        ? { type, role: 'user', content: [part] }
        : { type, call_id: 'external', output: [part] };
    const source = saved();
    const staged = withPendingInput(source, [item]);
    expect(pendingInput(parseSessionState(JSON.stringify(staged)))).toEqual([
      item,
    ]);
    expect(() => withPendingInput(source, [item, item])).toThrow(
      'Audio input exceeds',
    );
    expect(() => withPendingInput(staged, [item])).toThrow(
      'Audio input exceeds',
    );
    const raw = JSON.parse(JSON.stringify(staged));
    raw.manual_continuation.pending_input.push(item);
    expect(() => parseSessionState(JSON.stringify(raw))).toThrow(
      'Audio input exceeds',
    );
    expect(pendingInput(staged)).toEqual([item]);
  },
);
