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

  it('retains distinct native ledger owners across a restored turn start', () => {
    const fact = (id: string, tokens: number): ThreadHistory => [
      {
        type: 'event_msg',
        payload: {
          type: '_sdk_model_attempt',
          turn_id: 't',
          data: {
            owner_attempt_id: id,
            terminal_attempt_id: null,
            usage: {
              requests: 1,
              requests_without_token_usage: 0,
              token_usage: {
                input_tokens: tokens,
                cached_input_tokens: 0,
                output_tokens: 0,
                reasoning_output_tokens: 0,
                total_tokens: tokens,
              },
            },
          },
        },
      },
    ];
    const turn = project([
      ...fact('prior', 7),
      ...start,
      ...fact('current', 3),
    ]);
    expect(turn.usage?.totalTokens).toBe(10);
    expect(turn.runUsage?.requests).toBe(2);
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

describe('recorded response observations', () => {
  const observed = (
    id: string,
    usage: Record<string, string | number> | null,
    extra: Record<string, unknown> = {},
  ): ThreadHistory[number] => ({
    type: 'response_observation_record',
    payload: {
      id,
      thread_id: 'origin-thread',
      turn_id: 't',
      response_id: 'reused-provider-id',
      status: 'completed',
      incomplete_reason: null,
      usage,
      ...extra,
    } as ThreadHistory[number]['payload'],
  });
  const accounting = (link?: string): ThreadHistory[number] => ({
    type: 'token_usage_record',
    payload: {
      thread_id: 'origin-thread',
      turn_id: 't',
      response_id: 'reused-provider-id',
      usage: { input_tokens: 7, total_tokens: 9 },
      turn_token_usage: { input_tokens: 14, total_tokens: 18 },
      ...(link ? { response_observation_id: link } : {}),
    },
  });

  it('retains normalized zero cache writes across an application completion boundary', () => {
    const normalized = accounting('application-completion');
    normalized.payload.usage = { cache_write_input_tokens: 0 };
    normalized.payload.turn_token_usage = { cache_write_input_tokens: 0 };
    const turn = project([
      observed('application-completion', null, { response_id: null }),
      normalized,
    ]);

    expect(turn.usage?.inputTokensDetails.cacheWriteTokens).toBe(0);
    expect(turn.responses).toMatchObject([
      { responseId: null, status: 'completed', usage: null },
    ]);
  });

  it('keeps empty received usage for a genuine no-ID direct observation', () => {
    const turn = project([
      observed('direct-empty', {}, { response_id: null }),
      accounting('direct-empty'),
    ]);
    expect(turn.responses?.[0]).toMatchObject({ responseId: null, usage: {} });
    expect(turn.usage?.inputTokensDetails).not.toHaveProperty(
      'cacheWriteTokens',
    );
    expect(
      recordedTurnFromWire(recordedTurnToWire(turn)).responses?.[0].usage,
    ).toEqual({});
  });

  it.each([undefined, 0, 4])(
    'retains borrowed counter availability without inventing a provider ID: %s',
    (count) => {
      const normalized = accounting('borrowed-availability');
      normalized.payload.usage = { cache_write_input_tokens: count ?? 0 };
      normalized.payload.turn_token_usage = {
        cache_write_input_tokens: count ?? 0,
      };
      const turn = project([
        observed(
          'borrowed-availability',
          count === undefined ? {} : { cache_write_input_tokens: count },
          { response_id: null },
        ),
        normalized,
      ]);
      expect(turn.usage).not.toBeNull();
      expect(turn.usage?.inputTokensDetails.cacheWriteTokens).toBe(count);
      expect(turn.responses?.[0].responseId).toBeNull();
      expect(turn.responses?.[0].usage).toEqual(
        count === undefined
          ? {}
          : { inputTokensDetails: { cacheWriteTokens: count } },
      );
      const restored = recordedTurnFromWire(recordedTurnToWire(turn));
      expect(restored.responses?.[0].usage).toEqual(turn.responses?.[0].usage);
      expect(restored.usage?.inputTokensDetails.cacheWriteTokens).toBe(count);
    },
  );

  it.each([true, false])(
    'withholds a borrowed mixed total when the omitted peer is first: %s',
    (omittedFirst) => {
      const first = accounting('first-borrowed');
      const second = accounting('second-borrowed');
      first.payload.usage = { cache_write_input_tokens: omittedFirst ? 0 : 2 };
      first.payload.turn_token_usage = {
        cache_write_input_tokens: omittedFirst ? 0 : 2,
      };
      second.payload.usage = { cache_write_input_tokens: omittedFirst ? 2 : 0 };
      second.payload.turn_token_usage = { cache_write_input_tokens: 2 };
      const turn = project([
        observed(
          'first-borrowed',
          omittedFirst ? {} : { cache_write_input_tokens: 2 },
          { response_id: null },
        ),
        first,
        observed(
          'second-borrowed',
          omittedFirst ? { cache_write_input_tokens: 2 } : {},
          { response_id: null },
        ),
        second,
      ]);
      expect(turn.usage).not.toBeNull();
      expect(turn.usage?.inputTokensDetails).not.toHaveProperty(
        'cacheWriteTokens',
      );
      expect(turn.responses).toHaveLength(2);
      expect(
        turn.responses?.every((response) => response.responseId === null),
      ).toBe(true);
      expect(
        recordedTurnFromWire(recordedTurnToWire(turn)).usage
          ?.inputTokensDetails,
      ).not.toHaveProperty('cacheWriteTokens');
    },
  );

  it('keeps received cache-write availability through normalized totals and portable history', () => {
    for (const cacheWrite of [undefined, 0, 4]) {
      const normalized = accounting('availability');
      normalized.payload.turn_token_usage = {
        input_tokens: 7,
        cached_input_tokens: 2,
        cache_write_input_tokens: cacheWrite ?? 0,
        output_tokens: 2,
        total_tokens: 9,
      };
      const turn = {
        ...project([
          observed('availability', {
            input_tokens: 7,
            cached_input_tokens: 2,
            ...(cacheWrite === undefined
              ? {}
              : { cache_write_input_tokens: cacheWrite }),
          }),
          normalized,
        ]),
        receipt: {
          threadId: 'session',
          turnId: 't',
          model: 'gpt-5.5',
          reasoningEffort: null,
          instructionRevision: null,
          developerInstructionsSha256: null,
          instructionFiles: [],
          userConfigApplied: true,
          codexRevision: CODEX_REVISION,
          codexSourceTree: CODEX_REVISION,
          approvalPolicy: 'never' as const,
          executors: [],
        },
        parentSessionId: 'parent',
        parentTurnId: 'parent-turn',
      };
      const expected = {
        cachedTokens: 2,
        ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
      };
      expect(turn.usage?.inputTokensDetails).toEqual(expected);
      const wire = repairTurnWireSchema.parse(
        JSON.parse(JSON.stringify(recordedTurnToWire(turn))),
      );
      expect(recordedTurnFromWire(wire)).toEqual(turn);
      const wrongTurn = {
        ...wire,
        responses: wire.responses?.map((response) => ({
          ...response,
          turnId: 'contradictory-turn',
        })),
      };
      expect(repairTurnWireSchema.safeParse(wrongTurn).success).toBe(false);
    }
    const failed = observed('unlinked-failure', {}, { status: 'failed' });
    const success = observed('linked-success', { cache_write_input_tokens: 4 });
    const successfulAccounting = accounting('linked-success');
    successfulAccounting.payload.turn_token_usage = {
      cache_write_input_tokens: 4,
    };
    expect(
      project([failed, success, successfulAccounting]).usage?.inputTokensDetails
        .cacheWriteTokens,
    ).toBe(4);
    const partial = accounting('known');
    partial.payload.turn_token_usage = { cache_write_input_tokens: 4 };
    for (const observations of [
      [
        observed('unknown', {}),
        observed('known', { cache_write_input_tokens: 4 }),
      ],
      [
        observed('known', { cache_write_input_tokens: 4 }),
        observed('unknown', {}),
      ],
    ]) {
      expect(
        project([...observations, accounting('unknown'), partial]).usage
          ?.inputTokensDetails,
      ).not.toHaveProperty('cacheWriteTokens');
    }
  });

  it('keeps upstream request IDs distinct from response body IDs and preserves legacy history', () => {
    const turn = {
      ...project([
        observed(
          'identified',
          { input_tokens: 7, total_tokens: 9 },
          {
            response_id: 'body-response',
            upstream_request_id: 'transport-request',
          },
        ),
        accounting('identified'),
        observed('unknown-request', null, { response_id: null }),
      ]),
      parentSessionId: 'parent',
      parentTurnId: 'parent-turn',
    };
    const responses = turn.responses ?? [];
    expect(responses).toHaveLength(2);
    expect(responses[0]).toMatchObject({
      responseId: 'body-response',
      upstreamRequestId: 'transport-request',
      usage: { inputTokens: 7, totalTokens: 9 },
    });
    expect(responses[1]).toMatchObject({ responseId: null, usage: null });
    expect(responses[1]).not.toHaveProperty('upstreamRequestId');
    const wire = repairTurnWireSchema.parse(
      JSON.parse(JSON.stringify(recordedTurnToWire(turn))),
    );
    expect(wire.responses?.[0].upstreamRequestId).toBe('transport-request');
    expect(recordedTurnFromWire(wire)).toEqual(turn);
    const legacy = structuredClone(wire);
    delete legacy.responses![0].upstreamRequestId;
    const restored = recordedTurnFromWire(repairTurnWireSchema.parse(legacy));
    expect(restored.responses?.[0].responseId).toBe('body-response');
    expect(restored.responses?.[0]).not.toHaveProperty('upstreamRequestId');
    expect(restored.usage).toEqual(turn.usage);
  });

  it('preserves optional received counters, exact counts and absent whole usage', () => {
    const turn = project([
      observed('o1', { input_tokens: large, cached_input_tokens: 0 }),
      accounting('o1'),
      observed('o2', null, { response_id: null }),
      observed('o3', {}),
    ]);
    expect(turn.responses).toEqual([
      {
        id: 'o1',
        threadId: 'origin-thread',
        turnId: 't',
        responseId: 'reused-provider-id',
        status: 'completed',
        usageSource: 'received',
        usage: {
          inputTokens: 9007199254740993n,
          inputTokensDetails: { cachedTokens: 0 },
        },
      },
      {
        id: 'o2',
        threadId: 'origin-thread',
        turnId: 't',
        responseId: null,
        status: 'completed',
        usageSource: 'received',
        usage: null,
      },
      {
        id: 'o3',
        threadId: 'origin-thread',
        turnId: 't',
        responseId: 'reused-provider-id',
        status: 'completed',
        usageSource: 'received',
        usage: {},
      },
    ]);
    expect(turn.usage?.totalTokens).toBe(18);
    const wire = recordedTurnToWire(turn);
    expect(wire.responses?.[0].usage?.inputTokens).toBe(large);
    expect(JSON.parse(JSON.stringify(wire))).toEqual(wire);
    expect(recordedTurnFromWire(wire)).toEqual(turn);
    expect(project([])).not.toHaveProperty('responses');
  });

  it('matches accounting by exact observation link and retains occurrence order', () => {
    const old = accounting();
    const fresh = observed('new', { total_tokens: 9 });
    const missing = accounting('missing-observation');
    const records = [old, fresh, accounting('new'), old, missing];
    const responses = project(records).responses!;
    expect(responses.map((row) => [row.id, row.usageSource])).toEqual([
      [null, 'native_normalized'],
      ['new', 'received'],
      [null, 'native_normalized'],
      ['missing-observation', 'native_normalized'],
    ]);
    expect(responses[0]).not.toHaveProperty('status');
    expect(responses[0]).not.toHaveProperty('incompleteReason');
    expect(responses[0].usage?.inputTokens).toBe(7);
    expect(
      project([
        ...records,
        fresh,
        {
          type: 'compacted',
          payload: { latest_token_usage_record: accounting('new').payload },
        },
      ]).responses,
    ).toEqual(responses);
    // Projecting inherited history must not replace its native origin with the SDK session ID.
    expect(
      projectHistory([...start, ...records, ...finish], 'fork').turns[0]
        .responses,
    ).toEqual(responses);
    expect(project(records).responses).toEqual(responses);
  });

  it('deduplicates linked accounting fallbacks and preserves unlinked occurrences', () => {
    const records = [
      accounting('missing-observation'),
      accounting(),
      accounting('missing-observation'),
      accounting('received-observation'),
      accounting(),
      observed('received-observation', { total_tokens: 9 }),
    ];
    const turn = project(records);
    expect(
      turn.responses?.map(({ id, usageSource }) => [id, usageSource]),
    ).toEqual([
      ['missing-observation', 'native_normalized'],
      [null, 'native_normalized'],
      [null, 'native_normalized'],
      ['received-observation', 'received'],
    ]);
    expect(turn.usage).toEqual(project([accounting()]).usage);
  });

  it('retains provider terminal facts independently of SDK failure', () => {
    for (const status of ['completed', 'incomplete', 'failed']) {
      const turn = project([
        observed(
          'o',
          { total_tokens: 0 },
          {
            status,
            incomplete_reason:
              status === 'incomplete' ? 'max_output_tokens' : null,
          },
        ),
        {
          type: 'event_msg',
          payload: {
            type: 'error',
            turn_id: 't',
            message: 'fixture rejection',
          },
        },
      ]);
      expect(turn.status).toBe('failed');
      expect(turn.responses?.[0].status).toBe(status);
      expect(turn.responses?.[0].usage?.totalTokens).toBe(0);
    }
    expect(
      project([
        { type: 'event_msg', payload: { type: 'error', turn_id: 't' } },
      ]),
    ).not.toHaveProperty('responses');
  });

  it('removes response observations and link indexes with rolled-back turns', () => {
    const history: ThreadHistory = [
      ...start,
      observed('same', { total_tokens: 1 }),
      accounting('same'),
      ...finish,
      {
        type: 'event_msg',
        payload: { type: 'thread_rolled_back', num_turns: 1 },
      },
      ...start,
      observed('same', { total_tokens: 2 }),
      accounting('same'),
      ...finish,
    ];
    expect(projectHistory(history, 'session').turns[0].responses).toHaveLength(
      1,
    );
    expect(
      projectHistory(history, 'session').turns[0].responses?.[0].usage
        ?.totalTokens,
    ).toBe(2);
  });

  it('strictly validates repair response wire counters while accepting old receipts', () => {
    const turn = {
      ...recordedTurnToWire(project([observed('o', { total_tokens: large })])),
      parentSessionId: 'parent',
      parentTurnId: 'parent-turn',
    };
    expect(repairTurnWireSchema.parse(turn)).toEqual(turn);
    const { responses: _responses, ...legacy } = turn;
    expect(repairTurnWireSchema.parse(legacy)).toEqual(legacy);
    for (const counter of ['01', '-1', 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const invalid = structuredClone(turn);
      invalid.responses![0].usage!.totalTokens = counter;
      expect(repairTurnWireSchema.safeParse(invalid).success).toBe(false);
    }
    expect(
      repairTurnWireSchema.safeParse({
        ...turn,
        responses: [{ ...turn.responses![0], rawProviderError: 'private' }],
      }).success,
    ).toBe(false);
  });
});
