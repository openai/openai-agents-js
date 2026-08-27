import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { DemoAuthStore } from '../src/server/demoAuth';
import { requestCsrfToken } from '../src/client/demoAuthClient';
import { closeRemoteSession as closeWithAuthentication } from '../src/client/closeRemoteSession';
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
  it('aborts old cookie-setting authentication before admitting a replacement', async () => {
    const auth = new DemoAuthStore({ secureCookie: false });
    let cookie = '';
    let deliverOld!: () => void;
    let requests = 0;
    const request = () => ({ headers: { cookie } }) as IncomingMessage;
    const fetchAuth: typeof fetch = async (_input, init) => {
      const result = auth.getOrCreate(request());
      return new Promise<Response>((resolve, reject) => {
        const deliver = () => {
          if (init?.signal?.aborted) return;
          cookie = result.setCookie!.split(';')[0]!;
          resolve(Response.json({ csrfToken: result.principal.csrfToken }));
        };
        init?.signal?.addEventListener(
          'abort',
          () => reject(new Error('Aborted')),
          { once: true },
        );
        if (++requests === 1) deliverOld = deliver;
        else deliver();
      });
    };
    let replacementOwner = '';
    let replacementToken = '';
    const coordinator = new VoiceSessionCoordinator({
      closeRemoteSession: vi.fn(async () => {}),
      createConnection: () => {
        const abort = new AbortController();
        return {
          muted: false,
          setMuted: vi.fn(),
          close: () => abort.abort(),
          async connect(exchangeSdp) {
            await exchangeSdp('offer', abort.signal);
          },
        };
      },
      async exchangeOffer({ token }) {
        replacementOwner = auth.authenticate(request())!.ownerId;
        replacementToken = token;
        return 'answer';
      },
      getCsrfToken: (signal) => requestCsrfToken(fetchAuth, signal),
      onControls: vi.fn(),
      onStatus: vi.fn(),
      openEvents: () => ({ close: vi.fn() }),
    });
    const starting = coordinator.start();
    await vi.waitFor(() => expect(deliverOld).toBeTypeOf('function'));
    await coordinator.stop();
    await coordinator.start();
    deliverOld();
    await starting;

    const current = auth.authenticate(request())!;
    expect(current.ownerId).toBe(replacementOwner);
    const authorizedRequest = request();
    authorizedRequest.headers['x-csrf-token'] = replacementToken;
    expect(auth.verifyCsrf(authorizedRequest, current)).toBe(true);
    await coordinator.stop();
  });

  it.each(['Stop', 'server event', 'event stream error'])(
    'retains failed cleanup after %s and allows a deduplicated Stop retry',
    async (trigger) => {
      const retry = deferred<void>();
      const sessions = new SessionManager({ hangup: vi.fn(async () => {}) });
      const activeConnection = connection(async (exchangeSdp) => {
        await exchangeSdp('offer', new AbortController().signal);
      });
      const eventStream = { close: vi.fn() };
      let onMessage: ((value: unknown) => void) | undefined;
      let onError: (() => void) | undefined;
      let sessionId = '';
      const exchangeOffer = vi.fn(async (input: { sessionId: string }) => {
        sessionId = sessions.reserve('owner-1', input.sessionId);
        sessions.activate(sessionId);
        return 'answer';
      });
      const closeRemoteSession = vi
        .fn(async (id: string, _token: string) => {
          await retry.promise;
          await sessions.cancel(id, 'owner-1');
        })
        .mockRejectedValueOnce(new Error('Network unavailable.'));
      const onControls = vi.fn();
      const onStatus = vi.fn();
      const coordinator = new VoiceSessionCoordinator({
        closeRemoteSession,
        createConnection: () => activeConnection,
        exchangeOffer,
        getCsrfToken: vi.fn(async () => 'csrf-token'),
        onControls,
        onStatus,
        openEvents: (options) => {
          onMessage = options.onMessage;
          onError = options.onError;
          return eventStream;
        },
      });
      await coordinator.start();
      const originalId = sessionId;
      const oldError = onError;
      if (trigger === 'Stop') {
        await coordinator.stop();
      } else {
        if (trigger === 'event stream error') onError?.();
        else onMessage?.({ type: 'app.session.closed' });
        await vi.waitFor(() =>
          expect(onStatus).toHaveBeenLastCalledWith('error'),
        );
      }
      await coordinator.start();
      expect(exchangeOffer).toHaveBeenCalledOnce();
      expect(onControls).toHaveBeenLastCalledWith({
        canMute: false,
        canStart: false,
        canStop: true,
        muted: false,
      });
      expect(sessions.ownsActive(originalId, 'owner-1')).toBe(true);

      const stopping = coordinator.stop();
      const concurrentStop = coordinator.stop();
      await vi.waitFor(() =>
        expect(closeRemoteSession).toHaveBeenCalledTimes(2),
      );
      expect(onControls.mock.lastCall?.[0].canStop).toBe(false);
      retry.resolve();
      await Promise.all([stopping, concurrentStop]);

      expect(closeRemoteSession.mock.calls).toEqual([
        [originalId, 'csrf-token'],
        [originalId, 'csrf-token'],
      ]);
      expect(activeConnection.close).toHaveBeenCalledOnce();
      expect(eventStream.close).toHaveBeenCalledOnce();
      expect(onControls.mock.lastCall?.[0].canStart).toBe(true);
      await coordinator.start();
      oldError?.();
      expect(sessions.ownsActive(sessionId, 'owner-1')).toBe(true);
      expect(sessionId).not.toBe(originalId);
      await coordinator.stop();
    },
  );

  it.each(['Close', 'authentication refresh'])(
    'keeps cleanup retryable when %s stalls past the deadline',
    async (phase) => {
      vi.useFakeTimers();
      const timeout = vi
        .spyOn(AbortSignal, 'timeout')
        .mockImplementation((delay) => {
          const abort = new AbortController();
          setTimeout(() => abort.abort(new Error('Request timed out.')), delay);
          return abort.signal;
        });
      try {
        let stalled = true;
        const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
          if (!stalled) return new Response(null, { status: 204 });
          if (
            phase === 'authentication refresh' &&
            url !== '/api/auth/session'
          ) {
            return new Response(null, { status: 401 });
          }
          return new Promise<Response>((_resolve, reject) => {
            init!.signal!.addEventListener(
              'abort',
              () => reject(init!.signal!.reason),
              { once: true },
            );
          });
        });
        const onControls = vi.fn();
        const closeRemoteSession = vi.fn((id: string, token: string) =>
          closeWithAuthentication(id, token, fetchImpl),
        );
        const coordinator = new VoiceSessionCoordinator({
          closeRemoteSession,
          createConnection: () =>
            connection(async (exchange) => {
              await exchange('offer', new AbortController().signal);
            }),
          exchangeOffer: async () => 'answer',
          getCsrfToken: async () => 'token',
          onControls,
          onStatus: vi.fn(),
          openEvents: () => ({ close: vi.fn() }),
        });
        await coordinator.start();
        const stopping = coordinator.stop();
        await vi.advanceTimersByTimeAsync(14_999);
        expect(onControls.mock.lastCall?.[0]).toMatchObject({
          canStart: false,
          canStop: false,
        });
        await vi.advanceTimersByTimeAsync(1);
        await stopping;
        expect(onControls.mock.lastCall?.[0]).toMatchObject({
          canStart: false,
          canStop: true,
        });

        stalled = false;
        await coordinator.stop();
        expect(closeRemoteSession.mock.calls[1]).toEqual(
          closeRemoteSession.mock.calls[0],
        );
        expect(onControls.mock.lastCall?.[0].canStart).toBe(true);
      } finally {
        timeout.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it('refreshes authentication immediately before exchanging the SDP offer', async () => {
    const onControls = vi.fn();
    const getCsrfToken = vi.fn(async () => 'fresh-token');
    const exchangeOffer = vi.fn(async ({ sessionId, token }) => {
      expect(token).toBe('fresh-token');
      expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
      return 'answer';
    });
    const activeConnection = connection(async (exchangeSdp) => {
      expect(getCsrfToken).not.toHaveBeenCalled();
      expect(onControls.mock.lastCall?.[0].canMute).toBe(false);
      await exchangeSdp('offer', new AbortController().signal);
    });
    const coordinator = new VoiceSessionCoordinator({
      closeRemoteSession: vi.fn(async () => {}),
      createConnection: () => activeConnection,
      exchangeOffer,
      getCsrfToken,
      onControls,
      onStatus: vi.fn(),
      openEvents: vi.fn(() => ({ close: vi.fn() })),
    });

    await coordinator.start();

    expect(getCsrfToken).toHaveBeenCalledOnce();
    expect(exchangeOffer).toHaveBeenCalledOnce();
    expect(onControls.mock.lastCall?.[0].canMute).toBe(true);
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
