import { once } from 'node:events';
import { createServer } from 'node:http';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Environment,
  HttpMCP,
  NativeAgents,
  NativeProvider,
  fileSearch,
  tool,
  toolRef,
  webSearch,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';
import { nativeDescendantModel } from './fixtures/native-descendant-model';

afterEach(() => ModelServer.closeAll());

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-catalog',
    supportsWebsockets: false,
  });
}

const callback = (name: string, execute: () => string, namespace?: string) =>
  tool({ name, namespace, parameters: z.object({}), execute });

async function mcpPeer() {
  const calls: { name: string; tenant: string | string[] | undefined }[] = [];
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const rpc = JSON.parse(Buffer.concat(chunks).toString());
    if (rpc.method === 'tools/call')
      calls.push({
        name: rpc.params.name,
        tenant: request.headers['x-catalog-tenant'],
      });
    if (rpc.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    const result =
      rpc.method === 'initialize'
        ? {
            protocolVersion: rpc.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'catalog', version: '1' },
          }
        : rpc.method === 'tools/call'
          ? { content: [{ type: 'text', text: 'remote result' }] }
          : {
              tools: [
                {
                  name: 'remote',
                  inputSchema: { type: 'object', properties: {} },
                },
              ],
            };
    response
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No MCP listener');
  return { url: `http://127.0.0.1:${address.port}/mcp`, calls };
}

