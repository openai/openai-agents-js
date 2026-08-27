import { describe, expect, it, vi } from 'vitest';
import {
  VoiceSessionCoordinator,
  type VoiceConnection,
} from '../src/client/voiceSessionCoordinator';
import { SessionManager } from '../src/server/sessionManager';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function connection(connect: VoiceConnection['connect']): VoiceConnection & {
  close: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
} {
  let muted = false;
  return {
    close: vi.fn(),
    connect: vi.fn(connect),
    get muted() {
      return muted;
    },
    setMuted(nextMuted) {
      muted = nextMuted;
    },
  };
}

describe('VoiceSessionCoordinator', () => {
  it('refreshes authentication immediately before exchanging the SDP offer', async () => {
    const getCsrfToken = vi.fn(async () => 'fresh-token');
    const exchangeOffer = vi.fn(async ({ sessionId, token }) => {
      expect(token).toBe('fresh-token');
      expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
      return 'answer';
    });
    const activeConnection = connection(async (exchangeSdp) => {
      expect(getCsrfToken).not.toHaveBeenCalled();
      await exchangeSdp('offer', new AbortController().signal);
    });
    const coordinator = new VoiceSessionCoordinator({
      closeRemoteSession: vi.fn(async () => {}),
      createConnection: () => activeConnection,
      exchangeOffer,
      getCsrfToken,
      onControls: vi.fn(),
      onStatus: vi.fn(),
      openEvents: vi.fn(() => ({ close: vi.fn() })),
    });

    await coordinator.start();

    expect(getCsrfToken).toHaveBeenCalledOnce();
    expect(exchangeOffer).toHaveBeenCalledOnce();
    await coordinator.stop();
  });

  it('keeps a replacement active when a cancelled setup fails later', async () => {
    const oldSetup = deferred<void>();
    const oldConnection = connection(() => oldSetup.promise);
    const newConnection = connection(async (exchangeSdp) => {
      await exchangeSdp('new-offer', new AbortController().signal);
    });
    const connections = [oldConnection, newConnection];
    const eventStream = { close: vi.fn() };
    const statuses: string[] = [];
    const coordinator = new VoiceSessionCoordinator({
      closeRemoteSession: vi.fn(async () => {}),
      createConnection: () => connections.shift()!,
      exchangeOffer: vi.fn(async () => 'new-answer'),
      getCsrfToken: vi.fn(async () => 'csrf-token'),
      onControls: vi.fn(),
      onStatus: (status) => statuses.push(status),
      openEvents: vi.fn(() => eventStream),
    });

    const oldStart = coordinator.start();
    await vi.waitFor(() =>
      expect(oldConnection.connect).toHaveBeenCalledOnce(),
    );
    await coordinator.stop();
    await coordinator.start();

    oldSetup.reject(new Error('Old media acquisition failed.'));
    await oldStart;

    expect(oldConnection.close).toHaveBeenCalledOnce();
    expect(newConnection.close).not.toHaveBeenCalled();
    expect(eventStream.close).not.toHaveBeenCalled();
    expect(statuses.at(-1)).not.toBe('error');

    await coordinator.stop();
  });

  it('closes the requested session when the signaling response is lost', async () => {
    const signalingResponse = deferred<string>();
    const activeConnection = connection(async (exchangeSdp) => {
      await exchangeSdp('offer', new AbortController().signal);
    });
    const closeRemoteSession = vi.fn(async () => {});
    let requestedSessionId: string | undefined;
    const coordinator = new VoiceSessionCoordinator({
      closeRemoteSession,
      createConnection: () => activeConnection,
      exchangeOffer: vi.fn(({ sessionId }) => {
        requestedSessionId = sessionId;
        return signalingResponse.promise;
      }),
      getCsrfToken: vi.fn(async () => 'csrf-token'),
      onControls: vi.fn(),
      onStatus: vi.fn(),
      openEvents: vi.fn(() => ({ close: vi.fn() })),
    });

    const starting = coordinator.start();
    await vi.waitFor(() => expect(requestedSessionId).toBeDefined());

    await coordinator.stop();

    expect(closeRemoteSession).toHaveBeenCalledOnce();
    expect(closeRemoteSession).toHaveBeenCalledWith(
      requestedSessionId,
      'csrf-token',
    );

    signalingResponse.reject(
      new Error('The signaling response was not delivered.'),
    );
    await starting;
  });

  it('does not admit a replacement until the previous owner reservation closes', async () => {
    const oldRemoteClose = deferred<void>();
    const sessions = new SessionManager({ hangup: vi.fn(async () => {}) });
    const connections = [
      connection(async (exchangeSdp) => {
        await exchangeSdp('old-offer', new AbortController().signal);
      }),
      connection(async (exchangeSdp) => {
        await exchangeSdp('new-offer', new AbortController().signal);
      }),
    ];
    let oldSessionId: string | undefined;
    let newSessionId: string | undefined;
    const statuses: string[] = [];
    const onControls = vi.fn();
    const exchangeOffer = vi.fn(
      async ({ sessionId }: { sessionId: string }) => {
        sessions.reserve('owner-1', sessionId);
        sessions.activate(sessionId);
        if (!oldSessionId) {
          oldSessionId = sessionId;
        } else {
          newSessionId = sessionId;
        }
        return 'answer';
      },
    );
    const getCsrfToken = vi.fn(async () => 'csrf-token');
    const coordinator = new VoiceSessionCoordinator({
      closeRemoteSession: vi.fn(async (sessionId) => {
        if (sessionId === oldSessionId) {
          await oldRemoteClose.promise;
        }
        await sessions.cancel(sessionId, 'owner-1');
      }),
      createConnection: () => connections.shift()!,
      exchangeOffer,
      getCsrfToken,
      onControls,
      onStatus: (status) => statuses.push(status),
      openEvents: vi.fn(() => ({ close: vi.fn() })),
    });

    await coordinator.start();
    const oldStop = coordinator.stop();
    await coordinator.start();

    expect(onControls).toHaveBeenLastCalledWith({
      canMute: false,
      canStart: false,
      canStop: false,
      muted: false,
    });
    expect(exchangeOffer).toHaveBeenCalledOnce();
    expect(getCsrfToken).toHaveBeenCalledOnce();
    expect(sessions.ownsActive(oldSessionId!, 'owner-1')).toBe(true);

    oldRemoteClose.resolve();
    await oldStop;
    await coordinator.start();

    expect(exchangeOffer).toHaveBeenCalledTimes(2);
    expect(sessions.ownsActive(newSessionId!, 'owner-1')).toBe(true);
    expect(statuses.at(-1)).toBe('connecting');
    await coordinator.stop();
  });

  it('keeps Start disabled while failed setup cleanup is pending', async () => {
    const remoteClose = deferred<void>();
    const closeRemoteSession = vi.fn(() => remoteClose.promise);
    const exchangeOffer = vi.fn(async () => {
      throw new Error('The signaling response was lost.');
    });
    const createConnection = vi.fn(() =>
      connection(async (exchangeSdp) => {
        await exchangeSdp('offer', new AbortController().signal);
      }),
    );
    const onControls = vi.fn();
    const coordinator = new VoiceSessionCoordinator({
      closeRemoteSession,
      createConnection,
      exchangeOffer,
      getCsrfToken: vi.fn(async () => 'csrf-token'),
      onControls,
      onStatus: vi.fn(),
      openEvents: vi.fn(() => ({ close: vi.fn() })),
    });

    const starting = coordinator.start();
    await vi.waitFor(() => expect(closeRemoteSession).toHaveBeenCalledOnce());
    const stopping = coordinator.stop();
    await coordinator.start();

    expect(createConnection).toHaveBeenCalledOnce();
    expect(onControls.mock.lastCall?.[0].canStart).toBe(false);

    remoteClose.resolve();
    await Promise.all([starting, stopping]);

    expect(closeRemoteSession).toHaveBeenCalledOnce();
    expect(onControls.mock.lastCall?.[0].canStart).toBe(true);
  });
});
