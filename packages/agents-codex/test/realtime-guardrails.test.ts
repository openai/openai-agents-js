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
    threshold: 1,
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
