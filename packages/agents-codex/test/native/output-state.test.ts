import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent, NativeProvider } from '../../src';
import { recordedTurnFromWire } from '../../src/runtime/history';
import { prepareOutput } from '../../src/runtime/output';
import {
  copyJsonValue,
  losslessJsonValueSchema,
  encode,
  encodeReceipt,
  jsonObject,
  parseNative,
  type JsonObject,
  type JsonValue,
} from '../../src/runtime/binding';
import {
  CODEX_REVISION,
  fromNativeCheckpoint,
  isManualSessionState,
  parseNativeCheckpoint,
  assertOutputState,
  nativeCheckpoint,
  parseSessionState,
  withOutputState,
  sessionStateSchema,
  type NativeCheckpoint,
  type SessionState,
} from '../../src/runtime/state';

const root = (id = 'root') =>
  parseSessionState(
    JSON.stringify({
      format_version: 2,
      codex_revision: CODEX_REVISION,
      source_session_id: id,
      history: [],
      root_metadata: {},
    }),
  );
const pending = () =>
  parseSessionState(
    JSON.stringify({
      ...root(),
      format_version: 3,
      manual_continuation: {
        turn_id: 'parent-turn',
        reply_order: ['call'],
        accepted_replies: {},
        pending_manual: [{ call_id: 'call', name: 'lookup', arguments: '{}' }],
      },
      manual_context: { instructions: null, result_schemas: [], usage: null },
    }),
  );
const prompted = () =>
  prepareOutput({ mode: 'prompted', schema: z.object({ label: z.string() }) });
const roundTrip = (value: unknown) => parseSessionState(JSON.stringify(value));

afterEach(() => vi.restoreAllMocks());

