import { createServer } from 'node:http';
import { once } from 'node:events';
import type { Socket } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import {
  Agent,
  Environment,
  HttpMCP,
  NativeProvider,
  type Session,
  type SessionState,
} from '../../src';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

const PRIVATE = 'synthetic-private-header-credential';
const CURRENT = 'synthetic-current-header-credential';
const selectedHeaders = new Set([
  'x-tenant',
  'x-empty',
  'x-label',
  'authorization',
  'proxy-authorization',
  'referer',
  'content-type',
]);
const sessions: Session[] = [];
const providers: NativeProvider[] = [];
const peers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  try {
    await Promise.all(sessions.splice(0).map((session) => session.close()));
  } finally {
    try {
      await Promise.all(
        providers.splice(0).map((provider) => provider.close()),
      );
    } finally {
      try {
        await Promise.all(peers.splice(0).map((peer) => peer.close()));
      } finally {
        await ModelServer.closeAll();
      }
    }
  }
});

// Adapted from the existing real mcp-credentials peer; observes raw wire bytes.
async function headerPeer(
  expected: Record<string, string> = {},
  redirect?: { status: number; target?: string },
  hold = false,
) {
  const observed: Array<{
    path: string;
    method: string;
    headers: Record<string, string>;
    body: string;
  }> = [];
  const calls: JsonObject[] = [];
  const sockets = new Set<Socket>();
  let redirected: JsonObject | undefined;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const callEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const server = createServer(async (request, response) => {
    try {
      const headers: Record<string, string> = {};
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        const name = request.rawHeaders[index]!.toLowerCase();
        if (selectedHeaders.has(name))
          headers[name] = Buffer.from(
            request.rawHeaders[index + 1]!,
            'latin1',
          ).toString('utf8');
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString('utf8');
      const rpc = body ? (JSON.parse(body) as JsonObject) : (redirected ?? {});
      observed.push({
        path: request.url ?? '',
        method: request.method ?? '',
        headers,
        body,
      });
      if (
        Object.entries(expected).some(
          ([name, value]) => headers[name] !== value,
        )
      ) {
        response.writeHead(401).end();
        return;
      }
      if (request.method !== 'POST' && request.url !== '/target') {
        response.writeHead(405).end();
        return;
      }
      if (request.url === '/mcp' && rpc.method === 'tools/list' && redirect) {
        redirected = rpc;
        response
          .writeHead(redirect.status, {
            location: redirect.target ?? '/target',
          })
          .end();
        return;
      }
      if (rpc.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      if (rpc.method === 'server/discover') {
        response.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            error: { code: -32601, message: 'legacy fixture' },
          }),
        );
        return;
      }
      let result: object = {};
      if (rpc.method === 'initialize')
        result = {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: 'header-fixture', version: '1' },
        };
      else if (rpc.method === 'tools/list')
        result = {
          tools: [
            {
              name: 'search',
              annotations: { readOnlyHint: true },
              inputSchema: {
                type: 'object',
                properties: { key: { type: 'string' } },
                required: ['key'],
              },
            },
          ],
        };
      else if (rpc.method === 'tools/call') {
        calls.push(rpc.params as JsonObject);
        entered();
        if (hold) await released;
        result = { content: [{ type: 'text', text: 'header-record' }] };
      } else if (rpc.method === 'resources/list')
        result = { resources: [{ uri: 'fixture://headers', name: 'headers' }] };
      else if (rpc.method === 'resources/read')
        result = {
          contents: [{ uri: 'fixture://headers', text: 'private-resource' }],
        };
      if (!response.destroyed && !response.writableEnded)
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    } catch {
      if (!response.destroyed && !response.headersSent)
        response.writeHead(500).end();
      else response.destroy();
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    release();
    const closing = [...sockets].map((socket) => once(socket, 'close'));
    server.closeAllConnections();
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    await Promise.all(closing);
    expect(server.listening).toBe(false);
    expect(sockets.size).toBe(0);
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing MCP header peer port');
    const peer = {
      url: `http://127.0.0.1:${address.port}/mcp`,
      observed,
      calls,
      callEntered,
      release,
      close,
      get redirected() {
        return redirected;
      },
    };
    peers.push(peer);
    return peer;
  } catch (error) {
    await close();
    throw error;
  }
}

async function open(
  model: ModelServer,
  declaration: HttpMCP,
  environment?: Environment,
  state?: SessionState,
) {
  const config = await model.config();
  const provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic',
  });
  providers.push(provider);
  const session = await new Agent({
    instructions: 'Read.',
    model: 'gpt-5',
    provider,
    tools: [declaration],
  }).session({
    ...(environment ? { environment } : {}),
    ...(state ? { state } : {}),
  });
  sessions.push(session);
  return session;
}
const search = (id: string) =>
  call('search', { key: id }, { callId: id, namespace: 'mcp__headers' });
const fields = () => ({
  'X-Tenant': PRIVATE,
  'X-Empty': '',
  'X-Label': 'café 東京\tvalue',
});

