import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiServer } from '../src/server/apiServer';
import { DemoAuthStore } from '../src/server/demoAuth';
import { SessionManager } from '../src/server/sessionManager';
import { shutdownApiServer } from '../src/server/shutdown';
import { closeRemoteSession } from '../src/client/closeRemoteSession';
import { requestCsrfToken } from '../src/client/demoAuthClient';
import { VoiceSessionCoordinator } from '../src/client/voiceSessionCoordinator';
import type { VoiceController } from '../src/server/voiceController';

const appOrigin = 'http://app.example';
const audioSdp = [
  'v=0',
  'o=- 1 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
].join('\r\n');

const servers: ReturnType<typeof createApiServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

async function createHarness(hangup = vi.fn(async () => {}), now = Date.now) {
  const sessions = new SessionManager({ hangup, now });
  const start = vi.fn(
    async ({ ownerId, sessionId }: { ownerId: string; sessionId: string }) => {
      sessions.reserve(ownerId, sessionId);
      sessions.attachCall(sessionId, 'rtc_test');
      sessions.activate(sessionId);
      return { answerSdp: audioSdp, sessionId };
    },
  );
  const controller = { start } as unknown as VoiceController;
  const server = createApiServer({
    appOrigin,
    auth: new DemoAuthStore({ secureCookie: false, now }),
    controller,
    sessions,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  const authResponse = await fetch(`${baseUrl}/api/auth/session`);
  const cookie = authResponse.headers.get('set-cookie');
  const authBody = (await authResponse.json()) as { csrfToken: string };
  if (!cookie) {
    throw new Error('Test auth did not return a cookie.');
  }

  return {
    baseUrl,
    cookie,
    csrfToken: authBody.csrfToken,
    server,
    sessions,
    start,
  };
}

describe('createApiServer', () => {
  it('recovers Stop and Start after cleanup failure and demo authentication expiry', async () => {
    let now = 1_000;
    const hangup = vi
      .fn(async () => {})
      .mockRejectedValueOnce(new Error('timeout'));
    const harness = await createHarness(hangup, () => now);
    let cookie = harness.cookie;
    const responses: number[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      if (cookie) headers.set('Cookie', cookie);
      if (init?.method === 'POST') headers.set('Origin', appOrigin);
      const response = await fetch(`${harness.baseUrl}${input}`, {
        ...init,
        headers,
      });
      cookie = response.headers.get('set-cookie') ?? cookie;
      responses.push(response.status);
      return response;
    };
    const onControls = vi.fn();
    const coordinator = new VoiceSessionCoordinator({
      closeRemoteSession: (id, token) =>
        closeRemoteSession(id, token, fetchImpl),
      createConnection: () => ({
        close: vi.fn(),
        muted: false,
        setMuted: vi.fn(),
        async connect(exchangeSdp) {
          await exchangeSdp(audioSdp, new AbortController().signal);
        },
      }),
      async exchangeOffer({ sessionId, token, offerSdp }) {
        const response = await fetchImpl('/api/realtime/session', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/sdp',
            'X-CSRF-Token': token,
            'X-App-Session-Id': sessionId,
          },
          body: offerSdp,
        });
        if (!response.ok) throw new Error('Setup failed');
        return response.text();
      },
      getCsrfToken: (signal) => requestCsrfToken(fetchImpl, signal),
      onControls,
      onStatus: vi.fn(),
      openEvents: () => ({ close: vi.fn() }),
    });
    await coordinator.start();
    await coordinator.stop();
    expect(onControls.mock.lastCall?.[0]).toMatchObject({
      canStart: false,
      canStop: true,
    });
    expect(responses.at(-1)).toBe(502);

    now += 60 * 60_000 + 1;
    cookie = ''; // The browser has expired the demo cookie too.
    await harness.sessions.closeExpired(30 * 60_000);
    await coordinator.stop();

    expect(responses.slice(-3)).toEqual([401, 200, 404]);
    expect(onControls.mock.lastCall?.[0]).toMatchObject({
      canStart: true,
      canStop: false,
    });
    expect(hangup).toHaveBeenCalledTimes(2);
    await coordinator.start();
    expect(harness.start).toHaveBeenCalledTimes(2);
    expect(onControls.mock.lastCall?.[0].canStop).toBe(true);
    await coordinator.stop();
  });

  it('returns an error for failed hangup and accepts an authenticated close retry', async () => {
    const hangup = vi
      .fn(async () => {})
      .mockRejectedValueOnce(new Error('private provider failure'));
    const harness = await createHarness(hangup);
    const sessionId = randomUUID();
    const headers = {
      Cookie: harness.cookie,
      Origin: appOrigin,
      'X-CSRF-Token': harness.csrfToken,
      'X-App-Session-Id': sessionId,
      'Content-Type': 'application/sdp',
    };
    const start = await fetch(`${harness.baseUrl}/api/realtime/session`, {
      method: 'POST',
      headers,
      body: audioSdp,
    });
    expect(start.status).toBe(200);
    const closeUrl = `${harness.baseUrl}/api/realtime/sessions/${sessionId}/close`;
    const firstClose = await fetch(closeUrl, { method: 'POST', headers });
    expect(firstClose.status).toBe(502);
    expect(await firstClose.json()).toEqual({
      error: 'Could not complete the voice session request.',
    });
    const retry = await fetch(closeUrl, { method: 'POST', headers });
    expect(retry.status).toBe(204);
    expect(hangup.mock.calls).toEqual([['rtc_test'], ['rtc_test']]);

    const replacement = await fetch(`${harness.baseUrl}/api/realtime/session`, {
      method: 'POST',
      headers: { ...headers, 'X-App-Session-Id': randomUUID() },
      body: audioSdp,
    });
    expect(replacement.status).toBe(200);
    await harness.sessions.closeAll();
  });

  it.each([undefined, 'incorrect-token'])(
    'rejects a mutation with the exact origin and invalid CSRF token %s',
    async (csrfToken) => {
      const harness = await createHarness();
      const headers: Record<string, string> = {
        Cookie: harness.cookie,
        'Content-Type': 'application/sdp',
        Origin: appOrigin,
        'X-App-Session-Id': randomUUID(),
      };
      if (csrfToken) {
        headers['X-CSRF-Token'] = csrfToken;
      }

      const response = await fetch(`${harness.baseUrl}/api/realtime/session`, {
        method: 'POST',
        headers,
        body: audioSdp,
      });

      expect(response.status).toBe(403);
      expect(harness.start).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, 'not-a-uuid'])(
    'rejects an invalid application session ID %s',
    async (sessionId) => {
      const harness = await createHarness();
      const headers: Record<string, string> = {
        Cookie: harness.cookie,
        'Content-Type': 'application/sdp',
        Origin: appOrigin,
        'X-CSRF-Token': harness.csrfToken,
      };
      if (sessionId) {
        headers['X-App-Session-Id'] = sessionId;
      }

      const response = await fetch(`${harness.baseUrl}/api/realtime/session`, {
        method: 'POST',
        headers,
        body: audioSdp,
      });

      expect(response.status).toBe(400);
      expect(harness.start).not.toHaveBeenCalled();
    },
  );

  it('rejects a data-channel SDP before invoking the controller', async () => {
    const harness = await createHarness();
    const response = await fetch(`${harness.baseUrl}/api/realtime/session`, {
      method: 'POST',
      headers: {
        Cookie: harness.cookie,
        'Content-Type': 'application/sdp',
        Origin: appOrigin,
        'X-App-Session-Id': randomUUID(),
        'X-CSRF-Token': harness.csrfToken,
      },
      body: `${audioSdp}\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel`,
    });

    expect(response.status).toBe(400);
    expect(harness.start).not.toHaveBeenCalled();
  });

  it('exchanges valid audio SDP through the authenticated controller', async () => {
    const harness = await createHarness();
    const sessionId = randomUUID();
    const response = await fetch(`${harness.baseUrl}/api/realtime/session`, {
      method: 'POST',
      headers: {
        Cookie: harness.cookie,
        'Content-Type': 'application/sdp',
        Origin: appOrigin,
        'X-App-Session-Id': sessionId,
        'X-CSRF-Token': harness.csrfToken,
      },
      body: audioSdp,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/sdp');
    expect(response.headers.get('x-app-session-id')).toBe(sessionId);
    await expect(response.text()).resolves.toBe(audioSdp);
    expect(harness.start).toHaveBeenCalledWith({
      offerSdp: audioSdp,
      ownerId: expect.any(String),
      safetyIdentifier: expect.stringMatching(/^[0-9a-f]{64}$/),
      sessionId,
      signal: expect.any(AbortSignal),
    });
  });

  it('rejects setup when its authenticated close arrived first', async () => {
    const harness = await createHarness();
    const sessionId = randomUUID();
    const closeResponse = await fetch(
      `${harness.baseUrl}/api/realtime/sessions/${sessionId}/close`,
      {
        method: 'POST',
        headers: {
          Cookie: harness.cookie,
          Origin: appOrigin,
          'X-CSRF-Token': harness.csrfToken,
        },
      },
    );

    expect(closeResponse.status).toBe(204);

    const createResponse = await fetch(
      `${harness.baseUrl}/api/realtime/session`,
      {
        method: 'POST',
        headers: {
          Cookie: harness.cookie,
          'Content-Type': 'application/sdp',
          Origin: appOrigin,
          'X-App-Session-Id': sessionId,
          'X-CSRF-Token': harness.csrfToken,
        },
        body: audioSdp,
      },
    );

    expect(createResponse.status).toBe(409);
    await expect(createResponse.json()).resolves.toEqual({
      error: 'This voice session setup was cancelled.',
    });
  });

  it('rejects malformed cancellation identifiers', async () => {
    const harness = await createHarness();
    const response = await fetch(
      `${harness.baseUrl}/api/realtime/sessions/not-a-uuid/close`,
      {
        method: 'POST',
        headers: {
          Cookie: harness.cookie,
          Origin: appOrigin,
          'X-CSRF-Token': harness.csrfToken,
        },
      },
    );

    expect(response.status).toBe(404);
  });

  it('does not start a call after the signaling request is aborted', async () => {
    const harness = await createHarness();

    await new Promise<void>((resolve) => {
      const request = httpRequest(`${harness.baseUrl}/api/realtime/session`, {
        method: 'POST',
        headers: {
          Cookie: harness.cookie,
          'Content-Length': Buffer.byteLength(audioSdp) + 10,
          'Content-Type': 'application/sdp',
          Origin: appOrigin,
          'X-App-Session-Id': randomUUID(),
          'X-CSRF-Token': harness.csrfToken,
        },
      });
      request.on('error', () => resolve());
      request.write(audioSdp, () => request.destroy());
    });
    await fetch(`${harness.baseUrl}/health`);

    expect(harness.start).not.toHaveBeenCalled();
  });

  it('terminates an open signaling upload during server shutdown', async () => {
    const harness = await createHarness();
    let shutdownPromise: Promise<void> | undefined;
    const requestClosed = new Promise<void>((resolve) => {
      const request = httpRequest(`${harness.baseUrl}/api/realtime/session`, {
        method: 'POST',
        headers: {
          Cookie: harness.cookie,
          'Content-Length': Buffer.byteLength(audioSdp) + 10,
          'Content-Type': 'application/sdp',
          Origin: appOrigin,
          'X-App-Session-Id': randomUUID(),
          'X-CSRF-Token': harness.csrfToken,
        },
      });
      request.on('error', () => resolve());
      request.write(audioSdp, () => {
        setImmediate(() => {
          shutdownPromise = shutdownApiServer(harness.server, harness.sessions);
        });
      });
    });

    await requestClosed;
    await vi.waitFor(() => expect(shutdownPromise).toBeDefined());
    await shutdownPromise;
    expect(harness.server.listening).toBe(false);
    expect(harness.start).not.toHaveBeenCalled();
  });

  it('hides active session events and close from another principal', async () => {
    const harness = await createHarness();
    const createResponse = await fetch(
      `${harness.baseUrl}/api/realtime/session`,
      {
        method: 'POST',
        headers: {
          Cookie: harness.cookie,
          'Content-Type': 'application/sdp',
          Origin: appOrigin,
          'X-App-Session-Id': randomUUID(),
          'X-CSRF-Token': harness.csrfToken,
        },
        body: audioSdp,
      },
    );
    const sessionId = createResponse.headers.get('x-app-session-id')!;

    const secondAuthResponse = await fetch(
      `${harness.baseUrl}/api/auth/session`,
    );
    const secondCookie = secondAuthResponse.headers.get('set-cookie')!;
    const secondAuthBody = (await secondAuthResponse.json()) as {
      csrfToken: string;
    };

    const eventsResponse = await fetch(
      `${harness.baseUrl}/api/realtime/sessions/${sessionId}/events`,
      { headers: { Cookie: secondCookie } },
    );
    expect(eventsResponse.status).toBe(404);

    const closeResponse = await fetch(
      `${harness.baseUrl}/api/realtime/sessions/${sessionId}/close`,
      {
        method: 'POST',
        headers: {
          Cookie: secondCookie,
          Origin: appOrigin,
          'X-CSRF-Token': secondAuthBody.csrfToken,
        },
      },
    );
    expect(closeResponse.status).toBe(404);

    const ownerCloseResponse = await fetch(
      `${harness.baseUrl}/api/realtime/sessions/${sessionId}/close`,
      {
        method: 'POST',
        headers: {
          Cookie: harness.cookie,
          Origin: appOrigin,
          'X-CSRF-Token': harness.csrfToken,
        },
      },
    );
    expect(ownerCloseResponse.status).toBe(204);
  });
});
