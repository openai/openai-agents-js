import { createServer } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { Agent, HttpMCP, NativeProvider } from '@openai/agents-codex';
import { MCPApp } from '@openai/agents-codex/mcp-apps';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  await ModelServer.closeAll();
});
const uri = 'ui://synthetic/billing';
const mimeType = 'text/html;profile=mcp-app';
const html = '<!doctype html><html><body>Billing</body></html>';
const preservedJson = JSON.parse(
  '{"__proto__":{"retained":true},"constructor":{"prototype":{"retained":true}}}',
) as JsonObject;

async function peer(
  linked: boolean,
  policy: 'plain' | 'before' | 'approval' | 'transform' | 'native' = 'plain',
  resourceFields: JsonObject = {},
  holdAction?: Promise<void>,
  toolMetadata?: JsonObject,
  resultResource?: JsonObject,
) {
  const resource: JsonObject = {
    uri,
    mimeType,
    text: html,
    _meta: { synthetic: true, payload: preservedJson },
    ...resourceFields,
  };
  if (resourceFields.blob !== undefined) delete resource.text;
  const calls: JsonObject[] = [];
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const rpc = JSON.parse(Buffer.concat(chunks).toString()) as JsonObject;
    if (rpc.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    calls.push(rpc);
    const params = (rpc.params ?? {}) as JsonObject;
    let result: JsonObject = {};
    if (rpc.method === 'initialize')
      result = {
        protocolVersion: params.protocolVersion,
        capabilities: { tools: {}, resources: {} },
        serverInfo: { name: 'apps', version: '1' },
      };
    else if (rpc.method === 'tools/list')
      result = {
        tools: [
          {
            name: 'display',
            ...(toolMetadata === undefined ? {} : { _meta: toolMetadata }),
            inputSchema: {
              type: 'object',
              properties: {
                count: { type: 'integer' },
                payload: { type: 'object' },
              },
              required: ['count'],
              additionalProperties: false,
            },
          },
        ],
      };
    else if (rpc.method === 'resources/read') result = { contents: [resource] };
    else if (rpc.method === 'tools/call') {
      if (calls.filter((entry) => entry.method === 'tools/call').length > 1)
        await holdAction;
      result = {
        content:
          toolMetadata === undefined
            ? [
                linked
                  ? {
                      type: 'resource_link',
                      uri,
                      name: 'Billing app',
                      mimeType,
                    }
                  : { type: 'resource', resource },
              ]
            : resultResource
              ? [{ type: 'resource', resource: resultResource }]
              : [{ type: 'text', text: 'Counter data' }],
        structuredContent: {
          count: (params.arguments as JsonObject).count,
          payload: preservedJson,
        },
      };
    }
    response
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing fixture port');
  const declaration = new HttpMCP({
    name: 'apps',
    url: `http://127.0.0.1:${address.port}/mcp`,
    tools: ['display'],
    approvalMode: policy === 'native' ? 'native' : 'preapproved',
    ...(policy === 'before'
      ? { before: () => ({ action: 'allow' as const }) }
      : {}),
    ...(policy === 'approval' ? { approval: () => true } : {}),
    ...(policy === 'transform'
      ? { transformResult: (_context: unknown, result: JsonObject) => result }
      : {}),
  });
  return { declaration, calls };
}

async function open(declaration: HttpMCP, extraResponses = false) {
  const model = new ModelServer([
    [
      call(
        'display',
        { count: 1 },
        { callId: 'app-origin', namespace: 'mcp__apps' },
      ),
    ],
    [message('App ready')],
    ...(extraResponses ? [[message('Later turn')]] : []),
  ]);
  const config = await model.config();
  const provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-mcp-app-key',
    supportsWebsockets: false,
  });
  cleanup.push(() => provider.close());
  const session = await new Agent({
    instructions: 'Display the billing app.',
    model: 'gpt-5.5',
    provider,
    tools: [declaration],
  }).session({
    onInteraction: (request) => {
      if (request.type === 'approval_request')
        return request.reply('allow_once');
      throw new Error('Unexpected synthetic MCP interaction');
    },
  });
  cleanup.push(() => session.close());
  const turn = await session.submit('Show the app');
  expect((await turn.wait()).finalOutput).toBe('App ready');
  return { session, turn, model };
}

