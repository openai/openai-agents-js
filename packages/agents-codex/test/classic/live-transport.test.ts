import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import { afterEach, expect, test, vi } from 'vitest';
import { Runner } from '@openai/agents/classic';
import {
  createLiveTransport,
  closeSocket,
} from '../../../../examples/codex/live/transport';
import { relay } from '../../../../examples/codex/live/relay';
import { createLiveApp } from '../../../../examples/codex/live/server';

type Message = { type: string; [key: string]: unknown };
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

function inbox(socket: WebSocket) {
  const received: Message[] = [];
  socket.on('message', (data: RawData) =>
    received.push(JSON.parse(data.toString())),
  );
  return {
    received,
    async next(type: string) {
      await vi.waitFor(() =>
        expect(received.some((message) => message.type === type)).toBe(true),
      );
      return received.find((message) => message.type === type)!;
    },
  };
}

async function connect(url: string, origin?: string) {
  const socket = new WebSocket(url, origin ? { origin } : undefined);
  socket.on('error', () => {});
  cleanup.push(() => closeSocket(socket));
  await once(socket, 'open');
  return socket;
}

async function pair() {
  const server = createServer();
  const ws = new WebSocketServer({ server });
  cleanup.push(async () => {
    for (const client of ws.clients) client.terminate();
    await new Promise<void>((resolve) => ws.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const port = await listen(server);
  const accepted = once(ws, 'connection');
  const client = await connect(`ws://127.0.0.1:${port}`);
  const [peer] = (await accepted) as [WebSocket];
  peer.on('error', () => {});
  return { client, peer };
}

async function provider(
  options: {
    failFirstAttach?: boolean;
    confirmClose?: boolean;
    createGate?: Promise<void>;
    attachGate?: Promise<void>;
  } = {},
) {
  const sessionId = 'opaque/session ?#%';
  const requests: { url: string; auth?: string; body: unknown }[] = [];
  const attachments: { url: string; auth?: string }[] = [];
  const commands: Message[] = [];
  const closed = Promise.withResolvers<void>();
  const attached = Promise.withResolvers<WebSocket>();
  const creationEntered = Promise.withResolvers<void>();
  const attachmentEntered = Promise.withResolvers<void>();
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (data: string) => {
      body += data;
    });
    request.on('end', async () => {
      requests.push({
        url: request.url!,
        auth: request.headers.authorization,
        body: JSON.parse(body),
      });
      creationEntered.resolve();
      await options.createGate;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          session: { id: sessionId },
          transport: { sdp: 'provider-answer' },
        }),
      );
    });
  });
  const ws = new WebSocketServer({ noServer: true });
  server.on('upgrade', async (request, socket, head) => {
    attachments.push({
      url: request.url!,
      auth: request.headers.authorization,
    });
    attachmentEntered.resolve();
    await options.attachGate;
    if (options.failFirstAttach && attachments.length === 1) {
      socket.end(
        'HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n',
      );
      return;
    }
    ws.handleUpgrade(request, socket, head, (client) => {
      client.on('error', () => {});
      client.on('message', (data) => {
        const message = JSON.parse(data.toString()) as Message;
        commands.push(message);
        if (message.type === 'session.close') {
          if (options.confirmClose !== false) {
            client.send(
              JSON.stringify({
                type: 'session.closed',
                reason: 'close_requested',
                usage: { seconds: 7 },
              }),
            );
          } else client.close();
          closed.resolve();
        }
      });
      attached.resolve(client);
    });
  });
  cleanup.push(async () => {
    for (const client of ws.clients) client.terminate();
    await new Promise<void>((resolve) => ws.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const port = await listen(server);
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    sessionId,
    requests,
    attachments,
    commands,
    attached: attached.promise,
    closeRequested: closed.promise,
    creationEntered: creationEntered.promise,
    attachmentEntered: attachmentEntered.promise,
  };
}

async function app(baseURL: string) {
  const application = createLiveApp({
    apiKey: 'synthetic-server-key',
    baseURL,
  });
  cleanup.push(() => application.close());
  const port = await listen(application.server);
  return {
    url: `ws://127.0.0.1:${port}/ws`,
    origin: `http://127.0.0.1:${port}`,
  };
}

test('HTTP create and sideband attach retain server auth and encode the opaque session ID', async () => {
  const api = await provider();
  const options = { apiKey: 'synthetic-server-key', baseURL: api.baseURL };
  const transport = createLiveTransport(options);
  const config = { model: 'synthetic-live-model' };
  const created = await transport.create(config, 'browser-offer');
  expect(created.session.id).toBe(api.sessionId);
  expect(created.transport.sdp).toBe('provider-answer');
  options.apiKey = 'mutated-key-must-not-be-used';
  const live = await transport.attach(created.session.id);
  cleanup.push(() => closeSocket(live));
  expect(api.requests).toEqual([
    {
      url: '/v1/live/sessions',
      auth: 'Bearer synthetic-server-key',
      body: {
        session: config,
        transport: { type: 'webrtc', sdp: 'browser-offer' },
      },
    },
  ]);
  expect(api.attachments).toEqual([
    {
      url: `/v1/live/sessions/${encodeURIComponent(api.sessionId)}/attach`,
      auth: 'Bearer synthetic-server-key',
    },
  ]);
});

test.each(['http://evil.invalid', 'http://127.0.0.1:1', 'null', undefined])(
  'server refuses browser origin %s before creating a provider session',
  async (origin) => {
    const api = await provider();
    const application = await app(api.baseURL);
    const socket = new WebSocket(
      application.url,
      origin ? { origin } : undefined,
    );
    socket.on('error', () => {});
    const response = await new Promise<number>((resolve) => {
      socket.once('unexpected-response', (_request, response) => {
        response.resume();
        resolve(response.statusCode!);
        socket.terminate();
      });
    });
    expect(response).toBe(403);
    expect(api.requests).toEqual([]);
    expect(api.attachments).toEqual([]);
  },
);

test('server answers valid browser SDP only after attaching the created session', async () => {
  const api = await provider();
  const application = await app(api.baseURL);
  const browser = await connect(application.url, application.origin);
  const messages = inbox(browser);
  browser.send(JSON.stringify({ sdp: 'browser-offer' }));
  const answer = await messages.next('answer');
  expect(api.attachments).toHaveLength(1);
  expect(answer).toEqual({
    type: 'answer',
    sdp: 'provider-answer',
    session_id: api.sessionId,
  });
  expect(JSON.stringify(messages.received)).not.toContain(
    'synthetic-server-key',
  );
  browser.send(JSON.stringify({ type: 'close' }));
  expect(await messages.next('closed')).toEqual({
    type: 'closed',
    reason: 'close_requested',
    usage: { seconds: 7 },
  });
});

test('browser disconnect waits for an entered delegate callback before session.close and suppresses late output', async () => {
  const live = await pair();
  const browser = await pair();
  const upstream = inbox(live.client);
  const entered = Promise.withResolvers<AbortSignal>();
  const release = Promise.withResolvers<string>();
  const settled = Promise.withResolvers<void>();
  const conversation = relay(
    live.peer,
    browser.peer,
    async (_request, signal) => {
      entered.resolve(signal);
      try {
        return await release.promise;
      } finally {
        settled.resolve();
      }
    },
    { type: 'answer', sdp: 'local-answer' },
  );
  const result = conversation.then((value) => ({ value }));
  cleanup.push(async () => {
    release.resolve('released during cleanup');
    await conversation;
  });
  live.client.send(
    JSON.stringify({
      type: 'response.event',
      delegation_id: 'd1',
      event: { type: 'response.created', response: { id: 'r1' } },
    }),
  );
  live.client.send(
    JSON.stringify({
      type: 'response.event',
      delegation_id: 'd1',
      event: {
        type: 'response.output_item.done',
        item: {
          type: 'function_call',
          call_id: 'c1',
          name: 'ask_order_agent',
          arguments: '{"request":"Order A0042"}',
        },
      },
    }),
  );
  live.client.send(
    JSON.stringify({
      type: 'response.event',
      delegation_id: 'd1',
      event: { type: 'response.completed', response: { id: 'r1' } },
    }),
  );
  const signal = await entered.promise;
  await closeSocket(browser.client);
  await vi.waitFor(() => expect(signal.aborted).toBe(true));
  expect(upstream.received).toEqual([]);
  release.resolve('A0042 shipped.');
  await settled.promise;
  await upstream.next('session.close');
  live.client.send(
    JSON.stringify({
      type: 'session.closed',
      usage: { seconds: 2 },
      reason: 'browser_disconnected',
    }),
  );
  expect(await result).toEqual({ value: true });
  expect(upstream.received.map((message) => message.type)).toEqual([
    'session.close',
  ]);
});

test.each([true, false])(
  'relay reports finalization confirmed=%s without inventing final usage',
  async (confirm) => {
    const live = await pair();
    const browser = await pair();
    const upstream = inbox(live.client);
    const messages = inbox(browser.client);
    const conversation = relay(live.peer, browser.peer, async () => 'unused', {
      type: 'answer',
      sdp: 'local-answer',
    });
    await messages.next('answer');
    browser.client.send(JSON.stringify({ type: 'close' }));
    await upstream.next('session.close');
    if (confirm)
      live.client.send(
        JSON.stringify({
          type: 'session.closed',
          usage: { seconds: 9 },
          reason: 'close_requested',
        }),
      );
    else await closeSocket(live.client);
    expect(await conversation).toBe(confirm);
    if (confirm)
      expect(await messages.next('closed')).toEqual({
        type: 'closed',
        usage: { seconds: 9 },
        reason: 'close_requested',
      });
    else {
      expect(await messages.next('error')).toEqual({
        type: 'error',
        message: 'Session finalization could not be confirmed.',
      });
      expect(
        messages.received.some((message) => message.type === 'closed'),
      ).toBe(false);
    }
  },
);

test('creation followed by failed first attach recovers authority only to close the allocated session', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const api = await provider({ failFirstAttach: true });
  const application = await app(api.baseURL);
  const browser = await connect(application.url, application.origin);
  const messages = inbox(browser);
  browser.send(JSON.stringify({ sdp: 'browser-offer' }));
  await messages.next('error');
  expect(api.requests).toHaveLength(1);
  expect(api.attachments).toHaveLength(2);
  expect(api.attachments.map((request) => request.url)).toEqual(
    Array(2).fill(
      `/v1/live/sessions/${encodeURIComponent(api.sessionId)}/attach`,
    ),
  );
  expect(api.commands).toEqual([{ type: 'session.close' }]);
  expect(messages.received.some((message) => message.type === 'answer')).toBe(
    false,
  );
  expect(warn).toHaveBeenCalledWith(
    'Live example session failed (%s).',
    'Error',
  );
});

test.each(['create', 'attach'] as const)(
  'close during blocked %s prevents an answer or specialist execution and finalizes the allocated session',
  async (phase) => {
    const gate = Promise.withResolvers<void>();
    const run = vi.spyOn(Runner.prototype, 'run');
    const api = await provider(
      phase === 'create'
        ? { createGate: gate.promise }
        : { attachGate: gate.promise },
    );
    const application = await app(api.baseURL);
    const browser = await connect(application.url, application.origin);
    const messages = inbox(browser);
    cleanup.push(async () => {
      gate.resolve();
    });
    browser.send(JSON.stringify({ sdp: 'browser-offer' }));
    await (phase === 'create' ? api.creationEntered : api.attachmentEntered);
    browser.send(JSON.stringify({ type: 'close' }));
    // Pong proves the server received the preceding close frame before setup resumes.
    const pong = once(browser, 'pong');
    browser.ping();
    await pong;
    gate.resolve();
    await api.closeRequested;
    await once(browser, 'close');
    expect(messages.received.some((message) => message.type === 'answer')).toBe(
      false,
    );
    expect(run).not.toHaveBeenCalled();
    expect(api.requests).toHaveLength(1);
    expect(api.commands).toEqual([{ type: 'session.close' }]);
  },
);
