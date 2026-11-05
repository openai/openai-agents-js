import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  HttpMCP,
  NativeProvider,
  NativeAgents,
  HostedVerificationMCP,
  toolRef,
  tool,
} from '../../src';
import * as nativeBinding from '../../src/runtime/binding';
import { mcpConfig, selectHttpLeaves } from '../../src/runtime/mcp';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});

async function peer(denied = false) {
  const methods: string[] = [],
    effects: string[] = [];
  let connections = 0;
  let release: (() => void) | undefined;
  let hold = false;
  const initializing = Promise.withResolvers<void>();
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of request) chunks.push(Buffer.from(c));
    const rpc = JSON.parse(Buffer.concat(chunks).toString());
    methods.push(rpc.method);
    if (denied) {
      response.writeHead(401).end();
      return;
    }
    if (rpc.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    if (rpc.method === 'initialize' && hold) {
      initializing.resolve();
      await new Promise<void>((done) => {
        release = done;
      });
    }
    if (rpc.method === 'tools/call') effects.push(rpc.params.name);
    const result =
      rpc.method === 'initialize'
        ? {
            protocolVersion: rpc.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'dormant', version: '1' },
          }
        : rpc.method === 'tools/list'
          ? {
              tools: ['find-record', 'read', 'excluded'].map((name) => ({
                name,
                description: name,
                inputSchema: {
                  type: 'object',
                  properties: {},
                  additionalProperties: false,
                },
              })),
            }
          : { content: [{ type: 'text', text: rpc.params?.name ?? 'ok' }] };
    response
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  server.on('connection', () => connections++);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No listener');
  const url = `http://127.0.0.1:${address.port}/mcp`;
  return {
    methods,
    effects,
    get connections() {
      return connections;
    },
    url,
    hold() {
      hold = true;
    },
    initializing: initializing.promise,
    release() {
      release?.();
    },
    declaration(
      options: Partial<ConstructorParameters<typeof HttpMCP>[0]> = {},
    ) {
      return new HttpMCP({
        name: 'docs-api',
        tools: ['find-record', 'read'],
        url,
        activation: 'operation',
        approvalMode: 'approve',
        ...options,
      });
    },
    async close() {
      release?.();
      server.closeAllConnections();
      await new Promise<void>((done, reject) =>
        server.close((e) => (e ? reject(e) : done())),
      );
    },
  };
}
async function providerFor(model: ModelServer) {
  const config = await model.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-dormant',
    supportsWebsockets: false,
  });
}
const find = toolRef('find_record', 'mcp__docs_api');
const read = toolRef('read', 'mcp__docs_api');
function names(request: unknown): string[] {
  const parsed = request as {
    tools?: Array<{
      type: string;
      name: string;
      tools?: Array<{ name: string }>;
    }>;
  };
  return (parsed.tools ?? []).flatMap((t) =>
    t.type === 'namespace'
      ? (t.tools ?? []).map((leaf) => `${t.name}.${leaf.name}`)
      : [t.name],
  );
}
async function capturePublication(
  change?: (
    receipt: Record<string, any>,
    index: number,
  ) => void | Promise<void>,
) {
  const addon = await nativeBinding.binding();
  const original = addon.create_engine;
  const receipts: Record<string, any>[] = [];
  vi.spyOn(nativeBinding, 'binding').mockResolvedValue({
    ...addon,
    _packaged_runtime: addon._packaged_runtime,
    create_engine: async (...args) => {
      const engine = await original(...args);
      const start = engine.start_replaceable_thread.bind(engine);
      engine.start_replaceable_thread = async (...threadArgs) => {
        const thread = await start(...threadArgs);
        const publish = thread._replace_mcp_servers.bind(thread);
        thread._replace_mcp_servers = async (...publicationArgs) => {
          const receipt = JSON.parse(await publish(...publicationArgs));
          receipts.push(receipt);
          await change?.(receipt, receipts.length - 1);
          return JSON.stringify(receipt);
        };
        return thread;
      };
      return engine;
    },
  });
  return receipts;
}

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'ordinary dormant HTTP activation',
  () => {
    it('opens without TCP or discovery I/O, selects exact raw leaves, omits, and reactivates defaults', async () => {
      const http = await peer();
      const receipts = await capturePublication();
      const model = new ModelServer([
        (r) => {
          expect(names(r)).toEqual([]);
          return [message('empty')];
        },
        (r) => {
          expect(names(r)).toEqual(['mcp__docs_api.find_record']);
          return [
            call(
              'find_record',
              {},
              { callId: 'find', namespace: 'mcp__docs_api' },
            ),
          ];
        },
        [message('found')],
        (r) => {
          expect(names(r)).toEqual([]);
          return [message('off')];
        },
        (r) => {
          expect(names(r)).toEqual([
            'mcp__docs_api.find_record',
            'mcp__docs_api.read',
          ]);
          return [
            call('read', {}, { callId: 'read', namespace: 'mcp__docs_api' }),
          ];
        },
        [message('read')],
      ]);
      const provider = await providerFor(model);
      const declaration = http.declaration();
      const session = await new Agent({
        instructions: 'Read.',
        model: 'gpt-5.5',
        provider,
        tools: [declaration],
      }).session();
      try {
        expect(http.connections).toBe(0);
        expect(http.methods).toEqual([]);
        expect(receipts[0].result).toMatchObject({
          policy_generation: 0,
          ready: true,
          servers: {
            'docs-api': {
              accepted: true,
              ready: true,
              status: 'disabled',
              tools: [],
            },
          },
        });
        expect(
          (await (await session.submit('empty', { tools: [] })).wait())
            .finalOutput,
        ).toBe('empty');
        expect(http.connections).toBe(0);
        expect(
          (await (await session.submit('find', { tools: [find] })).wait())
            .finalOutput,
        ).toBe('found');
        expect(http.effects).toEqual(['find-record']);
        expect(receipts.at(-1)!.result.policy_generation).toBe(1);
        const count = http.methods.length;
        await (await session.submit('omit', { tools: [] })).wait();
        expect(http.methods).toHaveLength(count);
        expect(http.effects).toEqual(['find-record']);
        expect(receipts.at(-1)!.result).toMatchObject({
          policy_generation: 2,
          servers: { 'docs-api': { status: 'disabled', tools: [] } },
        });
        await (await session.submit('defaults')).wait();
        expect(http.effects).toEqual(['find-record', 'read']);
        expect(receipts.at(-1)!.result.policy_generation).toBe(3);
        model.assertExhausted();
      } finally {
        await session.close();
        await provider.close();
        await http.close();
      }
    });

    it('keeps omitted reservations and uses current idle bindings without raw identity expansion', async () => {
      const first = await peer(),
        second = await peer();
      const model = new ModelServer([
        [message('empty')],
        [call('read', {}, { callId: 'current', namespace: 'mcp__docs_api' })],
        [message('current')],
      ]);
      const provider = await providerFor(model);
      const session = await new Agent({
        instructions: 'Read.',
        model: 'gpt-5.5',
        provider,
        tools: [first.declaration()],
      }).session();
      try {
        await expect(
          session.update({ tools: [first.declaration({ name: 'docs.api' })] }),
        ).rejects.toThrow(/Session opening/);
        await expect(
          session.update({
            tools: [first.declaration({ tools: ['find_record'] })],
          }),
        ).rejects.toThrow(/raw identities/);
        await expect(
          session.submit('invalid', {
            tools: [toolRef('excluded', 'mcp__docs_api')],
          }),
        ).rejects.toThrow();
        expect(first.connections).toBe(0);
        expect(second.connections).toBe(0);
        expect(model.requests).toHaveLength(0);
        await session.update({
          tools: [second.declaration({ tools: ['read'] })],
        });
        await session.update({ tools: [] });
        await expect(
          session.submit('not rebound', { tools: [find] }),
        ).rejects.toThrow(/current captured raw binding/);
        expect(first.connections).toBe(0);
        expect(second.connections).toBe(0);
        await (await session.submit('empty')).wait();
        expect(first.connections).toBe(0);
        expect(second.connections).toBe(0);
        await (await session.submit('current', { tools: [read] })).wait();
        expect(first.effects).toEqual([]);
        expect(second.effects).toEqual(['read']);
        model.assertExhausted();
      } finally {
        await session.close();
        await provider.close();
        await first.close();
        await second.close();
      }
    });

    it('fences stale generation receipts before provider submission and old callbacks', async () => {
      const http = await peer();
      await capturePublication((receipt, index) => {
        if (index === 1) receipt.result.policy_generation = 0;
      });
      const effects: string[] = [];
      const local = tool({
        name: 'local',
        parameters: z.object({}),
        execute: () => {
          effects.push('local');
          return 'old';
        },
      });
      const model = new ModelServer([]);
      const provider = await providerFor(model);
      const session = await new Agent({
        instructions: 'Read.',
        model: 'gpt-5.5',
        provider,
        tools: [local, http.declaration()],
      }).session();
      try {
        await expect(
          session.submit('stale', { tools: [find] }),
        ).rejects.toThrow(/publication/);
        await expect(session.submit('old')).rejects.toThrow();
        expect(effects).toEqual([]);
        expect(model.requests).toHaveLength(0);
      } finally {
        await session.close();
        await provider.close();
        await http.close();
      }
    });

    it('owns async promotion through close and never admits a queued successor', async () => {
      const http = await peer();
      http.hold();
      const model = new ModelServer([]);
      const provider = await providerFor(model);
      const session = await new Agent({
        instructions: 'Read.',
        model: 'gpt-5.5',
        provider,
        tools: [http.declaration()],
      }).session();
      try {
        const pending = session.submit('activate', { tools: [find] });
        pending.catch(() => {});
        await http.initializing;
        const queued = await session.enqueue('successor', undefined, {
          tools: [read],
        });
        const result = queued.wait();
        result.catch(() => {});
        const closing = session.close();
        http.release();
        await closing;
        await expect(pending).rejects.toThrow();
        await expect(result).rejects.toThrow();
        expect(model.requests).toHaveLength(0);
        expect(http.effects).toEqual([]);
      } finally {
        http.release();
        await session.close();
        await provider.close();
        await http.close();
      }
    });

    it('joins a delayed activation receipt before close completes even after native publication settled', async () => {
      const published = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      await capturePublication(async (_receipt, index) => {
        if (index === 1) {
          published.resolve();
          await release.promise;
        }
      });
      const http = await peer(),
        model = new ModelServer([]),
        provider = await providerFor(model);
      const session = await new Agent({
        instructions: 'Read.',
        model: 'gpt-5.5',
        provider,
        tools: [http.declaration()],
      }).session();
      const pending = session.submit('activate', { tools: [find] });
      pending.catch(() => {});
      try {
        await published.promise;
        const closing = session.close();
        expect(
          await Promise.race([
            closing.then(() => 'closed'),
            setTimeout(50, 'pending'),
          ]),
        ).toBe('pending');
        expect(model.requests).toHaveLength(0);
        release.resolve();
        await closing;
        await expect(pending).rejects.toThrow();
        expect(http.effects).toEqual([]);
      } finally {
        release.resolve();
        await session.close();
        await provider.close();
        await http.close();
      }
    });

    it('shares activation across queued, output-aware and one-shot root starts while eager HTTP still opens eagerly', async () => {
      const dormant = await peer(),
        eager = await peer();
      const model = new ModelServer([
        (r) => {
          expect(names(r)).not.toContain('mcp__docs_api.read');
          return [message('empty')];
        },
        (r) => {
          expect(names(r)).toContain('mcp__docs_api.read');
          return [message('{"ok":true}')];
        },
        (r) => {
          expect(names(r)).toContain('mcp__docs_api.find_record');
          return [message('one-shot')];
        },
      ]);
      const provider = await providerFor(model);
      const declaration = dormant.declaration();
      const agent = new Agent({
        instructions: 'Read.',
        model: 'gpt-5.5',
        provider,
        tools: [
          declaration,
          eager.declaration({ name: 'eager', activation: 'session' }),
        ],
      });
      const session = await agent.session();
      try {
        expect(dormant.connections).toBe(0);
        expect(eager.methods).toContain('tools/list');
        await (await session.enqueue('empty', undefined, { tools: [] })).wait();
        expect(dormant.connections).toBe(0);
        expect(
          (
            await (
              await session.submitWithOutput(
                'json',
                z.object({ ok: z.boolean() }),
                { tools: [read] },
              )
            ).wait()
          ).finalOutput,
        ).toEqual({ ok: true });
        await session.close();
        expect((await agent.run('one-shot')).finalOutput).toBe('one-shot');
        model.assertExhausted();
      } finally {
        await session.close();
        await provider.close();
        await dormant.close();
        await eager.close();
      }
    });

    it('keeps omitted reservations dormant across context replacement and activates policies on the selected leaf', async () => {
      const http = await peer();
      const before = vi.fn(() => ({ action: 'allow' as const }));
      const transform = vi.fn(
        (_context: unknown, result: nativeBinding.JsonObject) => result,
      );
      const model = new ModelServer([
        [message('empty')],
        [
          call(
            'read',
            {},
            { callId: 'after-context', namespace: 'mcp__docs_api' },
          ),
        ],
        [message('read')],
        [message('empty again')],
      ]);
      const provider = await providerFor(model);
      const session = await new Agent({
        instructions: 'Read.',
        model: 'gpt-5.5',
        provider,
        tools: [http.declaration({ before, transformResult: transform })],
      }).session();
      try {
        await (await session.submit('empty', { tools: [] })).wait();
        await session.compact({ summary: 'The last answer was empty.' });
        expect(http.connections).toBe(0);
        await (await session.submit('read', { tools: [read] })).wait();
        expect(http.effects).toEqual(['read']);
        expect(before).toHaveBeenCalledTimes(1);
        expect(transform).toHaveBeenCalledTimes(1);
        await (await session.submit('empty again', { tools: [] })).wait();
        const count = http.methods.length;
        await session.compact({
          summary: 'Read was completed; no tools are active.',
        });
        expect(http.methods).toHaveLength(count);
        model.assertExhausted();
      } finally {
        await session.close();
        await provider.close();
        await http.close();
      }
    });

    it('does not acquire a dormant server that beforeStep tries to add outside the operation ceiling', async () => {
      const selected = await peer(),
        omitted = await peer();
      const model = new ModelServer([]);
      const provider = await providerFor(model);
      const session = await new Agent({
        instructions: 'Read.',
        model: 'gpt-5.5',
        provider,
        tools: [
          selected.declaration(),
          omitted.declaration({ name: 'omitted' }),
        ],
      }).session();
      try {
        const turn = await session.submit('narrow only', {
          tools: [find],
          beforeStep: () => [toolRef('read', 'mcp__omitted')],
        });
        await expect(turn.wait()).rejects.toThrow();
        expect(selected.methods).toContain('tools/list');
        expect(omitted.connections).toBe(0);
        expect(omitted.methods).toEqual([]);
        expect(selected.effects).toEqual([]);
        expect(omitted.effects).toEqual([]);
        expect(model.requests).toHaveLength(0);
      } finally {
        await session.close();
        await provider.close();
        await selected.close();
        await omitted.close();
      }
    });

    it('fences an admitted raw leaf that the connected peer does not publish', async () => {
      const http = await peer();
      const model = new ModelServer([]);
      const provider = await providerFor(model);
      const session = await new Agent({
        instructions: 'Read.',
        model: 'gpt-5.5',
        provider,
        tools: [http.declaration({ tools: ['missing'] })],
      }).session();
      try {
        expect(http.connections).toBe(0);
        await expect(
          session.submit('missing', {
            tools: [toolRef('missing', 'mcp__docs_api')],
          }),
        ).rejects.toThrow(/selected tool|ready/);
        expect(http.methods).toContain('tools/list');
        expect(http.effects).toEqual([]);
        expect(model.requests).toHaveLength(0);
        await expect(session.submit('old')).rejects.toThrow();
      } finally {
        await session.close();
        await provider.close();
        await http.close();
      }
    });

    it('fences connection failure before model submission and old authority', async () => {
      const http = await peer(true),
        model = new ModelServer([]),
        provider = await providerFor(model);
      const session = await new Agent({
        instructions: 'Read.',
        model: 'gpt-5.5',
        provider,
        tools: [http.declaration({ startupTimeout: 1 })],
      }).session();
      try {
        expect(http.connections).toBe(0);
        await expect(
          session.submit('denied', { tools: [find] }),
        ).rejects.toThrow(/not confirmed|ready/);
        await expect(session.submit('old')).rejects.toThrow();
        expect(model.requests).toHaveLength(0);
        expect(http.effects).toEqual([]);
      } finally {
        await session.close();
        await provider.close();
        await http.close();
      }
    });

    it('joins canceled activation before a queued successor can acquire authority', async () => {
      const http = await peer();
      http.hold();
      const model = new ModelServer([]);
      const provider = await providerFor(model);
      const session = await new Agent({
        instructions: 'Read.',
        model: 'gpt-5.5',
        provider,
        tools: [http.declaration()],
      }).session();
      try {
        const active = await session.enqueue('activate', undefined, {
          tools: [find],
        });
        const outcome = active.wait();
        outcome.catch(() => {});
        await http.initializing;
        const queued = await session.enqueue('successor', undefined, {
          tools: [read],
        });
        const next = queued.wait();
        next.catch(() => {});
        const cancel = active.cancel();
        http.release();
        await cancel;
        await expect(outcome).rejects.toThrow();
        await expect(next).rejects.toThrow();
        expect(model.requests).toHaveLength(0);
        expect(http.effects).toEqual([]);
      } finally {
        http.release();
        await session.close();
        await provider.close();
        await http.close();
      }
    });

    it('rejects child, Code Mode and hosted opt-ins before peer I/O', async () => {
      const http = await peer();
      const model = new ModelServer([]);
      const provider = await providerFor(model);
      try {
        await expect(
          new Agent({
            instructions: 'Read.',
            model: 'gpt-5.5',
            provider,
            tools: [http.declaration()],
            programmaticToolCalling: true,
          }).session(),
        ).rejects.toThrow(/ordinary root/);
        await expect(
          new Agent({
            instructions: 'Read.',
            model: 'gpt-5.5',
            provider,
            tools: [http.declaration(), new NativeAgents()],
          }).session(),
        ).rejects.toThrow(/ordinary root/);
        expect(
          () =>
            new HostedVerificationMCP({
              url: http.url,
              tools: ['read'],
              activation: 'operation',
            }),
        ).toThrow(/Hosted/);
        expect(http.connections).toBe(0);
        expect(model.requests).toHaveLength(0);
      } finally {
        await provider.close();
        await http.close();
      }
    });
  },
);

