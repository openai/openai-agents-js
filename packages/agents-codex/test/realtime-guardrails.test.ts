import { describe, expect, it, vi } from 'vitest';
import { Agent } from '../src/runtime/public-agent';
import {
  NativeRealtimeGuardrails,
  type NativeRealtimeGuardrailEvent,
  type NativeRealtimeGuardrailInput,
  type NativeRealtimeGuardrailResult,
} from '../src/runtime/realtime-guardrails';

const agentA = new Agent({ name: 'A', instructions: 'Agent A' });
const agentB = new Agent({ name: 'B', instructions: 'Agent B' });
const raw = (id: string, text: string) => ({
  response_id: id,
  item_id: `item-${id}`,
  output_kind: 'text',
  content_index: 0,
  output_index: 0,
  delta: text,
  text,
  profile_receipt: { profile_id: id, epoch: 1 },
});
const allowed = { tripwireTriggered: false };

function fixture(
  callback: (
    input: NativeRealtimeGuardrailInput,
  ) => NativeRealtimeGuardrailResult | Promise<NativeRealtimeGuardrailResult>,
  threshold: number | null = 1,
) {
  const events: NativeRealtimeGuardrailEvent[] = [];
  const trip = vi.fn(
    async (
      _input: NativeRealtimeGuardrailInput,
      _feedback: string | undefined,
    ) => {},
  );
  const fail = vi.fn();
  const helper = new NativeRealtimeGuardrails({
    guardrails: [
      { name: 'policy', callback, feedback: 'Please change the topic.' },
    ],
    threshold,
    source: (receipt: any) => ({
      agent: receipt.profile_id === 'A' ? agentA : agentB,
      context: { id: receipt.profile_id },
    }),
    invoke: async (run) => run(),
    trip,
    emit: (event) => events.push(event),
    fail,
  });
  return { helper, events, trip, fail };
}

