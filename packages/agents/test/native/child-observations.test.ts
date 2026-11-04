import { expect, it, vi } from 'vitest';
import {
  ChildCallbacks,
  type ChildObservationProducer,
} from '../../src/runtime/child-callbacks';
import { ObservationBuffer } from '../../src/runtime/observation';

it('delivers an entered callback tail before retirement EOF without revoking it', async () => {
  const callbacks = new ChildCallbacks();
  const producer = { ended: false };
  const owner = callbacks.owner('child', 'incarnation', 'turn', producer);
  const release = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const failed = vi.fn(async () => {});
  const pendingManual = vi.fn(() => {
    throw new Error('Observation must not enumerate interactions');
  });
  const buffer = new ObservationBuffer('session', { pendingManual });
  const identity = {
    submissionId: 'child:child:incarnation:turn',
    turnId: 'turn',
  };
  callbacks.track(
    owner,
    async () => {
      entered.resolve();
      await release.promise;
      buffer.append({
        type: 'tool_finished',
        ...identity,
        callId: 'call',
        name: 'tool',
        namespace: null,
        family: 'function',
        status: 'completed',
      });
    },
    failed,
  );
  await entered.promise;
  const reader = buffer.events(
    {},
    {
      includes: (event) =>
        'submissionId' in event && event.submissionId === identity.submissionId,
      phase: () => owner.observationPhase,
    },
  );
  const next = reader.next();
  const retirement = callbacks.retireObservations(producer, () =>
    buffer.notify(),
  );
  expect(owner.observationPhase).toBe('finishing');
  expect(callbacks.active(owner)).toBe(true);
  expect(owner.controller.signal.aborted).toBe(false);
  release.resolve();
  await retirement;
  expect((await next).value).toMatchObject({
    type: 'tool_finished',
    ...identity,
  });
  expect(await reader.next()).toEqual({ done: true, value: undefined });
  expect(failed).not.toHaveBeenCalled();
  expect(pendingManual).not.toHaveBeenCalled();
});

it('preserves callback failure for its result owner after observation retirement', async () => {
  const callbacks = new ChildCallbacks();
  const producer = { ended: true };
  const owner = callbacks.owner('child', 'incarnation', 'turn', producer);
  const failure = new Error('Callback failed');
  const failed = vi.fn(async () => {});
  callbacks.track(
    owner,
    async () => {
      throw failure;
    },
    failed,
  );
  await callbacks.retireObservations(producer, () => {});
  expect(owner.observationPhase).toBe('ended');
  expect(owner.failure).toBe(failure);
  await expect(callbacks.drain('child', 'incarnation', 'turn')).rejects.toBe(
    failure,
  );
  expect(failed).toHaveBeenCalledOnce();
});

it('matches the captured producer and exact instance without overtaking a publisher', async () => {
  const callbacks = new ChildCallbacks();
  const producer = { ended: false };
  const successor = { ended: false };
  const old = callbacks.owner('child', 'old', 'turn', producer);
  expect(
    callbacks.owner('child', 'old', 'turn', producer, '9007199254740993'),
  ).toBe(old);
  const publishing = callbacks.owner(
    'child',
    'old',
    'publishing',
    producer,
    old.instanceId,
  );
  publishing.observationPhase = 'finishing';
  const other = callbacks.owner(
    'child',
    'other',
    'turn',
    producer,
    '9007199254740992',
  );
  const current = callbacks.owner(
    'child',
    'new',
    'turn',
    successor,
    old.instanceId,
  );
  const notify = vi.fn();
  await callbacks.retireObservations(
    producer,
    notify,
    (owner) =>
      owner.childId === 'child' && owner.instanceId === '9007199254740993',
  );
  expect(old.observationPhase).toBe('ended');
  expect(publishing.observationPhase).toBe('finishing');
  expect(other.observationPhase).toBe('open');
  expect(current.observationPhase).toBe('open');
  expect(notify).toHaveBeenCalledOnce();
  expect(callbacks.owner('child', 'old', 'turn', producer)).toBe(old);
  expect(old.instanceId).toBe('9007199254740993');
});

