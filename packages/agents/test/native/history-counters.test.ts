import { describe, expect, it } from 'vitest';
import {
  projectHistory,
  recordedTurnFromWire,
  recordedTurnToWire,
  repairTurnWireSchema,
  type ThreadHistory,
} from '../../src/runtime/history';
import {
  addRunUsage,
  addTokenCounts,
  parseTokenCount,
  runUsageToWire,
  tokenCountToWire,
  tokenUsageInfo,
} from '../../src/runtime/run-events';
import { encodeReceipt } from '../../src/runtime/binding';
import {
  CODEX_REVISION,
  parseSessionState,
  sessionStateSchema,
} from '../../src/runtime/state';

const large = '9007199254740993';
const maxI64 = '9223372036854775807';
const zero = {
  inputTokens: 0,
  inputTokensDetails: { cachedTokens: 0 },
  outputTokens: 0,
  outputTokensDetails: { reasoningTokens: 0 },
  totalTokens: 0,
};
const start: ThreadHistory = [
  { type: 'event_msg', payload: { type: 'task_started', turn_id: 't' } },
];
const finish: ThreadHistory = [
  { type: 'event_msg', payload: { type: 'task_complete', turn_id: 't' } },
];
const project = (records: ThreadHistory) =>
  projectHistory([...start, ...records, ...finish], 'session').turns[0];
const record = (
  usage: Record<string, number | string | null>,
): ThreadHistory => [
  {
    type: 'token_usage_record',
    payload: { turn_id: 't', turn_token_usage: usage },
  },
];
const response = (
  usage: Record<string, number | string | null>,
): ThreadHistory => [
  {
    type: 'event_msg',
    payload: {
      type: 'raw_response_completed',
      turn_id: 't',
      token_usage: usage,
    },
  },
];
const receipt = (usage: unknown) => ({
  format_version: 3,
  codex_revision: CODEX_REVISION,
  source_session_id: 'session',
  history: [],
  root_metadata: {},
  manual_continuation: {
    turn_id: 't',
    reply_order: ['c'],
    accepted_replies: {},
    pending_manual: [
      {
        call_id: 'c',
        name: 'manual',
        arguments: '{"input_tokens":"unchanged"}',
      },
    ],
  },
  manual_context: { instructions: null, result_schemas: [], usage },
});

