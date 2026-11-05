import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  ObservationBuffer,
  type Observation,
  type ObservationPhase,
  type TurnObservationScope,
} from '../../src/runtime/observation';

const turn = { submissionId: 'owned', turnId: 'native-owned' };
const other = { submissionId: 'other', turnId: 'native-other' };

function scope(
  phase: () => ObservationPhase = () => 'ended',
): TurnObservationScope {
  return {
    includes: (event) =>
      'submissionId' in event && event.submissionId === turn.submissionId,
    phase,
  };
}

describe('passive turn observation cursors', () => {
  it('replays only owned observations to independent readers without reading requests', async () => {
    const pendingManual = vi.fn(() => {
      throw new Error('a passive reader must not enumerate requests');
    });
    const buffer = new ObservationBuffer('session', { pendingManual });
    const start = buffer.append({ type: 'turn_started', ...turn });
    buffer.append({ type: 'turn_started', ...other });
    const end = buffer.append({
      type: 'turn_finished',
      ...turn,
      status: 'completed',
    });
    const first = buffer.events({}, scope());
    const second = buffer.events({ after: 1 }, scope());
    expectTypeOf(first).toEqualTypeOf<AsyncIterableIterator<Observation>>();
    expect(await first.next()).toEqual({ done: false, value: start });
    expect(await first.next()).toEqual({ done: false, value: end });
    expect(await second.next()).toEqual({ done: false, value: end });
    expect(await first.next()).toEqual({ done: true, value: undefined });
    expect(await second.next()).toEqual({ done: true, value: undefined });
    expect(pendingManual).not.toHaveBeenCalled();
  });

  it('reports a global gap and ends when the owned terminal record was evicted', async () => {
    const buffer = new ObservationBuffer('session');
    buffer.append({ type: 'turn_started', ...turn });
    buffer.append({ type: 'turn_finished', ...turn, status: 'completed' });
    for (let index = 0; index < 256; index++)
      buffer.append({
        type: 'output_text_delta',
        ...other,
        itemId: 'message',
        delta: String(index),
      });
    const reader = buffer.events({}, scope());
    expect(await reader.next()).toEqual({
      done: false,
      value: {
        type: 'gap',
        sessionId: 'session',
        firstSequence: 1,
        sequence: 2,
      },
    });
    expect(await reader.next()).toEqual({ done: true, value: undefined });
  });

  it('waits for the producer to finish publication after the buffer closes', async () => {
    const buffer = new ObservationBuffer('session');
    let phase: ObservationPhase = 'finishing';
    const reader = buffer.events(
      {},
      scope(() => phase),
    );
    let settled = false;
    const pending = reader.next().then((result) => {
      settled = true;
      return result;
    });
    buffer.finish('failed');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    phase = 'ended';
    buffer.notify();
    expect(await pending).toEqual({ done: true, value: undefined });
  });

  it('drains a late terminal observation before ending', async () => {
    const buffer = new ObservationBuffer('session');
    let phase: ObservationPhase = 'finishing';
    const reader = buffer.events(
      {},
      scope(() => phase),
    );
    const pending = reader.next();
    const end = buffer.append({
      type: 'turn_finished',
      ...turn,
      status: 'failed',
      errorType: 'ToolError',
    });
    phase = 'ended';
    buffer.notify();
    expect(await pending).toEqual({ done: false, value: end });
    expect(await reader.next()).toEqual({ done: true, value: undefined });
  });

  it('closes a pending reader without closing a sibling or its producer', async () => {
    const buffer = new ObservationBuffer('session');
    const owner = scope(() => 'open');
    const first = buffer.events({}, owner);
    const second = buffer.events({}, owner);
    const pending = first.next();
    await expect(first.next()).rejects.toThrow('already has a pending read');
    expect(await first.return!()).toEqual({ done: true, value: undefined });
    expect(await pending).toEqual({ done: true, value: undefined });
    buffer.append({ type: 'turn_started', ...other });
    const start = buffer.append({ type: 'turn_started', ...turn });
    expect(await second.next()).toEqual({ done: false, value: start });
    await second.return!();
  });

  it('checks cursor bounds and callback authority at creation and every read', async () => {
    let allowed = true;
    const buffer = new ObservationBuffer('session', {
      validate: () => {
        if (!allowed) throw new Error('callback cannot observe its Session');
      },
    });
    const start = buffer.append({ type: 'turn_started', ...turn });
    for (const after of [-1, 1.5, 2, Number.NaN])
      expect(() => buffer.events({ after }, scope())).toThrow(RangeError);
    allowed = false;
    expect(() => buffer.events({}, scope())).toThrow('callback cannot observe');
    allowed = true;
    const reader = buffer.events({}, scope());
    allowed = false;
    await expect(reader.next()).rejects.toThrow('callback cannot observe');
    allowed = true;
    expect(await reader.next()).toEqual({ done: false, value: start });
    expect(await reader.next()).toEqual({ done: true, value: undefined });
  });
});
