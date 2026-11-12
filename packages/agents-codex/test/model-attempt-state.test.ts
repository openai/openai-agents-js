import { describe, it, expect } from 'vitest';
import {
  applyModelAttemptFact,
  attachModelUsageSource,
  modelAttemptUsage,
  modelAttemptUsageJson,
  retainModelAttemptFailure,
  modelAttemptOriginalError,
  releaseModelAttemptPayload,
  applyModelAttemptSnapshot,
  captureModelAttemptSnapshot,
  addModelReportedUsage,
  modelAttemptState,
  modelAttemptTerminalError,
  restoreModelUsageOffset,
  type ModelAttemptOwner,
} from '../src/runtime/model-attempts';
import { runUsageSnapshot, addRunUsage } from '../src/runtime/run-events';
function owner(): ModelAttemptOwner {
  return { tokenUsage: null, requests: 0, missingUsageRequests: 0 };
}
function snapshot(
  requests: number,
  missing: number,
  input: number | string,
  terminal: string | null = null,
) {
  return {
    owner_attempt_id: requests === 0 ? null : 'first',
    usage: {
      requests,
      requests_without_token_usage: missing,
      token_usage: { input_tokens: input, total_tokens: input },
    },
    terminal_attempt_id: terminal,
  };
}
describe('native attempt accounting and exact failure ownership', () => {
  it('replaces native cumulative totals while adding explicit reports exactly once', () => {
    const state = owner();
    addModelReportedUsage(state, { input_tokens: 3, total_tokens: 3 }, 1, 0);
    applyModelAttemptSnapshot(state, snapshot(1, 1, 0));
    expect(state.requests).toBe(2);
    expect(state.missingUsageRequests).toBe(1);
    expect(state.tokenUsage?.inputTokens).toBe(3);
    applyModelAttemptSnapshot(state, snapshot(2, 1, 7));
    applyModelAttemptSnapshot(state, snapshot(2, 1, 7));
    expect(state.requests).toBe(3);
    expect(state.missingUsageRequests).toBe(1);
    expect(state.tokenUsage?.inputTokens).toBe(10);
  });
  it('keeps exact large measured counters and a detached checkpoint offset', () => {
    const state = owner();
    const wire = snapshot(2, 0, '9007199254740993');
    applyModelAttemptSnapshot(state, wire);
    wire.usage.token_usage.input_tokens = '1';
    restoreModelUsageOffset(
      state,
      runUsageSnapshot(
        addRunUsage(null, { input_tokens: 3, total_tokens: 3 }),
        1,
        0,
      ),
    );
    expect(state.tokenUsage?.inputTokens).toBe(9007199254740996n);
    expect(state.requests).toBe(3);
    applyModelAttemptSnapshot(state, snapshot(3, 1, '9007199254740993'));
    expect(state.requests).toBe(4);
    expect(state.tokenUsage?.inputTokens).toBe(9007199254740996n);
  });
  it('releases request/model on retry and exposes only the exact terminal error', () => {
    const state = owner(),
      error = new Error('same provider error');
    const slot = {
      attemptId: 'first',
      error,
      request: {} as never,
      model: {} as never,
      advice: undefined,
    };
    modelAttemptState(state).failure = slot;
    applyModelAttemptFact(state, {
      ...snapshot(1, 1, 0),
      attempt_id: 'first',
      phase: 'retry',
    });
    expect(state.modelAttempts?.failure).toBeUndefined();
    expect(modelAttemptTerminalError(state)).toBeUndefined();
    modelAttemptState(state).failure = { ...slot, attemptId: 'second' };
    applyModelAttemptFact(state, {
      ...snapshot(2, 2, 0, 'first'),
      attempt_id: 'first',
      phase: 'terminal',
    });
    expect(modelAttemptTerminalError(state)).toBeUndefined();
    applyModelAttemptFact(state, {
      ...snapshot(2, 2, 0, 'second'),
      attempt_id: 'second',
      phase: 'terminal',
    });
    expect(modelAttemptTerminalError(state)?.error).toBe(error);
    expect(state.modelAttempts?.failure).toBeUndefined();
  });
  it('releases retained failures on cancellation and rejects malformed counters', () => {
    const state = owner();
    modelAttemptState(state).failure = {
      attemptId: 'one',
      error: undefined,
      request: {} as never,
      model: {} as never,
      advice: undefined,
    };
    applyModelAttemptFact(state, {
      ...snapshot(1, 1, 0),
      attempt_id: 'one',
      phase: 'cancelled',
    });
    expect(state.modelAttempts?.failure).toBeUndefined();
    for (const value of [
      snapshot(1, 2, 0),
      snapshot(-1, 0, 0),
      snapshot(1, 0, -1),
      snapshot(1, 0, 1.5),
      { ...snapshot(1, 0, 0), owner_attempt_id: null },
      { ...snapshot(0, 0, 0), terminal_attempt_id: 'not-empty' },
      { ...snapshot(1, 0, 0), owner_attempt_id: '' },
    ])
      expect(() => applyModelAttemptSnapshot(state, value)).toThrow();
  });
});
it('captures the ledger owner independently from terminal attempt identity', () => {
  const wire = snapshot(2, 0, 7, 'second');
  const captured = captureModelAttemptSnapshot(wire);
  expect(captured.ownerAttemptId).toBe('first');
  expect(captured.terminalAttemptId).toBe('second');
  wire.owner_attempt_id = 'rewritten';
  expect(captured.wire.owner_attempt_id).toBe('first');
});
it('does not retire a retained error on a malformed disposition', () => {
  const state = owner();
  const error = new Error('retained');
  const slot = {
    attemptId: 'one',
    error,
    request: {} as never,
    model: {} as never,
    advice: undefined,
  };
  modelAttemptState(state).failure = slot;
  expect(() =>
    applyModelAttemptFact(state, {
      ...snapshot(1, 2, 0),
      attempt_id: 'one',
      phase: 'retry',
    }),
  ).toThrow();
  expect(state.modelAttempts?.failure).toBe(slot);
});

