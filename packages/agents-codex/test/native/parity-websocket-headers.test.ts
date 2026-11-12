import { once } from 'node:events';
import { connect } from 'node:net';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { expect, it, vi } from 'vitest';
import { Agent, NativeProvider } from '@openai/agents';
import { NativeProviderRoutes } from '../../src/runtime/http-model';
import type { Engine } from '../../src/runtime/binding';
import type { NativeModelWebSocket } from '../../native';

const headers: [string, string][] = [
  ['Retry-After', '2'],
  ['Content-Type', 'application/json'],
  ['X-Request-ID', 'synthetic-request'],
  ['Connection', 'keep-alive, X-Upstream-Only'],
  ['cOnNeCtIoN', 'X-Second-Hop'],
  ['x-UPSTREAM-only', 'private-first-hop'],
  ['X-second-HOP', 'private-second-hop'],
  ['Keep-Alive', 'timeout=60'],
  ['Transfer-Encoding', 'chunked'],
  ['Content-Encoding', 'gzip'],
  ['Content-Length', '999999'],
  ['X-Agents-Model-Grant', 'private-grant'],
  ['X-Codex-Agents-Native-Route', 'private-route'],
  ['X-SDK-Sentinel-Grant', 'private-sentinel'],
];
const removed = [
  'x-upstream-only',
  'x-second-hop',
  'content-encoding',
  'x-agents-model-grant',
  'x-codex-agents-native-route',
  'x-sdk-sentinel-grant',
];

function unavailableSocket(body: Buffer, responseHeaders = headers) {
  const unexpected = () => {
    throw new Error('An unavailable WebSocket cannot exchange messages');
  };
  return {
    available: false,
    status: 429,
    headers: responseHeaders,
    error_body: body,
    close: vi.fn(async () => {}),
    project_response_items: unexpected,
    send_text: unexpected,
    _send_owned_text: unexpected,
    receive: unexpected,
  } satisfies NativeModelWebSocket;
}

async function carrier(extra: Partial<Engine>) {
  const routes = new NativeProviderRoutes();
  await routes.start({}, {});
  let origin = '';
  let grant = '';
  routes.bindEngine({
    _sentinel_bind(base: string, token: string) {
      origin = base;
      grant = token;
    },
    ...extra,
  } as Engine);
  return {
    routes,
    url: `${origin}/p-${Buffer.from('fixture').toString('base64url')}/responses`,
    grant,
  };
}

