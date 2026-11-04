import { once } from 'node:events';
import { createServer } from 'node:http';
import { createServer as createTcpServer, type Socket } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import {
  Agent,
  Environment,
  HttpMCP,
  NativeError,
  NativeProvider,
} from '@openai/agents';
import {
  binding,
  parseNative,
  type JsonObject,
  type NativeThread,
} from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) {
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
  }
  vi.restoreAllMocks();
  try {
    await ModelServer.closeAll();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length)
    throw new AggregateError(failures, 'Timeout fixture cleanup failed');
});
async function beforeDefaultDeadline<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                'Configured expiry did not precede the default timeout',
              ),
            ),
          3000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function providerFor(model: ModelServer) {
  const config = await model.config();
  const provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-timeout-key',
    supportsWebsockets: false,
  });
  cleanup.push(() => provider.close());
  return provider;
}
async function timeoutPeer(hold: 'initialize' | 'tools/call' | null) {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const effects: JsonObject[] = [];
  const active = new Set<Promise<void>>();
  const failures: unknown[] = [];
  const server = createServer((request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    const handling = (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const rpc = JSON.parse(Buffer.concat(chunks).toString()) as JsonObject;
      if (rpc.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      let result: JsonObject = {};
      if (rpc.method === 'initialize')
        result = {
          protocolVersion: (rpc.params as JsonObject).protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'expiry-peer', version: '1' },
        };
      if (rpc.method === 'tools/list')
        result = {
          tools: [
            {
              name: 'lookup',
              description: 'Read a record.',
              inputSchema: {
                type: 'object',
                properties: {},
                additionalProperties: false,
              },
            },
          ],
        };
      if (rpc.method === 'tools/call') {
        effects.push(rpc.params as JsonObject);
        result = { content: [{ type: 'text', text: 'PRIVATE_LATE_RECORD' }] };
      }
      if (rpc.method === hold) {
        entered.resolve();
        await release.promise;
      }
      if (!response.destroyed) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
      }
    })();
    active.add(handling);
    void handling
      .catch((error) => {
        failures.push(error);
        if (!response.destroyed) response.writeHead(500).end();
      })
      .finally(() => active.delete(handling));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing MCP peer address');
  cleanup.push(async () => {
    release.resolve();
    await Promise.allSettled([...active]);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    expect(failures).toEqual([]);
  });
  return {
    entered,
    release,
    effects,
    active,
    url: `http://127.0.0.1:${address.port}/mcp`,
  };
}

it('expires an executor argument policy before effect dispatch and joins its late callback', async () => {
  const executor = await startPublicExecutor();
  cleanup.push(() => executor.close());
  const model = new ModelServer([
    [
      call(
        'exec_command',
        { cmd: 'printf ORIGINAL' },
        { callId: 'expired-policy' },
      ),
    ],
  ]);
  const provider = await providerFor(model);
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>(),
    interrupted = Promise.withResolvers<void>();
  const addon = await binding();
  const interrupt = addon.NativeThread.prototype._interrupt_session;
  vi.spyOn(
    addon.NativeThread.prototype,
    '_interrupt_session',
  ).mockImplementation(async function (this: NativeThread) {
    interrupted.resolve();
    return interrupt.call(this);
  });
  let observed: unknown;
  const session = await new Agent({
    instructions: 'Run.',
    model: 'gpt-5.5',
    provider,
  }).session({
    environment: new Environment({
      url: executor.url,
      cwd: executor.cwd,
      headers: executor.headers,
      tools: ['exec_command'],
      policyTimeout: 0.1,
      approval: () => true,
      async transformArguments(info, args) {
        observed = info;
        entered.resolve();
        await release.promise;
        return { ...(args as JsonObject), cmd: 'printf PRIVATE_LATE_COMMAND' };
      },
    }),
  });
  cleanup.push(() => session.close());
  cleanup.push(async () => {
    release.resolve();
  });
  const turn = await session.submit('Run.');
  let settled = false;
  const outcome = turn
    .wait()
    .then(
      (value) => ({ value }),
      (error) => ({ error }),
    )
    .finally(() => {
      settled = true;
    });
  await entered.promise;
  expect(observed).toMatchObject({
    submission: turn,
    callId: 'expired-policy',
  });
  await interrupted.promise;
  expect(settled).toBe(false);
  expect(executor.requests.filter((r) => r.method === 'process/start')).toEqual(
    [],
  );
  release.resolve();
  const result = await outcome;
  expect(result).toHaveProperty('error');
  expect('error' in result && result.error).toBeInstanceOf(NativeError);
  expect(executor.requests.filter((r) => r.method === 'process/start')).toEqual(
    [],
  );
  expect(JSON.stringify(await Array.fromAsync(session.items()))).not.toContain(
    'PRIVATE_LATE_COMMAND',
  );
  expect(JSON.stringify(model.requests)).not.toContain('PRIVATE_LATE_COMMAND');
  model.assertExhausted();
}, 15_000);

