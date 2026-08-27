import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiServer } from '../src/server/apiServer';
import { DemoAuthStore } from '../src/server/demoAuth';
import { SessionManager } from '../src/server/sessionManager';
import { shutdownApiServer } from '../src/server/shutdown';
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

async function createHarness() {
  const sessions = new SessionManager({ hangup: vi.fn(async () => {}) });
  const start = vi.fn(
    async ({ ownerId, sessionId }: { ownerId: string; sessionId: string }) => {
      sessions.reserve(ownerId, sessionId);
      sessions.activate(sessionId);
      return { answerSdp: audioSdp, sessionId };
    },
  );
  const controller = { start } as unknown as VoiceController;
  const server = createApiServer({
    appOrigin,
    auth: new DemoAuthStore({ secureCookie: false }),
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