describe('native Realtime guardrails', () => {
  it('bounds cumulative prefix work before the retained text limit', async () => {
    const { helper, events } = fixture(() => allowed, null);
    const fragment = 'x'.repeat(4096);
    for (let index = 0; index < 180; index++)
      helper.observe(raw('A', fragment), false);
    expect(() => helper.observe(raw('A', fragment), false)).toThrow(
      'guardrail transcript work capacity',
    );
    expect(events).toEqual([]);
    await helper.join(helper.stop());
  });

  it('retains shared prefix work while a retired callback still owns its item', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const { helper, fail } = fixture(async (input) => {
      if (input.responseId === 'A') {
        entered.resolve();
        await release.promise;
      }
      return allowed;
    });
    const fragment = 'x'.repeat(2048);
    helper.observe(raw('A', fragment), false);
    await entered.promise;
    for (let index = 1; index < 255; index++)
      helper.observe(raw('A', fragment), false);
    // Replacing the transcript must not refund work still owned by this callback.
    helper.observe(raw('A', 'final'), true);
    const retired = helper.retire(new Set(['A']));
    helper.observe(raw('B', 'b'.repeat(128 * 1024)), false);
    helper.observe(raw('B', 'b'.repeat(128 * 1024)), false);
    expect(() => helper.observe(raw('B', '!'), false)).toThrow(
      'guardrail transcript work capacity',
    );
    release.resolve();
    await helper.join(retired);
    expect(() => helper.observe(raw('B', '!'), false)).not.toThrow();
    await helper.join(helper.stop());
    expect(fail).not.toHaveBeenCalled();
  });

  it('coalesces one blocked item while another source completes independently', async () => {
    const release = Promise.withResolvers<void>();
    const seen: NativeRealtimeGuardrailInput[] = [];
    const { helper, events, fail } = fixture(async (input) => {
      seen.push(input);
      if (input.responseId === 'A' && !input.final) await release.promise;
      return allowed;
    });
    helper.observe(raw('A', 'first'), false);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    helper.observe(raw('A', '-second'), false);
    helper.observe(raw('A', 'final A'), true);
    helper.observe(raw('B', 'B'), true);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0].input.agent).toBe(agentB);
    expect(seen[0].agent).toBe(agentA);
    expect(seen[0].text).toBe('first');
    release.resolve();
    await vi.waitFor(() => expect(events).toHaveLength(3));
    expect(
      seen
        .filter((input) => input.responseId === 'A')
        .map((input) => input.text),
    ).toEqual(['first', 'final A']);
    expect(fail).not.toHaveBeenCalled();
    await helper.join(helper.stop());
  });

  it('keeps callback errors local and sends only explicit feedback on a later trip', async () => {
    const secret = new Error('private diagnostic');
    const { helper, events, trip } = fixture((input) => {
      if (!input.final) throw secret;
      return { tripwireTriggered: true, outputInfo: 'private result' };
    });
    helper.observe(raw('A', 'first'), false);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0].error).toBe(secret);
    expect(trip).not.toHaveBeenCalled();
    helper.observe(raw('A', 'final'), true);
    await vi.waitFor(() => expect(trip).toHaveBeenCalledTimes(1));
    expect(trip.mock.calls[0][1]).toBe('Please change the topic.');
    helper.observe(raw('A', 'late'), true);
    expect(trip).toHaveBeenCalledTimes(1);
    await helper.join(helper.stop());
  });

  it('joins an exact retired snapshot without aborting a newer response', async () => {
    const entered = new Map<string, NativeRealtimeGuardrailInput>();
    const releaseC = Promise.withResolvers<void>();
    const { helper, events } = fixture(async (input) => {
      entered.set(input.responseId, input);
      if (input.responseId === 'A') {
        await new Promise<void>((resolve) =>
          input.signal.addEventListener('abort', () => resolve(), {
            once: true,
          }),
        );
      } else await releaseC.promise;
      return allowed;
    });
    helper.observe(raw('A', 'A'), false);
    await vi.waitFor(() => expect(entered.has('A')).toBe(true));
    const retired = helper.retire();
    helper.observe(raw('C', 'C'), false);
    await helper.join(retired);
    await vi.waitFor(() => expect(entered.has('C')).toBe(true));
    expect(entered.get('A')!.signal.aborted).toBe(true);
    expect(entered.get('C')!.signal.aborted).toBe(false);
    expect(events).toEqual([]);
    releaseC.resolve();
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(events[0].input.responseId).toBe('C');
    await helper.join(helper.stop());
  });

  it('excludes the originating worker while a trip joins its own response', async () => {
    let joined = false;
    const helper = new NativeRealtimeGuardrails({
      guardrails: [
        { name: 'stop', callback: () => ({ tripwireTriggered: true }) },
      ],
      threshold: null,
      source: () => ({ agent: agentA, context: undefined }),
      invoke: async (run) => run(),
      emit: () => {},
      fail: (error) => {
        throw error;
      },
      trip: async (input, _feedback, worker) => {
        await helper.join(helper.retire(new Set([input.responseId])), worker);
        joined = true;
      },
    });
    helper.observe(raw('A', 'not final'), false);
    await Promise.resolve();
    expect(joined).toBe(false);
    helper.observe(raw('A', 'final'), true);
    await vi.waitFor(() => expect(joined).toBe(true));
    await helper.join(helper.stop());
  });

  it('bounds retained transcript data before starting another callback', async () => {
    const callback = vi.fn(() => allowed);
    const { helper } = fixture(callback);
    expect(() => helper.observe(raw('A', 'x'.repeat(1_048_577)), true)).toThrow(
      'text capacity',
    );
    expect(callback).not.toHaveBeenCalled();
    await helper.join(helper.stop());
  });
});

const settledGuardrailTurn = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

it('reclaims settled final guardrails across more than the content capacity', async () => {
  const callback = vi.fn(() => allowed);
  const { helper, fail } = fixture(callback);
  try {
    for (let i = 0; i < 1030; i++) {
      helper.observe(raw(`completed-${i}`, 'final text'), true);
      await settledGuardrailTurn();
    }
    expect(callback).toHaveBeenCalledTimes(1030);
    expect(fail).not.toHaveBeenCalled();
  } finally {
    await helper.join(helper.stop());
  }
});

it('reclaims historical transcript and identity reservations after final callbacks settle', async () => {
  const callback = vi.fn(() => allowed);
  const { helper, fail } = fixture(callback);
  try {
    for (let i = 0; i < 3; i++) {
      helper.observe(
        raw(`${i}-${'i'.repeat(200_000)}`, 'x'.repeat(600_000)),
        true,
      );
      await settledGuardrailTurn();
    }
    expect(callback).toHaveBeenCalledTimes(3);
    expect(fail).not.toHaveBeenCalled();
  } finally {
    await helper.join(helper.stop());
  }
});

