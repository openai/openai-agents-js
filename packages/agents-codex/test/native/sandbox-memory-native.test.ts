import { afterEach, expect, it } from 'vitest';
import {
  readFile,
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  Agent,
  Environment,
  NativeProvider,
  ToolOutput,
  tool,
  type Session,
} from '../../src';
import {
  addSandboxEventSink,
  file,
  Manifest,
  sandboxEnvironment,
  type SandboxEvent,
  type SandboxMemoryOptions,
} from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents-core/sandbox/local';
import { ModelServer, message, call } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(() => ModelServer.closeAll());
it.each([
  'generate',
  'close',
  'tool-history',
  'tool-text-parts',
  'tool-media',
  'structured',
  'phase-close',
  'tool-record-bound',
  'tool-byte-bound',
] as const)(
  'owns explicit native sandbox memory (%s)',
  async (mode) => {
    const peer = await startPublicExecutor();
    const memoryFiles = new Map<string, Uint8Array>();
    const store = {
      read: async (path) => memoryFiles.get(path)?.slice() ?? null,
      write: async (path, data) => {
        memoryFiles.set(path, data.slice());
      },
      delete: async (path) => {
        memoryFiles.delete(path);
      },
      list: async (prefix) =>
        [...memoryFiles.keys()].filter((path) =>
          path.startsWith(prefix ? `${prefix}/` : ''),
        ),
    } satisfies NonNullable<SandboxMemoryOptions['store']>;
    const events: SandboxEvent[] = [];
    let session: Session<unknown> | undefined;
    let closing: Promise<void> | undefined;
    const appInput =
      '# AGENTS.md instructions\n\n<INSTRUCTIONS>\nRemember this project uses pnpm.\n</INSTRUCTIONS>';
    const generatedGuidance = 'private-generated-workspace-guidance';
    let workspace = '';
    let resourceId = '';
    const remove = addSandboxEventSink(async (event) => {
      events.push(event);
      if (
        mode === 'close' &&
        event.name === 'sandbox.memory.flush' &&
        event.phase === 'start'
      ) {
        closing = session!.close();
        await closing;
      }
    });
    const phaseEntered = Promise.withResolvers<void>();
    const phaseRelease = Promise.withResolvers<void>();
    const typedTool = mode.startsWith('tool-');
    const structured = typedTool || mode === 'structured';
    const generates =
      mode === 'generate' ||
      mode === 'phase-close' ||
      mode === 'tool-history' ||
      mode === 'tool-text-parts' ||
      mode === 'structured';
    const toolResult = {
      package_manager: 'pnpm',
      topic: 'package manager',
      ...(mode === 'tool-byte-bound' ? { padding: 'x'.repeat(1_000_000) } : {}),
    };
    const toolCalls = typedTool
      ? Array.from(
          { length: mode === 'tool-record-bound' ? 129 : 1 },
          (_, index) =>
            call(
              'lookup',
              { topic: 'package manager' },
              { callId: `lookup-${index}` },
            ),
        )
      : [];
    const finalMessage = message(
      structured
        ? JSON.stringify({ decision: 'Use pnpm.' })
        : 'The project uses pnpm.',
    );
    let effects = 0;
    const server = new ModelServer(
      generates
        ? [
            ...(typedTool ? [toolCalls] : []),
            [finalMessage],
            async () => {
              if (mode === 'phase-close') {
                phaseEntered.resolve();
                await phaseRelease.promise;
              }
              return [
                message(
                  JSON.stringify({
                    rollout_summary: 'Package manager decision',
                    rollout_slug: 'package-manager',
                    raw_memory: 'Use pnpm for this project.',
                  }),
                ),
              ];
            },
            [
              message(
                JSON.stringify({
                  summary: 'Project package manager: pnpm.',
                  memory: 'Use pnpm.',
                }),
              ),
            ],
          ]
        : [...(typedTool ? [toolCalls] : []), [finalMessage]],
    );
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-provider',
      supportsWebsockets: false,
    });
    const source = sandboxEnvironment({
      client: new UnixLocalSandboxClient(),
      manifest: new Manifest({
        entries: {
          'context.txt': file({
            content: 'fixture context',
            description: generatedGuidance,
          }),
        },
      }),
      memory: {
        phaseOne: new Agent({
          provider,
          model: 'gpt-5',
          instructions:
            'Extract structured artifacts from quoted transcript data.',
        }),
        phaseTwo: new Agent({
          provider,
          model: 'gpt-5',
          instructions:
            'Consolidate quoted memories into summary and memory fields.',
        }),
        store,
      },
      connect: async (resource) => {
        workspace = resource.state.workspaceRootPath;
        resourceId =
          typeof resource.state.sessionId === 'string'
            ? resource.state.sessionId
            : '';
        return Environment.lease(
          new Environment({
            url: peer.url,
            headers: peer.headers,
            cwd: workspace,
            tools: [],
          }),
          async () => {},
        );
      },
    });
    try {
      const agent = new Agent({
        provider,
        model: 'gpt-5',
        instructions: 'private-developer-instruction',
        ...(typedTool
          ? {
              tools: [
                tool({
                  name: 'lookup',
                  parameters: z.object({ topic: z.string() }),
                  execute: async ({ topic }) => {
                    expect(topic).toBe('package manager');
                    effects++;
                    if (mode === 'tool-media')
                      return ToolOutput.image({
                        fileId: 'opaque-memory-image',
                      });
                    if (mode === 'tool-text-parts')
                      return new ToolOutput([
                        { type: 'inputText', text: JSON.stringify(toolResult) },
                        {
                          type: 'inputText',
                          text: 'verified local tool result',
                        },
                      ]);
                    return toolResult;
                  },
                }),
              ],
            }
          : {}),
      });
      session = await (
        structured
          ? agent.withOutputType(z.object({ decision: z.string() }))
          : agent
      ).session({ environment: source });
      const result = await (await session.submit(appInput)).wait();
      if (structured)
        expect(result.finalOutput).toEqual({ decision: 'Use pnpm.' });
      if (typedTool) expect(effects).toBe(toolCalls.length);
      if (
        mode === 'generate' ||
        mode === 'tool-history' ||
        mode === 'tool-text-parts' ||
        mode === 'structured'
      ) {
        await Promise.all([session.flushMemory(), session.flushMemory()]);
        await session.flushMemory();
        expect(server.requests).toHaveLength(typedTool ? 4 : 3);
        expect(
          await readFile(join(workspace, 'memories', 'MEMORY.md'), 'utf8'),
        ).toBe('Use pnpm.');
        expect(
          new TextDecoder().decode(
            (await store.read('memories/memory_summary.md'))!,
          ),
        ).toBe('Project package manager: pnpm.');
        expect(
          await readFile(
            join(
              workspace,
              'memories',
              'rollout_summaries',
              `${session.id}.md`,
            ),
            'utf8',
          ),
        ).toContain(`session_id: ${resourceId}`);
        const transcript = await readFile(
          join(workspace, 'sessions', `${session.id}.jsonl`),
          'utf8',
        );
        expect(transcript.trim().split('\n')).toHaveLength(1);
        expect(transcript).toContain('Remember this project uses pnpm.');
        expect(
          JSON.parse(transcript).items.some(
            (item: { content: Array<{ text: string }> }) =>
              item.content?.some((part) => part.text === appInput),
          ),
        ).toBe(true);
        expect(
          JSON.stringify(server.requests.slice(typedTool ? 2 : 1)),
        ).not.toContain(generatedGuidance);
        expect(transcript).not.toContain(generatedGuidance);
        expect(
          JSON.stringify((await session.historySnapshot()).items),
        ).toContain(generatedGuidance);
        expect(JSON.parse(transcript).native_thread_id).toBe(session.id);
        if (structured) expect(transcript).toContain('Use pnpm.');
        if (typedTool) {
          const items = JSON.parse(transcript).items;
          expect(items).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: 'function_call',
                name: 'lookup',
                call_id: 'lookup-0',
                arguments: JSON.stringify({ topic: 'package manager' }),
              }),
              expect.objectContaining({
                type: 'function_call_output',
                call_id: 'lookup-0',
                output:
                  mode === 'tool-text-parts'
                    ? [
                        {
                          type: 'input_text',
                          text: JSON.stringify(toolResult),
                        },
                        {
                          type: 'input_text',
                          text: 'verified local tool result',
                        },
                      ]
                    : JSON.stringify(toolResult),
              }),
            ]),
          );
        }
        expect(transcript).not.toContain('private-developer-instruction');
        expect(
          JSON.stringify(server.requests.slice(typedTool ? 2 : 1)),
        ).not.toContain('private-developer-instruction');
        for (const name of [
          'sandbox.memory.enqueue_rollout',
          'sandbox.memory.flush',
        ])
          expect(
            events
              .filter((event) => event.name === name)
              .map((event) => event.phase),
          ).toEqual(['start', 'end']);
        expect(
          JSON.stringify(
            events.filter((event) => event.name.startsWith('sandbox.memory.')),
          ),
        ).not.toMatch(
          /private-developer|Remember this|Use pnpm|raw_memories|run_as/,
        );
      } else if (mode === 'close') {
        await expect(session.flushMemory()).rejects.toThrow(/cancel/i);
        await expect.poll(() => closing !== undefined).toBe(true);
        await closing;
        expect(server.requests).toHaveLength(1);
      } else if (mode === 'phase-close') {
        const flushing = session.flushMemory();
        const rejected =
          expect(flushing).rejects.toThrow(/closed|cancel|abort/i);
        await phaseEntered.promise;
        await session.close();
        await rejected;
        expect(server.requests).toHaveLength(2);
      } else {
        if (mode === 'tool-record-bound')
          expect((await session.historySnapshot()).total).toBeGreaterThan(256);
        await expect(session.flushMemory()).rejects.toThrow(
          mode === 'tool-record-bound'
            ? /256 original records/
            : mode === 'tool-media'
              ? /text content/
              : /1000000 bytes/,
        );
        expect(await store.list('')).toEqual([]);
        expect(server.requests).toHaveLength(2);
      }
      if (mode !== 'phase-close') server.assertExhausted();
    } finally {
      phaseRelease.resolve();
      await session?.close();
      await peer.close();
      remove();
    }
  },
  30000,
);

