import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { DemoAuthStore, DemoPrincipal } from './demoAuth';
import { MAX_SDP_BYTES, SdpPolicyError, assertAudioOnlySdp } from './sdpPolicy';
import {
  SessionCapacityError,
  SessionConflictError,
  type SessionManager,
} from './sessionManager';
import type { VoiceController } from './voiceController';

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};
const APP_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(body));
}

function requirePrincipal(
  request: IncomingMessage,
  auth: DemoAuthStore,
): DemoPrincipal {
  const principal = auth.authenticate(request);
  if (!principal) {
    throw new HttpError(401, 'Authentication is required.');
  }
  return principal;
}

function requireMutationSecurity(
  request: IncomingMessage,
  auth: DemoAuthStore,
  appOrigin: string,
): DemoPrincipal {
  if (request.headers.origin !== appOrigin) {
    throw new HttpError(403, 'The request origin is not allowed.');
  }
  const principal = requirePrincipal(request, auth);
  if (!auth.verifyCsrf(request, principal)) {
    throw new HttpError(403, 'The CSRF token is invalid.');
  }
  return principal;
}

function requireAppSessionId(request: IncomingMessage): string {
  const sessionId = request.headers['x-app-session-id'];
  if (
    typeof sessionId !== 'string' ||
    !APP_SESSION_ID_PATTERN.test(sessionId)
  ) {
    throw new HttpError(400, 'A valid X-App-Session-Id header is required.');
  }
  return sessionId;
}

async function readSdp(request: IncomingMessage): Promise<string> {
  const mediaType = (request.headers['content-type'] ?? '')
    .split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== 'application/sdp') {
    throw new HttpError(415, 'Expected an application/sdp request.');
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > MAX_SDP_BYTES) {
      throw new HttpError(413, 'The SDP offer is too large.');
    }
    chunks.push(buffer);
  }
  const sdp = Buffer.concat(chunks).toString('utf8');
  assertAudioOnlySdp(sdp);
  return sdp;
}

export function createApiServer(options: {
  appOrigin: string;
  auth: DemoAuthStore;
  controller: VoiceController;
  sessions: SessionManager;
}) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');

      if (request.method === 'GET' && url.pathname === '/health') {
        sendJson(response, 200, { status: 'ok' });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/api/auth/session') {
        const { principal, setCookie } = options.auth.getOrCreate(request);
        if (setCookie) {
          response.setHeader('Set-Cookie', setCookie);
        }
        sendJson(response, 200, { csrfToken: principal.csrfToken });
        return;
      }

      if (
        request.method === 'POST' &&
        url.pathname === '/api/realtime/session'
      ) {
        const principal = requireMutationSecurity(
          request,
          options.auth,
          options.appOrigin,
        );
        const sessionId = requireAppSessionId(request);
        const abortController = new AbortController();
        const handleAborted = () => {
          if (
            (request.aborted || response.destroyed) &&
            !response.writableEnded
          ) {
            abortController.abort(new Error('The browser cancelled setup.'));
          }
        };
        request.once('aborted', handleAborted);
        response.once('close', handleAborted);
        try {
          handleAborted();
          if (abortController.signal.aborted) {
            return;
          }
          const offerSdp = await readSdp(request);
          handleAborted();
          if (abortController.signal.aborted) {
            return;
          }
          const session = await options.controller.start({
            offerSdp,
            ownerId: principal.ownerId,
            safetyIdentifier: principal.safetyIdentifier,
            sessionId,
            signal: abortController.signal,
          });
          if (request.aborted || response.destroyed) {
            await options.sessions.close(session.sessionId, principal.ownerId);
            return;
          }
          response.writeHead(200, {
            ...SECURITY_HEADERS,
            'Content-Type': 'application/sdp',
            'X-App-Session-Id': session.sessionId,
          });
          response.end(session.answerSdp);
        } finally {
          request.off('aborted', handleAborted);
          response.off('close', handleAborted);
        }
        return;
      }

      const eventsMatch =
        /^\/api\/realtime\/sessions\/([0-9a-f-]+)\/events$/.exec(url.pathname);
      if (request.method === 'GET' && eventsMatch?.[1]) {
        const principal = requirePrincipal(request, options.auth);
        const sessionId = eventsMatch[1];
        if (!options.sessions.ownsActive(sessionId, principal.ownerId)) {
          throw new HttpError(404, 'Voice session not found.');
        }

        response.writeHead(200, {
          ...SECURITY_HEADERS,
          Connection: 'keep-alive',
          'Content-Type': 'text/event-stream; charset=utf-8',
        });
        const unsubscribe = options.sessions.subscribe(
          sessionId,
          principal.ownerId,
          {
            send(event) {
              response.write(`data: ${JSON.stringify(event)}\n\n`);
            },
            close() {
              response.end();
            },
          },
        );
        if (!unsubscribe) {
          response.end();
          return;
        }
        const keepAlive = setInterval(
          () => response.write(': keep-alive\n\n'),
          15_000,
        );
        request.on('close', () => {
          clearInterval(keepAlive);
          unsubscribe();
        });
        return;
      }

      const closeMatch =
        /^\/api\/realtime\/sessions\/([0-9a-f-]+)\/close$/.exec(url.pathname);
      if (
        request.method === 'POST' &&
        closeMatch?.[1] &&
        APP_SESSION_ID_PATTERN.test(closeMatch[1])
      ) {
        const principal = requireMutationSecurity(
          request,
          options.auth,
          options.appOrigin,
        );
        const closed = await options.sessions.cancel(
          closeMatch[1],
          principal.ownerId,
        );
        if (!closed) {
          throw new HttpError(404, 'Voice session not found.');
        }
        response.writeHead(204, SECURITY_HEADERS);
        response.end();
        return;
      }

      throw new HttpError(404, 'Not found.');
    } catch (error) {
      if (response.headersSent) {
        response.end();
        return;
      }
      if (error instanceof HttpError) {
        sendJson(response, error.status, { error: error.message });
      } else if (error instanceof SdpPolicyError) {
        sendJson(response, 400, { error: error.message });
      } else if (error instanceof SessionConflictError) {
        sendJson(response, 409, { error: error.message });
      } else if (error instanceof SessionCapacityError) {
        sendJson(response, 503, { error: error.message });
      } else {
        sendJson(response, 502, {
          error: 'Could not complete the voice session request.',
        });
      }
    }
  });
}