describe('exact observational counters', () => {
  it('keeps missing whole usage null and defaults absent fields in present usage to zero', () => {
    expect(project([]).usage).toBeNull();
    expect(project(record({})).usage).toEqual(zero);
    expect(project(record({ input_tokens: 7, total_tokens: 0 })).usage).toEqual(
      { ...zero, inputTokens: 7 },
    );
    expect(project(response({})).usage).toEqual(zero);
    expect(
      recordedTurnFromWire(recordedTurnToWire(project([]))).usage,
    ).toBeNull();
  });

  it('preserves reported cache writes, including zero and exact large counts', () => {
    for (const [raw, expected] of [
      [0, 0],
      [7, 7],
      [large, 9007199254740993n],
    ] as const) {
      expect(
        project(record({ cache_write_input_tokens: raw })).usage
          ?.inputTokensDetails,
      ).toEqual({ cachedTokens: 0, cacheWriteTokens: expected });
    }
    expect(project(record({})).usage?.inputTokensDetails).not.toHaveProperty(
      'cacheWriteTokens',
    );
  });

  it('only totals cache writes when every response reports the counter', () => {
    expect(
      project([
        ...response({ cache_write_input_tokens: large }),
        ...response({ cache_write_input_tokens: 2 }),
      ]).usage?.inputTokensDetails,
    ).toEqual({ cachedTokens: 0, cacheWriteTokens: 9007199254740995n });
    expect(
      project([
        ...response({ cache_write_input_tokens: 0 }),
        ...response({ cache_write_input_tokens: 0 }),
      ]).usage?.inputTokensDetails,
    ).toEqual({ cachedTokens: 0, cacheWriteTokens: 0 });
    const unavailable: ThreadHistory[] = [
      response({}),
      [
        {
          type: 'event_msg',
          payload: { type: 'raw_response_completed', turn_id: 't' },
        },
      ],
    ];
    for (const missing of unavailable) {
      for (const records of [
        [...missing, ...response({ cache_write_input_tokens: 7 })],
        [...response({ cache_write_input_tokens: 7 }), ...missing],
      ]) {
        expect(project(records).usage?.inputTokensDetails).not.toHaveProperty(
          'cacheWriteTokens',
        );
      }
    }
    expect(project(response({})).usage?.inputTokensDetails).not.toHaveProperty(
      'cacheWriteTokens',
    );
    expect(project(unavailable[1]).usage).toBeNull();
    expect(
      project([...unavailable[1], ...record({ cache_write_input_tokens: 5 })])
        .usage?.inputTokensDetails,
    ).toEqual({ cachedTokens: 0, cacheWriteTokens: 5 });
  });

  it('still rejects malformed cache writes after an incomplete response', () => {
    expect(() =>
      project([
        ...response({}),
        ...response({ cache_write_input_tokens: null }),
      ]),
    ).toThrow();
  });

  it('clears incomplete response cache accounting when a turn restarts', () => {
    expect(
      project([
        {
          type: 'event_msg',
          payload: { type: 'raw_response_completed', turn_id: 't' },
        },
        ...start,
        ...response({ cache_write_input_tokens: 3 }),
      ]).usage?.inputTokensDetails,
    ).toEqual({ cachedTokens: 0, cacheWriteTokens: 3 });
  });

  it('discards incomplete response accounting when history rolls back', () => {
    expect(
      project([
        {
          type: 'event_msg',
          payload: { type: 'raw_response_completed', turn_id: 't' },
        },
        {
          type: 'event_msg',
          payload: { type: 'thread_rolled_back', num_turns: 1 },
        },
        ...response({ cache_write_input_tokens: 4 }),
      ]).usage?.inputTokensDetails,
    ).toEqual({ cachedTokens: 0, cacheWriteTokens: 4 });
  });

  it('roundtrips optional cache writes through JSON and strict repair turns', () => {
    for (const raw of [undefined, 0, large]) {
      const turn = {
        ...project(
          record(raw === undefined ? {} : { cache_write_input_tokens: raw }),
        ),
        subagentId: null,
        status: 'completed' as const,
        parentSessionId: 'parent',
        parentTurnId: 'parent-turn',
      };
      const wire = repairTurnWireSchema.parse(
        JSON.parse(JSON.stringify(recordedTurnToWire(turn))),
      );
      expect(wire.usage?.inputTokensDetails).toEqual(
        raw === undefined
          ? { cachedTokens: 0 }
          : { cachedTokens: 0, cacheWriteTokens: raw },
      );
      expect(recordedTurnFromWire(wire)).toEqual(turn);
      if (wire.usage) {
        expect(
          repairTurnWireSchema.safeParse({
            ...wire,
            usage: {
              ...wire.usage,
              inputTokensDetails: { cachedTokens: 0, cacheWriteTokens: -1 },
            },
          }).success,
        ).toBe(false);
      }
    }
  });

  it('preserves safe counts and every large recorded counter exactly', () => {
    expect(parseTokenCount(Number.MAX_SAFE_INTEGER)).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(parseTokenCount(String(Number.MAX_SAFE_INTEGER))).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(parseTokenCount(1n)).toBe(1);
    expect(
      project(
        record({
          input_tokens: large,
          cached_input_tokens: maxI64,
          output_tokens: large,
          reasoning_output_tokens: maxI64,
          total_tokens: maxI64,
        }),
      ).usage,
    ).toEqual({
      inputTokens: 9007199254740993n,
      inputTokensDetails: { cachedTokens: 9223372036854775807n },
      outputTokens: 9007199254740993n,
      outputTokensDetails: { reasoningTokens: 9223372036854775807n },
      totalTokens: 9223372036854775807n,
    });
  });

  it('sums response fallback usage and root usage without safe-number overflow', () => {
    const first = addRunUsage(null, {
      input_tokens: Number.MAX_SAFE_INTEGER,
      total_tokens: Number.MAX_SAFE_INTEGER,
    });
    const result = addRunUsage(first, {
      input_tokens: 2,
      total_tokens: '2',
      cache_write_input_tokens: large,
    });
    expect(result.inputTokens).toBe(9007199254740993n);
    expect(result.totalTokens).toBe(9007199254740993n);
    expect(result.cacheWriteInputTokens).toBe(9007199254740993n);
    expect(addRunUsage(null, {}).totalTokens).toBe(0);
    const turn = project([
      ...response({ total_tokens: Number.MAX_SAFE_INTEGER }),
      ...response({
        total_tokens: '2',
        output_tokens: 2,
        unknown_counter: 'arbitrary',
      }),
    ]);
    expect(turn.usage).toEqual({
      ...zero,
      outputTokens: 2,
      totalTokens: 9007199254740993n,
    });
    expect(addTokenCounts(9007199254740993n, 7)).toBe(9007199254741000n);
  });

  it('keeps a present authoritative record separate from response fallback', () => {
    expect(
      project([
        ...response({ input_tokens: 12, total_tokens: large }),
        ...record({}),
      ]).usage,
    ).toEqual(zero);
  });

  it.each([
    Number.MAX_SAFE_INTEGER + 1,
    1.5,
    NaN,
    Infinity,
    null,
    '01',
    '1e3',
    '1.5',
  ])('rejects an inexact or malformed counter %s', (value) => {
    expect(() => parseTokenCount(value)).toThrow();
  });

  it('rejects unsafe numeric history and root accumulation instead of rounding or defaulting', () => {
    expect(() =>
      project(record({ input_tokens: Number.MAX_SAFE_INTEGER + 1 })),
    ).toThrow();
    expect(() =>
      project(response({ total_tokens: Number.MAX_SAFE_INTEGER + 1 })),
    ).toThrow();
    expect(() => project(record({ output_tokens: null }))).toThrow();
    expect(() =>
      addRunUsage(null, { total_tokens: Number.MAX_SAFE_INTEGER + 1 }),
    ).toThrow();
  });

  it('decodes exact live child snapshots with the same public representation', () => {
    const usage = {
      input_tokens: large,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: '2',
      reasoning_output_tokens: 0,
      total_tokens: maxI64,
    };
    const result = tokenUsageInfo({
      total_token_usage: usage,
      last_token_usage: usage,
      model_context_window: maxI64,
    });
    expect(result?.lastTokenUsage.inputTokens).toBe(9007199254740993n);
    expect(result?.lastTokenUsage.outputTokens).toBe(2);
    expect(result?.modelContextWindow).toBe(9223372036854775807n);
    expect(tokenUsageInfo(null)).toBeNull();
    expect(() =>
      tokenUsageInfo({
        total_token_usage: {
          ...usage,
          total_tokens: Number.MAX_SAFE_INTEGER + 1,
        },
        last_token_usage: usage,
        model_context_window: null,
      }),
    ).toThrow();
  });

  it('roundtrips typed turn usage through JSON without rewriting other packet values', () => {
    const turn = project(
      record({
        input_tokens: large,
        cached_input_tokens: maxI64,
        output_tokens: 4,
        reasoning_output_tokens: large,
        total_tokens: maxI64,
      }),
    );
    const toolData = {
      arguments: { input_tokens: Number.MAX_SAFE_INTEGER + 1 },
      output: {
        type: 'token_usage_record',
        turn_token_usage: { total_tokens: 'arbitrary' },
      },
    };
    const wire = recordedTurnToWire(turn);
    expect(wire.usage?.inputTokens).toBe(large);
    expect(wire.usage?.outputTokens).toBe(4);
    const decoded = JSON.parse(JSON.stringify({ turn: wire, toolData }));
    expect(recordedTurnFromWire(decoded.turn)).toEqual(turn);
    expect(decoded.toolData).toEqual(toolData);
    expect(tokenCountToWire(1n)).toBe(1);
    expect(tokenCountToWire(9007199254740993n)).toBe(large);
  });
});