it.each(['none', 'dormant', 'ordinary', 'guarded'] as const)(
  'preserves admitted declarations and narrower defaults after a %s MCP update',
  async (kind) => {
    const effects: string[] = [];
    const original = callback('lookup', () => 'old');
    const other = callback('other', () => {
      effects.push('other');
      return 'other';
    });
    const replacement = callback('lookup', () => {
      effects.push('new');
      return 'new';
    });
    const peer =
      kind === 'ordinary' || kind === 'guarded' ? await mcpPeer() : undefined;
    const oldBefore = vi.fn(() => ({ action: 'allow' as const }));
    const currentBefore = vi.fn(() => ({ action: 'allow' as const }));
    const suppliedHeaders = { 'X-Catalog-Tenant': 'current-captured' };
    const mcp =
      kind === 'none'
        ? []
        : [
            new HttpMCP({
              name: 'catalog',
              url: peer?.url ?? 'http://127.0.0.1:1/mcp',
              tools: peer ? ['remote'] : [],
              activation: peer ? 'session' : 'operation',
              approvalMode: 'preapproved',
              headers: { 'X-Catalog-Tenant': 'old-captured' },
              ...(kind === 'guarded' ? { before: oldBefore } : {}),
            }),
          ];
    const currentMcp = mcp.map(
      (server) =>
        new HttpMCP({
          name: server.name,
          url: server.url,
          tools: server.tools,
          activation: server.activation,
          approvalMode: server.approvalMode,
          headers: suppliedHeaders,
          ...(kind === 'guarded' ? { before: currentBefore } : {}),
        }),
    );
    suppliedHeaders['X-Catalog-Tenant'] = 'mutated-after-capture';
    const managedNames = (request: { tools?: unknown }) =>
      (request.tools as { type: string; name: string }[])
        .filter(
          (entry) =>
            entry.type === 'function' &&
            ['lookup', 'other'].includes(entry.name),
        )
        .map((entry) => entry.name);
    const server = new ModelServer([
      (request) => {
        expect(managedNames(request)).toEqual(['lookup']);
        return [call('lookup', {}, { callId: 'default' })];
      },
      [message('default')],
      (request) => {
        expect(managedNames(request)).toEqual(['lookup', 'other']);
        return [
          call('lookup', {}, { callId: 'replacement' }),
          call('other', {}, { callId: 'retained' }),
          ...(peer
            ? [
                call(
                  'remote',
                  {},
                  { namespace: 'mcp__catalog', callId: 'remote' },
                ),
              ]
            : []),
        ];
      },
      [message('selected')],
      (request) => {
        expect(managedNames(request)).toEqual([]);
        return [message('empty')];
      },
      [call('lookup', {}, { callId: 'readmitted' })],
      [message('retained')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Use selected tools.',
      provider,
      model: 'gpt-5',
      tools: [original, other, ...mcp],
    }).session();
    await session.update({ tools: [replacement, ...currentMcp] });
    expect(server.requests).toHaveLength(0);
    expect((await (await session.submit('default')).wait()).finalOutput).toBe(
      'default',
    );
    expect(
      (
        await (
          await session.submit('select', {
            tools: [
              replacement,
              toolRef('other'),
              ...(peer ? [currentMcp[0].tool('remote')] : []),
            ],
          })
        ).wait()
      ).finalOutput,
    ).toBe('selected');
    await session.update({ tools: currentMcp });
    expect((await (await session.submit('empty')).wait()).finalOutput).toBe(
      'empty',
    );
    expect(
      (
        await (
          await session.submit('retained', { tools: [replacement] })
        ).wait()
      ).finalOutput,
    ).toBe('retained');
    expect(effects.sort()).toEqual(['new', 'new', 'new', 'other']);
    expect(peer?.calls ?? []).toEqual(
      peer ? [{ name: 'remote', tenant: 'current-captured' }] : [],
    );
    expect(oldBefore).not.toHaveBeenCalled();
    expect(currentBefore).toHaveBeenCalledTimes(kind === 'guarded' ? 1 : 0);
    server.assertExhausted();
  },
  30_000,
);

it('allows a qualified web_search callback with hosted WebSearch through opening and update', async () => {
  const effects: string[] = [];
  const search = webSearch({ route: 'hosted' });
  const original = callback(
    'web_search',
    () => {
      effects.push('old');
      return 'old';
    },
    'crm',
  );
  const replacement = callback(
    'web_search',
    () => {
      effects.push('new');
      return 'new';
    },
    'crm',
  );
  const server = new ModelServer([
    [call('web_search', {}, { namespace: 'crm', callId: 'old' })],
    [message('old')],
    [call('web_search', {}, { namespace: 'crm', callId: 'new' })],
    [message('new')],
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Use CRM.',
    model: 'gpt-5',
    provider,
    tools: [search, original],
  }).session();
  expect((await (await session.submit('old')).wait()).finalOutput).toBe('old');
  await session.update({ tools: [search, replacement] });
  expect(
    (await (await session.submit('new', { tools: [replacement] })).wait())
      .finalOutput,
  ).toBe('new');
  expect(server.requests[0].tools).toContainEqual(
    expect.objectContaining({ type: 'web_search' }),
  );
  expect(effects).toEqual(['old', 'new']);
  server.assertExhausted();
});

it.each([undefined, 'functions'])(
  'still reserves hosted functions.web_search (%s)',
  async (namespace) => {
    await using provider = new NativeProvider();
    const acquire = vi.spyOn(provider, '_acquire');
    const agent = new Agent({
      instructions: 'Act.',
      provider,
      tools: [
        webSearch({ route: 'hosted' }),
        callback('web_search', () => 'unused', namespace),
      ],
    });
    await expect(agent.validate()).rejects.toThrow('reserves');
    await expect(agent.session()).rejects.toThrow('reserves');
    expect(acquire).not.toHaveBeenCalled();
  },
);

it('rejects custom collaboration functions with NativeAgents before opening or validation work', async () => {
  await using provider = new NativeProvider();
  const acquire = vi.spyOn(provider, '_acquire');
  const execute = vi.fn(() => 'unused');
  const agent = new Agent({
    instructions: 'Act.',
    provider,
    tools: [new NativeAgents(), callback('lookup', execute, 'collaboration')],
  });
  await expect(agent.validate()).rejects.toThrow(
    'NativeAgents reserves the collaboration namespace',
  );
  await expect(agent.session()).rejects.toThrow(
    'NativeAgents reserves the collaboration namespace',
  );
  expect(acquire).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
});

it.each([false, true])(
  'retains custom namespaces with NativeAgents=%s',
  async (native) => {
    const namespace = native ? 'crm' : 'collaboration';
    const execute = vi.fn(() => 'called');
    const server = new ModelServer([
      [call('lookup', {}, { namespace, callId: 'custom' })],
      [message('done')],
    ]);
    await using provider = await providerFor(server);
    const executor = native ? await startPublicExecutor() : undefined;
    if (executor) onTestFinished(() => executor.close());
    await using session = await new Agent({
      instructions: 'Use lookup.',
      provider,
      model: nativeDescendantModel,
      tools: [
        callback('lookup', execute, namespace),
        ...(native ? [new NativeAgents()] : []),
      ],
    }).session(
      executor
        ? {
            environment: new Environment({
              url: executor.url,
              cwd: executor.cwd,
              headers: executor.headers,
              tools: ['exec_command', 'write_stdin', 'apply_patch'],
            }),
          }
        : {},
    );
    expect((await (await session.submit('call')).wait()).finalOutput).toBe(
      'done',
    );
    expect(execute).toHaveBeenCalledOnce();
    server.assertExhausted();
  },
);

it.each([
  { namespaced: true, reverse: false },
  { namespaced: true, reverse: true },
  { namespaced: false, reverse: false },
  { namespaced: false, reverse: true },
])(
  'rejects ambiguous Code Mode exposure and retains root/step narrowing: %j',
  async ({ namespaced, reverse }) => {
    const effects: string[] = [];
    const bare = callback(namespaced ? 'crm__lookup' : 'foo-bar', () => {
      effects.push('bare');
      return 'bare';
    });
    const selected = callback(
      namespaced ? 'lookup' : 'foo_bar',
      () => {
        effects.push('selected');
        return 'selected';
      },
      namespaced ? 'crm' : undefined,
    );
    const symbol = namespaced ? 'crm__lookup' : 'foo_bar';
    const cell = (id: string) => ({
      type: 'custom_tool_call',
      call_id: id,
      name: 'exec',
      input: `text(await tools.${symbol}({}));`,
    });
    const server = new ModelServer([
      [cell('root')],
      [message('root')],
      [cell('step')],
      [message('step')],
      [cell('updated')],
      [message('updated')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Call the selected tool.',
      model: 'gpt-5.5',
      provider,
      tools: reverse ? [selected, bare] : [bare, selected],
      programmaticToolCalling: true,
    }).session();
    await expect((await session.submit('ambiguous')).wait()).rejects.toThrow(
      'Code Mode tool names collide after normalization',
    );
    expect(server.requests).toHaveLength(0);
    expect(effects).toEqual([]);
    expect(
      (await (await session.submit('root', { tools: [selected] })).wait())
        .finalOutput,
    ).toBe('root');
    await expect(
      (
        await session.submit('ambiguous step', {
          beforeStep: () => [bare, selected],
        })
      ).wait(),
    ).rejects.toThrow('Code Mode tool names collide after normalization');
    expect(server.requests).toHaveLength(2);
    expect(
      (
        await (
          await session.submit('step', { beforeStep: () => [selected] })
        ).wait()
      ).finalOutput,
    ).toBe('step');
    await session.update({ tools: [selected] });
    expect((await (await session.submit('updated')).wait()).finalOutput).toBe(
      'updated',
    );
    expect(effects).toEqual(['selected', 'selected', 'selected']);
    server.assertExhausted();
  },
  30_000,
);

it('preserves direct dispatch for both declarations with the same Code Mode projection', async () => {
  const effects: string[] = [];
  const server = new ModelServer([
    [
      call('crm__lookup', {}, { callId: 'bare' }),
      call('lookup', {}, { namespace: 'crm', callId: 'qualified' }),
    ],
    [message('done')],
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Call both.',
    model: 'gpt-5.5',
    provider,
    tools: [
      callback('crm__lookup', () => {
        effects.push('bare');
        return 'bare';
      }),
      callback(
        'lookup',
        () => {
          effects.push('qualified');
          return 'qualified';
        },
        'crm',
      ),
    ],
  }).session();
  expect((await (await session.submit('both')).wait()).finalOutput).toBe(
    'done',
  );
  expect(effects.sort()).toEqual(['bare', 'qualified']);
  server.assertExhausted();
});

it('excludes hosted specs and direct-only namespaces from Code Mode collision checks', async () => {
  const effects: string[] = [];
  const server = new ModelServer([
    [
      {
        type: 'custom_tool_call',
        call_id: 'cell',
        name: 'exec',
        input:
          'text(await tools.file_search({}));text(await tools.collaboration__lookup({}));',
      },
    ],
    [message('done')],
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Use the callable methods.',
    model: 'gpt-5.5',
    provider,
    programmaticToolCalling: true,
    tools: [
      fileSearch('vs_fixture'),
      callback('file-search', () => {
        effects.push('function');
        return 'function';
      }),
      callback('collaboration__lookup', () => {
        effects.push('bare');
        return 'bare';
      }),
      callback(
        'lookup',
        () => {
          effects.push('direct-only');
          return 'direct';
        },
        'collaboration',
      ),
    ],
  }).session();
  expect((await (await session.submit('call')).wait()).finalOutput).toBe(
    'done',
  );
  expect(effects).toEqual(['function', 'bare']);
  server.assertExhausted();
}, 30_000);