describe('portable output contract', () => {
  it('keeps omitted, undefined and zero prompted retry budgets equivalent', () => {
    const schema = z.object({ label: z.string() });
    const omitted = prepareOutput({ mode: 'prompted', schema });
    for (const maxRetries of [undefined, 0]) {
      const prepared = prepareOutput({ mode: 'prompted', schema, maxRetries });
      expect(prepared.identity).toEqual(omitted.identity);
      expect(prepared.identity.budget).toBe(0);
      expect(prepared.prompt).toBe(omitted.prompt);
      expect(prepared).not.toHaveProperty('repair');
      expect(prepared.parse?.('{"label":"valid"}')).toEqual({ label: 'valid' });
    }
    expect(omitted).not.toHaveProperty('repair');
  });

  it('captures the prompted repair schema, parser and budget with its output identity', () => {
    const output = {
      mode: 'prompted' as const,
      schema: z.object({ label: z.string().min(2) }),
      maxRetries: 2,
    };
    const captured = prepareOutput(output);
    output.maxRetries = 5;
    output.schema = z.object({ label: z.string().min(5) });
    expect(captured.identity.budget).toBe(2);
    expect(captured.repair).toMatchObject({
      maxRetries: 2,
      schema: {
        type: 'object',
        properties: { label: { type: 'string', minLength: 2 } },
      },
    });
    expect(captured.schema).toBeUndefined();
    expect(captured.parse?.('{"label":"ok"}')).toEqual({ label: 'ok' });
    expect(() => captured.parse?.('{"label":"x"}')).toThrow('did not match');
    const same = prepareOutput({
      mode: 'prompted',
      schema: z.object({ label: z.string().min(2) }),
      maxRetries: 2,
    });
    expect(captured.identity).toEqual(same.identity);
    const saved = roundTrip(withOutputState(root(), captured.identity));
    expect(() => assertOutputState(saved, same.identity)).not.toThrow();
    expect(() =>
      assertOutputState(saved, prepareOutput(output).identity),
    ).toThrow('matching current output contract');
    for (const maxRetries of [0, 1])
      expect(captured.identity.fingerprint).not.toBe(
        prepareOutput({
          mode: 'prompted',
          schema: z.object({ label: z.string().min(2) }),
          maxRetries,
        }).identity.fingerprint,
      );
    expect(prepareOutput(output).identity).not.toEqual(captured.identity);
  });

  it('captures a positive retry budget once and preserves direct transformed parsing', () => {
    const maxRetries = vi.fn(() => 1);
    const prepared = prepareOutput({
      mode: 'prompted',
      schema: z.string().transform((value) => value.length),
      get maxRetries() {
        return maxRetries();
      },
    });
    expect(maxRetries).toHaveBeenCalledTimes(1);
    expect(prepared.repair?.schema).toMatchObject({ type: 'string' });
    expect(prepared.repair?.maxRetries).toBe(1);
    expect(prepared.parse?.('"hello"')).toBe(5);
    expect(prepared.prompt).not.toContain('"response"');
  });

  it('captures schema meaning independently of the schema instance and distinguishes modes', () => {
    const first = prompted();
    expect(first.identity).toEqual(prompted().identity);
    expect(first.identity.budget).toBe(0);
    expect(Object.isFrozen(first.identity)).toBe(true);
    expect(first.identity).not.toEqual(
      prepareOutput({ mode: 'native', schema: z.object({ label: z.string() }) })
        .identity,
    );
    expect(first.identity).not.toEqual(
      prepareOutput({
        mode: 'prompted',
        schema: z.object({ label: z.string().min(2) }),
      }).identity,
    );
    expect(prepareOutput(z.string()).identity).toEqual(
      prepareOutput(undefined).identity,
    );
    expect(prepareOutput(z.string().min(5)).identity).not.toEqual(
      prepareOutput(undefined).identity,
    );
  });

  it('preserves ordinary parsing and native-only schema delivery across output modes', () => {
    const schema = z.string().min(2);
    const plain = prepareOutput(z.string());
    const native = prepareOutput({ mode: 'native', schema });
    const prompted = prepareOutput({ mode: 'prompted', schema });
    expect(prepareOutput(schema).identity.mode).toBe('native');
    expect(plain.parse?.('ok')).toBe('ok');
    expect(native.parse?.('{"response":"ok"}')).toBe('ok');
    expect(prompted.parse?.('"ok"')).toBe('ok');
    expect(plain.schema).toBeUndefined();
    expect(prompted.schema).toBeUndefined();
    expect(native.schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['response'],
    });
    expect(plain.prompt).toBeUndefined();
    expect(prompted.prompt).toContain('Return only JSON');
    expect(() => native.parse?.('{"response":"x"}')).toThrow('did not match');
    expect(() => prompted.parse?.('not JSON')).toThrow('did not match');
  });

  it('distinguishes declared scalar output from an explicit response object with the same wire schema', () => {
    const scalar = prepareOutput(z.number());
    const object = prepareOutput(z.object({ response: z.number() }));
    expect(scalar.schema).toEqual(object.schema);
    expect(scalar.parse?.('{"response":7}')).toBe(7);
    expect(object.parse?.('{"response":7}')).toEqual({ response: 7 });
    expect(scalar.identity).not.toEqual(object.identity);
  });

  it('retains declared defaults before strict native schema normalization', () => {
    const defaulted = prepareOutput(z.object({ count: z.number().default(1) }));
    const required = prepareOutput(z.object({ count: z.number() }));
    expect(defaulted.schema).toEqual(required.schema);
    expect(defaulted.parse?.('{}')).toEqual({ count: 1 });
    expect(() => required.parse?.('{}')).toThrow('did not match');
    expect(defaulted.identity).not.toEqual(required.identity);
  });

  it.each([
    {
      direction: 'scalar to response object',
      saved: z.number(),
      restored: z.object({ response: z.number() }),
    },
    {
      direction: 'response object to scalar',
      saved: z.object({ response: z.number() }),
      restored: z.number(),
    },
  ])(
    'rejects idle $direction restore before provider acquisition',
    async ({ saved, restored }) => {
      await using provider = new NativeProvider();
      const acquire = vi.spyOn(provider, '_acquire').mockImplementation(() => {
        throw new Error('Provider acquisition must not run');
      });
      const state = withOutputState(
        root(),
        prepareOutput<unknown>(saved).identity,
      );
      await expect(
        new Agent<undefined, unknown>({
          instructions: 'Answer.',
          provider,
          outputType: restored,
        }).session({ state }),
      ).rejects.toThrow('matching current output contract');
      expect(acquire).not.toHaveBeenCalled();
    },
  );

  it('rejects standalone malformed state before provider acquisition', async () => {
    await using provider = new NativeProvider();
    const acquire = vi.spyOn(provider, '_acquire').mockImplementation(() => {
      throw new Error('Provider acquisition must not run');
    });
    await expect(
      new Agent({ instructions: 'Answer.', provider }).session({
        state: {} as never,
      }),
    ).rejects.toBeInstanceOf(z.ZodError);
    expect(acquire).not.toHaveBeenCalled();
  });

  it('normalizes an omitted zero budget and refuses changed contracts', () => {
    const output = prompted();
    const state = withOutputState(root(), output.identity);
    const omitted = JSON.parse(JSON.stringify(state));
    delete omitted.output_context.budget;
    expect(() =>
      assertOutputState(roundTrip(omitted), output.identity),
    ).not.toThrow();
    for (const replacement of [
      { ...output.identity, budget: 1 },
      prepareOutput(undefined).identity,
      prepareOutput({ mode: 'prompted', schema: z.number() }).identity,
    ])
      expect(() => assertOutputState(state, replacement)).toThrow(
        'matching current output contract',
      );
  });

  it.each(['mode', 'schema', 'budget'])(
    'rejects a %s mismatch before acquiring a provider or native engine',
    async (kind) => {
      await using provider = new NativeProvider();
      const acquire = vi.spyOn(provider, '_acquire').mockImplementation(() => {
        throw new Error('Provider acquisition must not run');
      });
      const identity = prompted().identity;
      const state = withOutputState(
        pending(),
        kind === 'budget' ? { ...identity, budget: 1 } : identity,
      );
      const outputType =
        kind === 'mode'
          ? undefined
          : kind === 'schema'
            ? { mode: 'prompted' as const, schema: z.number() }
            : {
                mode: 'prompted' as const,
                schema: z.object({ label: z.string() }),
              };
      await expect(
        new Agent<undefined, unknown>({
          instructions: 'Ask.',
          provider,
          outputType,
        }).session({ state }),
      ).rejects.toThrow('matching current output contract');
      expect(acquire).not.toHaveBeenCalled();
    },
  );

  it('preserves legacy formats and strips only SDK fields before native restore', () => {
    for (const state of [root(), pending()]) {
      expect(roundTrip(state)).toEqual(state);
      expect(() => assertOutputState(state, prompted().identity)).not.toThrow();
      const captured = withOutputState(state, prompted().identity);
      expect(captured.format_version).toBe(state.format_version === 3 ? 5 : 4);
      expect(nativeCheckpoint(captured)).toEqual(nativeCheckpoint(state));
      expect(nativeCheckpoint(captured)).not.toHaveProperty('output_context');
      expect(nativeCheckpoint(captured)).not.toHaveProperty(
        'manual_continuation',
      );
      expect(nativeCheckpoint(captured)).not.toHaveProperty('repair_turns');
    }
  });

  it('rejects output-aware fields in legacy envelopes', () => {
    expect(() =>
      roundTrip({ ...root(), output_context: prompted().identity }),
    ).toThrow();
  });

  it('retains the current native output contract for a pending manual continuation', () => {
    const output = prepareOutput({ mode: 'native', schema: z.number() });
    const state = withOutputState(pending(), output.identity);
    expect(state.format_version).toBe(5);
    expect(() => assertOutputState(state, output.identity)).not.toThrow();
    expect(() =>
      assertOutputState(state, prepareOutput(undefined).identity),
    ).toThrow('matching current output');
    expect(nativeCheckpoint(state)).toEqual(nativeCheckpoint(pending()));
  });
});