it.each(['snapshot', 'snapshot-retry', 'symlink'] as const)(
  'preserves native memory at its resource boundary (%s)',
  async (mode) => {
    const base = await mkdtemp(join(tmpdir(), 'native-memory-boundary-'));
    const peer = await startPublicExecutor();
    const artifacts = {
      rollout_summary: 'Project decision',
      rollout_slug: 'decision',
      raw_memory: 'Use pnpm.',
    };
    const server = new ModelServer([
      [message('Use pnpm.')],
      ...(mode === 'snapshot-retry'
        ? [[message(JSON.stringify({ ...artifacts, rollout_summary: '' }))]]
        : []),
      [message(JSON.stringify(artifacts))],
      [
        message(
          JSON.stringify({
            summary: 'Use pnpm.',
            memory: 'pnpm workspace memory',
          }),
        ),
      ],
    ]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-provider',
      supportsWebsockets: false,
    });
    let workspace = '';
    let session: Session | undefined;
    const marker = 'benign-symlink-target-excluded';
    const source = sandboxEnvironment({
      manifest: new Manifest({}),
      client: new UnixLocalSandboxClient({
        workspaceBaseDir: base,
        snapshot: { type: 'local', baseDir: join(base, 'archives') },
      }),
      managedWorkspace: true,
      snapshot: { type: 'local', baseDir: join(base, 'archives') },
      memory: {
        phaseOne: new Agent({
          provider,
          model: 'gpt-5',
          instructions: 'Use the declared memory task.',
        }),
        phaseTwo: new Agent({
          provider,
          model: 'gpt-5',
          instructions: 'Use the declared memory task.',
        }),
      },
      connect: async (resource) => {
        workspace = resource.state.workspaceRootPath;
        if (mode === 'symlink') {
          await mkdir(join(workspace, 'memories', 'raw_memories'), {
            recursive: true,
          });
          await writeFile(
            join(workspace, 'benign-target.md'),
            `rollout_id: seeded
updated_at: 2999-01-01T00:00:00.000Z

${marker}`,
          );
          await symlink(
            join(workspace, 'benign-target.md'),
            join(workspace, 'memories', 'raw_memories', 'seeded.md'),
          );
          await expect(
            resource.readFileNoFollow!({
              path: 'memories/raw_memories/seeded.md',
              maxBytes: 1000,
            }),
          ).rejects.toThrow();
          await mkdir(join(workspace, 'private-dir'));
          await writeFile(join(workspace, 'private-dir', 'value'), 'benign');
          await symlink(
            join(workspace, 'private-dir'),
            join(workspace, 'alias-dir'),
          );
          await expect(
            resource.readFileNoFollow!({
              path: 'alias-dir/value',
              maxBytes: 1000,
            }),
          ).rejects.toThrow();
          await expect(
            resource.readFileNoFollow!({
              path: 'benign-target.md',
              maxBytes: 1,
            }),
          ).rejects.toThrow();
        }
        return Environment.lease(
          new Environment({
            url: peer.url,
            headers: peer.headers,
            cwd: workspace,
            tools: [],
          }),
          async () => {},
        );
      },
    });
    try {
      session = await new Agent({
        provider,
        model: 'gpt-5',
        instructions: 'Use the declared memory task.',
      }).session({
        environment: source,
      });
      await (await session.submit('Remember pnpm.')).wait();
      if (mode === 'snapshot-retry') {
        await expect(session.suspendWorkspace()).rejects.toThrow(
          /partially-empty/,
        );
        expect((await session.historySnapshot()).total).toBeGreaterThan(0);
      }
      if (mode === 'symlink') {
        await session.flushMemory();
        expect(JSON.stringify(server.requests.slice(1))).not.toContain(marker);
        expect(
          await readFile(join(workspace, 'benign-target.md'), 'utf8'),
        ).toContain(marker);
      }
      const checkpoint = await session.suspendWorkspace();
      const snapshot = (
        checkpoint.workspace.providerState.snapshot as { path: string }
      ).path;
      expect(
        await readFile(join(snapshot, 'memories', 'MEMORY.md'), 'utf8'),
      ).toBe('pnpm workspace memory');
      expect(
        (
          await readFile(
            join(snapshot, 'sessions', `${session.id}.jsonl`),
            'utf8',
          )
        )
          .trim()
          .split('\n'),
      ).toHaveLength(1);
      server.assertExhausted();
    } finally {
      await session?.close();
      await peer.close();
      await rm(base, { recursive: true, force: true });
    }
  },
  30000,
);