it('keeps physical repair and child sources independent of delayed predecessor snapshots', () => {
  const first = owner(),
    repair = owner(),
    child = owner();
  attachModelUsageSource(first, repair);
  attachModelUsageSource(repair, child);
  attachModelUsageSource(first, repair);
  applyModelAttemptSnapshot(first, snapshot(1, 0, 3));
  applyModelAttemptSnapshot(repair, {
    ...snapshot(2, 1, 7),
    owner_attempt_id: 'repair',
  });
  applyModelAttemptSnapshot(child, {
    ...snapshot(1, 0, 5),
    owner_attempt_id: 'child',
  });
  const before = modelAttemptUsage(first);
  expect(before).toMatchObject({
    requests: 4,
    missingUsageRequests: 1,
    inputTokens: 15,
  });
  applyModelAttemptSnapshot(first, snapshot(1, 0, 4));
  expect(modelAttemptUsage(first)).toMatchObject({
    requests: 4,
    missingUsageRequests: 1,
    inputTokens: 16,
  });
  expect(before.inputTokens).toBe(15);
  addModelReportedUsage(repair, { input_tokens: 2, total_tokens: 2 }, 0, 0);
  expect(modelAttemptUsage(first).inputTokens).toBe(18);
});
it('selects only the exact current admitted error and leaves timeout identity native-owned', () => {
  const state = owner(),
    first = new Error('first'),
    current = new Error('second');
  const slot = {
    attemptId: 'first',
    error: first,
    request: {} as never,
    model: {} as never,
    advice: undefined,
  };
  retainModelAttemptFailure(state, slot);
  expect(modelAttemptOriginalError(state, 'first')?.error).toBe(first);
  applyModelAttemptFact(state, {
    ...snapshot(1, 1, 0),
    attempt_id: 'first',
    phase: 'retry',
  });
  applyModelAttemptFact(state, {
    ...snapshot(2, 1, 0),
    attempt_id: 'second',
    phase: 'started',
  });
  expect(modelAttemptOriginalError(state, 'first')).toBeUndefined();
  retainModelAttemptFailure(state, {
    ...slot,
    attemptId: 'second',
    error: current,
  });
  expect(modelAttemptOriginalError(state, 'second')?.error).toBe(current);
  expect(modelAttemptOriginalError(state, null)).toBeUndefined();
  expect(modelAttemptOriginalError(state, 'foreign')).toBeUndefined();
  applyModelAttemptSnapshot(state, snapshot(2, 1, 0, 'second'));
  expect(modelAttemptTerminalError(state)?.error).toBe(current);
  releaseModelAttemptPayload(state);
  expect(modelAttemptOriginalError(state, 'second')).toBeUndefined();
});
it('reports exact integer cleanup usage without adding a request counter', () => {
  const usage = addRunUsage(null, {
    input_tokens: '9007199254740993',
    total_tokens: '9007199254740993',
  });
  const wire = modelAttemptUsageJson(usage);
  expect(wire).toContain('"input_tokens":9007199254740993');
  expect(wire).not.toContain('requests');
  expect(wire).not.toContain('"9007199254740993"');
});

it('publishes measured usage before settlement without counting it twice', () => {
  const state = owner();
  const measured = {
    ...snapshot(1, 0, 7),
    attempt_id: 'first',
    phase: 'measured',
  };
  applyModelAttemptFact(state, measured);
  expect(state.requests).toBe(1);
  expect(state.tokenUsage?.inputTokens).toBe(7);
  applyModelAttemptFact(state, measured);
  expect(state.requests).toBe(1);
  expect(state.tokenUsage?.inputTokens).toBe(7);
});