async function rejectedUpgrade(url: string, grant: string) {
  const target = new URL(url);
  const socket = connect(Number(target.port), target.hostname);
  const chunks: Buffer[] = [];
  socket.on('data', (chunk) => chunks.push(chunk));
  const ended = once(socket, 'end');
  await once(socket, 'connect');
  socket.write(
    [
      `GET ${target.pathname} HTTP/1.1`,
      `Host: ${target.host}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Key: c3ludGhldGljLWtleS0xMg==',
      `X-SDK-Sentinel-Grant: ${grant}`,
      '',
      '',
    ].join('\r\n'),
  );
  try {
    await ended;
    const wire = Buffer.concat(chunks);
    const boundary = wire.indexOf('\r\n\r\n');
    expect(boundary).toBeGreaterThan(0);
    const lines = wire.subarray(0, boundary).toString('latin1').split('\r\n');
    const status = lines.shift();
    const values = new Map(
      lines.map((line) => {
        const colon = line.indexOf(':');
        return [
          line.slice(0, colon).toLowerCase(),
          line.slice(colon + 1).trim(),
        ];
      }),
    );
    return { status, headers: values, body: wire.subarray(boundary + 4), wire };
  } finally {
    socket.destroy();
  }
}

it.each([false, true])(
  'preserves safe unavailable-WebSocket headers and frames a bounded body (oversized: %s)',
  async (oversized) => {
    const body = oversized
      ? Buffer.alloc(70 * 1024, 'x')
      : Buffer.from('{"error":"retry later"}');
    const remote = unavailableSocket(body);
    const selected = await carrier({
      _sentinel_open: vi.fn(async () => remote),
    });
    try {
      const response = await rejectedUpgrade(selected.url, selected.grant);
      expect(response.status).toBe('HTTP/1.1 429 Provider unavailable');
      expect(response.headers.get('retry-after')).toBe('2');
      expect(response.headers.get('content-type')).toBe('application/json');
      expect(response.headers.get('x-request-id')).toBe('synthetic-request');
      expect(response.headers.get('connection')).toBe('close');
      expect(response.headers.get('content-length')).toBe(
        String(Math.min(body.length, 64 * 1024)),
      );
      expect(response.body).toEqual(body.subarray(0, 64 * 1024));
      for (const name of [...removed, 'keep-alive', 'transfer-encoding'])
        expect(response.headers.has(name), name).toBe(false);
      expect(response.wire.toString()).not.toContain('private-');
    } finally {
      await selected.routes.close();
    }
    expect(remote.close).toHaveBeenCalled();
  },
);

it('keeps ordinary HTTP forwarding headers and body equivalent', async () => {
  const body = Buffer.from('{"error":"retry later"}');
  let sent = false;
  const close = vi.fn(async () => {});
  const selected = await carrier({
    _sentinel_admit: async () =>
      JSON.stringify({ model: 'fixture', kind: 'generation' }),
    _sentinel_restore_schemas: async (_provider, _ticket, body) => body,
    _sentinel_stream: vi.fn(async () => ({
      status: 429,
      headers,
      async next_chunk() {
        if (sent) return null;
        sent = true;
        return body;
      },
      close,
    })) as Engine['_sentinel_stream'],
  });
  try {
    const response = await fetch(selected.url, {
      method: 'POST',
      headers: { 'X-SDK-Sentinel-Grant': selected.grant },
      body: JSON.stringify({
        model: 'fixture',
        input: [],
        client_metadata: {
          sdk_sentinel_thread: 'synthetic-thread',
          sdk_sentinel_nonce: 'synthetic-nonce',
        },
      }),
    });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('2');
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('x-request-id')).toBe('synthetic-request');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(body);
    for (const name of removed)
      expect(response.headers.has(name), name).toBe(false);
  } finally {
    await selected.routes.close();
  }
  expect(close).toHaveBeenCalled();
});

it.each([
  ['Invalid\r\nName', 'value'],
  ['X-Upstream', 'value\r\nX-Injected: unsafe'],
])(
  'refuses malformed upstream header %j before writing a raw rejection',
  async (name, value) => {
    const remote = unavailableSocket(Buffer.from('retry'), [[name, value]]);
    const selected = await carrier({
      _sentinel_open: vi.fn(async () => remote),
    });
    try {
      await expect(
        rejectedUpgrade(selected.url, selected.grant),
      ).rejects.toThrow();
    } finally {
      await selected.routes.close();
    }
    expect(remote.close).toHaveBeenCalled();
  },
);

async function verifyRejectedUpgradeRetryAdvice(route: 'session' | 'plain') {
  const attempts: Array<{ method: string; at: number }> = [];
  let adviceAt: number | undefined;
  const rejectedUpgrades = route === 'session' ? 2 : 1;
  const frames = (id: string, generate = true) => [
    { type: 'response.created', response: { id } },
    ...(generate
      ? [
          {
            type: 'response.output_item.done',
            output_index: 0,
            item: {
              type: 'message',
              id: `${id}-message`,
              role: 'assistant',
              content: [{ type: 'output_text', text: 'recovered' }],
            },
          },
        ]
      : []),
    { type: 'response.completed', response: { id } },
  ];
  const server = createServer(async (request, response) => {
    attempts.push({ method: request.method ?? '', at: performance.now() });
    for await (const _chunk of request) {
      /* Drain the provider request. */
    }
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const frame of frames('http-recovered'))
      response.write(`data: ${JSON.stringify(frame)}\n\n`);
    response.end();
  });
  const sockets = new WebSocketServer({ noServer: true });
  let upgrades = 0;
  server.on('upgrade', (request, socket, head) => {
    attempts.push({ method: 'GET', at: performance.now() });
    upgrades++;
    if (upgrades <= rejectedUpgrades) {
      const body = Buffer.from(
        JSON.stringify({
          error: { code: 'server_is_overloaded', message: 'retry later' },
        }),
      );
      // Reject prewarm without advice. Only the sampling rejection controls the measured retry.
      const lastRejection = upgrades === rejectedUpgrades;
      const advice = lastRejection ? 'Retry-After: 2\r\n' : '';
      if (lastRejection) adviceAt = performance.now();
      socket.end(
        Buffer.concat([
          Buffer.from(
            `HTTP/1.1 503 Service Unavailable\r\n${advice}Content-Length: ${body.length}\r\nConnection: close\r\n\r\n`,
          ),
          body,
        ]),
      );
      return;
    }
    sockets.handleUpgrade(request, socket, head, (websocket) => {
      websocket.on('message', (data) => {
        const request = JSON.parse(data.toString());
        for (const frame of frames('ws-recovered', request.generate !== false))
          websocket.send(JSON.stringify(frame));
      });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Provider fixture did not bind');
  const provider = new NativeProvider({
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: 'synthetic',
    supportsWebsockets: true,
    ...(route === 'plain' ? { streamMaxRetries: 0 } : {}),
  });
  const agent = new Agent({
    instructions: 'Respond with recovered.',
    model: 'gpt-5',
    provider,
  });
  const session = route === 'session' ? await agent.session() : undefined;
  try {
    if (session)
      await vi.waitFor(() => expect(upgrades).toBe(1), { timeout: 3000 });
    const result = session
      ? await (await session.submit('start')).wait()
      : await agent.run('start');
    expect(result.finalOutput).toBe('recovered');
    expect(adviceAt).toBeDefined();
    const following = attempts.filter((attempt) => attempt.at > adviceAt!);
    expect(following.length).toBeGreaterThan(0);
    // Core's local first retry backoff is shorter. A missing header must not pass on incidental startup time.
    expect(following[0].at - adviceAt!).toBeGreaterThanOrEqual(1800);
    if (route === 'plain')
      expect(attempts.map((attempt) => attempt.method)).toEqual([
        'GET',
        'POST',
      ]);
  } finally {
    await session?.close();
    await provider.close();
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  }
}

it.each(['session', 'plain'] as const)(
  '%s run honors WSS retry advice',
  verifyRejectedUpgradeRetryAdvice,
  15000,
);

it('delivers sparse successful WebSocket handshake and response limit updates', async () => {
  let httpRequests = 0;
  const server = createServer((_request, response) => {
    httpRequests++;
    response.writeHead(500).end();
  });
  const sockets = new WebSocketServer({ server, perMessageDeflate: false });
  sockets.on('headers', (headers) => {
    headers.push(
      'X-RateLimit-Remaining-Requests: 7',
      'X-RateLimit-Limit-Requests: invalid',
      'Authorization: synthetic-private-header',
    );
  });
  sockets.on('connection', (socket) => {
    socket.on('message', (payload) => {
      const request = JSON.parse(payload.toString());
      const warmup = request.generate === false;
      const id = warmup ? 'warmup' : 'ws-limits';
      const send = (event: object) => socket.send(JSON.stringify(event));
      send({ type: 'response.created', response: { id } });
      if (!warmup) {
        send({
          type: 'response.metadata',
          headers: {
            'X-RateLimit-Remaining-Tokens': 11,
            'X-RateLimit-Reset-Tokens': '5ms',
          },
        });
        send({
          type: 'response.output_item.done',
          output_index: 0,
          item: {
            type: 'message',
            id: 'ws-limits-message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'done' }],
          },
        });
      }
      send({ type: 'response.completed', response: { id } });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Fixture did not bind');
  try {
    await using provider = new NativeProvider({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: 'synthetic',
      supportsWebsockets: true,
    });
    await using session = await new Agent({
      instructions: 'Reply.',
      model: 'gpt-5',
      provider,
    }).session();
    const turn = await session.submit('Reply.');
    expect((await turn.wait()).finalOutput).toBe('done');
    const snapshots = [];
    for await (const event of turn.events()) {
      if (event.type === 'api_rate_limits_updated')
        snapshots.push(event.snapshot);
    }
    expect(snapshots).toEqual([
      { requests: { remaining: 7 } },
      { tokens: { remaining: 11, resetAfterSeconds: 0.005 } },
    ]);
    expect(session.rateLimits()).toEqual(snapshots[1]);
    expect(httpRequests).toBe(0);
  } finally {
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    const closed = once(server, 'close');
    server.close();
    server.closeAllConnections();
    await closed;
  }
}, 15_000);
