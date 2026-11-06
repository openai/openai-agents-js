import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import OpenAI from 'openai';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { createOrderAgent, sessionConfig } from './agent';
import { DelegationHandler, type ResponseEnvelope } from './delegation';

const localOrigins = new Set([
  'http://localhost:8000',
  'http://127.0.0.1:8000',
]);
const offerSchema = z.strictObject({
  // SDP line endings are significant; validate emptiness without changing them.
  sdp: z
    .string()
    .max(65536)
    .refine((sdp) => sdp.trim().length > 0),
});
const closeTimeout = 15_000;

// Only operational metadata may cross into browser UI or terminal diagnostics.
function sessionFailure(stage: string, error: unknown): string {
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return `${stage} timed out. Check network connectivity and try again.`;
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return `${stage} could not reach OpenAI. Check network connectivity and proxy settings.`;
  }
  if (error instanceof OpenAI.APIError) {
    const status = error.status;
    const hints: Record<number, string> = {
      400: 'Check the Live session configuration and browser SDP offer.',
      401: 'Check the server API key.',
      403: 'Check the API project permissions and GPT Live access.',
      404: 'Check GPT Live availability for this project and the configured model.',
      429: 'Check the API project quota and rate limits.',
    };
    const hint =
      status === undefined
        ? 'Check the server configuration.'
        : (hints[status] ??
          (status >= 500
            ? 'OpenAI returned a server error. Try again later.'
            : 'Check the server configuration.'));
    const http = status === undefined ? '' : ` (HTTP ${status})`;
    const request = error.requestID ? ` Request ID: ${error.requestID}.` : '';
    return `${stage} failed${http}. ${hint}${request}`;
  }
  return `${stage} failed. Check the browser connection and server configuration.`;
}

function attach(client: OpenAI, sessionId: string) {
  return new WebSocket(
    `wss://api.openai.com/v1/live/sessions/${encodeURIComponent(sessionId)}/attach`,
    {
      headers: {
        Authorization: `Bearer ${client.apiKey}`,
        ...(client.organization
          ? { 'OpenAI-Organization': client.organization }
          : {}),
        ...(client.project ? { 'OpenAI-Project': client.project } : {}),
      },
      handshakeTimeout: 15_000,
    },
  );
}

// Install all receivers before the sideband opens; one owner executes functions.
export function relay(
  connection: WebSocket,
  notify: (event: Record<string, unknown>) => void,
  answer: { sdp: string },
  agent = createOrderAgent(),
) {
  let stopping = false;
  let finalized = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveDone: (confirmed: boolean) => void;
  const done = new Promise<boolean>((resolve) => {
    resolveDone = resolve;
  });
  const send = (event: Record<string, unknown>) => {
    if (connection.readyState !== WebSocket.OPEN)
      throw new Error('Sideband is not open.');
    connection.send(JSON.stringify(event), (error) => {
      if (error) finish();
    });
  };
  const handler = new DelegationHandler(agent, send, notify, () => stop());
  function finish() {
    handler.stop();
    clearTimeout(timer);
    connection.terminate();
    resolveDone(finalized);
  }
  function requestClose() {
    timer = setTimeout(finish, closeTimeout);
    try {
      send({ type: 'session.close' });
    } catch {
      finish();
    }
  }
  function stop() {
    if (stopping) return;
    stopping = true;
    handler.stop();
    if (connection.readyState === WebSocket.OPEN) requestClose();
    // A connecting sideband retains its handshake deadline and closes on open.
  }
  connection.on('open', () => {
    if (stopping) {
      requestClose();
      return;
    }
    try {
      notify({ type: 'answer', sdp: answer.sdp });
    } catch {
      stop();
    }
  });
  connection.on('message', (raw) => {
    try {
      const event = JSON.parse(raw.toString());
      if (event.type === 'session.closed') {
        finalized = true;
        handler.stop();
        try {
          notify({ type: 'closed', reason: event.reason, usage: event.usage });
        } finally {
          finish();
        }
      } else if (event.type === 'error') {
        stop();
      } else if (!stopping && event.type === 'response.event') {
        handler.receive(event as ResponseEnvelope);
      } else if (
        !stopping &&
        [
          'session.input_transcript.delta',
          'session.output_transcript.delta',
          'session.usage.updated',
        ].includes(event.type)
      ) {
        notify(event);
      }
    } catch {
      stop();
    }
  });
  connection.on('error', finish);
  connection.on('close', finish);
  return { stop, done };
}

