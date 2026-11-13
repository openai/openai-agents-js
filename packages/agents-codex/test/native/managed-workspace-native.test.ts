import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Manifest,
  sandboxEnvironment,
  ManagedWorkspaceCheckpoint,
} from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents/sandbox/local';
import { Agent, Environment, NativeProvider } from '@openai/agents';
import { ModelServer, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(() => ModelServer.closeAll());

it('retains paired A while native continuation publishes B and then resumes original A', async () => {
  const base = await mkdtemp(join(tmpdir(), 'managed-native-'));
  const server = new ModelServer([[message('A remembered')]]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-provider',
    supportsWebsockets: false,
  });
  const agent = new Agent({
    provider,
    model: 'gpt-5',
    instructions: 'Keep the workspace.',
  });
  let workspace = '';
  let beforeSerialize: (() => Promise<void>) | undefined;
  const source = (
    pair?: ManagedWorkspaceCheckpoint,
    policy: {
      readOnly?: boolean;
      deniedDomain?: string;
      trustedExpected?: ManagedWorkspaceCheckpoint;
    } = {},
  ) => {
    const payload = pair?.workspace.providerState;
    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: base,
      snapshot: { type: 'local', baseDir: join(base, 'archives') },
      ...(payload
        ? {
            resumeAuthority: {
              localSnapshotPath: (payload.snapshot as { path: string }).path,
            },
          }
        : {}),
    });
    const serialize = client.serializeSessionState.bind(client);
    client.serializeSessionState = async (state) => {
      await beforeSerialize?.();
      return serialize(state);
    };
    return sandboxEnvironment({
      client,
      managedWorkspace: true,
      ...(!payload
        ? { snapshot: { type: 'local', baseDir: join(base, 'archives') } }
        : {}),
      manifest: new Manifest(
        payload ? {} : { entries: { value: { type: 'file', content: 'A' } } },
      ),
      ...(payload
        ? {
            authorizedResumeState: {
              backendId: client.backendId,
              serializedState: payload,
            },
            ...(policy.trustedExpected
              ? { authorizedResumeCheckpoint: policy.trustedExpected }
              : {}),
          }
        : {}),
      connect: async (sandbox, { signal }) => {
        workspace = sandbox.state.workspaceRootPath;
        const peer = await startPublicExecutor();
        try {
          signal.throwIfAborted();
          return Environment.lease(
            new Environment({
              url: peer.url,
              headers: peer.headers,
              cwd: workspace,
              tools: ['exec_command'],
              ...(policy.readOnly === undefined
                ? {}
                : { readOnly: policy.readOnly }),
              network: {
                allowAllUnixSockets: true,
                deniedDomains: [
                  policy.deniedDomain ?? 'blocked.example.invalid',
                ],
              },
            }),
            peer.close,
          );
        } catch (error) {
          await peer.close();
          throw error;
        }
      },
    });
  };
  try {
    const first = await agent.session({ environment: source() });
    let a: ManagedWorkspaceCheckpoint;
    try {
      await first.saveState();
      expect(
        (await (await first.submit('Remember A')).wait()).finalOutput,
      ).toBe('A remembered');
      a = await first.suspendWorkspace();
    } finally {
      await first.close();
    }
    const pathA = (a.workspace.providerState.snapshot as { path: string }).path;
    expect(await readFile(join(pathA, 'value'), 'utf8')).toBe('A');
    // Ordinary state keeps its historical strict executor policy equality.
    await expect(
      agent.session({ state: a.conversation, environment: source(a) }),
    ).rejects.toThrow(/recorded executor write and network policy/);
    await expect(
      agent.session({ state: a, environment: source(a, { readOnly: true }) }),
    ).rejects.toThrow(/read-only/);
    // This trusted expected value has been coming directly from SDK capture,
    // independently of the imported bytes under test.
    const importedA = ManagedWorkspaceCheckpoint.fromJSON(JSON.stringify(a));
    await expect(
      agent.session({ state: importedA, environment: source(a) }),
    ).rejects.toThrow(/trusted.*checkpoint/);
    const modelRequests = server.requests.length;
    await expect(
      agent.session({
        state: importedA,
        environment: source(a, {
          deniedDomain: 'different.example.invalid',
          trustedExpected: a,
        }),
      }),
    ).rejects.toThrow(
      'Checkpoint and Environment must agree on the network policy',
    );
    expect(server.requests).toHaveLength(modelRequests);
    const defaultAgent = new Agent({
      provider,
      model: 'gpt-5',
      instructions: 'Keep the workspace.',
      environment: source(a, { trustedExpected: a }),
    });
    {
      await using restoredDefault = await defaultAgent.session({
        state: importedA,
      });
      expect(await readFile(join(workspace, 'value'), 'utf8')).toBe('A');
      const restoredItems = [];
      for await (const item of restoredDefault.items())
        restoredItems.push(item);
      expect(JSON.stringify(restoredItems)).toContain('A remembered');
    }
    await expect(
      defaultAgent.session({
        state: importedA,
        environment: source(a, { readOnly: true, trustedExpected: a }),
      }),
    ).rejects.toThrow(/read-only/);
    const mismatchedDefault = new Agent({
      provider,
      model: 'gpt-5',
      instructions: 'Keep the workspace.',
      environment: source(a, { readOnly: true, trustedExpected: a }),
    });
    {
      await using restoredOverride = await mismatchedDefault.session({
        state: importedA,
        environment: source(a, { trustedExpected: a }),
      });
      expect(await readFile(join(workspace, 'value'), 'utf8')).toBe('A');
    }
    expect(server.requests).toHaveLength(modelRequests);
    const second = await agent.session({
      state: importedA,
      environment: source(a, { trustedExpected: a }),
    });
    let b: ManagedWorkspaceCheckpoint;
    try {
      expect(await readFile(join(workspace, 'value'), 'utf8')).toBe('A');
      const restoredItems = [];
      for await (const item of second.items()) restoredItems.push(item);
      expect(JSON.stringify(restoredItems)).toContain('A remembered');
      await writeFile(join(workspace, 'value'), 'B');
      b = await second.suspendWorkspace();
    } finally {
      await second.close();
    }
    expect(b.workspaceJson).not.toBe(a.workspaceJson);
    expect(b.conversation.executor_policy_digest).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(join(pathA, 'value'), 'utf8')).toBe('A');
    const restoredB = await agent.session({ state: b, environment: source(b) });
    try {
      expect(await readFile(join(workspace, 'value'), 'utf8')).toBe('B');
    } finally {
      await restoredB.close();
    }
    const third = await agent.session({ state: a, environment: source(a) });
    try {
      expect(await readFile(join(workspace, 'value'), 'utf8')).toBe('A');
    } finally {
      await third.close();
    }
    // A competing close joins the same retirement while provider capture awaits.
    let entered!: () => void, release!: () => void;
    const capturing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    beforeSerialize = async () => {
      entered();
      await gate;
    };
    const racing = await agent.session({ environment: source() });
    const capture = racing.suspendWorkspace();
    await capturing;
    const closing = racing.close();
    await expect(
      racing.submit('Do not start during retirement'),
    ).rejects.toThrow();
    release();
    expect(await capture).toBeInstanceOf(ManagedWorkspaceCheckpoint);
    await closing;

    // Falsy callback failures still retire the working resource without a pair.
    beforeSerialize = async () => {
      throw false;
    };
    const failing = await agent.session({ environment: source() });
    const failedRoot = workspace;
    let published: ManagedWorkspaceCheckpoint | undefined;
    let failure: unknown;
    await failing.suspendWorkspace().then(
      (pair) => {
        published = pair;
      },
      (error) => {
        failure = error;
      },
    );
    expect(published).toBeUndefined();
    expect(failure).toMatchObject({ cause: false });
    await expect(failing.close()).rejects.toBe(failure);
    await expect(readFile(join(failedRoot, 'value'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}, 30_000);

it('retires two native Sessions independently when reusing one fresh managed source', async () => {
  const base = await mkdtemp(join(tmpdir(), 'managed-reused-'));
  const server = new ModelServer([]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-provider',
    supportsWebsockets: false,
  });
  const peer = await startPublicExecutor();
  const roots: string[] = [];
  const client = new UnixLocalSandboxClient({ workspaceBaseDir: base });
  const shared = sandboxEnvironment({
    client,
    managedWorkspace: true,
    snapshot: { type: 'local', baseDir: join(base, 'archives') },
    manifest: new Manifest({
      entries: { value: { type: 'file', content: 'initial' } },
    }),
    connect: async (sandbox) => {
      const root = sandbox.state.workspaceRootPath;
      roots.push(root);
      return Environment.lease(
        new Environment({
          url: peer.url,
          headers: peer.headers,
          cwd: root,
          tools: [],
        }),
        async () => {},
      );
    },
  });
  const agent = new Agent({
    provider,
    model: 'gpt-5',
    instructions: 'Keep each workspace.',
  });
  let first: Awaited<ReturnType<typeof agent.session>> | undefined;
  let second: Awaited<ReturnType<typeof agent.session>> | undefined;
  try {
    first = await agent.session({ environment: shared });
    second = await agent.session({ environment: shared });
    await writeFile(join(roots[0], 'value'), 'A');
    await writeFile(join(roots[1], 'value'), 'B');
    const a = await first.suspendWorkspace();
    await second.saveState();
    const b = await second.suspendWorkspace();
    expect(b.conversation.source_session_id).not.toBe(
      a.conversation.source_session_id,
    );
    expect(
      await readFile(
        join(
          (a.workspace.providerState.snapshot as { path: string }).path,
          'value',
        ),
        'utf8',
      ),
    ).toBe('A');
    expect(
      await readFile(
        join(
          (b.workspace.providerState.snapshot as { path: string }).path,
          'value',
        ),
        'utf8',
      ),
    ).toBe('B');
    await expect(readFile(join(roots[1], 'value'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await first.suspendWorkspace()).toBe(a);
  } finally {
    await second?.close();
    await first?.close();
    await peer.close();
    await rm(base, { recursive: true, force: true });
  }
}, 30_000);