it('allows queued auxiliary publication before retirement and late handles afterward', async () => {
  const callbacks = new ChildCallbacks();
  const producer: ChildObservationProducer = { ended: false };
  const owner = callbacks.owner('child', 'incarnation', 'turn', producer);
  const buffer = new ObservationBuffer('session');
  const main = Promise.withResolvers<void>();
  const auxiliary = Promise.withResolvers<void>();
  const auxiliaryReader = auxiliary.promise.then(() => {
    buffer.append({
      type: 'turn_started',
      turnId: 'turn',
      submissionId: 'child:child:incarnation:turn',
    });
  });
  // Session owns this join; creating a cursor never starts it.
  const retiring = Promise.allSettled([main.promise, auxiliaryReader]).then(
    async () => {
      producer.ended = true;
      await callbacks.retireObservations(producer, () => buffer.notify());
    },
  );
  main.resolve();
  await main.promise;
  expect(producer.ended).toBe(false);
  expect(owner.observationPhase).toBe('open');
  auxiliary.resolve();
  await retiring;
  const reader = buffer.events(
    {},
    {
      includes: (event) => 'submissionId' in event,
      phase: () => owner.observationPhase,
    },
  );
  expect((await reader.next()).value).toMatchObject({ type: 'turn_started' });
  expect(await reader.next()).toEqual({ done: true, value: undefined });
  const late = callbacks.owner('child', 'incarnation', 'late', producer);
  // Handle issuance uses the same producer-owned retirement path.
  if (producer.ended)
    await callbacks.retireObservations(producer, () => buffer.notify());
  const lateReader = buffer.events(
    {},
    {
      includes: (event) => 'turnId' in event && event.turnId === 'late',
      phase: () => late.observationPhase,
    },
  );
  expect(await lateReader.next()).toEqual({ done: true, value: undefined });
});

// Controlled native receipts exercise the public JS cancellation join only.
// Real child/cell admission remains covered by the native-gated child cases.
async function cancellationFixture() {
  const { Session } = await import('../../src/runtime/session');
  const { captureTools } = await import('../../src/runtime/tools');
  const native = {
    session_id: 'root',
    child_id: 'child',
    instance_id: '7',
    incarnation: 'incarnation',
    turn_id: 'original',
    cancel: vi.fn(async (): Promise<boolean | null> => true),
  };
  let current = native;
  const closeNative = vi.fn(async (): Promise<string | null> => null);
  const closeEngine = vi.fn(async (): Promise<string | null> => null);
  const thread = {
    id: 'root',
    call: async () =>
      JSON.stringify([
        {
          id: 'child',
          object: 'agent.session.subagent',
          session_id: 'root',
          parent_agent_id: 'root',
          name: 'worker',
          status: 'active',
          opened_at: 1,
          closed_at: null,
        },
      ]),
    _child_instance: async () => ['7', current],
    _stop_sampling_for_close: () => {},
    _close_report: closeNative,
  };
  const session = new Session(
    {
      _close_report: closeEngine,
    } as unknown as import('../../src/runtime/binding').Engine,
    thread as unknown as import('../../src/runtime/binding').NativeThread,
    captureTools([]),
    {},
    {},
  );
  const [child] = await Array.fromAsync(session.subagents());
  const callbacks = (session as unknown as { childCallbacks: ChildCallbacks })
    .childCallbacks;
  const owner = callbacks.find('child', 'incarnation', 'original')!;
  return {
    session,
    child: child!,
    native,
    callbacks,
    owner,
    closeEngine,
    successor: async () => {
      current = { ...native, turn_id: 'successor' };
      const [next] = await Array.fromAsync(session.subagents());
      return next!;
    },
  };
}

it.each([true, null] as const)(
  'joins exact callbacks after confirmed native cleanup (%s) without stopping a successor',
  async (confirmation) => {
    const f = await cancellationFixture();
    const confirmed = Promise.withResolvers<boolean | null>();
    f.native.cancel.mockReturnValue(confirmed.promise);
    const entered = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let finished = false;
    f.callbacks.track(
      f.owner,
      async () => {
        entered.resolve();
        await new Promise<void>((resolve) =>
          f.owner.controller.signal.addEventListener(
            'abort',
            () => {
              aborted.resolve();
              resolve();
            },
            { once: true },
          ),
        );
        await release.promise;
        finished = true;
      },
      async () => {},
    );
    await entered.promise;
    const outcome = f.child.tryCancel(f.child.turn!).then(
      (value) => ({ value }),
      (error) => ({ error: error as Error }),
    );
    let settled = false;
    void outcome.then(() => {
      settled = true;
    });
    const next = await f.successor();
    const successorOwner = f.callbacks.find(
      'child',
      'incarnation',
      next.turn!.turnId,
    )!;
    confirmed.resolve(confirmation);
    await aborted.promise;
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(finished).toBe(false);
    expect(successorOwner.controller.signal.aborted).toBe(false);
    release.resolve();
    const result = await outcome;
    expect(finished).toBe(true);
    if (confirmation) expect(result).toEqual({ value: true });
    else {
      expect(result).toHaveProperty('error');
      const error = (result as { error: Error }).error;
      expect(error.message).toBe('Child cancellation cleanup failed');
      expect(error.cause).toBeUndefined();
    }
    expect(successorOwner.controller.signal.aborted).toBe(false);
    await f.session.close();
  },
);

