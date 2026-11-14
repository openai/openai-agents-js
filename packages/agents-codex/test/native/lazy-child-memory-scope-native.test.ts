import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Agent, Environment, NativeProvider } from '../../src';
import { binding, type NativeThread } from '../../src/runtime/binding';
import { Manifest, sandboxEnvironment } from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents-core/sandbox/local';
import { ModelServer, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(() => {
  vi.restoreAllMocks();
  return ModelServer.closeAll();
});

it('exports terminal root memory without consuming or grouping an unvisited child Source', async () => {
  const peer = await startPublicExecutor();
  const server = new ModelServer([
    [message('root-memory-answer')],
    [
      message(
        JSON.stringify({
          rollout_summary: 'Root facts',
          rollout_slug: 'root',
          raw_memory: 'Root facts only.',
        }),
      ),
    ],
    [
      message(
        JSON.stringify({ summary: 'Root facts', memory: 'Root facts only.' }),
      ),
    ],
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-memory-source',
    supportsWebsockets: false,
  });
  const phase = new Agent({
    provider,
    model: 'gpt-5.5',
    instructions: 'Return memory artifacts.',
  });
  let rootWorkspace = '';
  let rootReleases = 0;
  const childSource = vi.fn(
    sandboxEnvironment({
      client: new UnixLocalSandboxClient(),
      manifest: new Manifest({ entries: {} }),
      memory: { phaseOne: phase, phaseTwo: phase },
      connect: async () => {
        throw new Error('Unvisited child resource opened');
      },
    }),
  );
  const child = new Agent({
    name: 'child',
    provider,
    model: 'gpt-5.5',
    instructions: 'Answer.',
    environment: childSource,
  });
  const root = new Agent({
    provider,
    model: 'gpt-5.5',
    instructions: 'Answer directly.',
    handoffs: [child],
  });
  const rootSource = sandboxEnvironment({
    client: new UnixLocalSandboxClient(),
    manifest: new Manifest({ entries: {} }),
    memory: { phaseOne: phase, phaseTwo: phase },
    connect: async ({ state }) => {
      rootWorkspace = state.workspaceRootPath;
      return Environment.lease(
        new Environment({
          url: peer.url,
          headers: peer.headers,
          cwd: rootWorkspace,
          tools: [],
        }),
        async () => {
          rootReleases++;
        },
      );
    },
  });
  try {
    await using session = await root.session({ environment: rootSource });
    expect(childSource).not.toHaveBeenCalled();
    expect(
      (await (await session.submit('root-memory-input')).wait()).finalOutput,
    ).toBe('root-memory-answer');
    const native = await binding();
    const read = native.NativeThread.prototype._memory_history;
    const partitions: string[][] = [];
    vi.spyOn(
      native.NativeThread.prototype,
      '_memory_history',
    ).mockImplementation(function (this: NativeThread, turn, scope) {
      if (scope !== undefined)
        partitions.push((JSON.parse(scope) as { profiles: string[] }).profiles);
      return read.call(this, turn, scope);
    });
    await session.flushMemory();
    expect(partitions).toHaveLength(1);
    expect(partitions[0]).toHaveLength(1);
    const transcript = await readFile(
      join(rootWorkspace, 'sessions', `${session.id}.jsonl`),
      'utf8',
    );
    expect(transcript).toContain('root-memory-input');
    expect(transcript).toContain('root-memory-answer');
    expect(childSource).not.toHaveBeenCalled();
    expect(server.requests).toHaveLength(3);
    expect(rootReleases).toBe(0);
    await session.close();
    expect(rootReleases).toBe(1);
    expect(childSource).not.toHaveBeenCalled();
  } finally {
    await peer.close();
  }
}, 60_000);