describe('passive repair receipts', () => {
  const turn = (id: string) => ({
    id,
    object: 'agent.session.turn',
    sessionId: 'attempt-session',
    subagentId: null,
    status: 'completed',
    createdAt: null,
    startedAt: null,
    completedAt: null,
    error: null,
    usage: null,
    parentSessionId: 'root',
    parentTurnId: 'parent-turn',
  });
  const receipt = () =>
    roundTrip({
      ...withOutputState(root(), prompted().identity),
      repair_turns: [
        turn('attempt-1'),
        {
          ...turn('attempt-2'),
          usage: {
            inputTokens: '9007199254740993',
            inputTokensDetails: { cachedTokens: 0 },
            outputTokens: 2,
            outputTokensDetails: { reasoningTokens: 0 },
            totalTokens: '9007199254740995',
          },
        },
      ],
      repair_items: [
        {
          parentSessionId: 'root',
          parentTurnId: 'parent-turn',
          sessionId: 'attempt-session',
          item: {
            id: 'attempt-item',
            turnId: 'attempt-2',
            type: 'message',
            text: 'observations only',
            generation: '9007199254740993',
          },
        },
      ],
    });

  it('round-trips exact and missing usage without placing attempt data in native history', () => {
    const state = receipt();
    expect(roundTrip(state)).toEqual(state);
    if (state.format_version !== 4)
      throw new Error('Expected output-aware idle state');
    expect(state.repair_turns[0].usage).toBeNull();
    expect(state.repair_turns[1].usage?.inputTokens).toBe('9007199254740993');
    expect(recordedTurnFromWire(state.repair_turns[1]).usage?.inputTokens).toBe(
      9007199254740993n,
    );
    expect(nativeCheckpoint(state)).toEqual(nativeCheckpoint(root()));
    expect(state.history).toEqual([]);
  });

  it('captures the complete current repair snapshot without duplicating prior receipts', () => {
    const prior = receipt();
    if (prior.format_version !== 4)
      throw new Error('Expected output-aware idle state');
    const repairs = {
      turns: [
        ...prior.repair_turns,
        {
          ...prior.repair_turns[0],
          id: 'new-attempt',
          sessionId: 'new-attempt-session',
          parentTurnId: 'later-parent',
        },
      ],
      items: [
        ...prior.repair_items,
        {
          ...prior.repair_items[0],
          sessionId: 'new-attempt-session',
          parentTurnId: 'later-parent',
          item: {
            ...prior.repair_items[0].item,
            id: 'new-item',
            turnId: 'new-attempt',
          },
        },
      ],
    };
    const before = JSON.stringify({ prior, repairs });
    const state = withOutputState(
      root('forked-root'),
      prompted().identity,
      prior,
      repairs,
    );
    if (state.format_version !== 4)
      throw new Error('Expected output-aware idle state');
    expect(state.repair_turns).toEqual(
      repairs.turns.map((turn) => ({
        ...turn,
        parentSessionId: 'forked-root',
      })),
    );
    expect(state.repair_items).toEqual(
      repairs.items.map((item) => ({
        ...item,
        parentSessionId: 'forked-root',
      })),
    );
    expect(state.repair_turns).toHaveLength(3);
    expect(state.repair_items).toHaveLength(2);
    expect(state.repair_turns[0].usage).toBeNull();
    expect(state.repair_turns[1].usage?.totalTokens).toBe('9007199254740995');
    expect(state.repair_items[0].item.generation).toBe('9007199254740993');
    expect(roundTrip(state)).toEqual(state);
    expect(nativeCheckpoint(state)).toEqual(
      nativeCheckpoint(root('forked-root')),
    );
    state.repair_turns[0].id = 'caller mutation';
    state.repair_items[0].item.text = 'caller mutation';
    state.repair_turns.pop();
    state.repair_items.pop();
    expect(JSON.stringify({ prior, repairs })).toBe(before);
  });

  it('uses an explicitly empty current snapshot instead of prior receipts', () => {
    const prior = receipt();
    const state = withOutputState(prior, prompted().identity, prior, {
      turns: [],
      items: [],
    });
    if (state.format_version !== 4)
      throw new Error('Expected output-aware idle state');
    expect(state.repair_turns).toEqual([]);
    expect(state.repair_items).toEqual([]);
  });

  it('preserves manual continuation fields when capturing current repairs', () => {
    const prior = receipt();
    if (prior.format_version !== 4)
      throw new Error('Expected output-aware idle state');
    const repairs = { turns: prior.repair_turns, items: prior.repair_items };
    for (const source of [
      pending(),
      withOutputState(pending(), prompted().identity),
    ]) {
      const state = withOutputState(source, prompted().identity, null, repairs);
      if (state.format_version !== 5)
        throw new Error('Expected output-aware manual state');
      expect(state).toMatchObject({
        manual_continuation: {
          turn_id: 'parent-turn',
          reply_order: ['call'],
          accepted_replies: {},
          pending_manual: [
            { call_id: 'call', name: 'lookup', arguments: '{}' },
          ],
        },
        manual_context: { instructions: null, result_schemas: [], usage: null },
        repair_turns: prior.repair_turns,
        repair_items: prior.repair_items,
      });
      expect(roundTrip(state)).toEqual(state);
      expect(nativeCheckpoint(state)).toEqual(nativeCheckpoint(source));
    }
  });

  it('validates supplied current receipts with the existing checkpoint rules', () => {
    const prior = receipt();
    if (prior.format_version !== 4)
      throw new Error('Expected output-aware idle state');
    expect(() =>
      withOutputState(root(), prompted().identity, prior, {
        turns: [...prior.repair_turns, prior.repair_turns[0]],
        items: prior.repair_items,
      }),
    ).toThrow();
  });

  it('retargets only parent root identity for a new root and detaches caller-owned copies', () => {
    const source = receipt();
    const before = JSON.stringify(source);
    const forked = withOutputState(
      root('forked-root'),
      prompted().identity,
      source,
    );
    if (forked.format_version !== 4)
      throw new Error('Expected output-aware idle state');
    expect(forked.repair_turns.map((entry) => entry.parentSessionId)).toEqual([
      'forked-root',
      'forked-root',
    ]);
    expect(forked.repair_turns.map((entry) => entry.sessionId)).toEqual([
      'attempt-session',
      'attempt-session',
    ]);
    expect(forked.repair_items[0]).toMatchObject({
      parentSessionId: 'forked-root',
      parentTurnId: 'parent-turn',
      item: { id: 'attempt-item', turnId: 'attempt-2' },
    });
    forked.repair_items[0].item.text = 'caller mutation';
    expect(JSON.stringify(source)).toBe(before);
    expect(nativeCheckpoint(forked)).toEqual(
      nativeCheckpoint(root('forked-root')),
    );
  });

  it('retains reused item IDs across legitimate turn and call/output scopes', () => {
    const state = receipt();
    if (state.format_version !== 4)
      throw new Error('Expected output-aware idle state');
    const original = state.repair_items[0];
    const repeated = roundTrip({
      ...state,
      repair_items: [
        original,
        { ...original, item: { ...original.item, turnId: 'attempt-1' } },
        {
          ...original,
          item: {
            ...original.item,
            id: 'call-item',
            type: 'function_call',
            callId: 'call',
            name: 'lookup',
            arguments: '{}',
          },
        },
        {
          ...original,
          item: {
            ...original.item,
            id: 'call-item',
            type: 'function_call_output',
            callId: 'call',
            output: 'value',
          },
        },
      ],
    });
    if (repeated.format_version !== 4)
      throw new Error('Expected output-aware idle state');
    expect(repeated.repair_items).toHaveLength(4);
    expect(repeated.repair_items.map((entry) => entry.item.id)).toEqual([
      original.item.id,
      original.item.id,
      'call-item',
      'call-item',
    ]);
    expect(nativeCheckpoint(repeated)).toEqual(nativeCheckpoint(root()));
  });

  it('rejects duplicate attempts, mismatched item ownership and inexact counters', () => {
    const state = receipt();
    if (state.format_version !== 4)
      throw new Error('Expected output-aware idle state');
    expect(() =>
      roundTrip({
        ...state,
        repair_turns: [state.repair_turns[0], state.repair_turns[0]],
      }),
    ).toThrow();
    expect(() =>
      roundTrip({
        ...state,
        repair_items: [
          { ...state.repair_items[0], sessionId: 'unrecorded-attempt' },
        ],
      }),
    ).toThrow();
    expect(() =>
      roundTrip({
        ...state,
        repair_turns: [
          {
            ...state.repair_turns[1],
            usage: {
              ...state.repair_turns[1].usage,
              inputTokens: 9007199254740992,
            },
          },
        ],
      }),
    ).toThrow();
  });
});

