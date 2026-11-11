import { it, expect } from 'vitest';
import { parseNative } from '../src/runtime/binding';
import {
  projectHistory,
  recordedTurnToWire,
  recordedTurnFromWire,
  repairTurnWireSchema,
  type ThreadHistory,
} from '../src/runtime/history';
const counters = {
  requests: 2,
  requests_without_token_usage: 1,
  token_usage: {
    input_tokens: 3,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 3,
  },
};
it('prefers the latest persisted native aggregate over response or context-window copies', () => {
  const history: ThreadHistory = [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
    {
      type: 'event_msg',
      payload: {
        type: '_sdk_model_attempt',
        turn_id: 'turn',
        data: {
          owner_attempt_id: 'id',
          attempt_id: 'id',
          phase: 'started',
          usage: {
            requests: 1,
            requests_without_token_usage: 1,
            token_usage: null,
          },
          terminal_attempt_id: null,
        },
      },
    },
    {
      type: 'event_msg',
      payload: {
        type: 'raw_response_completed',
        turn_id: 'turn',
        model_attempt_id: 'generation-copy',
        token_usage: { input_tokens: 100, total_tokens: 100 },
      },
    },
    {
      type: 'event_msg',
      payload: {
        type: '_sdk_model_attempt',
        turn_id: 'turn',
        data: {
          owner_attempt_id: 'id',
          attempt_id: 'id',
          phase: 'finished',
          usage: counters,
          terminal_attempt_id: null,
        },
      },
    },
    {
      type: 'event_msg',
      payload: {
        type: 'raw_response_completed',
        turn_id: 'turn',
        model_attempt_id: 'generation-copy',
        token_usage: { input_tokens: 100, total_tokens: 100 },
      },
    },
    {
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'turn',
        last_agent_message: 'ok',
      },
    },
  ];
  const projected = projectHistory(history, 'thread');
  expect(projected.turns).toHaveLength(1);
  expect(projected.turns[0].usage).toMatchObject({
    inputTokens: 3,
    totalTokens: 3,
  });
});
it('restores exact integer tokens only in owned attempt paths', () => {
  const token = '9007199254740993';
  const source = `{"msg":{"type":"_sdk_model_attempt","data":{"owner_attempt_id":"id","attempt_id":"id","phase":"finished","usage":{"requests":2,"requests_without_token_usage":1,"token_usage":{"input_tokens":${token},"total_tokens":${token}}},"terminal_attempt_id":null}},"arbitrary":{"input_tokens":3}}`;
  const parsed = parseNative(source) as any;
  expect(parsed.msg.data.usage.token_usage.input_tokens).toBe(token);
  expect(parsed.msg.data.usage.requests).toBe('2');
  expect(parsed.arbitrary.input_tokens).toBe(3);
});
it('sums distinct restored ledger owners under a retained turn and preserves the legacy prefix', () => {
  const fact = (owner: string, input: number) => ({
    type: 'event_msg',
    payload: {
      type: '_sdk_model_attempt',
      turn_id: 'turn',
      data: {
        owner_attempt_id: owner,
        attempt_id: owner,
        phase: 'finished',
        usage: {
          ...counters,
          token_usage: {
            ...counters.token_usage,
            input_tokens: input,
            total_tokens: input,
          },
        },
        terminal_attempt_id: null,
      },
    },
  });
  const history: ThreadHistory = [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
    {
      type: 'event_msg',
      payload: {
        type: 'raw_response_completed',
        turn_id: 'turn',
        token_usage: { input_tokens: 2, total_tokens: 2 },
      },
    },
    fact('original-owner', 3),
    fact('original-owner', 5),
    fact('restored-owner', 7),
    fact('restored-owner', 7),
    {
      type: 'event_msg',
      payload: {
        type: 'raw_response_completed',
        turn_id: 'turn',
        model_attempt_id: 'generation-copy',
        token_usage: { input_tokens: 100, total_tokens: 100 },
      },
    },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn' } },
  ];
  const projected = projectHistory(history, 'thread');
  expect(projected.turns[0].usage).toMatchObject({
    inputTokens: 14,
    totalTokens: 14,
  });
  expect(
    projected.turns[0].usage?.inputTokensDetails.cacheWriteTokens,
  ).toBeUndefined();
});

it('retains untagged compaction usage after the first native generation snapshot', () => {
  const history: ThreadHistory = [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
    {
      type: 'event_msg',
      payload: {
        type: '_sdk_model_attempt',
        turn_id: 'turn',
        data: {
          owner_attempt_id: 'generation',
          attempt_id: 'generation',
          phase: 'finished',
          usage: counters,
          terminal_attempt_id: null,
        },
      },
    },
    {
      type: 'event_msg',
      payload: {
        type: 'raw_response_completed',
        turn_id: 'turn',
        model_attempt_id: 'generation',
        token_usage: { input_tokens: 100, total_tokens: 100 },
      },
    },
    {
      type: 'event_msg',
      payload: {
        type: 'raw_response_completed',
        turn_id: 'turn',
        token_usage: { input_tokens: 7, total_tokens: 7 },
      },
    },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn' } },
  ];
  expect(projectHistory(history, 'thread').turns[0].usage).toMatchObject({
    inputTokens: 10,
    totalTokens: 10,
  });
});