it.each(['custom', 'bearer'] as const)(
  'delivers captured authenticated empty/Unicode header bytes: %s',
  async (authentication) => {
    const supplied: Record<string, string> = fields();
    const expected: Record<string, string> = Object.fromEntries(
      Object.entries(supplied).map(([name, value]) => [
        name.toLowerCase(),
        value,
      ]),
    );
    const auth =
      authentication === 'bearer'
        ? { bearerToken: 'synthetic-bearer-auth' }
        : {};
    if (authentication === 'custom')
      supplied.aUtHoRiZaTiOn = 'Custom synthetic-header-auth';
    expected.authorization =
      authentication === 'bearer'
        ? 'Bearer synthetic-bearer-auth'
        : 'Custom synthetic-header-auth';
    const peer = await headerPeer(expected);
    const declaration = new HttpMCP({
      name: 'headers',
      tools: ['search'],
      approvalMode: 'preapproved',
      url: peer.url,
      headers: supplied,
      ...auth,
    });
    supplied['X-Tenant'] = 'mutated-after-capture';
    const model = new ModelServer([[search('read')], [message('done')]]);
    const session = await open(model, declaration);
    expect((await (await session.submit('read')).wait()).finalOutput).toBe(
      'done',
    );
    expect(JSON.stringify(await session.saveState())).not.toContain(PRIVATE);
    for (const secret of [PRIVATE, expected.authorization!]) {
      expect(JSON.stringify(model.requests)).not.toContain(secret);
      expect(JSON.stringify(model.requestHeaders)).not.toContain(secret);
      expect(JSON.stringify(await session.saveState())).not.toContain(secret);
    }
    expect(peer.calls).toHaveLength(1);
    expect(peer.observed.length).toBeGreaterThan(0);
    for (const row of peer.observed)
      expect(row.headers).toMatchObject(expected);
  },
  30_000,
);

it('uses current captured headers over poisoned saved launch authority', async () => {
  const old = await headerPeer({ 'x-tenant': PRIVATE });
  const current = await headerPeer({ 'x-tenant': CURRENT });
  const original = new HttpMCP({
    name: 'headers',
    url: old.url,
    tools: ['search'],
    headers: { 'X-Tenant': PRIVATE },
    approvalMode: 'preapproved',
  });
  const values = { 'X-Tenant': CURRENT };
  const selected = new HttpMCP({
    name: 'headers',
    url: current.url,
    tools: ['search'],
    headers: values,
    approvalMode: 'preapproved',
  });
  values['X-Tenant'] = 'mutated-current';
  const model = new ModelServer([
    [search('old')],
    [message('old')],
    [search('new')],
    [message('new')],
  ]);
  const session = await open(model, original);
  await (await session.submit('old')).wait();
  await session.update({ tools: [] });
  await session.update({ tools: [selected] });
  await (await session.submit('new')).wait();
  const saved = await session.saveState();
  for (const secret of [PRIVATE, CURRENT])
    expect(JSON.stringify(saved)).not.toContain(secret);
  await session.close();
  const oldCount = old.observed.length;
  const resumedModel = new ModelServer([
    [search('restored')],
    [message('restored')],
  ]);
  const restored = await open(resumedModel, selected, undefined, {
    ...saved,
    agent_options: {
      config: {
        mcp_servers: {
          headers: {
            url: old.url,
            http_headers: { 'X-Tenant': 'poisoned-header' },
          },
        },
      },
    },
  });
  await (await restored.submit('continue')).wait();
  expect(old.observed).toHaveLength(oldCount);
  expect(current.calls.length).toBeGreaterThan(0);
  for (const row of current.observed)
    expect(row.headers['x-tenant']).toBe(CURRENT);
  for (const secret of [PRIVATE, CURRENT, 'poisoned-header']) {
    expect(
      JSON.stringify([...model.requests, ...resumedModel.requests]),
    ).not.toContain(secret);
    expect(
      JSON.stringify([...model.requestHeaders, ...resumedModel.requestHeaders]),
    ).not.toContain(secret);
    expect(JSON.stringify(await restored.saveState())).not.toContain(secret);
  }
}, 40_000);

it('preserves headers through resource-only projection with zero model requests', async () => {
  const peer = await headerPeer({ 'x-tenant': PRIVATE });
  const model = new ModelServer([]);
  const session = await open(
    model,
    new HttpMCP({
      name: 'headers',
      url: peer.url,
      tools: [],
      headers: { 'X-Tenant': PRIVATE },
    }),
  );
  expect((await session.listMcpResources('headers')).resources).toEqual([
    { uri: 'fixture://headers', name: 'headers' },
  ]);
  expect(
    (await session.readMcpResource('headers', 'fixture://headers')).contents,
  ).toEqual([{ uri: 'fixture://headers', text: 'private-resource' }]);
  expect(JSON.stringify(await session.saveState())).not.toContain(PRIVATE);
  expect(peer.observed.length).toBeGreaterThan(0);
  expect(model.requests).toHaveLength(0);
}, 30_000);

