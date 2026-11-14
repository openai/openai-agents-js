import { expect, it, vi } from 'vitest';
import { Agent } from '../src/runtime/public-agent';
import {
  CODEX_REVISION,
  parseSessionState,
  pendingInput,
  withPendingInput,
  withoutPendingInput,
  nativeCheckpoint,
} from '../src/runtime/state';
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
it('keeps old empty queues readable without adding a format fence', () => {
  const old = saved();
  expect(pendingInput(old)).toEqual([]);
  expect(withPendingInput(old, [])).toEqual(old);
  expect(withPendingInput(old, []).format_version).toBe(3);
});
it('normalizes text and retains ordered duplicate occurrences through serde', () => {
  const old = saved();
  const first = withPendingInput(old, 'repeat');
  const staged = withPendingInput(first, 'repeat');
  expect(staged.format_version).toBe(19);
  expect(pendingInput(parseSessionState(JSON.stringify(staged)))).toEqual([
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'repeat' }],
    },
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'repeat' }],
    },
  ]);
  expect(pendingInput(old)).toEqual([]);
  expect(nativeCheckpoint(staged)).not.toHaveProperty('manual_continuation');
});
it('returns detached immutable snapshots and clears only staged input', () => {
  const old = saved();
  const item = {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'original' }],
    provider_extension: { keep: ['exact'] },
  };
  const state = withPendingInput(old, [item]);
  item.content[0].text = 'changed';
  const view = pendingInput(state);
  expect(view[0]).toMatchObject({
    content: [{ text: 'original' }],
    provider_extension: { keep: ['exact'] },
  });
  expect(Object.isFrozen(view)).toBe(true);
  expect(Object.isFrozen(view[0].content)).toBe(true);
  expect(withoutPendingInput(state)).toEqual(old);
  expect(pendingInput(state)).toHaveLength(1);
});
it('requires a format fence for every nonempty portable batch', () => {
  const staged = withPendingInput(saved(), 'new');
  expect(() =>
    parseSessionState(JSON.stringify({ ...staged, format_version: 3 })),
  ).toThrow();
  expect(() =>
    parseSessionState(
      JSON.stringify({
        ...staged,
        manual_continuation: {
          ...staged.manual_continuation,
          pending_input: [],
        },
      }),
    ),
  ).toThrow();
});
it('refuses unsupported states and exhausted model steps without mutation', () => {
  const idle = { ...saved(), format_version: 2 };
  delete (idle as any).manual_continuation;
  delete (idle as any).manual_context;
  expect(() =>
    withPendingInput(parseSessionState(JSON.stringify(idle)), 'new'),
  ).toThrow();
  const exhausted = saved({
    manual_context: {
      instructions: null,
      result_schemas: [],
      usage: null,
      remaining_model_steps: 0,
    },
  });
  expect(() => withPendingInput(exhausted, 'new')).toThrow();
  expect(pendingInput(exhausted)).toEqual([]);
  expect(() => withPendingInput(saved(), [null] as any)).toThrow();
});
it.each([false, true])(
  'keeps the native VM codec and existing budget (budget=%s)',
  (budget) => {
    const state = saved({
      format_version: budget ? 18 : 7,
      output_context: {
        version: 1,
        mode: 'plain',
        budget: 0,
        fingerprint: '0'.repeat(64),
      },
      ...(budget
        ? { run_budget: { version: 1, maxRequests: 3, admittedRequests: 1 } }
        : {}),
    });
    const staged = withPendingInput(state, 'vm input');
    expect(staged.format_version).toBe(20);
    expect(nativeCheckpoint(staged).format_version).toBe(4);
    expect(withoutPendingInput(staged).format_version).toBe(budget ? 18 : 7);
    expect(pendingInput(withoutPendingInput(staged))).toEqual([]);
  },
);
it('retains the new-format fence after clearing a settled staged retry', () => {
  const initial = withPendingInput(saved(), 'extra');
  const retry = parseSessionState(
    JSON.stringify({
      ...initial,
      manual_continuation: {
        ...initial.manual_continuation,
        pending_manual: [],
        accepted_replies: { pending: 'accepted' },
        staged_retry: true,
      },
    }),
  );
  const clear = withoutPendingInput(retry);
  expect(clear.format_version).toBe(19);
  expect(pendingInput(clear)).toEqual([]);
  expect(parseSessionState(JSON.stringify(clear))).toEqual(clear);
  expect(() =>
    parseSessionState(JSON.stringify({ ...clear, format_version: 3 })),
  ).toThrow();
});

it.each(['fresh', 'manual'] as const)(
  'forwards staged input admission through the public %s run opening',
  async (mode) => {
    const agent = new Agent({
      name: 'staged-run',
      instructions: 'Handle staged input.',
    });
    const opening = new Error('opening intercepted');
    const session = vi.spyOn(agent, 'session').mockRejectedValueOnce(opening);
    await expect(
      agent.run(mode === 'manual' ? null : '', {
        ...(mode === 'manual' ? { state: saved() } : {}),
        pendingInputAdmission: 'selected-before-send',
      }),
    ).rejects.toBe(opening);
    expect(session).toHaveBeenCalledWith(
      expect.objectContaining({
        pendingInputAdmission: 'selected-before-send',
      }),
    );
  },
);
