import { createServer } from 'node:http';
import console from 'node:console';
import process from 'node:process';

const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.OPENAI_REALTIME_MODEL ?? 'gpt-realtime-2.1';
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? '127.0.0.1';

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
  console.log(`Realtime token server listening on http://${host}:${port}`);
});

function sendJson(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
}
