import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Manifest,
  sandboxEnvironment,
  type SandboxCapability,
  type SandboxSessionLike,
} from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents/sandbox/local';
import { Agent, Environment, NativeProvider, tool } from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

let peer: Awaited<ReturnType<typeof startPublicExecutor>>;
beforeAll(async () => {
  peer = await startPublicExecutor();
});
afterAll(async () => {
  await peer?.close();
});
afterEach(() => ModelServer.closeAll());

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic',
    supportsWebsockets: false,
  });
}
function ownedSource(
  options: {
    failSecond?: Error;
    holdFirst?: { entered: () => void; release: Promise<void> };
    invalidRoot?: boolean;
    occupy?: boolean;
  } = {},
) {
  const client = new UnixLocalSandboxClient();
  let prepared = 0;
  let bound = 0;
  let resource: SandboxSessionLike;
  let root = '';
  let firstEffect: string | undefined;
  const writes: string[] = [];
  const probes: { lease: number; output: string }[] = [];
  const create = client.create.bind(client);
  vi.spyOn(client, 'create').mockImplementation(async (args) => {
    const sandbox = await create(args);
    resource = sandbox;
    root = sandbox.state.workspaceRootPath as string;
    const write = sandbox.writeFileNoFollow!.bind(sandbox);
    Object.defineProperty(sandbox, 'writeFileNoFollow', {
      value: async (args: Parameters<typeof write>[0]) => {
        writes.push(args.path);
        if (args.path === 'destination-a.txt' && options.holdFirst) {
          options.holdFirst.entered();
          await options.holdFirst.release;
        }
        if (args.path === 'destination-b.txt' && options.failSecond) {
          firstEffect = await readFile(join(root, 'destination-a.txt'), 'utf8');
          throw options.failSecond;
        }
        await write(args);
      },
    });
    return sandbox;
  });
  class Destination implements SandboxCapability {
    readonly type = 'captured-destination';
    lease = -1;
    clone() {
      return new Destination();
    }
    prepareManifest(manifest: Manifest) {
      const destination = prepared++ > 0;
      return new Manifest({
        ...manifest,
        ...(destination && options.invalidRoot
          ? { root: '/another-workspace' }
          : {}),
        entries: {
          ...manifest.entries,
          'root.txt': { type: 'file', content: 'root-content' },
          ...(destination
            ? {
                'destination-a.txt': {
                  type: 'file' as const,
                  content: 'destination-a',
                },
                'destination-b.txt': {
                  type: 'file' as const,
                  content: 'destination-b',
                },
              }
            : {}),
        },
      });
    }
    bind() {
      this.lease = bound++;
      return this;
    }
    instructions(manifest: Manifest) {
      return 'CAP_FILES_' + Object.keys(manifest.entries).sort().join(',');
    }
    tools() {
      return [
        tool({
          name: 'inspect_workspace',
          description: 'Inspect this captured owned workspace.',
          parameters: z.object({}),
          execute: async (_args, context) => {
            const output = (
              await context.sandbox!.exec({
                cmd: 'cat root.txt; if [ -f destination-a.txt ]; then cat destination-a.txt; fi',
                login: false,
              })
            ).stdout;
            probes.push({ lease: this.lease, output });
            if (options.occupy && this.lease === 0)
              await context.sandbox!.exec({
                cmd: 'printf user-owned > destination-b.txt',
                login: false,
              });
            return output;
          },
        }),
      ];
    }
  }
  return {
    source: sandboxEnvironment({
      client,
      manifest: new Manifest(),
      capabilities: [new Destination()],
      connect: async (sandbox) =>
        Environment.lease(
          new Environment({
            url: peer.url,
            headers: peer.headers,
            cwd: sandbox.state.workspaceRootPath as string,
            tools: [],
          }),
          () => {},
        ),
    }),
    writes,
    probes,
    root: () => root,
    resource: () => resource!,
    firstEffect: () => firstEffect,
  };
}
function actors(
  provider: NativeProvider,
  extra: ReturnType<typeof tool>[] = [],
  returning = false,
) {
  let root: Agent;
  const receiver = new Agent({
    name: 'receiver',
    instructions: 'RECEIVER_BASE',
    model: 'gpt-5.5',
    handoffs: returning ? [() => root] : [],
  });
  root = new Agent({
    name: 'root',
    instructions: 'ROOT_BASE',
    model: 'gpt-5.5',
    provider,
    handoffs: [receiver],
    tools: extra,
  });
  return { root, receiver };
}