const vmSnapshot = (next = '2') => ({
  format_version: 1,
  next_cell_id: next,
  stored_values: {
    result: { count: 41 },
    application: { next_cell_id: '9007199254740993', generation: 7 },
  },
  completed_cells: {
    '1': {
      public_cell_id: 'g2:1',
      pending_initial_yield_items: [{ Text: { text: 'committed' } }],
      event: { Completed: { content_items: [], error_text: null } },
    },
  },
});
const vmNative = () => ({
  format_version: 4,
  codex_revision: CODEX_REVISION,
  source_session_id: 'root',
  history: [],
  root_metadata: { _sdk_default_tools: [{ name: 'lookup' }] },
  root_code_mode: vmSnapshot(),
  root_goal: {
    thread_id: 'root',
    objective: 'Preserve committed work',
    status: 'paused',
  },
  root_turn_budget: {
    turn_id: 'turn',
    admitted: '1',
    limit: '9007199254740993',
  },
  descendants: [
    {
      status: 'closed',
      thread_id: 'child',
      parent_thread_id: 'root',
      metadata: {},
      history: [],
      code_mode: vmSnapshot(),
    },
  ],
});
const vmPlain = prepareOutput(undefined);
const readVm = (value: unknown) => parseNativeCheckpoint(encodeReceipt(value));

