import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import type { Socket } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
  await ModelServer.closeAll();
});

async function records() {
  const calls: JsonObject[] = [];
  const methods: string[] = [];
  const sockets = new Set<Socket>();
  const failures: unknown[] = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== 'POST') {
        response.writeHead(405).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const rpc = JSON.parse(Buffer.concat(chunks).toString()) as JsonObject;
      methods.push(rpc.method as string);
      if (rpc.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      let result: JsonObject = {};
      if (rpc.method === 'initialize')
        result = {
          protocolVersion: (rpc.params as JsonObject).protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'example-records', version: '1' },
        };
      if (rpc.method === 'tools/list')
        result = {
          tools: [
            {
              name: 'lookup',
              description: 'Read a record',
              inputSchema: {
                type: 'object',
                properties: { key: { type: 'string' } },
                required: ['key'],
                additionalProperties: false,
              },
            },
          ],
        };
      if (rpc.method === 'tools/call') {
        calls.push(rpc.params as JsonObject);
        result = {
          content: [{ type: 'text', text: 'record-result-from-trusted-peer' }],
        };
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    } catch (error) {
      failures.push(error);
      response.writeHead(500).end();
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing peer address');
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
    expect(failures).toEqual([]);
  });
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    calls,
    methods,
    sockets,
  };
}

async function cli(model: ModelServer, mcpUrl: string) {
  const config = await model.config();
  const baseUrl = (config['model_providers.fixture'] as { base_url: string })
    .base_url;
  const child = spawn(
    'pnpm',
    ['exec', 'tsx', 'packages/agents-codex/examples/mcp-policy.ts'],
    {
      cwd: resolve(import.meta.dirname, '../../../..'),
      env: {
        ...process.env,
        OPENAI_API_KEY: 'synthetic-loopback-example-key',
        OPENAI_BASE_URL: baseUrl,
        MCP_URL: mcpUrl,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data) => {
    stdout += String(data);
  });
  child.stderr.on('data', (data) => {
    stderr += String(data);
  });
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    // pnpm owns a tsx child; stop only this isolated test process group.
    if (child.pid && process.platform !== 'win32')
      process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  }, 20_000);
  try {
    const [code, signal] = await once(child, 'close');
    expect(timedOut).toBe(false);
    expect(signal).toBeNull();
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timeout);
  }
}

it('runs the advertised MCP CLI against an explicit model endpoint and selects public:example', async () => {
  const peer = await records();
  const model = new ModelServer([
    [
      call(
        'lookup',
        { key: 'example' },
        { namespace: 'mcp__records', callId: 'read-example' },
      ),
    ],
    (request) => {
      expect(JSON.stringify(request.input)).toContain(
        'record-result-from-trusted-peer',
      );
      return [message('example record read')];
    },
  ]);
  const result = await cli(model, peer.url);
  expect(result.code).toBe(0);
  expect(result.stdout.trim()).toBe('example record read');
  expect(
    peer.calls.map(({ name, arguments: args }) => ({ name, arguments: args })),
  ).toEqual([{ name: 'lookup', arguments: { key: 'public:example' } }]);
  expect(peer.methods).toContain('initialize');
  expect(peer.methods).toContain('tools/list');
  expect(peer.methods.indexOf('tools/list')).toBeLessThan(
    peer.methods.indexOf('tools/call'),
  );
  expect(model.requests).toHaveLength(2);
  expect(JSON.stringify(model.requests[0].input)).not.toContain(
    'record-result-from-trusted-peer',
  );
  expect(JSON.stringify(result)).not.toContain(
    'synthetic-loopback-example-key',
  );
  await expect.poll(() => peer.sockets.size).toBe(0);
  model.assertExhausted();
}, 30_000);

it('keeps the advertised CLI allowlist after argument replacement and closes on denial', async () => {
  const peer = await records();
  const model = new ModelServer([
    [
      call(
        'lookup',
        { key: 'private' },
        { namespace: 'mcp__records', callId: 'denied-example' },
      ),
    ],
  ]);
  const result = await cli(model, peer.url);
  expect(result.code).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('NativeError');
  expect(peer.calls).toEqual([]);
  // Discovery is allowed before policy admission. No tool effect or model retry follows denial.
  expect(peer.methods).toContain('tools/list');
  expect(model.requests).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain(
    'synthetic-loopback-example-key',
  );
  await expect.poll(() => peer.sockets.size).toBe(0);
  model.assertExhausted();
}, 30_000);
