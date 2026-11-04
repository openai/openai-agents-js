import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import console from 'node:console';
import process from 'node:process';
import { randomBytes, timingSafeEqual } from 'node:crypto';

const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_REALTIME_MODEL ?? 'gpt-realtime-2.1';
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';
const pairingToken =
  host === '127.0.0.1' || host === '::1' || host === 'localhost'
    ? null
    : randomBytes(24).toString('base64url');
const tokenRequests = new Map();

if (!apiKey) {
  throw new Error('Set OPENAI_API_KEY before starting the token server.');
}

const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    sendJson(response, 200, { ok: true });
    return;
  }
  if (request.method !== 'POST' || request.url !== '/token') {
    sendJson(response, 404, { error: 'Not found.' });
    return;
  }
  if (pairingToken) {
    const expected = Buffer.from(`Bearer ${pairingToken}`);
    const supplied = Buffer.from(request.headers.authorization ?? '');
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    ) {
      sendJson(response, 401, { error: 'Pairing token required.' });
      return;
    }
  }

  const client = request.socket.remoteAddress;
  const now = Date.now();
  let window = tokenRequests.get(client);
  if (!window || now >= window.resetAt) {
    window = { count: 0, resetAt: now + 60_000 };
    tokenRequests.set(client, window);
  }
  if (window.count >= 6) {
    sendJson(response, 429, { error: 'Too many token requests.' });
    return;
  }
  window.count += 1;

  try {
    const tokenResponse = await globalThis.fetch(
      'https://api.openai.com/v1/realtime/client_secrets',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          session: {
            type: 'realtime',
            model,
          },
        }),
      },
    );
    const body = await tokenResponse.text();
    if (!tokenResponse.ok) {
      console.error(
        `Client secret request failed with status ${tokenResponse.status}.`,
      );
      sendJson(response, tokenResponse.status, {
        error: 'Failed to create an ephemeral client key.',
      });
      return;
    }

    const token = JSON.parse(body);
    sendJson(response, 200, {
      value: token.value,
      expires_at: token.expires_at,
    });
  } catch (error) {
    console.error('Client secret request failed.', error);
    sendJson(response, 500, {
      error: 'Failed to create an ephemeral client key.',
    });
  }
});

if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
  console.warn(
    `The token server is reachable beyond this machine because HOST is ${host}.`,
  );
}

server.listen(port, host, () => {
  if (pairingToken) {
    console.log(`Pairing token: ${pairingToken}`);
  }
  console.log(`Realtime token server listening on http://${host}:${port}`);
});

function sendJson(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}
