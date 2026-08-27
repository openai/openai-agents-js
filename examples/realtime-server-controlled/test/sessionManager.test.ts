import { describe, expect, it, vi } from 'vitest';
import {
  SessionConflictError,
  SessionManager,
} from '../src/server/sessionManager';

describe('SessionManager', () => {
  it('allows only one session per authenticated owner', () => {
    const sessions = new SessionManager({ hangup: vi.fn(async () => {}) });
    sessions.reserve('owner-1');
    expect(() => sessions.reserve('owner-1')).toThrow(SessionConflictError);
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