describe('HTTP reservation/schema composition (pure)', () => {
  it('keeps deferred schema metadata when narrowing an active leaf or retaining a disabled reservation', () => {
    const server = new HttpMCP({
      name: 'records',
      url: 'https://example.invalid/mcp',
      bearerToken: 'synthetic-reservation-token',
      tools: ['find-record', 'read'],
      activation: 'operation',
      deferLoading: true,
    });
    const selected = selectHttpLeaves(server, ['read']);
    expect(selected.deferLoading).toBe(true);
    expect(selected.bearerToken).toBe(server.bearerToken);
    expect(
      mcpConfig([selected], undefined, false, [server]).records,
    ).toMatchObject({
      enabled_tools: ['read'],
      required: true,
      omit_tools_from: ['code_mode'],
    });
    expect(mcpConfig([], undefined, false, [server]).records).toMatchObject({
      enabled: false,
      required: false,
      enabled_tools: ['find-record', 'read'],
      omit_tools_from: ['code_mode'],
    });
    expect(server.tools).toEqual(['find-record', 'read']);
    expect(server.activation).toBe('operation');
  });

  it('preserves the third codeMode boolean for existing eager schema declarations', () => {
    const server = new HttpMCP({
      name: 'records',
      url: 'https://example.invalid/mcp',
      tools: ['read'],
      deferLoading: true,
    });
    expect(server.activation).toBe('session');
    expect(mcpConfig([server]).records).toHaveProperty('omit_tools_from', [
      'code_mode',
    ]);
    expect(mcpConfig([server], undefined, true).records).not.toHaveProperty(
      'omit_tools_from',
    );
  });
});