it('has been staging the accepted destination manifest and publishing its current canonical workspace before sampling', async () => {
  const server = new ModelServer([
    [call('inspect_workspace', {}, { callId: 'root-read' })],
    [call('transfer_to_receiver', {}, { callId: 'transfer' })],
    [call('inspect_workspace', {}, { callId: 'target-read' })],
    [call('transfer_to_root', {}, { callId: 'return-transfer' })],
    [call('inspect_workspace', {}, { callId: 'return-read' })],
    [message('root complete')],
  ]);
  await using provider = await providerFor(server);
  const scope = ownedSource();
  const { root } = actors(provider, [], true);
  await using session = await root.session({ environment: scope.source });
  expect(
    (await (await session.submit('Inspect then transfer.')).wait()).finalOutput,
  ).toBe('root complete');
  expect(scope.writes).toEqual(['destination-a.txt', 'destination-b.txt']);
  expect(scope.probes).toEqual([
    { lease: 0, output: 'root-content' },
    { lease: 1, output: 'root-contentdestination-a' },
    { lease: 0, output: 'root-contentdestination-a' },
  ]);
  const publication = (await session.saveState()).history.findLast(
    (row) =>
      row.type === 'response_item' &&
      JSON.stringify(row.metadata).includes('sdk_agent_profile'),
  );
  expect(JSON.stringify(publication)).toContain('ROOT_BASE');
  expect(JSON.stringify(server.requests[2].input)).toContain('RECEIVER_BASE');
  expect(JSON.stringify(publication)).toContain(
    'CAP_FILES_destination-a.txt,destination-b.txt,root.txt',
  );
  expect(JSON.stringify(publication)).toContain(
    '# Current SDK workspace snapshot',
  );
  expect(JSON.stringify(server.requests[0].input)).not.toContain(
    'destination-a.txt',
  );
  expect(JSON.stringify(server.requests[2].input)).toContain(
    'destination-a.txt',
  );
  expect(scope.writes).toHaveLength(2);
  expect(scope.probes.at(-1)).toEqual({
    lease: 0,
    output: 'root-contentdestination-a',
  });
  expect(JSON.stringify(server.requests[4].input)).toContain(
    'CAP_FILES_destination-a.txt,destination-b.txt,root.txt',
  );
  server.assertExhausted();
});

it('has been preparing the captured workspace during an idle Agent update', async () => {
  const server = new ModelServer([
    [call('transfer_to_receiver', {}, { callId: 'transfer' })],
    [message('destination complete')],
    [message('root complete')],
  ]);
  await using provider = await providerFor(server);
  const scope = ownedSource();
  const { root } = actors(provider);
  await using session = await root.session({ environment: scope.source });
  expect((await (await session.submit('Transfer.')).wait()).finalOutput).toBe(
    'destination complete',
  );
  await session.update({ agent: root });
  expect((await (await session.submit('Continue.')).wait()).finalOutput).toBe(
    'root complete',
  );
  expect(scope.writes).toEqual(['destination-a.txt', 'destination-b.txt']);
  expect(JSON.stringify(server.requests[2].input)).toContain('ROOT_BASE');
  expect(JSON.stringify(server.requests[2].input)).toContain(
    'CAP_FILES_destination-a.txt,destination-b.txt,root.txt',
  );
  server.assertExhausted();
});