it('retains request counts and legacy usage across a restored owner starting the same turn', () => {
  const fact = (owner: string, tokens: number) => ({
    type: 'event_msg',
    payload: {
      type: '_sdk_model_attempt',
      turn_id: 'same',
      data: {
        owner_attempt_id: owner,
        attempt_id: owner,
        phase: 'finished',
        usage: {
          ...counters,
          token_usage: {
            ...counters.token_usage,
            input_tokens: tokens,
            total_tokens: tokens,
          },
        },
        terminal_attempt_id: null,
      },
    },
  });
  const history: ThreadHistory = [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'same' } },
    {
      type: 'event_msg',
      payload: {
        type: 'raw_response_completed',
        turn_id: 'same',
        token_usage: { input_tokens: 2, total_tokens: 2 },
      },
    },
    fact('original', 3),
    fact('original', 5),
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'same' } },
    fact('restored', 7),
    fact('restored', 7),
    {
      type: 'event_msg',
      payload: {
        type: 'raw_response_completed',
        turn_id: 'same',
        model_attempt_id: 'restored',
        token_usage: { input_tokens: 100, total_tokens: 100 },
      },
    },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'same' } },
  ];
  const restoredTurn = projectHistory(history, 'thread').turns[0];
  expect(
    restoredTurn.usage?.inputTokensDetails.cacheWriteTokens,
  ).toBeUndefined();
  expect(restoredTurn.runUsage).toMatchObject({
    requests: 5,
    missingUsageRequests: 2,
    inputTokens: 14,
    totalTokens: 14,
  });
});
it('keeps missing usage explicit and restores exact persisted recorded-turn counters', () => {
  const history: ThreadHistory = [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn' } },
    {
      type: 'event_msg',
      payload: {
        type: 'raw_response_completed',
        turn_id: 'turn',
        token_usage: null,
      },
    },
    {
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'turn',
        model_attempt: {
          owner_attempt_id: 'owner',
          terminal_attempt_id: null,
          usage: {
            requests: 2,
            requests_without_token_usage: 1,
            token_usage: {
              input_tokens: '9007199254740993',
              total_tokens: '9007199254740993',
            },
          },
        },
      },
    },
  ];
  const turn = projectHistory(history, 'thread').turns[0];
  expect(turn.runUsage).toMatchObject({
    requests: 3,
    missingUsageRequests: 2,
    inputTokens: 9007199254740993n,
  });
  const saved = JSON.parse(JSON.stringify(recordedTurnToWire(turn)));
  expect(saved.runUsage.inputTokens).toBe('9007199254740993');
  const repair = {
    ...saved,
    parentSessionId: 'parent',
    parentTurnId: 'original',
  };
  expect(repairTurnWireSchema.safeParse(repair).success).toBe(true);
  expect(
    repairTurnWireSchema.safeParse({
      ...repair,
      runUsage: { ...repair.runUsage, requests: -1 },
    }).success,
  ).toBe(false);
  const restored = recordedTurnFromWire(saved);
  expect(restored.runUsage).toEqual(turn.runUsage);
  expect(restored.runUsage).not.toBe(turn.runUsage);
});
it('leaves legacy run totals unavailable and removes discarded native owner contributions', () => {
  const legacy: ThreadHistory = [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'legacy' } },
    {
      type: 'event_msg',
      payload: {
        type: 'raw_response_completed',
        turn_id: 'legacy',
        token_usage: { input_tokens: 3, total_tokens: 3 },
      },
    },
    {
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'legacy' },
    },
  ];
  const old = projectHistory(legacy, 'thread').turns[0];
  expect(old.runUsage).toBeUndefined();
  expect(recordedTurnToWire(old)).not.toHaveProperty('runUsage');
  const history: ThreadHistory = [
    ...legacy,
    {
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'discarded' },
    },
    {
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'discarded',
        model_attempt: {
          owner_attempt_id: 'discarded-owner',
          terminal_attempt_id: null,
          usage: counters,
        },
      },
    },
    {
      type: 'event_msg',
      payload: { type: 'thread_rolled_back', num_turns: 1 },
    },
    {
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'discarded' },
    },
    {
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: 'discarded',
        model_attempt: {
          owner_attempt_id: 'new-owner',
          terminal_attempt_id: null,
          usage: { ...counters, requests: 1, requests_without_token_usage: 0 },
        },
      },
    },
  ];
  expect(
    projectHistory(history, 'thread').turns.at(-1)?.runUsage,
  ).toMatchObject({ requests: 1, missingUsageRequests: 0, inputTokens: 3 });
});
