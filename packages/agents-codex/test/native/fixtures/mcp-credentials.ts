import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ModelServer, message, call as functionCall } from './model-server';
import { Agent, HttpMCP, NativeProvider, type Session } from '../../../src';
import type { JsonObject } from '../../../src/runtime/binding';

const sessions: Session[] = [];
const providers: NativeProvider[] = [];
const servers: Server[] = [];
let directory: string | undefined;

async function cleanup() {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  await Promise.all(providers.splice(0).map((provider) => provider.close()));
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
  await ModelServer.closeAll();
}

async function peer(label: string, token: string) {
  const auth: Array<string | undefined> = [];
  const calls: JsonObject[] = [];
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    auth.push(request.headers.authorization);
    if (request.headers.authorization !== 'Bearer ' + token) {
      response.writeHead(401).end();
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    const parts: Buffer[] = [];
    for await (const part of request) parts.push(Buffer.from(part));
    const rpc = JSON.parse(Buffer.concat(parts).toString());
    requests.push(rpc.method);
    if (rpc.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    let result: object = {};
    if (rpc.method === 'initialize')
      result = {
        protocolVersion: rpc.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: label, version: '1' },
      };
    else if (rpc.method === 'tools/list')
      result = {
        tools: [
          {
            name: 'search',
            description: 'Read the current record',
            annotations: {
              readOnlyHint: true,
              destructiveHint: false,
              openWorldHint: false,
            },
            inputSchema: {
              type: 'object',
              properties: { key: { type: 'string' } },
              required: ['key'],
            },
          },
        ],
      };
    else if (rpc.method === 'tools/call') {
      calls.push(rpc.params);
      result = { content: [{ type: 'text', text: label }] };
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No MCP peer port');
  return {
    url: 'http://127.0.0.1:' + address.port + '/mcp',
    calls,
    requests,
    auth,
  };
}

async function main() {
  const credential = process.argv[2];
  assert.equal(credential, 'literal');
  directory = await mkdtemp(join(tmpdir(), 'agents-mcp-credentials-'));
  const oldToken = 'synthetic-old-mcp-credential';
  const newToken = 'synthetic-current-mcp-credential';
  const old = await peer('old-record', oldToken);
  const current = await peer('current-record', newToken);
  const original = new HttpMCP({
    name: 'docs',
    url: old.url,
    bearerToken: oldToken,
    tools: ['search'],
    approvalMode: 'preapproved',
  });
  const selected = new HttpMCP({
    name: 'docs',
    url: current.url,
    bearerToken: newToken,
    tools: ['search'],
    approvalMode: 'preapproved',
  });
  const call = (key: string) =>
    functionCall('search', { key }, { callId: key, namespace: 'mcp__docs' });
  const agent = async (model: ModelServer, server?: HttpMCP) => {
    const config = await model.config();
    const route = config['model_providers.fixture'] as { base_url: string };
    const provider = new NativeProvider({
      baseUrl: route.base_url,
      apiKey: 'synthetic',
    });
    providers.push(provider);
    return new Agent({
      instructions: 'Read the selected record.',
      model: 'gpt-5',
      provider,
      tools: server ? [server] : [],
    });
  };
  const model = new ModelServer([
    [call('old')],
    [message('old')],
    [call('removed')],
    [message('removed')],
    [call('replaced')],
    [message('replaced')],
  ]);
  const session = await (await agent(model, original)).session();
  sessions.push(session);
  assert.equal((await (await session.submit('old')).wait()).finalOutput, 'old');
  assert.equal(old.calls.length, 1);
  assert.ok(JSON.stringify(model.requests[1].input).includes('old-record'));
  const saved = await session.saveState();
  const accepted = saved.history.filter((row) => row.type === 'response_item');
  assert.deepEqual(saved.agent_options, {});
  for (const value of [oldToken, old.url, 'AGENTS_MCP_OLD_TEST_TOKEN'])
    assert.ok(!JSON.stringify(saved).includes(value));
  await session.update({ tools: [] });
  assert.equal(
    (await (await session.submit('removed')).wait()).finalOutput,
    'removed',
  );
  assert.equal(old.calls.length, 1);
  assert.ok(!JSON.stringify(model.requests[2].tools).includes('mcp__docs'));
  await session.update({ tools: [selected] });
  assert.equal(
    (await (await session.submit('replaced')).wait()).finalOutput,
    'replaced',
  );
  assert.equal(current.calls.length, 1);
  assert.ok(JSON.stringify(model.requests[5].input).includes('current-record'));
  model.assertExhausted();
  await session.close();
  const oldCount = old.requests.length;
  const restoredModel = new ModelServer([
    [call('restored')],
    [message('restored')],
  ]);
  const restored = await (
    await agent(restoredModel, selected)
  ).session({
    state: {
      ...saved,
      agent_options: {
        config: {
          mcp_servers: {
            stale: {
              url: old.url,
              http_headers: { Authorization: 'Bearer ' + oldToken },
            },
          },
        },
      },
    },
  });
  sessions.push(restored);
  assert.deepEqual(
    (await restored.saveState()).history.filter(
      (row) => row.type === 'response_item',
    ),
    accepted,
  );
  assert.equal(
    (await (await restored.submit('restore')).wait()).finalOutput,
    'restored',
  );
  assert.ok(
    JSON.stringify(restoredModel.requests[1].input).includes('current-record'),
  );
  assert.deepEqual((await restored.saveState()).agent_options, {});
  restoredModel.assertExhausted();
  await restored.close();
  const withoutModel = new ModelServer([[message('no server')]]);
  const without = await (await agent(withoutModel)).session({ state: saved });
  sessions.push(without);
  assert.equal(
    (await (await without.submit('continue')).wait()).finalOutput,
    'no server',
  );
  assert.ok(
    !JSON.stringify(withoutModel.requests[0].tools).includes('mcp__docs'),
  );
  assert.equal(old.requests.length, oldCount);
  assert.deepEqual(
    old.calls.map((entry) => entry.arguments),
    [{ key: 'old' }],
  );
  assert.deepEqual(
    current.calls.map((entry) => entry.arguments),
    [{ key: 'replaced' }, { key: 'restored' }],
  );
  assert.deepEqual(new Set(old.auth), new Set(['Bearer ' + oldToken]));
  assert.deepEqual(new Set(current.auth), new Set(['Bearer ' + newToken]));
  for (const value of [oldToken, newToken]) {
    assert.ok(
      !JSON.stringify([
        ...model.requests,
        ...restoredModel.requests,
        ...withoutModel.requests,
      ]).includes(value),
    );
  }
  process.stdout.write(JSON.stringify({ credential, result: 'ok' }));
}
main()
  .finally(cleanup)
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