it.each([false, true])(
  'opens retained HTML (linked=%s) and calls its exact native tool',
  async (linked) => {
    const remote = await peer(linked);
    const { session, turn, model } = await open(remote.declaration);
    const app = await MCPApp.open(session, turn, 'app-origin');
    expect(app.view).toMatchObject({
      callId: 'app-origin',
      toolName: 'display',
      arguments: { count: 1 },
      resource: {
        uri,
        mimeType,
        text: html,
        _meta: { synthetic: true },
      },
    });
    const detached = app.view;
    detached.resource.text = 'caller mutation';
    expect(app.view.resource.text).toBe(html);
    expect((app.view.result.structuredContent as JsonObject).payload).toEqual(
      preservedJson,
    );
    expect(app.view.resource._meta?.payload).toEqual(preservedJson);
    const output = await app.callTool('display', {
      count: 2,
      payload: preservedJson,
    });
    expect(output).toMatchObject({ structuredContent: { count: 2 } });
    expect((output.structuredContent as JsonObject).payload).toEqual(
      preservedJson,
    );
    expect(
      Object.hasOwn(
        (output.structuredContent as JsonObject).payload as object,
        '__proto__',
      ),
    ).toBe(true);
    expect(
      remote.calls
        .filter((rpc) => rpc.method === 'tools/call')
        .map((rpc) => {
          const params = rpc.params as JsonObject;
          return { name: params.name, arguments: params.arguments };
        }),
    ).toEqual([
      { name: 'display', arguments: { count: 1 } },
      { name: 'display', arguments: { count: 2, payload: preservedJson } },
    ]);
    expect(
      remote.calls.filter((rpc) => rpc.method === 'initialize'),
    ).toHaveLength(1);
    expect(
      remote.calls.filter((rpc) => rpc.method === 'resources/read'),
    ).toHaveLength(linked ? 1 : 0);
    expect(model.requests).toHaveLength(2);
    await expect(app.callTool('other', {})).rejects.toThrow('originating');
    app.close();
    await expect(app.callTool('display', {})).rejects.toThrow('closed');
    await expect(session.saveState()).resolves.toBeDefined();
    model.assertExhausted();
  },
);

it('rejects foreign handles and stale views after a later root', async () => {
  const remote = await peer(false);
  const first = await open(remote.declaration, true);
  const second = await open(remote.declaration);
  await expect(
    MCPApp.open(first.session, second.turn, 'app-origin'),
  ).rejects.toThrow('latest');
  await expect(
    MCPApp.open(first.session, first.turn, 'missing'),
  ).rejects.toThrow('canonical');
  const app = await MCPApp.open(first.session, first.turn, 'app-origin');
  await (await first.session.submit('Continue')).wait();
  await expect(app.callTool('display', {})).rejects.toThrow('latest');
  await expect(
    MCPApp.open(first.session, first.turn, 'app-origin'),
  ).rejects.toThrow('latest');
  expect(
    remote.calls.filter((rpc) => rpc.method === 'tools/call'),
  ).toHaveLength(2);
});

it('rejects same-name endpoint replacement and change-and-revert', async () => {
  const remote = await peer(false);
  const replacement = await peer(false);
  const { session, turn } = await open(remote.declaration);
  const app = await MCPApp.open(session, turn, 'app-origin');
  await session.update({ tools: [replacement.declaration] });
  await expect(app.callTool('display', {})).rejects.toThrow('latest');
  await session.update({ tools: [remote.declaration] });
  await expect(MCPApp.open(session, turn, 'app-origin')).rejects.toThrow(
    'latest',
  );
  expect(
    remote.calls.filter((rpc) => rpc.method === 'tools/call'),
  ).toHaveLength(1);
  expect(
    replacement.calls.filter((rpc) => rpc.method === 'tools/call'),
  ).toHaveLength(0);
});

it.each(['before', 'approval', 'transform', 'native'] as const)(
  'rejects unsupported %s policy before action dispatch',
  async (policy) => {
    const remote = await peer(false, policy);
    const { session, turn } = await open(remote.declaration);
    await expect(MCPApp.open(session, turn, 'app-origin')).rejects.toThrow(
      'preapproved',
    );
    expect(
      remote.calls.filter((rpc) => rpc.method === 'tools/call'),
    ).toHaveLength(1);
  },
);

it.each<JsonObject>([
  { text: 'x'.repeat(64 * 1024 + 1) },
  { blob: 'AAEC' },
  { mimeType: 'text/html' },
])('rejects unsupported MCP App resource content', async (resourceFields) => {
  const remote = await peer(false, 'plain', resourceFields);
  const { session, turn } = await open(remote.declaration);
  await expect(MCPApp.open(session, turn, 'app-origin')).rejects.toThrow(
    'MCPApp',
  );
  expect(
    remote.calls.filter((rpc) => rpc.method === 'tools/call'),
  ).toHaveLength(1);
});

it('accepts a linked HTML resource at the 64 KiB boundary', async () => {
  const remote = await peer(true, 'plain', { text: 'x'.repeat(64 * 1024) });
  const { session, turn } = await open(remote.declaration);
  const app = await MCPApp.open(session, turn, 'app-origin');
  expect(Buffer.byteLength(app.view.resource.text, 'utf8')).toBe(64 * 1024);
  expect(app.view.resource._meta?.payload).toEqual(preservedJson);
  expect(
    Object.hasOwn(app.view.resource._meta?.payload as object, '__proto__'),
  ).toBe(true);
  app.close();
});