it('refuses an unfingerprinted legacy manual checkpoint with a native output schema before provider acquisition', async () => {
  const provider = new NativeProvider();
  const acquire = vi.spyOn(provider, '_acquire');
  const agent = new Agent({
    instructions: 'Ask.',
    provider,
    outputType: {
      mode: 'native',
      schema: z.strictObject({ answer: z.string() }),
    },
  });
  await expect(agent.session({ state: pending() })).rejects.toThrow(
    'legacy pending manual',
  );
  expect(acquire).not.toHaveBeenCalled();
});

describe('settled checkpoint codec', () => {
  it('distinguishes native format4 from an SDK output envelope', () => {
    const saved = readVm(vmNative());
    expect(() => parseSessionState(encodeReceipt(vmNative()))).toThrow();
    const state = fromNativeCheckpoint(saved, vmPlain.identity);
    expect(state.format_version).toBe(6);
    expect(state.output_context).toEqual(vmPlain.identity);
    expect(() => parseNativeCheckpoint(state)).toThrow();
    expect(() =>
      parseNativeCheckpoint(withOutputState(root(), vmPlain.identity)),
    ).toThrow('SDK envelope');
    expect(() => assertOutputState(state, vmPlain.identity)).not.toThrow();
  });

  it('round trips exact root and descendant counters without rewriting stored application values', () => {
    const input = vmNative();
    input.root_code_mode.next_cell_id = '18446744073709551615';
    input.descendants[0].code_mode.next_cell_id = '9007199254740993';
    const saved = readVm(input);
    const state = fromNativeCheckpoint(saved, vmPlain.identity);
    const restored = parseSessionState(JSON.stringify(state));
    const raw = nativeCheckpoint(restored);
    expect(raw.format_version).toBe(4);
    expect(readVm(raw)).toEqual(saved);
    expect(state.root_code_mode?.stored_values).toEqual(
      input.root_code_mode.stored_values,
    );
    expect(state.root_goal).toEqual(input.root_goal);
    expect(state.root_turn_budget).toEqual(input.root_turn_budget);
    expect(state.root_metadata).toEqual(input.root_metadata);
    expect(withOutputState(restored, vmPlain.identity).format_version).toBe(6);
    expect(encodeReceipt(raw)).toContain('"next_cell_id":18446744073709551615');
    expect(encodeReceipt(raw)).toContain(
      '"application":{"next_cell_id":"9007199254740993","generation":7}',
    );
  });

  it('retains exact counters inside a native manual-seal receipt', () => {
    const input = vmNative();
    input.root_code_mode.next_cell_id = '9007199254740993';
    const wire = `{"checkpoint":${encodeReceipt(input)},"manual_continuation":{}}`;
    const value = parseNative(wire) as { checkpoint: unknown };
    const saved = parseNativeCheckpoint(value.checkpoint);
    expect(saved.root_code_mode?.next_cell_id).toBe('9007199254740993');
    expect(saved.root_turn_budget?.limit).toBe('9007199254740993');
  });

  it.each([2, 3, 4, 5])(
    'refuses VM data in legacy public format%s instead of dropping child state',
    (format) => {
      const base = format === 3 || format === 5 ? pending() : root();
      const state =
        format === 4 || format === 5
          ? withOutputState(base, vmPlain.identity)
          : base;
      expect(state.format_version).toBe(format);
      expect(() =>
        parseSessionState(
          JSON.stringify({ ...state, root_code_mode: vmSnapshot() }),
        ),
      ).toThrow('CodeMode state requires');
      expect(() =>
        parseSessionState(
          JSON.stringify({ ...state, descendants: vmNative().descendants }),
        ),
      ).toThrow('CodeMode state requires');
      expect(() => readVm({ ...vmNative(), format_version: 2 })).toThrow(
        'requires format_version=4',
      );
    },
  );

  it.each([
    [
      'zero counter',
      (value: ReturnType<typeof vmNative>) => {
        value.descendants[0].code_mode.next_cell_id = '0';
      },
    ],
    [
      'overflow counter',
      (value: ReturnType<typeof vmNative>) => {
        value.descendants[0].code_mode.next_cell_id = '18446744073709551616';
      },
    ],
    [
      'reused counter',
      (value: ReturnType<typeof vmNative>) => {
        value.descendants[0].code_mode.next_cell_id = '1';
      },
    ],
    [
      'changed public identity',
      (value: ReturnType<typeof vmNative>) => {
        value.descendants[0].code_mode.completed_cells['1'].public_cell_id =
          'g2:2';
      },
    ],
    [
      'noncanonical generation',
      (value: ReturnType<typeof vmNative>) => {
        value.descendants[0].code_mode.completed_cells['1'].public_cell_id =
          'g02:1';
      },
    ],
  ] as const)('validates closed descendants too: %s', (_name, mutate) => {
    const input = vmNative();
    mutate(input);
    expect(() => readVm(input)).toThrow();
  });

  it.each(['Pending', 'Yielded'])(
    'refuses an active %s cell snapshot',
    (event) => {
      const input = vmNative();
      const child = input.descendants[0].code_mode;
      const malformed = {
        ...child,
        completed_cells: {
          '1': {
            ...child.completed_cells['1'],
            event: { [event]: { content_items: [] } },
          },
        },
      };
      expect(() =>
        readVm({
          ...input,
          descendants: [{ ...input.descendants[0], code_mode: malformed }],
        }),
      ).toThrow();
    },
  );

  it('preserves manual call identity and the active output contract in a VM envelope', () => {
    const legacy = parseSessionState(
      JSON.stringify({
        format_version: 3,
        codex_revision: CODEX_REVISION,
        source_session_id: 'root',
        history: [],
        root_metadata: {},
        manual_continuation: {
          turn_id: 'original-turn',
          reply_order: ['effect'],
          accepted_replies: {},
          pending_manual: [
            { call_id: 'effect', name: 'lookup', arguments: '{}' },
          ],
        },
        manual_context: { instructions: null, result_schemas: [], usage: null },
      }),
    );
    if (!isManualSessionState(legacy))
      throw new Error('Expected manual fixture');
    const state = fromNativeCheckpoint(
      readVm(vmNative()),
      vmPlain.identity,
      undefined,
      undefined,
      {
        manual_continuation: legacy.manual_continuation,
        manual_context: legacy.manual_context,
      },
    );
    expect(state.format_version).toBe(7);
    expect(isManualSessionState(state)).toBe(true);
    expect(state.manual_continuation).toEqual(legacy.manual_continuation);
    expect(nativeCheckpoint(state)).toEqual(
      nativeCheckpoint(
        fromNativeCheckpoint(readVm(vmNative()), vmPlain.identity),
      ),
    );
    expect(withOutputState(state, vmPlain.identity).format_version).toBe(7);
  });
});

