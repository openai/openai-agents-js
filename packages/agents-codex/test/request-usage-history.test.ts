import { expect, it } from 'vitest';
import {
  projectHistory,
  recordedTurnToWire,
  recordedTurnFromWire,
  repairTurnWireSchema,
  type ThreadHistory,
} from '../src/runtime/history';
function snapshot(
  owner: string,
  requests: number,
  missing: number,
  input: number | string,
) {
  return {
    owner_attempt_id: owner,
    terminal_attempt_id: null,
    usage: {
      requests,
      requests_without_token_usage: missing,
      token_usage: {
        input_tokens: input,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: input,
      },
    },
  };
}
function fact(
  owner: string,
  attempt: string,
  requests: number,
  missing: number,
  input: number | string,
  phase = 'finished',
) {
  return {
    type: 'event_msg',
    payload: {
      type: '_sdk_model_attempt',
      thread: 'thread',
      turn_id: 'turn',
      data: {
        ...snapshot(owner, requests, missing, input),
        attempt_id: attempt,
        phase,
      },
    },
  };
}
function history(...facts: ThreadHistory) {
  return projectHistory(
    [
      { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
      ...facts,
      {
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: 'turn',
          last_agent_message: 'ok',
        },
      },
    ],
    'thread',
  ).turns[0];
}
it('retains unknown failed and known successful SDK attempts without counting duplicate or measured events', () => {
  const first = fact('owner', 'first', 1, 1, 0);
  const turn = history(
    first,
    first,
    fact('owner', 'second', 2, 1, 3, 'measured'),
    fact('owner', 'second', 2, 1, 3),
  );
  expect(turn.requestUsageEntriesComplete).toBe(true);
  expect(turn.requestUsageEntries).toMatchObject([
    {
      scope: 'sdk_model_attempt',
      threadId: 'thread',
      turnId: 'turn',
      ownerAttemptId: 'owner',
      attemptId: 'first',
      requestOrdinal: 1,
      tokenUsageKnown: false,
      inputTokens: 0,
      totalTokens: 0,
    },
    {
      attemptId: 'second',
      requestOrdinal: 2,
      tokenUsageKnown: true,
      inputTokens: 3,
      totalTokens: 3,
    },
  ]);
  expect(turn.runUsage).toMatchObject({
    requests: 2,
    missingUsageRequests: 1,
    inputTokens: 3,
  });
  expect(turn.requestUsageEntries![0]).not.toHaveProperty('endpoint');
});
it('keeps missing durable settled facts explicit instead of turning a terminal aggregate into attempt usage', () => {
  const turn = history(fact('owner', 'second', 2, 1, 3, 'measured'));
  expect(turn.requestUsageEntries).toEqual([]);
  expect(turn.requestUsageEntriesComplete).toBe(false);
  expect(turn.runUsage?.requests).toBe(2);
});
it('marks a gap incomplete and keeps subsequent contiguous deltas attributable', () => {
  const turn = history(
    fact('owner', 'second', 2, 1, 3),
    fact('owner', 'third', 3, 1, 8),
  );
  expect(turn.requestUsageEntriesComplete).toBe(false);
  expect(turn.requestUsageEntries).toMatchObject([
    { attemptId: 'third', inputTokens: 5, requestOrdinal: 3 },
  ]);
});
it('keeps restored owners separate under the same turn', () => {
  const turn = history(
    fact('before', 'a', 1, 0, 3),
    fact('after', 'b', 1, 0, 5),
  );
  expect(turn.requestUsageEntriesComplete).toBe(true);
  expect(turn.requestUsageEntries).toMatchObject([
    { ownerAttemptId: 'before', requestOrdinal: 1, inputTokens: 3 },
    { ownerAttemptId: 'after', requestOrdinal: 1, inputTokens: 5 },
  ]);
  expect(turn.runUsage?.inputTokens).toBe(8);
});
it('distinguishes known zero usage from an unmeasured request', () => {
  const turn = history(fact('owner', 'zero', 1, 0, 0));
  expect(turn.requestUsageEntriesComplete).toBe(true);
  expect(turn.requestUsageEntries).toMatchObject([
    { tokenUsageKnown: true, totalTokens: 0 },
  ]);
});
it.each(['duplicate', 'decrease', 'unknown-with-tokens', 'reused-id'] as const)(
  'marks inconsistent %s facts incomplete',
  (mode) => {
    const next =
      mode === 'reused-id'
        ? fact('owner', 'first', 2, 0, 5)
        : mode === 'duplicate'
          ? fact('owner', 'different', 1, 0, 3)
          : mode === 'decrease'
            ? fact('owner', 'second', 2, 0, 2)
            : fact('owner', 'second', 2, 1, 4);
    const turn = history(fact('owner', 'first', 1, 0, 3), next);
    expect(turn.requestUsageEntriesComplete).toBe(false);
    expect(turn.requestUsageEntries).toHaveLength(1);
  },
);
it('round trips exact large token counts through passive repair history', () => {
  const turn = {
    ...history(fact('owner', 'large', 1, 0, '9007199254740993')),
    subagentId: null,
    parentSessionId: 'parent',
    parentTurnId: 'original',
  };
  const wire = recordedTurnToWire(turn);
  expect(wire.requestUsageEntries![0].inputTokens).toBe('9007199254740993');
  const restored = recordedTurnFromWire(repairTurnWireSchema.parse(wire));
  expect(restored.requestUsageEntries![0].inputTokens).toBe(9007199254740993n);
  expect(restored.requestUsageEntriesComplete).toBe(true);
  restored.requestUsageEntries![0].inputTokensDetails.cachedTokens = 99;
  expect(turn.requestUsageEntries![0].inputTokensDetails.cachedTokens).toBe(0);
});
it.each(['thread', 'turn_id'])(
  'keeps missing %s provenance incomplete',
  (key) => {
    const record = fact('owner', 'attempt', 1, 0, 3);
    Reflect.deleteProperty(record.payload, key);
    const turn = history(record);
    expect(turn.requestUsageEntries).toEqual([]);
    expect(turn.requestUsageEntriesComplete).toBe(false);
  },
);
