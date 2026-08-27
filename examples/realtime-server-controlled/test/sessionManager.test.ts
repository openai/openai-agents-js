import { describe, expect, it, vi } from 'vitest';
import { NotFoundError } from 'openai';
import {
  SessionConflictError,
  SessionManager,
} from '../src/server/sessionManager';

describe('SessionManager', () => {
  it('retains failed cleanup and the owner reservation until a retry succeeds', async () => {
    let finishHangup!: () => void;
    const hangup = vi
      .fn(async () => {})
      .mockRejectedValueOnce(new Error('timeout'));
    const sessions = new SessionManager({ hangup });
    const id = sessions.reserve('owner-1');
    const realtimeSession = { close: vi.fn() };
    sessions.attachCall(id, 'rtc_retry');
    sessions.attachRealtimeSession(id, realtimeSession);
    sessions.activate(id);
    await expect(sessions.cancel(id, 'owner-1')).rejects.toThrow('timeout');
    expect(() => sessions.reserve('owner-1')).toThrow(SessionConflictError);
    expect(sessions.ownsActive(id, 'owner-1')).toBe(false);

    hangup.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishHangup = resolve;
        }),
    );
    const retry = sessions.cancel(id, 'owner-1');
    const concurrentRetry = sessions.cancel(id, 'owner-1');
    await vi.waitFor(() => expect(hangup).toHaveBeenCalledTimes(2));
    expect(() => sessions.reserve('owner-1')).toThrow(SessionConflictError);
    finishHangup();
    await Promise.all([retry, concurrentRetry]);

    expect(realtimeSession.close).toHaveBeenCalledOnce();
    expect(hangup.mock.calls).toEqual([['rtc_retry'], ['rtc_retry']]);
    expect(() => sessions.reserve('owner-1')).not.toThrow();
  });

  it('retries failed hangups on the sweep without waiting for session expiry', async () => {
    const hangup = vi
      .fn(async () => {})
      .mockRejectedValueOnce(new Error('timeout'));
    const sessions = new SessionManager({ hangup, now: () => 1_000 });
    const id = sessions.reserve('owner-1');
    sessions.attachCall(id, 'rtc_retry');
    await expect(sessions.close(id)).rejects.toThrow('timeout');

    await sessions.closeExpired(30 * 60_000);

    expect(hangup).toHaveBeenCalledTimes(2);
    expect(() => sessions.reserve('owner-1')).not.toThrow();
  });

  it('treats a provider-confirmed missing call as already cleaned up', async () => {
    const hangup = vi.fn(async () => {
      throw new NotFoundError(404, {}, 'Call not found', new Headers());
    });
    const sessions = new SessionManager({ hangup });
    const id = sessions.reserve('owner-1');
    sessions.attachCall(id, 'rtc_absent');

    await expect(sessions.close(id)).resolves.toBe(true);
    await sessions.closeExpired(0);

    expect(hangup).toHaveBeenCalledOnce();
    expect(() => sessions.reserve('owner-1')).not.toThrow();
  });

  it('retains detached call IDs for the same cleanup sweep', async () => {
    const hangup = vi
      .fn(async () => {})
      .mockRejectedValueOnce(new Error('timeout'));
    const sessions = new SessionManager({ hangup });
    await expect(sessions.closeDetachedCall('rtc_detached')).rejects.toThrow(
      'timeout',
    );

    await sessions.closeExpired(30 * 60_000);
    await sessions.closeExpired(30 * 60_000);

    expect(hangup.mock.calls).toEqual([['rtc_detached'], ['rtc_detached']]);
  });

  it('makes a bounded shutdown retry and reports persistent failure safely', async () => {
    const hangup = vi.fn(async (): Promise<void> => {
      throw new Error('private provider error');
    });
    const warning = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const sessions = new SessionManager({ hangup });
      const id = sessions.reserve('owner-1');
      sessions.attachCall(id, 'rtc_shutdown');
      await sessions.closeAll();
      expect(hangup).toHaveBeenCalledTimes(2);
      expect(warning).toHaveBeenCalledExactlyOnceWith(
        'A Realtime call could not be terminated during shutdown.',
      );
      hangup.mockResolvedValueOnce(undefined);
      await expect(sessions.close(id)).resolves.toBe(true);
      expect(hangup).toHaveBeenCalledTimes(3);
    } finally {
      warning.mockRestore();
    }
  });

  it('allows only one session per authenticated owner', () => {
    const sessions = new SessionManager({ hangup: vi.fn(async () => {}) });
    sessions.reserve('owner-1');
    expect(() => sessions.reserve('owner-1')).toThrow(SessionConflictError);
  });

  it('does not let another owner replace a client-selected session ID', () => {
    const sessions = new SessionManager({ hangup: vi.fn(async () => {}) });
    const sessionId = '00000000-0000-4000-8000-000000000001';
    sessions.reserve('owner-1', sessionId);
    sessions.activate(sessionId);

    expect(() => sessions.reserve('owner-2', sessionId)).toThrow(
      'session identifier is already in use',
    );
    expect(sessions.ownsActive(sessionId, 'owner-1')).toBe(true);
  });

  it('makes cancellation win when it arrives before reservation', async () => {
    const sessions = new SessionManager({ hangup: vi.fn(async () => {}) });
    const sessionId = '00000000-0000-4000-8000-000000000001';
    const replacementId = '00000000-0000-4000-8000-000000000002';

    await expect(sessions.cancel(sessionId, 'owner-1')).resolves.toBe(true);

    expect(() => sessions.reserve('owner-1', sessionId)).toThrow(
      'voice session setup was cancelled',
    );
    expect(() => sessions.reserve('owner-2', sessionId)).toThrow(
      'session identifier is already in use',
    );
    expect(sessions.reserve('owner-1', replacementId)).toBe(replacementId);
  });

  it('retains cancellation evidence after the live-session expiry sweep', async () => {
    let now = 1_000;
    const sessions = new SessionManager({
      hangup: vi.fn(async () => {}),
      now: () => now,
    });
    const sessionId = '00000000-0000-4000-8000-000000000001';
    await sessions.cancel(sessionId, 'owner-1');

    now = 2_001;
    await sessions.closeExpired(1_000);

    expect(() => sessions.reserve('owner-1', sessionId)).toThrow(
      'voice session setup was cancelled',
    );
  });

  it('requires ownership for subscription and close', async () => {
    const sessions = new SessionManager({ hangup: vi.fn(async () => {}) });
    const id = sessions.reserve('owner-1');
    sessions.activate(id);
    const client = { close: vi.fn(), send: vi.fn() };

    expect(sessions.subscribe(id, 'owner-2', client)).toBeNull();
    await expect(sessions.close(id, 'owner-2')).resolves.toBe(false);
    expect(sessions.ownsActive(id, 'owner-1')).toBe(true);
  });

  it('does not let another owner cancel an active session', async () => {
    const sessions = new SessionManager({ hangup: vi.fn(async () => {}) });
    const id = sessions.reserve('owner-1');
    sessions.activate(id);

    await expect(sessions.cancel(id, 'owner-2')).resolves.toBe(false);

    expect(sessions.ownsActive(id, 'owner-1')).toBe(true);
  });

  it('replays only cached public state to a new subscriber', () => {
    const sessions = new SessionManager({ hangup: vi.fn(async () => {}) });
    const id = sessions.reserve('owner-1');
    sessions.activate(id);
    sessions.publish(id, { type: 'app.agent.state', state: 'speaking' });
    const client = { close: vi.fn(), send: vi.fn() };

    const unsubscribe = sessions.subscribe(id, 'owner-1', client);

    expect(unsubscribe).toBeTypeOf('function');
    expect(client.send.mock.calls).toEqual([
      [{ type: 'app.session.ready' }],
      [{ type: 'app.agent.state', state: 'speaking' }],
    ]);
  });

  it('converges concurrent cleanup on one SDK close and one hangup', async () => {
    const hangup = vi.fn(async () => {});
    const closeRealtime = vi.fn();
    const sessions = new SessionManager({ hangup });
    const id = sessions.reserve('owner-1');
    sessions.attachCall(id, 'rtc_test');
    sessions.attachRealtimeSession(id, { close: closeRealtime });
    sessions.activate(id);
    const client = { close: vi.fn(), send: vi.fn() };
    sessions.subscribe(id, 'owner-1', client);

    await Promise.all([sessions.close(id), sessions.close(id)]);

    expect(closeRealtime).toHaveBeenCalledOnce();
    expect(hangup).toHaveBeenCalledOnce();
    expect(hangup).toHaveBeenCalledWith('rtc_test');
    expect(client.send).toHaveBeenCalledWith({ type: 'app.session.closed' });
    expect(client.close).toHaveBeenCalledOnce();
  });

  it('publishes cleanup ownership before SDK close can re-enter', async () => {
    const hangup = vi.fn(async () => {});
    const sessions = new SessionManager({ hangup });
    const id = sessions.reserve('owner-1');
    let reentrantClose: Promise<boolean> | undefined;
    const closeRealtime = vi.fn(() => {
      reentrantClose = sessions.close(id);
    });
    sessions.attachCall(id, 'rtc_reentrant');
    sessions.attachRealtimeSession(id, { close: closeRealtime });
    sessions.activate(id);

    await expect(sessions.close(id)).resolves.toBe(true);
    await expect(reentrantClose).resolves.toBe(true);

    expect(closeRealtime).toHaveBeenCalledOnce();
    expect(hangup).toHaveBeenCalledOnce();
    expect(hangup).toHaveBeenCalledWith('rtc_reentrant');
  });

  it('rejects new reservations after shutdown cleanup starts', async () => {
    const sessions = new SessionManager({ hangup: vi.fn(async () => {}) });
    await sessions.closeAll();

    expect(() => sessions.reserve('owner-1')).toThrow(
      'voice service is shutting down',
    );
  });
});