describe('existing format-3 manual usage wire', () => {
  it('preserves a legacy safe numeric receipt and nullable usage', () => {
    const usage = runUsageToWire(
      addRunUsage(null, { input_tokens: 2, total_tokens: 3 }),
    );
    const original = receipt(usage);
    const parsed = parseSessionState(JSON.stringify(original));
    expect(parsed).toMatchObject(original);
    expect(parsed.format_version).toBe(3);
    if (parsed.format_version !== 3) throw new Error('expected format3');
    expect(parsed.manual_context.usage).toEqual(usage);
    expect(JSON.stringify(parsed)).not.toContain('bigint');
    const missing = parseSessionState(JSON.stringify(receipt(null)));
    expect(
      missing.format_version === 3 && missing.manual_context.usage,
    ).toBeNull();
  });

  it('keeps large counters JSON-safe in SessionState and restores exact accumulation', () => {
    const usage = addRunUsage(null, {
      input_tokens: large,
      total_tokens: maxI64,
    });
    const encoded = encodeReceipt(receipt(runUsageToWire(usage)));
    const parsed = parseSessionState(encoded);
    if (parsed.format_version !== 3) throw new Error('expected format3');
    const wire = parsed.manual_context.usage!;
    expect(wire.inputTokens).toBe(large);
    expect(wire.totalTokens).toBe(maxI64);
    expect(() => JSON.stringify(parsed)).not.toThrow();
    const restored = addRunUsage(null, {
      input_tokens: wire.inputTokens,
      total_tokens: wire.totalTokens,
    });
    expect(restored.inputTokens).toBe(9007199254740993n);
    expect(addRunUsage(restored, { total_tokens: 1 }).totalTokens).toBe(
      9223372036854775808n,
    );
    expect(parsed.manual_continuation.pending_manual[0].arguments).toBe(
      '{"input_tokens":"unchanged"}',
    );
  });

  it.each([-1, '-1', '01', '1.0', '1e3', Number.MAX_SAFE_INTEGER + 1, null])(
    'refuses malformed or unsafe manual counter %s',
    (value) => {
      const wire = {
        ...runUsageToWire(addRunUsage(null, {})),
        totalTokens: value,
      };
      expect(() => parseSessionState(JSON.stringify(receipt(wire)))).toThrow();
    },
  );

  it('keeps manual receipt counts nonnegative and rejects bigint inside SessionState', () => {
    expect(() =>
      runUsageToWire({ ...addRunUsage(null, {}), totalTokens: -1n }),
    ).toThrow();
    const invalid = receipt({
      ...runUsageToWire(addRunUsage(null, {})),
      totalTokens: 1n,
    });
    expect(sessionStateSchema.safeParse(invalid).success).toBe(false);
  });
});