it.each([303, 307])(
  'applies legacy same-origin redirect retention/stripping: %i',
  async (status) => {
    const peer = await headerPeer(
      { 'x-tenant': PRIVATE, authorization: 'Custom redirect-auth' },
      { status },
    );
    const model = new ModelServer([[message('done')]]);
    const session = await open(
      model,
      new HttpMCP({
        name: 'headers',
        url: peer.url,
        tools: ['search'],
        headers: {
          'X-Tenant': PRIVATE,
          Authorization: 'Custom redirect-auth',
          'Proxy-Authorization': 'synthetic-proxy',
          Referer: 'https://synthetic.invalid/private',
        },
      }),
    );
    await (await session.submit('read')).wait();
    expect(
      peer.observed.some(
        (row) =>
          row.path === '/mcp' &&
          row.headers['proxy-authorization'] === 'synthetic-proxy',
      ),
    ).toBe(true);
    const target = peer.observed.filter((row) => row.path === '/target');
    expect(target.length).toBeGreaterThan(0);
    for (const row of target) {
      expect(row.headers['x-tenant']).toBe(PRIVATE);
      expect(row.headers.authorization).toBe('Custom redirect-auth');
      expect(row.headers).not.toHaveProperty('proxy-authorization');
      expect(row.headers.referer).toBe(peer.url);
      expect(row.method).toBe(status === 303 ? 'GET' : 'POST');
      if (status === 303) {
        expect(row.body).toBe('');
        expect(row.headers).not.toHaveProperty('content-type');
      } else expect(JSON.parse(row.body).method).toBe('tools/list');
    }
  },
  30_000,
);

it('rejects cross-origin redirect before any target request', async () => {
  const target = await headerPeer();
  const origin = await headerPeer({}, { status: 307, target: target.url });
  const model = new ModelServer([]);
  await expect(
    (async () => {
      const session = await open(
        model,
        new HttpMCP({
          name: 'headers',
          url: origin.url,
          tools: ['search'],
          headers: fields(),
        }),
      );
      await (await session.submit('read')).wait();
    })(),
  ).rejects.toBeInstanceOf(Error);
  expect(origin.redirected?.method).toBe('tools/list');
  expect(target.observed).toHaveLength(0);
  expect(model.requests).toHaveLength(0);
}, 30_000);

it('keeps host-owned HTTP credentials off unrelated real WSS executor traffic', async () => {
  const executor = await startPublicExecutor({ captureHandshakeHeaders: true });
  let session: Session | undefined;
  try {
    const peer = await headerPeer({ 'x-tenant': PRIVATE });
    const model = new ModelServer([
      [call('exec_command', { cmd: 'pwd' }, { callId: 'executor' })],
      [search('http')],
      [message('done')],
    ]);
    session = await open(
      model,
      new HttpMCP({
        name: 'headers',
        url: peer.url,
        tools: ['search'],
        headers: { 'X-Tenant': PRIVATE },
        approvalMode: 'preapproved',
      }),
      new Environment({
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
        tools: ['exec_command'],
        ...(process.platform === 'win32'
          ? { writePolicy: 'legacy' as const }
          : {}),
      }),
    );
    expect((await (await session.submit('read')).wait()).finalOutput).toBe(
      'done',
    );
    expect(executor.requests.length).toBeGreaterThan(0);
    expect(executor.handshakeHeaders.length).toBeGreaterThan(0);
    for (const handshake of executor.handshakeHeaders) {
      expect(handshake.authorization).toBe(executor.headers.Authorization);
      expect(handshake).not.toHaveProperty('x-tenant');
      expect(JSON.stringify(handshake)).not.toContain(PRIVATE);
    }
    expect(peer.calls).toHaveLength(1);
    expect(JSON.stringify(executor.requests)).not.toContain(PRIVATE);
    expect(JSON.stringify(model.requests)).not.toContain(PRIVATE);
    expect(JSON.stringify(model.requestHeaders)).not.toContain(PRIVATE);
  } finally {
    try {
      await session?.close();
    } finally {
      await executor.close();
    }
  }
}, 60_000);

it('settles a held HTTP call on interruption without replay and closes owned fixtures', async () => {
  const peer = await headerPeer({ 'x-tenant': PRIVATE }, undefined, true);
  const model = new ModelServer([[search('held')]]);
  const session = await open(
    model,
    new HttpMCP({
      name: 'headers',
      url: peer.url,
      tools: ['search'],
      headers: { 'X-Tenant': PRIVATE },
      approvalMode: 'preapproved',
    }),
  );
  const turn = await session.submit('held');
  const result = turn.wait().catch((error: unknown) => error);
  try {
    await peer.callEntered;
    await session.interrupt();
    expect(await result).toBeInstanceOf(Error);
  } finally {
    peer.release();
    await session.close();
  }
  expect(peer.calls).toHaveLength(1);
  expect(model.requests).toHaveLength(1);
}, 30_000);