// JSON.parse creates a real own __proto__ property, unlike an object literal.
const ownStoredValues = (): JsonObject =>
  JSON.parse(
    '{"__proto__":{"kept":true},"nested":{"__proto__":7},"array":[{"__proto__":{"deep":true}},null,true,"雪"],"constructor":{"prototype":{"data":true}},"application":{"next_cell_id":"0003","generation":7,"nonce":"007","root_code_mode":{"stored_values":{"__proto__":9}}}}',
  );
function expectOrdinaryPrototypes(value: JsonValue): void {
  if (Array.isArray(value)) {
    for (const item of value) expectOrdinaryPrototypes(item);
  } else if (value !== null && typeof value === 'object') {
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    for (const item of Object.values(value)) expectOrdinaryPrototypes(item);
  }
}
function vmStoredAt(
  state: NativeCheckpoint | SessionState,
  location: 'root' | 'descendant',
) {
  const stored =
    location === 'root'
      ? state.root_code_mode?.stored_values
      : state.descendants[0].code_mode?.stored_values;
  if (!stored) throw new Error('Expected VM stored values');
  return stored;
}

describe('lossless VM stored JSON', () => {
  it.each(['root', 'descendant'] as const)(
    'preserves own store names and nested/array object keys through the %s codec',
    (location) => {
      const input = vmNative();
      const snapshot =
        location === 'root'
          ? input.root_code_mode
          : input.descendants[0].code_mode;
      const values = ownStoredValues();
      const expected = JSON.stringify(values);
      const prototype = Object.getOwnPropertyDescriptors(Object.prototype);
      Object.assign(snapshot, { stored_values: values });
      const native = parseNativeCheckpoint(input);
      const state = fromNativeCheckpoint(native, vmPlain.identity);
      const decorated = withOutputState(state, vmPlain.identity);
      const parsed = sessionStateSchema.parse(decorated);
      const stored = parseSessionState(JSON.stringify(parsed));
      const restored = readVm(nativeCheckpoint(stored));
      for (const stage of [
        native,
        state,
        decorated,
        parsed,
        stored,
        restored,
      ]) {
        const result = vmStoredAt(stage, location);
        expect(JSON.stringify(result)).toBe(expected);
        expect(Object.hasOwn(result, '__proto__')).toBe(true);
        expectOrdinaryPrototypes(result);
      }
      expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(
        prototype,
      );
      Object.defineProperty(values, '__proto__', {
        value: 'caller mutation',
        enumerable: true,
      });
      expect(JSON.stringify(vmStoredAt(restored, location))).toBe(expected);
    },
  );

  it.each(['root', 'descendant'] as const)(
    'retains caller-mutated %s stored values before receipt normalization',
    (location) => {
      const state = fromNativeCheckpoint(readVm(vmNative()), vmPlain.identity);
      const snapshot =
        location === 'root'
          ? state.root_code_mode
          : state.descendants[0].code_mode;
      if (!snapshot) throw new Error('Expected VM snapshot');
      snapshot.stored_values = ownStoredValues();
      const expected = JSON.stringify(snapshot.stored_values);
      const restored = parseSessionState(encodeReceipt(state));
      expect(JSON.stringify(vmStoredAt(restored, location))).toBe(expected);
      expectOrdinaryPrototypes(vmStoredAt(restored, location));
    },
  );

  it('preserves VM JSON through the manual outer envelope, assembly and native encoding', () => {
    const input = vmNative();
    Object.assign(input.root_code_mode, { stored_values: ownStoredValues() });
    Object.assign(input.descendants[0].code_mode, {
      stored_values: ownStoredValues(),
    });
    input.root_code_mode.next_cell_id = '18446744073709551615';
    input.descendants[0].code_mode.next_cell_id = '9007199254740993';
    const wire = `{"checkpoint":${encodeReceipt(input)},"manual_continuation":{}}`;
    // The manual owner must defer checkpoint normalization to the native codec.
    const envelope = z
      .object({ checkpoint: z.unknown(), manual_continuation: jsonObject })
      .parse(parseNative(wire));
    const legacy = pending();
    if (!isManualSessionState(legacy))
      throw new Error('Expected manual fixture');
    const state = fromNativeCheckpoint(
      parseNativeCheckpoint(envelope.checkpoint),
      vmPlain.identity,
      undefined,
      undefined,
      {
        manual_continuation: legacy.manual_continuation,
        manual_context: legacy.manual_context,
      },
    );
    expect(state.format_version).toBe(7);
    const saved = parseSessionState(encodeReceipt(state));
    const restored = readVm(nativeCheckpoint(saved));
    const reencodedEnvelope = parseNative(
      encodeReceipt({
        checkpoint: nativeCheckpoint(saved),
        manual_continuation: {},
      }),
    ) as { checkpoint: unknown };
    expect(parseNativeCheckpoint(reencodedEnvelope.checkpoint)).toEqual(
      restored,
    );
    for (const location of ['root', 'descendant'] as const) {
      expect(JSON.stringify(vmStoredAt(restored, location))).toBe(
        JSON.stringify(ownStoredValues()),
      );
      expectOrdinaryPrototypes(vmStoredAt(restored, location));
    }
    expect(restored.root_code_mode?.next_cell_id).toBe('18446744073709551615');
    expect(restored.descendants[0].code_mode?.next_cell_id).toBe(
      '9007199254740993',
    );
    expect(restored.root_turn_budget?.limit).toBe('9007199254740993');
  });

  it('rejects own __proto__ cell IDs before normalization while preserving stored JSON names', () => {
    for (const location of ['root', 'descendant'] as const) {
      const input = vmNative();
      const snapshot =
        location === 'root'
          ? input.root_code_mode
          : input.descendants[0].code_mode;
      Object.assign(snapshot, { stored_values: ownStoredValues() });
      const valid = readVm(input);
      expect(JSON.stringify(vmStoredAt(valid, location))).toBe(
        JSON.stringify(ownStoredValues()),
      );
      const publicState = fromNativeCheckpoint(valid, vmPlain.identity);
      Object.defineProperty(snapshot.completed_cells, '__proto__', {
        value: snapshot.completed_cells['1'],
        enumerable: true,
      });
      expect(Object.hasOwn(snapshot.completed_cells, '__proto__')).toBe(true);
      expect(() => parseNativeCheckpoint(input)).toThrow(
        'Invalid retained cell ID',
      );
      expect(() => parseNativeCheckpoint(JSON.stringify(input))).toThrow(
        'Invalid retained cell ID',
      );
      expect(() => encodeReceipt(input)).toThrow('Invalid retained cell ID');
      const mutated =
        location === 'root'
          ? publicState.root_code_mode
          : publicState.descendants[0].code_mode;
      if (!mutated) throw new Error('Expected VM snapshot');
      Object.defineProperty(mutated.completed_cells, '__proto__', {
        value: mutated.completed_cells['1'],
        enumerable: true,
      });
      expect(() => sessionStateSchema.parse(publicState)).toThrow(
        'Invalid retained cell ID',
      );
      expect(() => withOutputState(publicState, vmPlain.identity)).toThrow(
        'Invalid retained cell ID',
      );
      expect(() => encodeReceipt(publicState)).toThrow(
        'Invalid retained cell ID',
      );
    }
  });

  it('validates values under own __proto__ keys instead of skipping their JSON contract', () => {
    for (const invalid of [
      undefined,
      () => 'not JSON',
      1n,
      NaN,
      Infinity,
      new Array(1),
    ]) {
      const input = vmNative();
      Object.assign(input.root_code_mode, {
        stored_values: Object.fromEntries([['__proto__', invalid]]),
      });
      expect(() => parseNativeCheckpoint(input)).toThrow();
      expect(() => encodeReceipt(input)).toThrow();
    }
  });

  it('rejects object and array ancestry cycles without overflowing or retaining parents', () => {
    const object: Record<string, unknown> = {};
    object.self = object;
    const array: unknown[] = [];
    array.push(array);
    for (const cyclic of [object, array]) {
      const parents = new Set<object>();
      expect(() => copyJsonValue(cyclic, parents)).toThrow(TypeError);
      expect(() => copyJsonValue(cyclic, parents)).toThrow('cyclic JSON');
      expect(parents.size).toBe(0);
      expect(losslessJsonValueSchema.safeParse(cyclic).success).toBe(false);
      const input = vmNative();
      Object.assign(input.root_code_mode, { stored_values: { cyclic } });
      expect(() => parseNativeCheckpoint(input)).toThrow('cyclic JSON');
      expect(() => encodeReceipt(input)).toThrow('cyclic JSON');
    }
  });

  it('accepts shared aliases and detaches each lossless JSON copy', () => {
    const alias = ownStoredValues();
    const input = { left: alias, right: alias };
    const parents = new Set<object>();
    const copied = copyJsonValue(input, parents) as JsonObject;
    expect(parents.size).toBe(0);
    expect(JSON.stringify(copied)).toBe(JSON.stringify(input));
    expect(copied.left).not.toBe(copied.right);
    expect(copied.left).not.toBe(alias);
    expectOrdinaryPrototypes(copied);
    const checkpoint = vmNative();
    Object.assign(checkpoint.root_code_mode, { stored_values: input });
    const state = fromNativeCheckpoint(
      parseNativeCheckpoint(checkpoint),
      vmPlain.identity,
    );
    const restored = parseSessionState(encodeReceipt(state));
    expect(JSON.stringify(restored.root_code_mode?.stored_values)).toBe(
      JSON.stringify(input),
    );
  });

  it('rejects non-JSON runtime objects as VM stores or nested values', () => {
    for (const invalid of [new Date(0), new Map(), new Set(), Object(7)]) {
      for (const stored_values of [invalid, { nested: invalid }]) {
        const input = vmNative();
        Object.assign(input.root_code_mode, { stored_values });
        expect(() => parseNativeCheckpoint(input)).toThrow();
        expect(() => encodeReceipt(input)).toThrow();
      }
    }
  });

  it('preserves own JSON keys and authority-shaped application data on the receipt path', () => {
    const values = ownStoredValues();
    for (const application of [
      { root_code_mode: { stored_values: values } },
      {
        arguments: {
          codex_revision: CODEX_REVISION,
          source_session_id: 'user',
          root_code_mode: { stored_values: values },
        },
      },
    ]) {
      const encoded = JSON.parse(encode(application));
      expect(encoded).toEqual(application);
      expectOrdinaryPrototypes(encoded);
      const receipt = JSON.parse(encodeReceipt(application));
      expect(receipt).toEqual(application);
      expectOrdinaryPrototypes(receipt);
      const stored =
        'arguments' in receipt
          ? receipt.arguments.root_code_mode.stored_values
          : receipt.root_code_mode.stored_values;
      expect(Object.hasOwn(stored, '__proto__')).toBe(true);
      expect(stored.application).toMatchObject({
        next_cell_id: '0003',
        generation: 7,
        nonce: '007',
      });
      expect(parseNative(JSON.stringify(application))).toEqual(application);
    }
    const state = fromNativeCheckpoint(readVm(vmNative()), vmPlain.identity);
    const expected = JSON.stringify(state.root_code_mode?.stored_values);
    expect(
      JSON.stringify(
        parseSessionState(encodeReceipt(state)).root_code_mode?.stored_values,
      ),
    ).toBe(expected);
  });
});