it('has been discarding the owned source after a later prevalidated write fails without a second sampling or target acceptance', async () => {
  const primary = new Error('later-prevalidated-write-failure');
  const server = new ModelServer([
    [call('transfer_to_receiver', {}, { callId: 'transfer' })],
  ]);
  await using provider = await providerFor(server);
  const scope = ownedSource({ failSecond: primary });
  await using session = await actors(provider).root.session({
    environment: scope.source,
  });
  await expect((await session.submit('Transfer.')).wait()).rejects.toThrow(
    'later-prevalidated-write-failure',
  );
  expect(scope.writes).toEqual(['destination-a.txt', 'destination-b.txt']);
  expect(scope.firstEffect()).toBe('destination-a');
  expect(scope.resource().state.workspaceReady).toBe(false);
  await expect(access(scope.root())).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(session.submit('Continue on the source.')).rejects.toThrow();
  expect(server.requests).toHaveLength(1);
  expect(scope.probes).toEqual([]);
  server.assertExhausted();
});

it('has been joining an entered destination write on cancellation before discarding its owned resource', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const server = new ModelServer([
    [call('transfer_to_receiver', {}, { callId: 'transfer' })],
  ]);
  await using provider = await providerFor(server);
  const scope = ownedSource({
    holdFirst: { entered: entered.resolve, release: release.promise },
  });
  await using session = await actors(provider).root.session({
    environment: scope.source,
  });
  const turn = await session.submit('Transfer.');
  const result = turn.wait().catch((error) => error);
  try {
    await entered.promise;
    let joined = false;
    const cancellation = turn.cancel().then(() => {
      joined = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(joined).toBe(false);
    release.resolve();
    await cancellation;
    expect(await result).toBeInstanceOf(Error);
    expect(scope.writes).toEqual(['destination-a.txt']);
    await expect(access(scope.root())).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(session.submit('Continue.')).rejects.toThrow();
    expect(server.requests).toHaveLength(1);
  } finally {
    release.resolve();
  }
});

it('has been rejecting destination authority changes before callback or model effects', async () => {
  const server = new ModelServer([]);
  await using provider = await providerFor(server);
  const scope = ownedSource({ invalidRoot: true });
  await expect(
    actors(provider).root.session({ environment: scope.source }),
  ).rejects.toThrow('unchanged workspace authority');
  expect(scope.writes).toEqual([]);
  expect(scope.probes).toEqual([]);
  expect(server.requests).toEqual([]);
  await expect(access(scope.root())).rejects.toMatchObject({ code: 'ENOENT' });
});

it('has been checking every destination occupancy before writing the first file', async () => {
  const server = new ModelServer([
    [call('inspect_workspace', {}, { callId: 'source-write' })],
    [call('transfer_to_receiver', {}, { callId: 'transfer' })],
  ]);
  await using provider = await providerFor(server);
  const scope = ownedSource({ occupy: true });
  await using session = await actors(provider).root.session({
    environment: scope.source,
  });
  await expect(
    (await session.submit('Inspect and transfer.')).wait(),
  ).rejects.toThrow('already exists outside its recorded manifest');
  expect(scope.writes).toEqual([]);
  expect(server.requests).toHaveLength(2);
  await expect(access(scope.root())).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(session.submit('Continue.')).rejects.toThrow();
});

it('has been retaining the source workspace when a later fatal sibling prevents accepted activation', async () => {
  const primary = new Error('later-fatal-before-workspace-activation');
  const fatal = tool({
    name: 'fatal_later',
    description: 'Fail this source batch.',
    parameters: z.object({}),
    errorFunction: null,
    execute: () => {
      throw primary;
    },
  });
  const server = new ModelServer([
    [
      call('transfer_to_receiver', {}, { callId: 'transfer' }),
      call('fatal_later', {}, { callId: 'fatal' }),
    ],
  ]);
  await using provider = await providerFor(server);
  const scope = ownedSource();
  await using session = await actors(provider, [fatal]).root.session({
    environment: scope.source,
  });
  await expect(
    (await session.submit('Transfer with the sibling.')).wait(),
  ).rejects.toThrow('later-fatal-before-workspace-activation');
  expect(scope.writes).toEqual([]);
  await expect(readFile(join(scope.root(), 'root.txt'), 'utf8')).resolves.toBe(
    'root-content',
  );
  await expect(
    access(join(scope.root(), 'destination-a.txt')),
  ).rejects.toMatchObject({ code: 'ENOENT' });
  expect(server.requests).toHaveLength(1);
});
