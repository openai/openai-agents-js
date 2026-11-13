import { afterEach, expect, it, vi } from 'vitest';
import * as privateOpening from '../../src/runtime/private-opening-contribution';
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
  TurnAborted,
  GuardrailTripwire,
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

afterEach(() => {
  vi.restoreAllMocks();
  return ModelServer.closeAll();
});
it.each([
  'generate',
  'close',
  'tool-history',
  'tool-text-parts',
  'tool-media',
  'user-media',
  'hosted-records',
  'structured',
  'phase-close',
  'tool-record-bound',
  'tool-byte-bound',
  'private-selection',
  'private-nested-root',
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
      mode === 'tool-media' ||
      mode === 'user-media' ||
      mode === 'hosted-records' ||
      mode === 'structured' ||
      mode === 'private-selection' ||
      mode === 'private-nested-root';
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
    const finalItems =
      mode === 'hosted-records'
        ? [
            {
              type: 'file_search_call',
              id: 'memory-search',
              status: 'completed',
              queries: ['fixture memory query'],
              results: null,
            },
            {
              type: 'image_generation_call',
              id: 'excluded-image-generation',
              status: 'failed',
              result: null,
            },
            finalMessage,
          ]
        : [finalMessage];
    let effects = 0;
    const server = new ModelServer(
      generates
        ? [
            ...(typedTool ? [toolCalls] : []),
            finalItems,
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
            ...(mode === 'private-nested-root'
              ? [[message('Nested ordinary root completed.')]]
              : []),
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
    const privateMode =
      mode === 'private-selection' || mode === 'private-nested-root';
    const optionalExecute = vi.fn(() => 'optional lookup');
    const optionalPolicy = vi.fn(() => undefined);
    const optionalTool = tool({
      name: 'f9_optional_lookup',
      parameters: z.object({}),
      execute: optionalExecute,
    });
    const contribution = privateMode
      ? vi.spyOn(privateOpening, 'privateOpeningContribution').mockReturnValue({
          tools: [optionalTool],
          beforeComplete: optionalPolicy,
        })
      : undefined;
    let nestedRoots = 0;
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
          beforeComplete:
            mode === 'private-nested-root'
              ? async () => {
                  const nested = await new Agent({
                    provider,
                    model: 'gpt-5',
                    instructions: 'An ordinary nested user root.',
                  }).run('nested user work');
                  expect(nested.finalOutput).toBe(
                    'Nested ordinary root completed.',
                  );
                  nestedRoots++;
                }
              : undefined,
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
      const input =
        mode === 'user-media'
          ? ({
              role: 'user',
              content: [
                { type: 'input_text', text: appInput },
                { type: 'input_image', file_id: 'opaque-user-memory-image' },
              ],
            } as const)
          : appInput;
      const result = await (await session.submit(input)).wait();
      if (structured)
        expect(result.finalOutput).toEqual({ decision: 'Use pnpm.' });
      if (typedTool) expect(effects).toBe(toolCalls.length);
      if (generates && mode !== 'phase-close') {
        await Promise.all([session.flushMemory(), session.flushMemory()]);
        await session.flushMemory();
        expect(server.requests).toHaveLength(
          typedTool || mode === 'private-nested-root' ? 4 : 3,
        );
        if (privateMode) {
          const nested = mode === 'private-nested-root';
          expect(contribution).toHaveBeenCalledTimes(nested ? 2 : 1);
          expect(optionalPolicy).toHaveBeenCalledTimes(nested ? 2 : 1);
          expect(optionalExecute).not.toHaveBeenCalled();
          expect(nestedRoots).toBe(nested ? 1 : 0);
          expect(JSON.stringify(server.requests[0]?.tools ?? [])).toContain(
            'f9_optional_lookup',
          );
          expect(JSON.stringify(server.requests[1]?.tools ?? [])).not.toContain(
            'f9_optional_lookup',
          );
          expect(
            JSON.stringify(server.requests[nested ? 3 : 2]?.tools ?? []),
          ).not.toContain('f9_optional_lookup');
          if (nested)
            expect(JSON.stringify(server.requests[2]?.tools ?? [])).toContain(
              'f9_optional_lookup',
            );
        }
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
        if (mode === 'user-media') {
          expect(JSON.parse(transcript).items).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                role: 'user',
                content: expect.arrayContaining([
                  expect.objectContaining({
                    type: 'input_image',
                    file_id: 'opaque-user-memory-image',
                  }),
                ]),
              }),
            ]),
          );
        }
        if (mode === 'hosted-records') {
          expect(JSON.parse(transcript).items).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: 'file_search_call',
                status: 'completed',
                queries: ['fixture memory query'],
              }),
            ]),
          );
          expect(transcript).not.toContain('image_generation_call');
        }
        expect(transcript).not.toContain(
          'internal_chat_message_metadata_passthrough',
        );
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
                    : mode === 'tool-media'
                      ? [
                          expect.objectContaining({
                            type: 'input_image',
                            file_id: 'opaque-memory-image',
                          }),
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
      contribution?.mockRestore();
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

it.each([
  'cancelled',
  'failed',
  'guardrail',
  'step-limit',
  'phase-failure',
  'graceful-abort',
  'graceful-complete',
  'non-error',
  'input-guardrail',
  'input-throw',
  'input-invalid',
  'guarded-cancel',
] as const)(
  'records a settled source outcome (%s)',
  async (mode) => {
    const cancelledSource =
      mode === 'cancelled' ||
      mode === 'phase-failure' ||
      mode === 'graceful-abort' ||
      mode === 'guarded-cancel';
    const toolSource = cancelledSource || mode === 'step-limit';
    const sourceFailure =
      mode === 'non-error'
        ? 'provider unavailable'
        : new Error('original source completion failure');
    const phaseFailure = new Error('unrelated memory phase failure');
    const inputFailure = new Error('raw input guard callback failure');
    const peer = await startPublicExecutor();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let effects = 0;
    const server = new ModelServer([
      ...(mode.startsWith('input-')
        ? []
        : [
            mode === 'graceful-complete'
              ? async () => {
                  entered.resolve();
                  await release.promise;
                  return [message('natural source completion')];
                }
              : [
                  toolSource
                    ? call(
                        'held_source',
                        {},
                        { callId: 'cancelled-source-call' },
                      )
                    : message('source completion candidate'),
                ],
          ]),
      [
        message(
          JSON.stringify({
            rollout_summary: 'Stopped project lookup',
            rollout_slug: 'stopped-lookup',
            raw_memory: 'The project lookup did not finish.',
          }),
        ),
      ],
      ...(mode === 'phase-failure'
        ? []
        : [
            [
              message(
                JSON.stringify({
                  summary: 'Project lookup stopped.',
                  memory: 'The lookup did not finish.',
                }),
              ),
            ],
          ]),
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
    try {
      session = await new Agent({
        provider,
        model: 'gpt-5',
        instructions: 'Run the lookup.',
        ...(mode === 'failed' || mode === 'non-error'
          ? {
              beforeComplete: () => {
                throw sourceFailure;
              },
            }
          : {}),
        ...(mode.startsWith('input-') || mode === 'guarded-cancel'
          ? {
              inputGuardrails: [
                {
                  name: 'blocked-input',
                  runInParallel: false,
                  callback: () => {
                    if (mode === 'guarded-cancel')
                      return { tripwireTriggered: false };
                    if (mode === 'input-throw') throw inputFailure;
                    if (mode === 'input-invalid') return {} as never;
                    return {
                      tripwireTriggered: true,
                      outputInfo: 'private-rejected-input',
                    };
                  },
                },
              ],
            }
          : {}),
        ...(mode === 'guardrail'
          ? {
              outputGuardrails: [
                {
                  name: 'source-guard',
                  callback: () => ({
                    tripwireTriggered: true,
                    outputInfo: 'private-guard-result',
                  }),
                },
              ],
            }
          : {}),
        tools: [
          tool({
            name: 'held_source',
            parameters: z.object({}),
            async execute(_args, context) {
              effects++;
              entered.resolve();
              if (mode === 'graceful-abort') {
                await release.promise;
                return 'drained source tool';
              }
              if (mode === 'step-limit') return 'completed source tool step';
              await new Promise<never>((_resolve, reject) => {
                if (context.signal.aborted) reject(context.signal.reason);
                else
                  context.signal.addEventListener(
                    'abort',
                    () => reject(context.signal.reason),
                    { once: true },
                  );
              });
              return 'unreachable';
            },
          }),
        ],
      }).session({
        environment: sandboxEnvironment({
          client: new UnixLocalSandboxClient(),
          manifest: new Manifest(),
          memory: {
            phaseOne: new Agent({
              provider,
              model: 'gpt-5',
              instructions: 'Extract memory.',
              ...(mode === 'phase-failure'
                ? {
                    beforeComplete: () => {
                      throw phaseFailure;
                    },
                  }
                : {}),
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
        }),
      });
      const turn = await session.submit(
        mode.startsWith('input-')
          ? 'synthetic rejected sensitive input'
          : 'Start the project lookup.',
        mode === 'step-limit' ? { maxModelSteps: 1 } : undefined,
      );
      const original = turn.wait().catch((error: unknown) => error);
      if (cancelledSource || mode === 'graceful-complete') {
        await entered.promise;
        const stopping = turn.cancel(
          mode.startsWith('graceful') ? { mode: 'graceful' } : undefined,
        );
        release.resolve();
        await expect(stopping).resolves.toBeUndefined();
      }
      const cancelled = await original;
      if (mode.startsWith('input-')) {
        expect(turn.turnId).toEqual(expect.any(String));
        if (mode === 'input-throw') expect(cancelled).toBe(inputFailure);
        else if (mode === 'input-invalid')
          expect(cancelled).toBeInstanceOf(TypeError);
        else expect(cancelled).toBeInstanceOf(GuardrailTripwire);
        await expect(session.flushMemory()).rejects.toBe(cancelled);
        expect(server.requests).toHaveLength(0);
        await expect(
          readFile(join(workspace, 'sessions', `${session.id}.jsonl`)),
        ).rejects.toMatchObject({ code: 'ENOENT' });
        return;
      }
      if (mode === 'graceful-complete')
        expect(cancelled).toMatchObject({
          finalOutput: 'natural source completion',
        });
      else if (cancelledSource) expect(cancelled).toBeInstanceOf(TurnAborted);
      else if (mode === 'guardrail')
        expect(cancelled).toBeInstanceOf(GuardrailTripwire);
      else if (mode === 'step-limit')
        expect(cancelled).toMatchObject({ code: 'max_model_steps_exceeded' });
      else expect(cancelled).toBe(sourceFailure);
      expect(effects).toBe(toolSource ? 1 : 0);
      expect(server.requests).toHaveLength(1);
      if (mode === 'phase-failure') {
        await expect(session.flushMemory()).rejects.toBe(phaseFailure);
      } else {
        await Promise.all([session.flushMemory(), session.flushMemory()]);
        await session.flushMemory();
      }
      const text = await readFile(
        join(workspace, 'sessions', `${session.id}.jsonl`),
        'utf8',
      );
      expect(text.trim().split('\n')).toHaveLength(1);
      const terminalState =
        mode === 'graceful-complete'
          ? 'completed'
          : cancelledSource
            ? 'cancelled'
            : mode === 'guardrail'
              ? 'guardrail_tripped'
              : mode === 'step-limit'
                ? 'max_turns_exceeded'
                : 'failed';
      expect(JSON.parse(text).terminal_metadata).toMatchObject({
        terminal_state:
          mode === 'graceful-complete'
            ? 'completed'
            : cancelledSource
              ? 'cancelled'
              : mode === 'guardrail'
                ? 'guardrail_tripped'
                : mode === 'step-limit'
                  ? 'max_turns_exceeded'
                  : 'failed',
        exception_type:
          mode === 'graceful-complete'
            ? null
            : cancelledSource
              ? 'TurnAborted'
              : mode === 'guardrail'
                ? 'GuardrailTripwire'
                : mode === 'step-limit'
                  ? 'NativeError'
                  : 'Error',
        exception_message:
          mode === 'graceful-complete'
            ? null
            : cancelledSource
              ? 'Turn interrupted'
              : mode === 'guardrail'
                ? 'Run blocked by guardrail'
                : mode === 'step-limit'
                  ? 'Root model step limit reached'
                  : typeof sourceFailure === 'string'
                    ? sourceFailure
                    : sourceFailure.message,
        has_final_output: mode === 'graceful-complete',
      });
      if (mode !== 'phase-failure') {
        const raw = await readFile(
          join(workspace, 'memories', 'raw_memories', `${session.id}.md`),
          'utf8',
        );
        const summary = await readFile(
          join(workspace, 'memories', 'rollout_summaries', `${session.id}.md`),
          'utf8',
        );
        expect(raw).toContain(`terminal_state: ${terminalState}`);
        expect(summary).toContain(`terminal_state: ${terminalState}`);
        expect(JSON.stringify(server.requests.at(-1))).toContain(
          `terminal_state: ${terminalState}`,
        );
      }
      expect(text).not.toContain('private-guard-result');
      expect(await turn.wait().catch((error: unknown) => error)).toBe(
        cancelled,
      );
      expect(effects).toBe(toolSource ? 1 : 0);
      expect(server.requests).toHaveLength(mode === 'phase-failure' ? 2 : 3);
      server.assertExhausted();
    } finally {
      release.resolve();
      await session?.close();
      await peer.close();
    }
  },
  30_000,
);
