import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Engine, NativeThread } from '../src/runtime/binding';
import { NativeTurn } from '../src/runtime/native-turn';
import { QueuedRoots } from '../src/runtime/queued-roots';
import { Session } from '../src/runtime/session';
import { captureTools } from '../src/runtime/tools';

// Source controls with a controlled bridge; no native/provider proof.
const sessions: Session[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
});

async function fixture() {
  const batches: string[][] = [];
  let reader: ReturnType<typeof Promise.withResolvers<string[]>> | undefined;
  const emit = (id: string, text: string) => {
    const batch = [
      JSON.stringify({
        id,
        msg: { type: 'task_complete', last_agent_message: text },
      }),
    ];
    if (reader) {
      const pending = reader;
      reader = undefined;
      pending.resolve(batch);
    } else batches.push(batch);
  };
  let submissions = 0;
  const native = {
    id: 'root',
    _submit: vi.fn(async (_wire: string) =>
      JSON.stringify({
        status: 'started',
        turn_id: `turn-${++submissions}`,
      }),
    ),
    _next_session_events: () => {
      if (batches.length) return Promise.resolve(batches.shift()!);
      reader = Promise.withResolvers<string[]>();
      return reader.promise;
    },
    _enable_native_interception: vi.fn(),
    _configure_native_interception: vi.fn(),
    _next_native_interception: async () => 'null',
    _revoke_native_interception: vi.fn(),
    _finish_native_interception_reader: vi.fn(),
    _finish_child_event_reader: vi.fn(),
    _stop_sampling_for_close: vi.fn(),
    _request_graph_stop: vi.fn(() => ({
      settle: async () => {},
      release: vi.fn(),
    })),
    _close_report: async () => {
      reader?.reject(new Error('reader closed'));
      return null;
    },
  };
  const session = new Session(
    { _close_report: async () => null } as unknown as Engine,
    native as unknown as NativeThread,
    captureTools([]),
    { websocketsAllowed: false },
    {},
  );
  sessions.push(session);
  await session._start();
  return { session, native, emit };
}

describe('queued root Session source controls', () => {
  it('withdraws the exact queued handle, keeps FIFO and cancels only a passive waiter', async () => {
    const { session, native, emit } = await fixture();
    const a = await session.submit('A');
    const b = await session.enqueue('B');
    const c = await session.enqueue('C');
    const d = await session.enqueue('D');
    expect(b.turnId).toBeNull();
    expect(c.turnId).toBeNull();
    const stopped = b.wait().catch((error: unknown) => error);
    await b.cancel();
    const failure = await stopped;
    expect(failure).toHaveProperty(
      'message',
      'Queued work cancelled before admission',
    );
    expect(await b.wait().catch((error: unknown) => error)).toBe(failure);
    const controller = new AbortController();
    const passive = c
      .wait({ until: 'manual_tool', signal: controller.signal })
      .catch((error: unknown) => error);
    const reason = new Error('only this waiter');
    controller.abort(reason);
    expect(await passive).toBe(reason);
    expect(native._submit).toHaveBeenCalledTimes(1);
    emit(a.turnId, 'A done');
    expect((await a.wait()).finalOutput).toBe('A done');
    await vi.waitFor(() => expect(c.turnId).toBe('turn-2'));
    expect(d.turnId).toBeNull();
    emit(c.turnId!, 'C done');
    expect((await c.wait()).finalOutput).toBe('C done');
    await vi.waitFor(() => expect(d.turnId).toBe('turn-3'));
    emit(d.turnId!, 'D done');
    await d.wait();
    expect(
      native._submit.mock.calls.map(([wire]) => JSON.parse(wire).input),
    ).toEqual([
      [{ type: 'text', text: 'A' }],
      [{ type: 'text', text: 'C' }],
      [{ type: 'text', text: 'D' }],
    ]);
  });

  it('interrupts the pending batch without dispatch and retains the stop cleanup fence', async () => {
    const { session, native, emit } = await fixture();
    const cleanup = Promise.withResolvers<void>();
    const release = vi.fn();
    native._request_graph_stop.mockReturnValueOnce({
      settle: () => cleanup.promise,
      release,
    });
    const a = await session.submit('A');
    const b = await session.enqueue('B');
    const c = await session.enqueue('C');
    await session.interrupt();
    const failure = await b.wait().catch((error: unknown) => error);
    expect(failure).toHaveProperty(
      'message',
      'Queued work stopped by Session interruption',
    );
    expect(await c.wait().catch((error: unknown) => error)).toBe(failure);
    expect(native._submit).toHaveBeenCalledTimes(1);
    emit(a.turnId, 'A stopped');
    await a.wait().catch(() => {});
    await expect(session.enqueue('before cleanup')).rejects.toThrow(
      'without a mutation, capture, or stop',
    );
    expect(release).not.toHaveBeenCalled();
    cleanup.resolve();
    await vi.waitFor(() => expect(release).toHaveBeenCalledWith(true));
    const d = await session.enqueue('D');
    await vi.waitFor(() => expect(d.turnId).toBe('turn-2'));
    emit(d.turnId!, 'D done');
    await d.wait();
    expect(native._submit).toHaveBeenCalledTimes(2);
  });

  it('keeps the queues of two Sessions independent', async () => {
    const left = await fixture();
    const right = await fixture();
    const a = await left.session.submit('left active');
    const b = await left.session.enqueue('left queued');
    const x = await right.session.submit('right active');
    const y = await right.session.enqueue('right queued');
    await b.cancel();
    right.emit(x.turnId, 'right active done');
    await x.wait();
    await vi.waitFor(() => expect(y.turnId).toBe('turn-2'));
    expect(left.native._submit).toHaveBeenCalledTimes(1);
    left.emit(a.turnId, 'left done');
    await a.wait();
    right.emit(y.turnId!, 'right queued done');
    expect((await y.wait()).finalOutput).toBe('right queued done');
    expect(left.native._submit).toHaveBeenCalledTimes(1);
  });

  it('keeps native admission failure in Session and never retries the failed root', async () => {
    const { session, native, emit } = await fixture();
    const a = await session.submit('A');
    const b = await session.enqueue('B');
    const c = await session.enqueue('C');
    const failure = Object.assign(new Error('guard rejection'), {
      code: 'InvalidArg',
    });
    native._submit.mockRejectedValueOnce(failure);
    emit(a.turnId, 'A done');
    await a.wait();
    expect(await b.wait().catch((error: unknown) => error)).toBe(failure);
    await vi.waitFor(() => expect(c.turnId).toBe('turn-2'));
    emit(c.turnId!, 'C done');
    await c.wait();
    expect(native._submit).toHaveBeenCalledTimes(3);
  });
});