it('applies connectTimeout to an accepted but stalled TLS/WebSocket connection', async () => {
  const accepted = Promise.withResolvers<void>(),
    sockets = new Set<Socket>();
  const peer = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', () => accepted.resolve());
  });
  peer.listen(0, '127.0.0.1');
  await once(peer, 'listening');
  cleanup.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      peer.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = peer.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing peer address');
  const model = new ModelServer([]),
    provider = await providerFor(model);
  // Core connect_websocket_request wraps the complete TLS/WebSocket handshake.
  const opening = new Agent({
    instructions: 'Do not run commands.',
    model: 'gpt-5.5',
    provider,
  }).session({
    environment: new Environment({
      url: `wss://127.0.0.1:${address.port}/executor`,
      cwd: '/tmp',
      connectTimeout: 0.1,
    }),
  });
  const outcome = opening.then(
    (session) => ({ session }),
    (error) => ({ error }),
  );
  cleanup.push(async () => {
    const result = await outcome;
    if ('session' in result) await result.session.close();
  });
  await accepted.promise;
  const result = await beforeDefaultDeadline(outcome);
  expect(result).toHaveProperty('error');
  expect('error' in result && String(result.error)).toContain(
    'remote executor failed to become ready',
  );
  expect(peer.listening).toBe(true);
  expect(model.requests).toEqual([]);
  model.assertExhausted();
}, 15_000);

it('expires MCP startup before publishing a Session or admitting a tool effect', async () => {
  const peer = await timeoutPeer('initialize'),
    model = new ModelServer([]),
    provider = await providerFor(model);
  const opening = new Agent({
    instructions: 'Read.',
    model: 'gpt-5.5',
    provider,
    tools: [
      new HttpMCP({
        name: 'fixture',
        url: peer.url,
        tools: ['lookup'],
        startupTimeout: 0.1,
      }),
    ],
  }).session();
  const outcome = opening.then(
    (session) => ({ session }),
    (error) => ({ error }),
  );
  cleanup.push(async () => {
    peer.release.resolve();
    const result = await outcome;
    if ('session' in result) await result.session.close();
  });
  await peer.entered.promise;
  const result = await beforeDefaultDeadline(outcome);
  expect(result).toHaveProperty('error');
  expect('error' in result && String(result.error)).toContain(
    'Native MCP publication was not confirmed',
  );
  expect(peer.effects).toEqual([]);
  expect(model.requests).toEqual([]);
  peer.release.resolve();
  await Promise.all([...peer.active]);
  model.assertExhausted();
}, 15_000);

