import { expect, it, vi } from 'vitest';
import { Session } from '../src/runtime/session';
import { captureTools } from '../src/runtime/tools';
import type { Engine, NativeThread } from '../src/runtime/binding';

// A native event source, so these exercise the actual sole Session reader and
// public lifecycle rather than calling the Realtime owner's control route.
function fixture(providerFailure?: Error) {
  let waiting = Promise.withResolvers<string[]>();
  const queued: string[][] = [];
  let reading = false;
  const emit = (
    id: string,
    type: string,
    fields: Record<string, unknown> = {},
  ) => {
    const batch = [JSON.stringify({ id, msg: { type, ...fields } })];
    if (reading) {
      reading = false;
      waiting.resolve(batch);
      waiting = Promise.withResolvers<string[]>();
    } else queued.push(batch);
  };
  let generation = '';
  const mediaCleanup = { close: vi.fn(async (_generation: string) => {}) };
  const native = {
    id: 'native-root',
    _realtime_cleanup: () => mediaCleanup,
    _next_session_events: vi.fn(async () => {
      if (queued.length) return queued.shift()!;
      reading = true;
      return waiting.promise;
    }),
    _finish_child_event_reader: vi.fn(),
    _stop_sampling_for_close: vi.fn(),
    _close_report: vi.fn(async () => {
      emit('', 'shutdown_complete');
      return null;
    }),
    call: vi.fn(async (operation: string, raw: string) => {
      const params = JSON.parse(raw);
      if (operation === 'realtime_conversation_prepare_sdk') {
        generation = params.generation;
        return JSON.stringify({ generation });
      }
      if (operation === 'realtime_conversation_activate_sdk') {
        emit(generation, 'realtime_conversation_started');
      }
      if (operation === 'realtime_conversation_close_sdk')
        emit(generation, 'realtime_conversation_closed', {
          reason: 'requested',
        });
      return 'null';
    }),
  };
  const engine = { _close_report: vi.fn(async () => null) };
  const carrier = {
    close: vi.fn(async () => {
      if (providerFailure) throw providerFailure;
    }),
  };
  const session = new Session(
    engine as unknown as Engine,
    native as unknown as NativeThread,
    captureTools([]),
    {},
    {},
    null,
    carrier as never,
  );
  return {
    session,
    mediaCleanup,
    native,
    engine,
    carrier,
    emit: (type: string, fields: Record<string, unknown> = {}) =>
      emit(generation, type, fields),
  };
}

it('routes native Realtime before passive observation and joins its real Session reader on close', async () => {
  const f = fixture();
  await f.session._start();
  const voice = await f.session.realtime({
    settings: { transcription: null, turnDetection: null },
  });
  await expect(f.session.realtime()).rejects.toThrow();
  f.emit('realtime_conversation_realtime', {
    payload: {
      AudioOut: { data: 'AQACAA==', sample_rate: 24000, num_channels: 1 },
    },
  });
  const events = voice.events();
  expect((await events.next()).value).toMatchObject({
    type: 'lifecycle',
    status: 'started',
  });
  expect((await events.next()).value).toMatchObject({
    type: 'audio',
    data: new Uint8Array([1, 0, 2, 0]),
  });
  await f.session.close();
  expect((await events.next()).value).toMatchObject({
    type: 'lifecycle',
    status: 'closed',
  });
  expect((await events.next()).done).toBe(true);
  expect(f.native._finish_child_event_reader).toHaveBeenCalledOnce();
  expect(f.engine._close_report).toHaveBeenCalledOnce();
  expect(f.carrier.close).toHaveBeenCalledOnce();
});

it('native graph retirement releases a pending delegation even when later provider cleanup fails', async () => {
  const failure = new Error('provider release failed');
  const f = fixture(failure);
  await f.session._start();
  const publicResult = Promise.withResolvers<never>();
  void publicResult.promise.catch(() => {});
  const cancel = vi.fn(async () => {
    await f.session.close();
  });
  vi.spyOn(f.session, 'submit').mockResolvedValue({
    wait: () => publicResult.promise,
    cancel,
  } as never);
  const voice = await f.session.realtime();
  f.emit('realtime_conversation_realtime', {
    payload: {
      HandoffRequested: { handoff_id: 'h', input_transcript: 'ignored' },
    },
    _sdk_native_input: 'Core prepared text',
  });
  await vi.waitFor(() =>
    expect(f.session.submit).toHaveBeenCalledWith('Core prepared text'),
  );
  await expect(f.session.close()).rejects.toBe(failure);
  publicResult.reject(new Error('retired native result'));
  expect(f.native._close_report).toHaveBeenCalledOnce();
  expect(f.engine._close_report).toHaveBeenCalledOnce();
  expect(f.carrier.close).toHaveBeenCalledOnce();
  expect((await voice.events().next()).value).toMatchObject({
    type: 'lifecycle',
    status: 'closed',
  });
});

it.each(['voice', 'session'] as const)(
  'retries retained postgraph media cleanup through %s without repeating released resources',
  async (retry) => {
    const f = fixture();
    await f.session._start();
    const voice = await f.session.realtime();
    const failure = new Error('hangup409');
    f.mediaCleanup.close.mockRejectedValueOnce(failure);
    await expect(f.session.close()).rejects.toBe(failure);
    expect(f.mediaCleanup.close).toHaveBeenCalledOnce();
    expect(f.carrier.close).toHaveBeenCalledOnce();
    if (retry === 'voice') await voice.close();
    else await f.session.close();
    await f.session.close();
    expect(f.mediaCleanup.close).toHaveBeenCalledTimes(2);
    expect(f.mediaCleanup.close.mock.calls[1]).toEqual(
      f.mediaCleanup.close.mock.calls[0],
    );
    expect(f.engine._close_report).toHaveBeenCalledOnce();
    expect(f.carrier.close).toHaveBeenCalledOnce();
  },
);

it('rejects callback lifecycle reentrancy before mutating or joining its own Realtime work', async () => {
  const f = fixture();
  await f.session._start();
  const voice = await f.session.realtime();
  const before = f.native.call.mock.calls.length;
  await expect(
    f.session._runVoiceCallback(() => voice.close()),
  ).rejects.toThrow();
  await expect(
    f.session._runVoiceCallback(() => voice.interrupt()),
  ).rejects.toThrow();
  expect(f.native.call.mock.calls).toHaveLength(before);
  await voice.sendText('still open');
  await voice.close();
  await f.session.close();
});