it('deduplicates recent settled finals and rejects changed finals or late deltas', async () => {
  const callback = vi.fn(() => allowed);
  const { helper } = fixture(callback);
  helper.observe(raw('A', 'final'), true);
  await settledGuardrailTurn();
  helper.observe(raw('A', 'final'), true);
  expect(callback).toHaveBeenCalledTimes(1);
  expect(() => helper.observe(raw('A', 'changed'), true)).toThrow(
    'changed after',
  );
  expect(() => helper.observe(raw('A', 'late'), false)).toThrow(
    'changed after',
  );
  // Hashing must preserve JavaScript string units, including isolated surrogates.
  helper.observe(raw('unicode', '\ud800'), true);
  await settledGuardrailTurn();
  expect(() => helper.observe(raw('unicode', '\ud801'), true)).toThrow(
    'changed after',
  );
  await helper.join(helper.stop());
});

it('retains and joins a blocked final callback while settled siblings are reclaimed', async () => {
  const release = Promise.withResolvers<void>();
  let held: NativeRealtimeGuardrailInput | undefined;
  const { helper, events } = fixture(async (input) => {
    if (input.responseId === 'held') {
      held = input;
      await release.promise;
    }
    return allowed;
  });
  helper.observe(raw('held', 'x'.repeat(600_000)), true);
  await settledGuardrailTurn();
  try {
    for (let i = 0; i < 1030; i++) {
      helper.observe(raw(`sibling-${i}`, 'settled'), true);
      await settledGuardrailTurn();
    }
    expect(() =>
      helper.observe(raw('overflow', 'x'.repeat(600_000)), true),
    ).toThrow('text capacity');
    let joined = false;
    const joining = helper.join(helper.retire(new Set(['held']))).then(() => {
      joined = true;
    });
    await settledGuardrailTurn();
    expect(held?.signal.aborted).toBe(true);
    expect(joined).toBe(false);
    release.resolve();
    await joining;
    expect(joined).toBe(true);
    expect(events.filter((event) => event.input.responseId === 'held')).toEqual(
      [],
    );
  } finally {
    release.resolve();
    await helper.join(helper.stop());
  }
});

it('releases only each settled guardrail identity reservation', async () => {
  const callback = vi.fn(() => allowed);
  const { helper, fail } = fixture(callback);
  try {
    for (let i = 0; i < 5; i++) {
      helper.observe(raw(`${i}-${'i'.repeat(400_000)}`, 'final'), true);
      await settledGuardrailTurn();
    }
    expect(callback).toHaveBeenCalledTimes(5);
    expect(fail).not.toHaveBeenCalled();
  } finally {
    await helper.join(helper.stop());
  }
});

it('bounds retirement history without reactivating an existing retired worker', async () => {
  const release = Promise.withResolvers<void>();
  const callback = vi.fn(async () => {
    await release.promise;
    return allowed;
  });
  const { helper, events } = fixture(callback);
  helper.observe(raw('held', 'pending'), false);
  await settledGuardrailTurn();
  const retired = helper.retire(new Set(['held']));
  try {
    for (let i = 0; i < 1030; i++) helper.retire(new Set([`retired-${i}`]));
    helper.observe(raw('held', 'late final'), true);
    expect(callback).toHaveBeenCalledTimes(1);
    let joined = false;
    const joining = helper.join(retired).then(() => {
      joined = true;
    });
    await settledGuardrailTurn();
    expect(joined).toBe(false);
    release.resolve();
    await joining;
    helper.observe(raw('held', 'late again'), false);
    await settledGuardrailTurn();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(events).toEqual([]);
  } finally {
    release.resolve();
    await helper.join(helper.stop());
  }
});

it.each([null, 1])(
  'reclaims retired unfinished rows after their owned work settles (threshold %s)',
  async (threshold) => {
    const callback = vi.fn(() => allowed);
    const { helper, fail } = fixture(callback, threshold);
    try {
      for (let i = 0; i < 1030; i++) {
        const id = `unfinished-${i}`;
        helper.observe(raw(id, 'partial'), false);
        await helper.join(helper.retire(new Set([id])));
      }
      // A retained retired-item receipt remains inert after response-history pressure.
      for (let i = 0; i < 1030; i++) helper.retire(new Set([`other-${i}`]));
      helper.observe(raw('unfinished-1029', 'late final'), true);
      await settledGuardrailTurn();
      expect(callback).not.toHaveBeenCalled();
      expect(fail).not.toHaveBeenCalled();
    } finally {
      await helper.join(helper.stop());
    }
  },
);
