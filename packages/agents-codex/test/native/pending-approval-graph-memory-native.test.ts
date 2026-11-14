import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Environment,
  NativeProvider,
  isFunctionApprovalRequest,
  tool,
} from '../../src';
import { binding, type NativeThread } from '../../src/runtime/binding';
import { Manifest, sandboxEnvironment } from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents-core/sandbox/local';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(() => {
  vi.restoreAllMocks();
  return ModelServer.closeAll();
});

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-graph-pending-memory',
    supportsWebsockets: false,
  });
}

it('keeps a live destination approval outside its resource memory and excludes root history', async () => {
  const peer = await startPublicExecutor();
  const rootSecret = 'ROOT_ONLY_BEFORE_HANDOFF';
  const pendingSecret = 'UNAPPROVED_DESTINATION_ARGUMENT';
  const source = new ModelServer([
    [
      message(rootSecret),
      call('transfer_to_destination', {}, { callId: 'enter-destination' }),
    ],
    [
      message('DESTINATION_PUBLIC_FACT'),
      call(
        'risky',
        { value: pendingSecret },
        { callId: 'destination-pending' },
      ),
    ],
    [message('done')],
  ]);
  const memory = new ModelServer([
    [
      message(
        JSON.stringify({
          rollout_summary: 'Destination fact.',
          rollout_slug: 'destination',
          raw_memory: 'Destination fact.',
        }),
      ),
    ],
    [
      message(
        JSON.stringify({
          summary: 'Destination fact.',
          memory: 'Destination fact.',
        }),
      ),
    ],
  ]);
  await using sourceProvider = await providerFor(source);
  await using memoryProvider = await providerFor(memory);
  const files = new Map<string, Uint8Array>();
  const store = {
    read: async (path: string) => files.get(path) ?? null,
    write: async (path: string, value: Uint8Array) => {
      files.set(path, value.slice());
    },
    delete: async (path: string) => {
      files.delete(path);
    },
    list: async (prefix: string) =>
      [...files.keys()].filter((path) => path.startsWith(prefix)),
  };
  const phase = new Agent({
    provider: memoryProvider,
    model: 'gpt-5.5',
    instructions: 'Return memory artifacts.',
  });
  let effects = 0;
  const destination = new Agent({
    name: 'destination',
    provider: sourceProvider,
    model: 'gpt-5.5',
    instructions: 'Use risky.',
    tools: [
      tool({
        name: 'risky',
        parameters: z.object({ value: z.string() }),
        needsApproval: true,
        execute: ({ value }) => {
          effects++;
          return value;
        },
      }),
    ],
    environment: sandboxEnvironment({
      client: new UnixLocalSandboxClient(),
      manifest: new Manifest({ entries: {} }),
      memory: { phaseOne: phase, phaseTwo: phase, store },
      connect: async ({ state }) =>
        Environment.lease(
          new Environment({
            url: peer.url,
            headers: peer.headers,
            cwd: state.workspaceRootPath,
            tools: [],
          }),
          async () => {},
        ),
    }),
  });
  const root = new Agent({
    provider: sourceProvider,
    model: 'gpt-5.5',
    instructions: 'Transfer to the destination.',
    handoffs: [destination],
  });
  const native = await binding();
  const prototype = native.NativeThread.prototype;
  const configure = prototype._configure_agent_profiles;
  let rootProfile = '';
  vi.spyOn(prototype, '_configure_agent_profiles').mockImplementation(function (
    this: NativeThread,
    roster,
    rootId,
  ) {
    rootProfile = rootId;
    return configure.call(this, roster, rootId);
  });
  try {
    await using session = await root.session();
    const turn = await session.submit('ROOT_ONLY_CALLER_INPUT');
    const stream = session.interactions()[Symbol.asyncIterator]();
    const item = await stream.next();
    if (item.done || !isFunctionApprovalRequest(item.value))
      throw new Error('Missing destination approval');
    const approval = item.value;
    const read = prototype._pending_memory_history;
    let checked = false;
    vi.spyOn(prototype, '_pending_memory_history').mockImplementation(
      async function (this: NativeThread, request, scopeJson) {
        if (!scopeJson) throw new Error('Missing private graph partition');
        const scope = JSON.parse(scopeJson) as {
          source: { profile_id: string; epoch: number };
          profiles: string[];
        };
        expect(scope.source.profile_id).not.toBe(rootProfile);
        expect(scope.profiles).not.toContain(rootProfile);
        if (!checked) {
          checked = true;
          for (const source of [
            { ...scope.source, profile_id: rootProfile },
            { ...scope.source, epoch: scope.source.epoch + 1 },
          ]) {
            await expect(
              read.call(this, request, JSON.stringify({ ...scope, source })),
            ).rejects.toThrow('exact native profile scope');
          }
          await expect(
            read.call(
              this,
              request,
              JSON.stringify({
                ...scope,
                profiles: [...scope.profiles, rootProfile],
              }),
            ),
          ).rejects.toThrow('crosses admitted resources');
          expect(files.size).toBe(0);
          expect(memory.requests).toHaveLength(0);
        }
        return read.call(this, request, scopeJson);
      },
    );
    await session.flushMemory();
    expect(checked).toBe(true);
    expect(memory.requests).toHaveLength(2);
    const path = [...files.keys()].find((path) => path.endsWith('.jsonl'));
    expect(path).toBeDefined();
    const rollout = new TextDecoder().decode(files.get(path!)!);
    for (const data of [rollout, JSON.stringify(memory.requests)]) {
      expect(data).toContain('DESTINATION_PUBLIC_FACT');
      expect(data).not.toContain(rootSecret);
      expect(data).not.toContain('ROOT_ONLY_CALLER_INPUT');
      expect(data).not.toContain(pendingSecret);
      expect(data).not.toContain('manual_grant');
    }
    expect(effects).toBe(0);
    await session.respond(approval.reject('denied after memory'));
    await expect(async () =>
      session.respond(approval.reject('denied twice')),
    ).rejects.toThrow();
    expect((await turn.wait()).finalOutput).toBe('done');
    expect(effects).toBe(0);
    expect(source.requests).toHaveLength(3);
  } finally {
    await peer.close();
  }
}, 30_000);
