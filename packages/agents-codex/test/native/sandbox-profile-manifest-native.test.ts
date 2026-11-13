import { access, readFile, writeFile } from 'node:fs/promises';
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
import { registerExclusiveWorkspaceCreate } from '@openai/agents-core/sandbox/internal';

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
    raceFirst?: boolean;
    borrowed?: Awaited<ReturnType<UnixLocalSandboxClient['create']>>;
  } = {},
) {
  const client = new UnixLocalSandboxClient();
  let prepared = 0;
  let bound = 0;
  let resource: SandboxSessionLike | undefined = options.borrowed;
  let root = (options.borrowed?.state.workspaceRootPath as string) ?? '';
  let firstEffect: string | undefined;
  let racedContent: string | undefined;
  const writes: string[] = [];
  const probes: { lease: number; output: string }[] = [];
  const create = client.create.bind(client);
  vi.spyOn(client, 'create').mockImplementation(async (args) => {
    const sandbox = await create(args);
    resource = sandbox;
    root = sandbox.state.workspaceRootPath as string;
    const exists = sandbox.pathExists.bind(sandbox);
    if (options.raceFirst)
      sandbox.pathExists = async (path, runAs) => {
        const present = await exists(path, runAs);
        if (path === 'destination-b.txt')
          await writeFile(
            join(root, 'destination-a.txt'),
            'raced-user-content',
          );
        return present;
      };
    const write: NonNullable<
      ReturnType<typeof registerExclusiveWorkspaceCreate>
    > = registerExclusiveWorkspaceCreate(sandbox, async (args) => {
      writes.push(args.path);
      if (args.path === 'destination-a.txt' && options.holdFirst) {
        options.holdFirst.entered();
        await options.holdFirst.release;
      }
      if (args.path === 'destination-b.txt' && options.failSecond) {
        firstEffect = await readFile(join(root, 'destination-a.txt'), 'utf8');
        throw options.failSecond;
      }
      try {
        await write(args);
      } catch (error) {
        if (options.raceFirst)
          racedContent = await readFile(
            join(root, 'destination-a.txt'),
            'utf8',
          );
        throw error;
      }
    })!;
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
      session: options.borrowed,
      manifest: options.borrowed?.state.manifest ?? new Manifest(),
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
    racedContent: () => racedContent,
  };
}
function actors(
  provider: NativeProvider,
  extra: ReturnType<typeof tool>[] = [],
  returning = false,
) {
  const receiver = new Agent({
    name: 'receiver',
    instructions: 'RECEIVER_BASE',
    model: 'gpt-5.5',
    handoffs: returning ? [() => root] : [],
  });
  const root: Agent = new Agent({
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

it('has been rejecting changed profile manifests without discarding a borrowed resource', async () => {
  const client = new UnixLocalSandboxClient();
  const borrowed = await client.create(
    new Manifest({
      entries: {
        'root.txt': { type: 'file', content: 'root-content' },
      },
    }),
  );
  try {
    const server = new ModelServer([]);
    await using provider = await providerFor(server);
    const scope = ownedSource({ borrowed });
    await expect(
      actors(provider).root.session({ environment: scope.source }),
    ).rejects.toThrow('owned disposable workspace');
    expect(scope.writes).toEqual([]);
    await expect(
      readFile(join(scope.root(), 'root.txt'), 'utf8'),
    ).resolves.toBe('root-content');
    await expect(
      access(join(scope.root(), 'destination-a.txt')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(server.requests).toEqual([]);
  } finally {
    await borrowed.close();
  }
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

it('has been rejecting a file raced after occupancy validation before target sampling', async () => {
  const server = new ModelServer([
    [call('transfer_to_receiver', {}, { callId: 'transfer' })],
    [message('unexpected accepted target')],
  ]);
  await using provider = await providerFor(server);
  const scope = ownedSource({ raceFirst: true });
  await using session = await actors(provider).root.session({
    environment: scope.source,
  });
  await expect((await session.submit('Transfer.')).wait()).rejects.toThrow(
    /File exists/i,
  );
  expect(scope.racedContent()).toBe('raced-user-content');
  expect(server.requests).toHaveLength(1);
  await expect(access(scope.root())).rejects.toMatchObject({ code: 'ENOENT' });
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

it.each(['handoff', 'idle'] as const)(
  'prepares the destination workspace when transferring between different owners (%s)',
  async (mode) => {
    const server = new ModelServer(
      mode === 'handoff'
        ? [
            [call('transfer_to_external', {}, { callId: 'to-external' })],
            [call('transfer_to_receiver', {}, { callId: 'to-receiver' })],
            [call('inspect_workspace', {}, { callId: 'receiver-read' })],
            [message('receiver complete')],
          ]
        : [[message('external complete')], [message('receiver complete')]],
    );
    await using provider = await providerFor(server);
    const scope = ownedSource();
    const receiver = new Agent({
      name: 'receiver',
      instructions: 'RECEIVER_BASE',
      model: 'gpt-5.5',
    });
    const external = new Agent({
      name: 'external',
      instructions: 'EXTERNAL_BASE',
      model: 'gpt-5.5',
      environment: new Environment({
        url: peer.url,
        headers: peer.headers,
        cwd: peer.cwd,
        tools: [],
      }),
      handoffs: [receiver],
    });
    const root = new Agent({
      name: 'root',
      instructions: 'ROOT_BASE',
      model: 'gpt-5.5',
      provider,
      handoffs: [external, receiver],
    });
    await using session = await root.session({ environment: scope.source });
    if (mode === 'idle') {
      await session.update({ agent: external });
      expect(
        (await (await session.submit('External.')).wait()).finalOutput,
      ).toBe('external complete');
      expect(scope.writes).toEqual([]);
      await session.update({ agent: receiver });
    }
    expect((await (await session.submit('Transfer.')).wait()).finalOutput).toBe(
      'receiver complete',
    );
    const externalRequest = server.requests[mode === 'handoff' ? 1 : 0];
    const receiverRequest = server.requests[mode === 'handoff' ? 2 : 1];
    expect(JSON.stringify(externalRequest.input)).toContain('EXTERNAL_BASE');
    expect(JSON.stringify(externalRequest.input)).not.toContain(
      'destination-a.txt',
    );
    expect(JSON.stringify(receiverRequest.input)).toContain('RECEIVER_BASE');
    expect(JSON.stringify(receiverRequest.input)).toContain(
      'destination-a.txt',
    );
    expect(scope.writes).toEqual(['destination-a.txt', 'destination-b.txt']);
    server.assertExhausted();
  },
);