it.each(['false', 'error'] as const)(
  'leaves the original callback live when cancellation is unconfirmed (%s)',
  async (decision) => {
    const f = await cancellationFixture();
    const error = new Error('unconfirmed interruption');
    if (decision === 'false') f.native.cancel.mockResolvedValue(false);
    else f.native.cancel.mockRejectedValue(error);
    if (decision === 'false')
      await expect(f.child.tryCancel(f.child.turn!)).resolves.toBe(false);
    else await expect(f.child.tryCancel(f.child.turn!)).rejects.toBe(error);
    expect(f.callbacks.active(f.owner)).toBe(true);
    expect(f.owner.controller.signal.aborted).toBe(false);
    await f.session.close();
  },
);

it.each([false, true])(
  'retains cleanup after the caller stops waiting and sanitizes callback failure (%s)',
  async (fails) => {
    const f = await cancellationFixture();
    const entered = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const privateError = new Error('private-application-cleanup-secret');
    let finished = false;
    f.callbacks.track(
      f.owner,
      async () => {
        entered.resolve();
        await new Promise<void>((resolve) =>
          f.owner.controller.signal.addEventListener(
            'abort',
            () => {
              aborted.resolve();
              resolve();
            },
            { once: true },
          ),
        );
        await release.promise;
        finished = true;
        if (fails) throw privateError;
      },
      async () => {},
    );
    await entered.promise;
    // The caller need not continue awaiting cancellation for close to join it.
    const result = f.child.tryCancel(f.child.turn!).then(
      (value) => value,
      (error) => error as Error,
    );
    await aborted.promise;
    let closed = false;
    const closing = f.session.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(finished).toBe(false);
    release.resolve();
    await closing;
    const outcome = await result;
    expect(finished).toBe(true);
    if (!fails) expect(outcome).toBe(true);
    else {
      expect(outcome).toBeInstanceOf(Error);
      const failure = outcome as Error;
      expect(failure.message).toBe('Child cancellation cleanup failed');
      expect(failure.cause).toBeUndefined();
      expect(String(failure.stack)).not.toContain(privateError.message);
      expect(JSON.stringify(failure)).not.toContain(privateError.message);
    }
  },
);

it.each([false, true])(
  'joins an already completed close without creating an owner after its sweep (close fails: %s)',
  async (fails) => {
    const f = await cancellationFixture();
    const releaseReceipt = Promise.withResolvers<boolean | null>();
    f.native.cancel.mockReturnValue(releaseReceipt.promise);
    if (fails) f.closeEngine.mockResolvedValue('private-native-close-error');
    const cancellation = f.child.tryCancel(f.child.turn!).then(
      (value) => value,
      (error) => error as Error,
    );
    if (fails)
      await expect(f.session.close()).rejects.toThrow(
        'private-native-close-error',
      );
    else await f.session.close();
    const owner = f.callbacks.find('child', 'incarnation', 'original');
    releaseReceipt.resolve(true);
    const result = await cancellation;
    expect(f.callbacks.find('child', 'incarnation', 'original')).toBe(owner);
    if (!fails) expect(result).toBe(true);
    else {
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toBe(
        'Child cancellation cleanup failed',
      );
      expect((result as Error).cause).toBeUndefined();
      expect(String((result as Error).stack)).not.toContain(
        'private-native-close-error',
      );
    }
  },
);

it('retries confirmed cleanup on the original child receipt after a successor is observed', async () => {
  const f = await cancellationFixture();
  f.native.cancel.mockResolvedValueOnce(null).mockResolvedValueOnce(true);
  await expect(f.child.tryCancel(f.child.turn!)).rejects.toMatchObject({
    name: 'NativeError',
    message: 'Child cancellation cleanup failed',
  });
  const next = await f.successor();
  expect(next.turn!.turnId).not.toBe(f.child.turn!.turnId);
  const successorOwner = f.callbacks.find(
    'child',
    'incarnation',
    next.turn!.turnId,
  )!;
  await expect(f.child.tryCancel(f.child.turn!)).resolves.toBe(true);
  expect(f.native.cancel).toHaveBeenCalledTimes(2);
  expect(f.native.cancel.mock.contexts).toEqual([f.native, f.native]);
  expect(successorOwner.controller.signal.aborted).toBe(false);
  await f.session.close();
});
