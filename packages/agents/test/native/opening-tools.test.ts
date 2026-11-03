import { once } from 'node:events';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  HttpMCP,
  NativeProvider,
  manualTool,
  tool,
  type SessionOptions,
  type Tool,
  type ToolContext,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';
import * as nativeBinding from '../../src/runtime/binding';

afterEach(() => ModelServer.closeAll());

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'fixture',
    supportsWebsockets: false,
  });
}

const lookup = (value: string) =>
  tool({ name: 'lookup', parameters: z.object({}), execute: () => value });

async function mcpPeer(value: string) {
  const methods: string[] = [];
  const peer = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const rpc = JSON.parse(Buffer.concat(chunks).toString());
    methods.push(rpc.method);
    if (rpc.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    const result =
      rpc.method === 'initialize'
        ? {
            protocolVersion: rpc.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'opening-fixture', version: '1' },
          }
        : rpc.method === 'tools/list'
          ? {
              tools: [
                {
                  name: 'lookup',
                  description: 'Lookup.',
                  inputSchema: {
                    type: 'object',
                    properties: {},
                    additionalProperties: false,
                  },
                },
              ],
            }
          : { content: [{ type: 'text', text: value }] };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  peer.listen(0, '127.0.0.1');
  await once(peer, 'listening');
  const address = peer.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected TCP listener');
  return {
    methods,
    tool: new HttpMCP({
      name: 'fixture',
      tools: ['lookup'],
      approvalMode: 'approve',
      url: `http://127.0.0.1:${address.port}/mcp`,
    }),
    async close() {
      peer.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        peer.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

describe('opening tool declarations', () => {
  it('inherits omitted declarations and lets an empty opening replace them', async () => {
    const execute = vi.fn(() => 'inherited callback result');
    const server = new ModelServer([
      (request) => {
        expect(request.tools).toEqual([
          expect.objectContaining({ name: 'lookup' }),
        ]);
        return [call('lookup', {}, { callId: 'inherited-call' })];
      },
      (request) => {
        expect(JSON.stringify(request.input)).toContain(
          'inherited callback result',
        );
        return [message('inherited')];
      },
      (request) => {
        expect(request.tools).toEqual([]);
        return [call('lookup', {}, { callId: 'undeclared-call' })];
      },
      (request) => {
        expect(request.input).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'function_call_output',
              call_id: 'undeclared-call',
              output: 'unsupported call: lookup',
            }),
          ]),
        );
        return [message('empty')];
      },
    ]);
    const provider = await providerFor(server);
    const inherited = tool({
      name: 'lookup',
      parameters: z.object({}),
      execute,
    });
    const agent = new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
      tools: [inherited],
    });
    for (const options of [undefined, { tools: [] }]) {
      const session = await agent.session(options);
      try {
        await (await session.submit('Answer')).wait();
        expect(execute).toHaveBeenCalledTimes(1);
        if (options)
          await expect(
            session.update({ tools: [inherited] }),
          ).rejects.toThrow();
      } finally {
        await session.close();
      }
    }
    expect(agent.tools).toEqual([inherited]);
    await provider.close();
    server.assertExhausted();
  });

  it('keeps concurrent same-name callbacks bound to their opening', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let enteredCount = 0;
    const callbacks = ['tenant-a', 'tenant-b'].map((tenant) =>
      tool({
        name: 'lookup',
        parameters: z.object({}),
        async execute() {
          if (++enteredCount === 2) entered.resolve();
          await release.promise;
          return tenant;
        },
      }),
    );
    const servers = ['tenant-a', 'tenant-b'].map(
      (tenant) =>
        new ModelServer([
          [call('lookup', {}, { callId: tenant })],
          (request) => {
            expect(JSON.stringify(request.input)).toContain(tenant);
            expect(JSON.stringify(request.input)).not.toContain(
              tenant === 'tenant-a' ? 'tenant-b' : 'tenant-a',
            );
            return [message(tenant)];
          },
        ]),
    );
    const providers = await Promise.all(servers.map(providerFor));
    const agent = new Agent({
      instructions: 'Lookup.',
      model: 'gpt-5',
      provider: providers[0],
    });
    const firstOpening = agent.session({ tools: [callbacks[0]] });
    agent.provider = providers[1];
    const secondOpening = agent.session({ tools: [callbacks[1]] });
    const sessions = await Promise.all([firstOpening, secondOpening]);
    try {
      const turns = await Promise.all(
        sessions.map((session) => session.submit('Lookup')),
      );
      await entered.promise;
      release.resolve();
      expect(
        (await Promise.all(turns.map((turn) => turn.wait()))).map(
          (result) => result.finalOutput,
        ),
      ).toEqual(['tenant-a', 'tenant-b']);
      expect(agent.tools).toEqual([]);
    } finally {
      release.resolve();
      await Promise.all(sessions.map((session) => session.close()));
      await Promise.all(providers.map((provider) => provider.close()));
    }
    servers.forEach((server) => server.assertExhausted());
  });

  it('captures opening arrays, schemas, settings, provider, and the exact context reference before yielding', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const originalBinding = nativeBinding.binding;
    const binding = vi
      .spyOn(nativeBinding, 'binding')
      .mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return originalBinding();
      });
    const originalContext = { tenant: 'original' };
    let observedContext: typeof originalContext | undefined;
    const server = new ModelServer([
      (request) => {
        expect(request.reasoning).toMatchObject({ effort: 'low' });
        expect(request.tools).toEqual([
          expect.objectContaining({
            name: 'lookup',
            parameters: expect.objectContaining({
              properties: { key: { type: 'string' } },
            }),
          }),
        ]);
        return [call('lookup', { key: 'saved' }, { callId: 'captured' })];
      },
      (request) => {
        expect(JSON.stringify(request.input)).toContain('captured callback');
        return [message('captured')];
      },
    ]);
    const provider = await providerFor(server);
    const selected = {
      ...tool({
        name: 'lookup',
        parameters: z.object({ key: z.string() }),
        execute(_args, info: ToolContext<typeof originalContext>) {
          observedContext = info.context;
          return 'captured callback';
        },
      }),
    };
    const declarations: Tool<typeof originalContext>[] = [selected];
    const settings = { reasoningEffort: 'low' };
    const agent = new Agent<typeof originalContext>({
      instructions: 'Lookup.',
      model: 'gpt-5',
      provider,
      modelSettings: settings,
    });
    const options: SessionOptions<typeof originalContext> & {
      context: typeof originalContext;
    } = { tools: declarations, context: originalContext };
    const opening = agent.session(options);
    await entered.promise;
    options.context = { tenant: 'replacement' };
    declarations.length = 0;
    (selected.parameters as { properties: unknown }).properties = {};
    agent.modelSettings!.reasoningEffort = 'high';
    agent.tools = [lookup('later')];
    release.resolve();
    const session = await opening;
    try {
      expect((await (await session.submit('Lookup')).wait()).finalOutput).toBe(
        'captured',
      );
      expect(observedContext).toBe(originalContext);
    } finally {
      release.resolve();
      binding.mockRestore();
      await session.close();
      await provider.close();
    }
    server.assertExhausted();
  });

  it('keeps concurrent identical MCP aliases bound to each tenant endpoint', async () => {
    const peers = await Promise.all(
      ['mcp tenant-a', 'mcp tenant-b'].map(mcpPeer),
    );
    const servers = ['mcp tenant-a', 'mcp tenant-b'].map(
      (tenant) =>
        new ModelServer([
          [call('lookup', {}, { callId: 'lookup', namespace: 'mcp__fixture' })],
          (request) => {
            expect(JSON.stringify(request.input)).toContain(tenant);
            expect(JSON.stringify(request.input)).not.toContain(
              tenant === 'mcp tenant-a' ? 'mcp tenant-b' : 'mcp tenant-a',
            );
            return [message(tenant)];
          },
        ]),
    );
    const providers = await Promise.all(servers.map(providerFor));
    const agent = new Agent({
      instructions: 'Lookup.',
      model: 'gpt-5',
      provider: providers[0],
    });
    const firstOpening = agent.session({ tools: [peers[0].tool] });
    agent.provider = providers[1];
    const secondOpening = agent.session({ tools: [peers[1].tool] });
    const sessions = await Promise.all([firstOpening, secondOpening]);
    try {
      // This slice retains eager initialization and listing at opening.
      peers.forEach((peer) => expect(peer.methods).toContain('tools/list'));
      const results = await Promise.all(
        sessions.map(async (session) =>
          (await session.submit('Lookup')).wait(),
        ),
      );
      expect(results.map((result) => result.finalOutput)).toEqual([
        'mcp tenant-a',
        'mcp tenant-b',
      ]);
      peers.forEach((peer) =>
        expect(
          peer.methods.filter((method) => method === 'tools/call'),
        ).toHaveLength(1),
      );
    } finally {
      await Promise.all(sessions.map((session) => session.close()));
      await Promise.all(providers.map((provider) => provider.close()));
      await Promise.all(peers.map((peer) => peer.close()));
    }
    servers.forEach((server) => server.assertExhausted());
  });

  it('rejects hidden run tools before invoking an overridden session factory', async () => {
    class ObservedAgent extends Agent {
      opened = 0;
      override async session(options: SessionOptions = {}) {
        this.opened++;
        return super.session(options);
      }
    }
    const agent = new ObservedAgent({ instructions: 'Answer.' });
    const acquire = vi.spyOn(agent.provider, '_acquire');
    const options = { context: undefined, tools: [] };
    await expect(agent.run('Hello', options)).rejects.toThrow(/tools/i);
    expect(agent.opened).toBe(0);
    expect(acquire).not.toHaveBeenCalled();
    await agent.provider.close();
  });

  it('allows provider close during declaration preflight without reserving a lease', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const originalBinding = nativeBinding.binding;
    const binding = vi
      .spyOn(nativeBinding, 'binding')
      .mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return originalBinding();
      });
    const server = new ModelServer([]);
    const provider = await providerFor(server);
    const acquire = vi.spyOn(provider, '_acquire');
    const agent = new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
    });
    const opening = agent.session();
    try {
      await entered.promise;
      await expect(provider.close()).resolves.toBeUndefined();
      expect(acquire).not.toHaveBeenCalled();
      expect(server.requests).toHaveLength(0);
      release.resolve();
      await expect(opening).rejects.toThrow(/closed/);
      await expect(provider.close()).resolves.toBeUndefined();
      expect(server.requests).toHaveLength(0);
    } finally {
      release.resolve();
      binding.mockRestore();
    }
  });

  it.each(['reserved', 'duplicate', 'invalid schema'] as const)(
    'rejects %s opening declarations before provider acquisition',
    async (kind) => {
      const peer = await mcpPeer('never acquired');
      const agent = new Agent({ instructions: 'Answer.' });
      const acquire = vi.spyOn(agent.provider, '_acquire');
      const declaration = lookup('never');
      const declarations =
        kind === 'reserved'
          ? [{ ...declaration, name: 'exec_command' }]
          : kind === 'duplicate'
            ? [declaration, declaration]
            : [{ ...declaration, parameters: { type: 'null' } }];
      try {
        await expect(
          agent.session({ tools: [...declarations, peer.tool] }),
        ).rejects.toThrow();
        expect(acquire).not.toHaveBeenCalled();
        expect(peer.methods).toEqual([]);
        await agent.provider.close();
      } finally {
        await peer.close();
      }
    },
  );

  it('restores idle state with the destination opening callback', async () => {
    const server = new ModelServer([
      [message('saved')],
      [call('lookup', {}, { callId: 'destination' })],
      (request) => {
        expect(JSON.stringify(request.input)).toContain('destination binding');
        expect(JSON.stringify(request.input)).not.toContain('source binding');
        return [message('restored')];
      },
    ]);
    const provider = await providerFor(server);
    const agent = new Agent({
      instructions: 'Lookup.',
      model: 'gpt-5',
      provider,
      tools: [lookup('agent binding')],
    });
    const source = await agent.session({ tools: [lookup('source binding')] });
    let state;
    try {
      await (await source.submit('Save')).wait();
      state = await source.saveState();
    } finally {
      await source.close();
    }
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const originalBinding = nativeBinding.binding;
    const binding = vi
      .spyOn(nativeBinding, 'binding')
      .mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return originalBinding();
      });
    const options: SessionOptions<unknown> = {
      state,
      tools: [lookup('destination binding')],
    };
    const opening = agent.session(options);
    await entered.promise;
    options.state = undefined;
    release.resolve();
    const destination = await opening;
    try {
      expect(destination.id).toBe(source.id);
      expect(
        (await (await destination.submit('Lookup')).wait()).finalOutput,
      ).toBe('restored');
    } finally {
      release.resolve();
      binding.mockRestore();
      await destination.close();
      await provider.close();
    }
    server.assertExhausted();
  });

  it('releases the provider after a later restore failure', async () => {
    const server = new ModelServer([]);
    const provider = await providerFor(server);
    const agent = new Agent({
      instructions: 'Lookup.',
      model: 'gpt-5',
      provider,
    });
    const source = await agent.session({ tools: [lookup('source')] });
    const state = await source.saveState();
    await source.close();
    await expect(agent.session({ state, tools: [] })).rejects.toThrow(
      /matching managed tools/,
    );
    await expect(provider.close()).resolves.toBeUndefined();
    expect(server.requests).toHaveLength(0);
  });

  it('restores manual grants against the current opening declaration', async () => {
    const server = new ModelServer([
      [call('decision', {}, { callId: 'pending' })],
      [message('accepted')],
    ]);
    const provider = await providerFor(server);
    const agent = new Agent({
      instructions: 'Ask decision.',
      model: 'gpt-5',
      provider,
    });
    const declaration = () =>
      manualTool({
        name: 'decision',
        description: 'Ask for a decision.',
        parameters: z.object({}),
        result: z.string(),
      });
    const sourceTool = declaration();
    const currentTool = declaration();
    const source = await agent.session({ tools: [sourceTool] });
    let state;
    try {
      await source.submit('Ask');
      for await (const event of source.events())
        if (event.type === 'action_requested') break;
      state = await source.suspend();
    } finally {
      await source.close();
    }
    const destination = await agent.session({ state, tools: [currentTool] });
    try {
      for await (const event of destination.events()) {
        if (event.type !== 'action_requested') continue;
        expect(sourceTool.match(event)).toBeUndefined();
        const current = currentTool.match(event);
        expect(current).toBeDefined();
        if (!current) throw new Error('Expected current opening grant');
        expect(
          (await (await destination.submit(current.reply('yes'))).wait())
            .finalOutput,
        ).toBe('accepted');
        break;
      }
    } finally {
      await destination.close();
      await provider.close();
    }
    server.assertExhausted();
  });
});