it('retires the native memory callback guard for delayed application work', async () => {
  const peer = await startPublicExecutor();
  const afterFlush = Promise.withResolvers<void>();
  let session: Session | undefined;
  let delayed: Promise<unknown> | undefined;
  const server = new ModelServer([
    [message('Remember pnpm.')],
    [call('check_owner', {}, { callId: 'memory-owner' })],
    [
      message(
        JSON.stringify({
          rollout_summary: 'pnpm',
          rollout_slug: 'pnpm',
          raw_memory: 'pnpm',
        }),
      ),
    ],
    [message(JSON.stringify({ summary: 'pnpm', memory: 'pnpm' }))],
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-provider',
    supportsWebsockets: false,
  });
  const phaseOne = new Agent<undefined>({
    instructions: 'Use the declared memory task.',
    provider,
    model: 'gpt-5',
    tools: [
      tool({
        name: 'check_owner',
        parameters: z.object({}),
        execute: async () => {
          await expect(
            Promise.resolve().then(() => session!.close()),
          ).rejects.toThrow(/memory phase/);
          delayed = afterFlush.promise.then(() => session!.historySnapshot());
          void delayed.catch(() => {});
          return 'owner guard checked';
        },
      }),
    ],
  });
  try {
    const source = sandboxEnvironment({
      manifest: new Manifest({}),
      client: new UnixLocalSandboxClient(),
      memory: {
        phaseOne,
        phaseTwo: new Agent({
          provider,
          model: 'gpt-5',
          instructions: 'Use the declared memory task.',
        }),
      },
      connect: async (resource) =>
        Environment.lease(
          new Environment({
            url: peer.url,
            headers: peer.headers,
            cwd: resource.state.workspaceRootPath,
            tools: [],
          }),
          async () => {},
        ),
    });
    session = await new Agent({
      provider,
      model: 'gpt-5',
      instructions: 'Use the declared memory task.',
    }).session({
      environment: source,
    });
    await (await session.submit('Remember pnpm.')).wait();
    await session.flushMemory();
    expect(delayed).toBeDefined();
    afterFlush.resolve();
    await expect(delayed).resolves.toHaveProperty('items');
    server.assertExhausted();
  } finally {
    afterFlush.resolve();
    await session?.close();
    await peer.close();
  }
}, 30000);