// Abort listeners on never-admitted records have no public signal surface.
// These controls exercise the owning boundary with canonical NativeTurn records.
function record() {
  return new NativeTurn(
    () => {},
    (completion) => completion,
  );
}

describe('queued rejection source controls', () => {
  it('detaches the entire interrupted batch before reentrant exact withdrawal', async () => {
    const ended: NativeTurn[] = [];
    const queue = new QueuedRoots((run) => ended.push(run));
    const a = record(),
      b = record(),
      successor = record();
    const original = new Error('bulk interruption');
    let detachedSize: number | undefined;
    a.controller.signal.addEventListener('abort', () => {
      detachedSize = queue.size;
      queue.withdraw(b, new Error('reentrant cancellation'));
      queue.register(successor, []);
    });
    queue.register(a, []);
    queue.register(b, []);
    queue.discard(original);
    expect(detachedSize).toBe(0);
    expect(ended).toEqual([a, b]);
    for (const run of [a, b]) {
      expect(run.controller.signal.reason).toBe(original);
      expect(await run.accepted.promise.catch((error: unknown) => error)).toBe(
        original,
      );
      expect(await run.wait().catch((error: unknown) => error)).toBe(original);
    }
    const dispatch = vi.fn();
    queue.promote(() => true, dispatch);
    expect(dispatch.mock.calls).toEqual([[successor, []]]);
  });

  it('withdraws before abort and publishes settlement before observation', async () => {
    const run = record();
    const order: string[] = [];
    const queue = new QueuedRoots((entry) => {
      expect(entry).toBe(run);
      order.push('observation');
    });
    const original = new Error('withdraw');
    run.controller.signal.addEventListener('abort', () => {
      expect(queue.has(run)).toBe(false);
      queue.withdraw(run, new Error('again'));
      order.push('abort');
    });
    run.accepted.promise.catch(() => order.push('admission'));
    run.completion.promise.catch(() => order.push('completion'));
    queue.register(run, []);
    queue.withdraw(run, original);
    await Promise.resolve();
    expect(order).toEqual(['abort', 'observation', 'admission', 'completion']);
    expect(run.controller.signal.reason).toBe(original);
  });

  it('rejects synchronous dispatch failure once and rechecks the promotion fence', async () => {
    const ended = vi.fn();
    const queue = new QueuedRoots(ended);
    const a = record(),
      b = record();
    queue.register(a, []);
    queue.register(b, []);
    const failure = new Error('dispatch');
    let allowed = true;
    const dispatch = vi.fn(() => {
      allowed = false;
      throw failure;
    });
    queue.promote(() => allowed, dispatch);
    expect(await a.wait().catch((error: unknown) => error)).toBe(failure);
    expect(await a.accepted.promise.catch((error: unknown) => error)).toBe(
      failure,
    );
    expect(ended.mock.calls).toEqual([[a]]);
    expect(queue.has(b)).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
    const next = vi.fn();
    queue.promote(() => true, next);
    expect(next.mock.calls).toEqual([[b, []]]);
  });
});
