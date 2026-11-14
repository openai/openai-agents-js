import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { Agent, Environment, NativeProvider, tool } from '../../src';
import { binding, type NativeThread } from '../../src/runtime/binding';
import { UnixLocalSandboxClient } from '@openai/agents-core/sandbox/local';
import { Manifest, sandboxEnvironment } from '@openai/agents/sandbox';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(() => {
  vi.restoreAllMocks();
  return ModelServer.closeAll();
});

it('exports only the terminal child resource partition, including its later caller input', async () => {
  const peer = await startPublicExecutor();
  const artifact = () => [
    message(
      JSON.stringify({
        rollout_summary: 'Child facts',
        rollout_slug: 'child',
        raw_memory: 'Child facts only.',
      }),
    ),
  ];
  const consolidated = () => [
    message(
      JSON.stringify({
        summary: 'Child facts',
        memory: 'Child facts only.',
      }),
    ),
  ];
  const server = new ModelServer([
    [
      message('root-only-output'),
      call('transfer_to_child', {}, { callId: 'memory-route' }),
    ],
    [call('child_lookup', {}, { callId: 'child-local' })],
    [message('child-owned-output')],
    artifact(),
    consolidated(),
    [message('child-second-output')],
    artifact(),
    consolidated(),
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-child-memory',
    supportsWebsockets: false,
  });
  const phase = new Agent({
    provider,
    model: 'gpt-5.5',
    instructions: 'Return memory artifacts.',
  });
  let workspace = '';
  let childEffects = 0;
  let releases = 0;
  const child = new Agent({
    name: 'child',
    model: 'gpt-5.5',
    provider,
    instructions: 'Answer as the child.',
    tools: [
      tool({
        name: 'child_lookup',
        parameters: z.object({}),
        execute: () => {
          childEffects++;
          return 'child-owned-tool-output';
        },
      }),
    ],
    environment: sandboxEnvironment({
      client: new UnixLocalSandboxClient(),
      manifest: new Manifest({ entries: {} }),
      memory: { phaseOne: phase, phaseTwo: phase },
      connect: async ({ state }) => {
        workspace = state.workspaceRootPath;
        return Environment.lease(
          new Environment({
            url: peer.url,
            headers: peer.headers,
            cwd: workspace,
            tools: [],
          }),
          async () => {
            releases++;
          },
        );
      },
    }),
  });
  const root = new Agent({
    provider,
    model: 'gpt-5.5',
    instructions: 'Transfer to the child.',
    handoffs: [child],
  });
  try {
    await using session = await root.session();
    expect(
      (await (await session.submit('root-only-caller-input')).wait())
        .finalOutput,
    ).toBe('child-owned-output');
    expect(childEffects).toBe(1);
    const allHistory = JSON.stringify(await session.historySnapshot());
    expect(allHistory).toContain('root-only-caller-input');
    expect(allHistory).toContain('root-only-output');
    const native = await binding();
    const read = native.NativeThread.prototype._memory_history;
    let captured:
      { thread: NativeThread; turn: string; scope: string } | undefined;
    vi.spyOn(
      native.NativeThread.prototype,
      '_memory_history',
    ).mockImplementation(function (this: NativeThread, turn, scope) {
      if (scope !== undefined) captured = { thread: this, turn, scope };
      return read.call(this, turn, scope);
    });
    await session.flushMemory();
    expect(captured).toBeDefined();
    const owned = captured!;
    const scope = JSON.parse(owned.scope) as {
      source: { profile_id: string; epoch: number };
      profiles: string[];
    };
    await expect(
      read.call(
        owned.thread,
        owned.turn,
        JSON.stringify({
          ...scope,
          source: { ...scope.source, epoch: scope.source.epoch + 1 },
        }),
      ),
    ).rejects.toThrow('exact native terminal profile proof');
    await expect(
      read.call(
        owned.thread,
        owned.turn,
        JSON.stringify({
          ...scope,
          profiles: [...scope.profiles, 'foreign-profile'],
        }),
      ),
    ).rejects.toThrow('outside the captured Agent graph');
    expect(server.requests).toHaveLength(5);
    const first = await readFile(
      join(workspace, 'sessions', `${session.id}.jsonl`),
      'utf8',
    );
    expect(first).toContain('child-owned-output');
    expect(first).toContain('child-owned-tool-output');
    expect(first).not.toContain('root-only-caller-input');
    expect(first).not.toContain('root-only-output');
    const phaseRequests = JSON.stringify(server.requests.slice(3, 5));
    expect(phaseRequests).toContain('child-owned-output');
    expect(phaseRequests).not.toContain('root-only-caller-input');
    expect(phaseRequests).not.toContain('root-only-output');
    await session.flushMemory();
    expect(server.requests).toHaveLength(5);
    expect(
      (await (await session.submit('child-owned-caller-input')).wait())
        .finalOutput,
    ).toBe('child-second-output');
    await session.flushMemory();
    const second = await readFile(
      join(workspace, 'sessions', `${session.id}.jsonl`),
      'utf8',
    );
    expect(second).toContain('child-owned-caller-input');
    expect(second).not.toContain('root-only-caller-input');
    expect(second).not.toContain('root-only-output');
    expect(server.requests).toHaveLength(8);
    expect(releases).toBe(0);
    await session.close();
    expect(releases).toBe(1);
  } finally {
    await peer.close();
  }
}, 60_000);

it('does not transfer an ordinary terminal Agent history into an acquired child memory store', async () => {
  const peer = await startPublicExecutor();
  const server = new ModelServer([
    [call('transfer_to_child', {}, { callId: 'enter-child' })],
    [call('transfer_to_returned', {}, { callId: 'leave-child' })],
    [message('ordinary-root-final')],
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-child-memory',
    supportsWebsockets: false,
  });
  const phase = new Agent({
    provider,
    model: 'gpt-5.5',
    instructions: 'Return memory artifacts.',
  });
  const returned = new Agent({
    name: 'returned',
    provider,
    model: 'gpt-5.5',
    instructions: 'Answer as the ordinary root.',
  });
  let releases = 0;
  const child = new Agent({
    name: 'child',
    provider,
    model: 'gpt-5.5',
    instructions: 'Return to the ordinary root.',
    handoffs: [returned],
    environment: sandboxEnvironment({
      client: new UnixLocalSandboxClient(),
      manifest: new Manifest({ entries: {} }),
      memory: { phaseOne: phase, phaseTwo: phase },
      connect: async ({ state }) =>
        Environment.lease(
          new Environment({
            url: peer.url,
            headers: peer.headers,
            cwd: state.workspaceRootPath,
            tools: [],
          }),
          async () => {
            releases++;
          },
        ),
    }),
  });
  const root = new Agent({
    provider,
    model: 'gpt-5.5',
    instructions: 'Transfer to the child.',
    handoffs: [child],
  });
  try {
    await using session = await root.session();
    expect(
      (await (await session.submit('ordinary-root-private-input')).wait())
        .finalOutput,
    ).toBe('ordinary-root-final');
    await expect(session.flushMemory()).rejects.toThrow(
      'terminal Agent resource has no sandbox memory',
    );
    expect(server.requests).toHaveLength(3);
    expect(releases).toBe(0);
    await session.close();
    expect(releases).toBe(1);
  } finally {
    await peer.close();
  }
}, 60_000);