it('reports an MCP execution timeout as a tool error without claiming its entered peer effect ended', async () => {
  const peer = await timeoutPeer('tools/call');
  const model = new ModelServer([
    [call('lookup', {}, { namespace: 'mcp__fixture', callId: 'timed-tool' })],
    (request) => {
      expect(JSON.stringify(request.input)).toMatch(/timed out|timeout/i);
      expect(JSON.stringify(request.input)).not.toContain(
        'PRIVATE_LATE_RECORD',
      );
      return [message('handled tool timeout')];
    },
  ]);
  const provider = await providerFor(model);
  const session = await new Agent({
    instructions: 'Read once.',
    model: 'gpt-5.5',
    provider,
    tools: [
      new HttpMCP({
        name: 'fixture',
        url: peer.url,
        tools: ['lookup'],
        approvalMode: 'approve',
        executionTimeout: 0.1,
      }),
    ],
  }).session();
  cleanup.push(() => session.close());
  cleanup.push(async () => {
    peer.release.resolve();
  });
  const turn = await session.submit('Read.');
  await peer.entered.promise;
  expect((await turn.wait()).finalOutput).toBe('handled tool timeout');
  expect(peer.effects).toHaveLength(1);
  expect(peer.active.size).toBe(1);
  peer.release.resolve();
  await Promise.all([...peer.active]);
  expect(JSON.stringify(await Array.fromAsync(session.items()))).not.toContain(
    'PRIVATE_LATE_RECORD',
  );
  expect(model.requests).toHaveLength(2);
  model.assertExhausted();
}, 15_000);

it('expires an MCP result policy while retaining its callback and withholding its late replacement', async () => {
  const peer = await timeoutPeer(null),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const addon = await binding(),
    next = addon.NativeThread.prototype._next_native_mcp_result;
  let current: (() => boolean) | undefined;
  vi.spyOn(
    addon.NativeThread.prototype,
    '_next_native_mcp_result',
  ).mockImplementation(async function (this: NativeThread) {
    const raw = await next.call(this);
    const notice = parseNative(raw) as {
      nonce: string;
      turn_id: string;
      call_id: string;
    } | null;
    if (notice)
      current = () =>
        this._check_native_mcp_result(
          notice.nonce,
          notice.turn_id,
          notice.call_id,
        );
    return raw;
  });
  const model = new ModelServer([
      [
        call(
          'lookup',
          {},
          { namespace: 'mcp__fixture', callId: 'timed-result' },
        ),
      ],
      (request) => {
        expect(JSON.stringify(request.input)).toContain('MCP result withheld');
        expect(JSON.stringify(request.input)).not.toContain(
          'PRIVATE_LATE_RECORD',
        );
        return [message('handled result timeout')];
      },
    ]),
    provider = await providerFor(model);
  const session = await new Agent({
    instructions: 'Read once.',
    model: 'gpt-5.5',
    provider,
    tools: [
      new HttpMCP({
        name: 'fixture',
        url: peer.url,
        tools: ['lookup'],
        approvalMode: 'approve',
        transformResultTimeout: 0.1,
        async transformResult(_context, result) {
          entered.resolve();
          await release.promise;
          return {
            ...result,
            content: [{ type: 'text', text: 'PRIVATE_LATE_REPLACEMENT' }],
          };
        },
      }),
    ],
  }).session();
  cleanup.push(() => session.close());
  cleanup.push(async () => {
    release.resolve();
  });
  const turn = await session.submit('Read.');
  let settled = false;
  const outcome = turn
    .wait()
    .then(
      (value) => ({ value }),
      (error) => ({ error }),
    )
    .finally(() => {
      settled = true;
    });
  await entered.promise;
  expect(current?.()).toBe(true);
  await vi.waitFor(() => expect(current?.()).toBe(false));
  expect(settled).toBe(false);
  release.resolve();
  const result = await outcome;
  expect(result).toHaveProperty('error');
  expect('error' in result && result.error).toBeInstanceOf(NativeError);
  expect(peer.effects).toHaveLength(1);
  expect(JSON.stringify(await Array.fromAsync(session.items()))).not.toMatch(
    /PRIVATE_LATE_RECORD|PRIVATE_LATE_REPLACEMENT/,
  );
  for (const includeExecutionDetails of [false, true]) {
    expect(
      JSON.stringify(
        await Array.fromAsync(turn.events({ includeExecutionDetails })),
      ),
    ).not.toMatch(/PRIVATE_LATE_RECORD|PRIVATE_LATE_REPLACEMENT/);
  }
  expect(model.requests).toHaveLength(2);
  model.assertExhausted();
}, 15_000);