it('excludes other work and joins a pending native MCP App action when the Session closes', async () => {
  const release = Promise.withResolvers<void>();
  const remote = await peer(false, 'plain', {}, release.promise);
  const { session, turn, model } = await open(remote.declaration);
  const app = await MCPApp.open(session, turn, 'app-origin');
  let actionSettled = false;
  let closeSettled = false;
  const action = app
    .callTool('display', { count: 2 })
    .then(
      () => {
        throw new Error('Held action unexpectedly succeeded');
      },
      (error: unknown) => error,
    )
    .finally(() => {
      actionSettled = true;
    });
  let closing: Promise<void> | undefined;
  try {
    await vi.waitFor(() =>
      expect(
        remote.calls.filter((rpc) => rpc.method === 'tools/call'),
      ).toHaveLength(2),
    );
    await expect(session.submit('Must remain idle')).rejects.toThrow();
    closing = session.close().finally(() => {
      closeSettled = true;
    });
    await vi.waitFor(
      () => {
        expect(actionSettled).toBe(true);
        expect(closeSettled).toBe(true);
      },
      { timeout: 2000 },
    );
    expect(await action).toBeInstanceOf(Error);
    await expect(app.callTool('display', { count: 3 })).rejects.toThrow();
    expect(
      remote.calls.filter((rpc) => rpc.method === 'tools/call'),
    ).toHaveLength(2);
    expect(model.requests).toHaveLength(2);
  } finally {
    release.resolve();
    await Promise.allSettled([action, ...(closing ? [closing] : [])]);
    app.close();
  }
});

it.each([
  { ui: { resourceUri: uri } },
  { 'ui/resourceUri': uri },
] as JsonObject[])(
  'opens negotiated tool UI metadata without result resources (%j)',
  async (metadata) => {
    const remote = await peer(false, 'plain', {}, undefined, metadata);
    const { session, turn, model } = await open(remote.declaration);
    const app = await MCPApp.open(session, turn, 'app-origin');
    expect(app.view.resource).toMatchObject({ uri, mimeType, text: html });
    expect(app.view.result.content).toEqual([
      { type: 'text', text: 'Counter data' },
    ]);
    expect(
      (await app.callTool('display', { count: 2 })).structuredContent,
    ).toMatchObject({ count: 2 });
    const reads = remote.calls.filter((rpc) => rpc.method === 'resources/read');
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ params: { uri } });
    expect(
      remote.calls.filter((rpc) => rpc.method === 'initialize'),
    ).toHaveLength(1);
    expect(
      remote.calls
        .filter((rpc) => rpc.method === 'tools/call')
        .map((rpc) => {
          const params = rpc.params as JsonObject;
          return { name: params.name, arguments: params.arguments };
        }),
    ).toEqual([
      { name: 'display', arguments: { count: 1 } },
      { name: 'display', arguments: { count: 2 } },
    ]);
    model.assertExhausted();
  },
);

it.each([
  { ui: { resourceUri: 'https://untrusted.invalid/app' } },
  { ui: { resourceUri: null } },
  { ui: { resourceUri: '' } },
  { ui: { resourceUri: uri }, 'ui/resourceUri': 'ui://other/app' },
  { ui: 'invalid' },
] as JsonObject[])(
  'rejects malformed or conflicting declared UI metadata (%j)',
  async (metadata) => {
    const remote = await peer(false, 'plain', {}, undefined, metadata);
    const { session, turn } = await open(remote.declaration);
    await expect(MCPApp.open(session, turn, 'app-origin')).rejects.toThrow(
      /metadata|URI/,
    );
    expect(
      remote.calls.filter((rpc) => rpc.method === 'resources/read'),
    ).toHaveLength(0);
  },
);

it('uses declared resource authority instead of a conflicting result resource and keeps the captured view', async () => {
  const metadata = { ui: { resourceUri: uri } };
  const remote = await peer(false, 'plain', {}, undefined, metadata, {
    uri: 'ui://other/app',
    mimeType,
    text: 'Unselected result HTML',
  });
  const { session, turn } = await open(remote.declaration);
  const app = await MCPApp.open(session, turn, 'app-origin');
  expect(app.view.resource).toMatchObject({ uri, text: html });
  metadata.ui.resourceUri = 'ui://later/app';
  expect(app.view.resource.uri).toBe(uri);
  await expect(app.callTool('other', {})).rejects.toThrow();
  app.close();
  await expect(app.callTool('display', { count: 2 })).rejects.toThrow();
});