it('bounds the latest native rollout across successive large text snapshots', async () => {
  const peer = await startPublicExecutor();
  const script = Array.from({ length: 4 }, () => [
    [message('Remember pnpm.')],
    [
      message(
        JSON.stringify({
          rollout_summary: 'pnpm',
          rollout_slug: 'pnpm',
          raw_memory: 'pnpm',
        }),
      ),
    ],
    [message(JSON.stringify({ summary: 'pnpm', memory: 'pnpm' }))],
  ]).flat();
  const server = new ModelServer(script);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-provider',
    supportsWebsockets: false,
  });
  let workspace = '';
  let session: Session | undefined;
  try {
    const source = sandboxEnvironment({
      client: new UnixLocalSandboxClient(),
      manifest: new Manifest({}),
      memory: {
        phaseOne: new Agent({
          provider,
          model: 'gpt-5',
          instructions: 'Extract memory.',
        }),
        phaseTwo: new Agent({
          provider,
          model: 'gpt-5',
          instructions: 'Consolidate memory.',
        }),
      },
      connect: async (resource) => {
        workspace = resource.state.workspaceRootPath;
        return Environment.lease(
          new Environment({
            url: peer.url,
            headers: peer.headers,
            cwd: workspace,
            tools: [],
          }),
          async () => {},
        );
      },
    });
    session = await new Agent({
      provider,
      model: 'gpt-5',
      instructions: 'Remember project context.',
    }).session({ environment: source });
    for (let index = 0; index < 4; index++) {
      await (
        await session.submit(
          index === 0 ? 'x'.repeat(350_000) : `Continue ${index}.`,
        )
      ).wait();
      await session.flushMemory();
    }
    const transcript = await readFile(
      join(workspace, 'sessions', `${session.id}.jsonl`),
      'utf8',
    );
    expect(Buffer.byteLength(transcript)).toBeLessThan(1_000_000);
    expect(transcript.trim().split('\n')).toHaveLength(1);
    expect(transcript).toContain('Continue 3.');
    expect(server.requests).toHaveLength(12);
    server.assertExhausted();
  } finally {
    await session?.close();
    await peer.close();
  }
}, 60000);

it('requires resource file access before starting native memory generation', async () => {
  const peer = await startPublicExecutor();
  const server = new ModelServer([]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-provider',
    supportsWebsockets: false,
  });
  try {
    const phase = new Agent({
      provider,
      model: 'gpt-5',
      instructions: 'Use the declared memory task.',
    });
    const source = sandboxEnvironment({
      client: new UnixLocalSandboxClient(),
      manifest: new Manifest(),
      memory: { phaseOne: phase, phaseTwo: phase },
      connect: async (resource) => {
        Object.defineProperty(resource, 'writeFileNoFollow', {
          value: undefined,
        });
        return Environment.lease(
          new Environment({
            url: peer.url,
            headers: peer.headers,
            cwd: resource.state.workspaceRootPath,
            tools: [],
          }),
          async () => {},
        );
      },
    });
    await expect(
      new Agent({
        provider,
        model: 'gpt-5',
        instructions: 'Use the declared task.',
      }).session({ environment: source }),
    ).rejects.toThrow(/no-follow file access/);
    expect(server.requests).toHaveLength(0);
    server.assertExhausted();
  } finally {
    await peer.close();
  }
}, 30000);