// A failed initial attachment may still leave a created Live session running.
async function closeUnattachedSession(client: OpenAI, sessionId: string) {
  const cleanup = relay(attach(client, sessionId), () => {}, { sdp: '' });
  cleanup.stop();
  return cleanup.done;
}

export async function handleBrowser(browser: WebSocket, client: OpenAI) {
  let stage = 'Browser offer';
  let stopping = false;
  let active: ReturnType<typeof relay> | undefined;
  let offerTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    stopping = true;
    active?.stop();
  };
  const notify = (event: Record<string, unknown>) => {
    if (browser.readyState === WebSocket.OPEN) {
      browser.send(JSON.stringify(event), (error) => {
        if (error) stop();
      });
    }
  };
  browser.on('close', stop);
  browser.on('error', stop);
  try {
    const offer = await new Promise<z.infer<typeof offerSchema>>(
      (resolve, reject) => {
        const fail = () =>
          reject(new Error('Browser disconnected before its offer.'));
        browser.once('close', fail);
        browser.once('error', fail);
        offerTimer = setTimeout(
          () => reject(new Error('Offer timed out.')),
          30_000,
        );
        browser.once('message', (raw) => {
          clearTimeout(offerTimer);
          browser.off('close', fail);
          browser.off('error', fail);
          try {
            resolve(offerSchema.parse(JSON.parse(raw.toString())));
          } catch {
            reject(new Error('Invalid offer.'));
          }
        });
      },
    );
    browser.on('message', (raw) => {
      try {
        const command = JSON.parse(raw.toString());
        if (command.type !== 'close') throw new Error('Unsupported command.');
      } catch {
        notify({ type: 'error', message: 'Unsupported browser command.' });
      }
      stop();
    });
    if (stopping) return;
    // The pinned OpenAI JS SDK has no Live resource yet. Use its HTTP client
    // for the documented endpoint, with retries disabled on session creation.
    stage = 'Live session creation';
    const result = await client.post<{
      session: { id: string };
      transport: { type: 'webrtc'; sdp: string };
    }>('/live/sessions', {
      body: {
        session: sessionConfig(),
        transport: { type: 'webrtc', sdp: offer.sdp },
      },
      maxRetries: 0,
      timeout: 30_000,
    });
    let confirmed = false;
    stage = 'Live sideband setup';
    try {
      active = relay(
        attach(client, result.session.id),
        notify,
        result.transport,
      );
      if (stopping) active.stop();
      confirmed = await active.done;
    } finally {
      // Cleanup attachment never executes tools or resubmits function results.
      if (!confirmed)
        confirmed = await closeUnattachedSession(client, result.session.id);
      if (!confirmed) {
        notify({
          type: 'error',
          message: 'Session finalization could not be confirmed.',
        });
        console.warn('Live session finalization could not be confirmed.');
      }
    }
  } catch (error) {
    // Never forward error.message, error.error, headers, stacks, or causes.
    const message = sessionFailure(stage, error);
    console.error(message);
    notify({ type: 'error', message });
  } finally {
    clearTimeout(offerTimer);
    stop();
    browser.close();
  }
}

export function buildServer(client: OpenAI) {
  const files: Record<string, [string, string]> = {
    '/': ['index.html', 'text/html'],
    '/static/app.js': ['app.js', 'text/javascript'],
  };
  const server = createServer(async (request, response) => {
    const file = files[request.url ?? ''];
    if (request.method !== 'GET' || !file) {
      response.writeHead(404).end();
      return;
    }
    try {
      const content = await readFile(
        new URL(`./static/${file[0]}`, import.meta.url),
      );
      response.writeHead(200, { 'Content-Type': file[1] }).end(content);
    } catch {
      response.writeHead(500).end();
    }
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 65536 });
  server.on('upgrade', (request, socket, head) => {
    if (
      request.url !== '/ws' ||
      !localOrigins.has(request.headers.origin ?? '')
    ) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(request, socket, head, (browser) => {
      void handleBrowser(browser, client);
    });
  });
  server.on('close', () => sockets.close());
  return server;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const client = new OpenAI({
    baseURL: 'https://api.openai.com/v1',
    maxRetries: 0,
    timeout: 30_000,
  });
  buildServer(client).listen(8000, '127.0.0.1', () => {
    console.log('Open http://localhost:8000');
  });
}
