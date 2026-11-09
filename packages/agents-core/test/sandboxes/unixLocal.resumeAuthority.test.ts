import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Manifest,
  UnixLocalSandboxClient,
  UnixLocalSandboxSession,
  InMemoryRemoteSnapshotStore,
  NoopSnapshotSpec,
  SandboxAgent,
  shell,
} from '../../src/sandbox/local';
import { Runner } from '../../src';
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
} from '../../src/testing';
import { markRunStateSessionState } from '../../src/sandbox/internal/sessionStateTrust';
import {
  rebindPersistedMountCredentials,
  rebindPersistedPathGrants,
} from '../../src/sandbox/sandboxes/shared/manifestPersistence';
import {
  captureSandboxStateGeneration,
  assertSandboxStateGenerationUnchanged,
  markSandboxSessionStateUnsafe,
  withExclusiveSandboxManifestMutation,
} from '../../src/sandbox/mountSecurity';

let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'unix-resume-authority-'));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

it.each(['created', 'resumed'])(
  'resumes %s live SDK state through the Runner explicit session-state path',
  async (kind) => {
    const grant = join(base, 'grant');
    await mkdir(grant);
    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: base,
      snapshot: new NoopSnapshotSpec(),
    });
    const manifest = new Manifest({
      entries: { 'sentinel.txt': { type: 'file', content: 'live sentinel' } },
      extraPathGrants: [{ path: grant, readOnly: true }],
    });
    const session = await client.create(manifest);
    const live =
      kind === 'created'
        ? session
        : await client.resume(
            await client.deserializeSessionState(
              JSON.parse(
                JSON.stringify(
                  await client.serializeSessionState(session.state),
                ),
              ),
            ),
            {
              clientOptions: {
                resumeAuthority: {
                  workspaceRootPath: session.state.workspaceRootPath,
                },
              },
            },
          );
    const model = new ScriptedModel([
      [
        functionCall(
          'exec_command',
          {
            cmd: 'cat sentinel.txt',
            shell: '/bin/sh',
            login: false,
            yield_time_ms: 500,
          },
          { callId: 'read' },
        ),
      ],
      [assistantMessage('done')],
    ]);
    const agent = new SandboxAgent({
      name: 'LiveResume',
      model,
      defaultManifest: manifest,
      capabilities: [shell()],
    });
    try {
      const result = await new Runner({ tracingDisabled: true }).run(
        agent,
        'read the sentinel',
        { sandbox: { client, sessionState: live.state } },
      );
      expect(JSON.stringify(result.history)).toContain('live sentinel');
      expect(result.finalOutput).toBe('done');
    } finally {
      await live.close();
      await session.close();
    }
  },
);

it.each([false, true])(
  'does not grant Runner authority to parsed state (tampered: %s)',
  async (tampered) => {
    const { client, session, saved, victim } = await fixture();
    const state = await client.deserializeSessionState(
      tampered
        ? {
            ...saved,
            workspaceRootPath: victim,
            workspaceRootOwned: true,
            snapshot: null,
          }
        : saved,
    );
    const model = new ScriptedModel([[assistantMessage('must not run')]]);
    const agent = new SandboxAgent({
      name: 'ParsedResume',
      model,
      defaultManifest: session.state.manifest,
      capabilities: [shell()],
    });
    try {
      await expect(
        new Runner({ tracingDisabled: true }).run(agent, 'read', {
          sandbox: { client, sessionState: state },
        }),
      ).rejects.toThrow(/trusted resumeAuthority/);
      expect(model.calls).toHaveLength(0);
      expect(await readFile(join(victim, 'secret.txt'), 'utf8')).toBe(
        'synthetic host data',
      );
    } finally {
      await session.close();
    }
  },
);

it.each(['root', 'snapshot'])(
  'retains captured path checks on live SDK copies (%s)',
  async (field) => {
    const { client, session, victim } = await fixture();
    const copied = rebindPersistedPathGrants(
      rebindPersistedMountCredentials(session.state, session.state.manifest),
      session.state.manifest,
    );
    if (field === 'root') copied.workspaceRootPath = victim;
    else copied.snapshot = { type: 'local', id: 'forged', path: victim };
    await expect(client.resume(copied)).rejects.toThrow(
      /trusted resumeAuthority/,
    );
    expect(await readFile(join(victim, 'secret.txt'), 'utf8')).toBe(
      'synthetic host data',
    );
    await session.close();
  },
);

it.each(['source', 'copy'])(
  'rejects %s mutation during asynchronous Runner preparation',
  async (mutator) => {
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manifest = new Manifest();
    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: base,
      snapshot: new NoopSnapshotSpec(),
    });
    const source = await client.create(manifest);
    const copiedState = rebindPersistedPathGrants(
      rebindPersistedMountCredentials(source.state, manifest),
      manifest,
    );
    const copied = new UnixLocalSandboxSession({ state: copiedState });
    const model = new ScriptedModel([[assistantMessage('must not run')]]);
    const agent = new SandboxAgent({
      name: 'ConcurrentResume',
      model,
      defaultManifest: manifest,
      capabilities: [shell()],
    });
    const resume = client.resume.bind(client);
    vi.spyOn(client, 'resume').mockImplementationOnce(async (...args) => {
      entered();
      await released;
      return resume(...args);
    });
    const pending = new Runner({ tracingDisabled: true }).run(agent, 'resume', {
      sandbox: { client, sessionState: copied.state },
    });
    const rejected = expect(pending).rejects.toThrow(/manifest changed/);
    try {
      await Promise.race([
        waiting,
        pending.then(() => {
          throw new Error('Runner completed before resume preparation');
        }),
      ]);
      await (mutator === 'source' ? source : copied).materializeEntry({
        path: 'changed.txt',
        entry: { type: 'file', content: 'changed' },
      });
      release();
      await rejected;
      expect(model.calls).toHaveLength(0);
    } finally {
      release();
      await pending.catch(() => {});
      await copied.close();
      await source.close();
    }
  },
);

it.each([true, false])(
  'cleans only fresh workspaces after a resume-generation failure (fresh: %s)',
  async (fresh) => {
    const store = new InMemoryRemoteSnapshotStore();
    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: base,
      snapshot: { type: 'remote', store },
    });
    const source = await client.create(
      new Manifest({
        entries: { 'note.txt': { type: 'file', content: 'saved' } },
      }),
    );
    await client.serializeSessionState(source.state);
    const originalRoot = source.state.workspaceRootPath;
    if (fresh) await rm(originalRoot, { recursive: true, force: true });
    else await writeFile(join(originalRoot, 'note.txt'), 'drift');
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const load = store.load.bind(store);
    vi.spyOn(store, 'load').mockImplementationOnce(async (...args) => {
      entered();
      await released;
      return load(...args);
    });
    const pending = client.resume(source.state);
    const rejected = expect(pending).rejects.toThrow(/manifest changed/);
    try {
      await Promise.race([
        waiting,
        pending.then(() => {
          throw new Error('Resume completed before snapshot load');
        }),
      ]);
      expect(await readdir(base)).toHaveLength(1);
      await withExclusiveSandboxManifestMutation(source.state, async () => {});
      release();
      await rejected;
      if (fresh) expect(await readdir(base)).toEqual([]);
      else expect(await stat(originalRoot)).toBeTruthy();
    } finally {
      release();
      await pending.catch(() => {});
      await source.close();
    }
  },
);

it('shares pending mutation and unsafe-state rejection across live copies', async () => {
  const { client, session } = await fixture();
  const copied = rebindPersistedPathGrants(
    session.state,
    session.state.manifest,
  );
  const generation = captureSandboxStateGeneration(session.state);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const mutation = withExclusiveSandboxManifestMutation(copied, () => blocked);
  await expect(client.resume(session.state)).rejects.toThrow(
    /mutation is in progress/,
  );
  release();
  await mutation;
  expect(() =>
    assertSandboxStateGenerationUnchanged(session.state, generation),
  ).toThrow(/manifest changed/);
  expect(() =>
    rebindPersistedPathGrants(copied, session.state.manifest),
  ).toThrow(/manifest changed/);
  markSandboxSessionStateUnsafe(copied);
  await expect(session.readFile({ path: 'note.txt' })).rejects.toThrow(
    /unavailable/,
  );
  await expect(client.resume(copied)).rejects.toThrow(/unavailable/);
  await session.close();
});

async function fixture() {
  const client = new UnixLocalSandboxClient({
    workspaceBaseDir: base,
    snapshot: { type: 'local', baseDir: base },
  });
  const session = await client.create(
    new Manifest({
      entries: { 'note.txt': { type: 'file', content: 'snapshot contents' } },
    }),
  );
  const saved = JSON.parse(
    JSON.stringify(await client.serializeSessionState(session.state)),
  ) as Record<string, unknown>;
  if (session.state.snapshot?.type !== 'local')
    throw new Error('Expected local snapshot');
  const snapshotPath = session.state.snapshot.path;
  const victim = join(base, 'victim');
  await mkdir(victim);
  await writeFile(join(victim, 'secret.txt'), 'synthetic host data');
  return { client, session, saved, snapshotPath, victim };
}

it('rejects unbound saved roots through direct resume, RunState, and serialization', async () => {
  const { client, session, saved, victim } = await fixture();
  const state = await client.deserializeSessionState({
    ...saved,
    workspaceRootPath: victim,
    workspaceRootOwned: true,
    snapshot: null,
    snapshotSpec: { type: 'noop' },
  });
  await expect(client.resume(state)).rejects.toThrow(/trusted resumeAuthority/);
  await expect(client.resume(markRunStateSessionState(state))).rejects.toThrow(
    /trusted resumeAuthority/,
  );
  await expect(client.serializeSessionState(state)).rejects.toThrow(
    /trusted resumeAuthority/,
  );
  expect(await readFile(join(victim, 'secret.txt'), 'utf8')).toBe(
    'synthetic host data',
  );
  await session.close();
});

it('rejects forged workspace and snapshot paths before restoring or replacing contents', async () => {
  const { client, session, saved, snapshotPath, victim } = await fixture();
  const clientOptions = {
    resumeAuthority: {
      workspaceRootPath: session.state.workspaceRootPath,
      localSnapshotPath: snapshotPath,
    },
  };
  const forgedRoot = await client.deserializeSessionState({
    ...saved,
    workspaceRootPath: victim,
  });
  await expect(client.resume(forgedRoot, { clientOptions })).rejects.toThrow(
    /workspace path does not match/,
  );
  const forgedSnapshot = await client.deserializeSessionState({
    ...saved,
    snapshot: { type: 'local', id: 'forged', path: victim },
  });
  await expect(
    client.resume(forgedSnapshot, { clientOptions }),
  ).rejects.toThrow(/localSnapshotPath/);
  const boundClient = new UnixLocalSandboxClient(clientOptions);
  await expect(
    boundClient.serializeSessionState(forgedSnapshot),
  ).rejects.toThrow(/localSnapshotPath/);
  expect(await readdir(victim)).toEqual(['secret.txt']);
  expect(
    await readFile(join(session.state.workspaceRootPath, 'note.txt'), 'utf8'),
  ).toBe('snapshot contents');
  await session.close();
});

it('restores a bound local snapshot into a fresh private workspace with current snapshot policy', async () => {
  const { client, session, saved, snapshotPath, victim } = await fixture();
  await session.close();
  const forbiddenBase = join(victim, 'untrusted-snapshot-output');
  const state = await client.deserializeSessionState({
    ...saved,
    workspaceRootPath: victim,
    snapshotSpec: { type: 'local', baseDir: forbiddenBase },
  });
  const restored = await client.resume(state, {
    clientOptions: {
      workspaceBaseDir: base,
      snapshot: { type: 'local', baseDir: base },
      resumeAuthority: { localSnapshotPath: snapshotPath },
    },
  });
  expect(restored.state.workspaceRootPath).not.toBe(victim);
  expect(
    Buffer.from(await restored.readFile({ path: 'note.txt' })).toString(),
  ).toBe('snapshot contents');
  await client.serializeSessionState(restored.state);
  await client.serializeSessionState(restored.state);
  await expect(stat(forbiddenBase)).rejects.toMatchObject({ code: 'ENOENT' });
  await restored.close();
  expect(await readFile(join(victim, 'secret.txt'), 'utf8')).toBe(
    'synthetic host data',
  );
});

it('uses trusted cleanup ownership and pins cleanup even if public state changes', async () => {
  const { client, session, saved, snapshotPath, victim } = await fixture();
  const restored = await client.resume(
    await client.deserializeSessionState({
      ...saved,
      workspaceRootOwned: true,
    }),
    {
      clientOptions: {
        resumeAuthority: {
          workspaceRootPath: session.state.workspaceRootPath,
          localSnapshotPath: snapshotPath,
        },
      },
    },
  );
  await restored.close();
  expect(await stat(session.state.workspaceRootPath)).toBeTruthy();
  const ownedPath = session.state.workspaceRootPath;
  session.state.workspaceRootPath = victim;
  session.state.workspaceRootOwned = true;
  await session.close();
  await expect(stat(ownedPath)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(victim, 'secret.txt'), 'utf8')).toBe(
    'synthetic host data',
  );
});

it('restores remote RunState using its separate trusted snapshot configuration', async () => {
  const store = new InMemoryRemoteSnapshotStore();
  const snapshot = { type: 'remote' as const, store };
  const client = new UnixLocalSandboxClient({
    workspaceBaseDir: base,
    snapshot,
  });
  const session = await client.create(
    new Manifest({
      entries: { 'remote.txt': { type: 'file', content: 'remote data' } },
    }),
  );
  const saved = JSON.parse(
    JSON.stringify(await client.serializeSessionState(session.state)),
  );
  await session.close();
  const state = markRunStateSessionState(
    await new UnixLocalSandboxClient().deserializeSessionState(saved),
    { clientOptions: { workspaceBaseDir: base }, snapshot },
  );
  const restored = await new UnixLocalSandboxClient().resume(state);
  expect(
    Buffer.from(await restored.readFile({ path: 'remote.txt' })).toString(),
  ).toBe('remote data');
  await restored.close();
});

it('does not let mutable live state redirect snapshot creation', async () => {
  const { session, victim } = await fixture();
  const forbiddenBase = join(victim, 'untrusted-output');
  session.state.snapshotSpec = { type: 'local', baseDir: forbiddenBase };
  await new UnixLocalSandboxClient().serializeSessionState(session.state);
  await expect(stat(forbiddenBase)).rejects.toMatchObject({ code: 'ENOENT' });
  await session.close();
});

it.each(['create', 'resume'])(
  'detaches snapshot policy exposed by %s from the original client',
  async (entrypoint) => {
    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: base,
      snapshot: { type: 'local', baseDir: base },
    });
    let session = await client.create(new Manifest());
    if (entrypoint === 'resume') {
      const saved = await client.serializeSessionState(session.state);
      const resumeAuthority = {
        workspaceRootPath: session.state.workspaceRootPath,
        localSnapshotPath:
          session.state.snapshot?.type === 'local'
            ? session.state.snapshot.path
            : undefined,
      };
      session = await client.resume(
        await client.deserializeSessionState(saved),
        { clientOptions: { resumeAuthority } },
      );
    }

    const forbiddenBase = join(base, 'untrusted-output');
    Object.assign(session.state.snapshotSpec!, { baseDir: forbiddenBase });
    await client.serializeSessionState(session.state);
    await expect(stat(forbiddenBase)).rejects.toMatchObject({ code: 'ENOENT' });
    await session.close();
  },
);

it('retains snapshot replacement on explicitly bound state during repeated serialization', async () => {
  const { client, session, saved, snapshotPath } = await fixture();
  const state = await client.deserializeSessionState(saved);
  const bound = new UnixLocalSandboxClient({
    snapshot: { type: 'local', baseDir: base },
    resumeAuthority: {
      workspaceRootPath: session.state.workspaceRootPath,
      localSnapshotPath: snapshotPath,
    },
  });
  const first = await bound.serializeSessionState(state);
  expect(state.snapshot).toEqual(first.snapshot);
  const second = await bound.serializeSessionState(state);
  expect(state.snapshot).toEqual(second.snapshot);
  await expect(
    stat((first.snapshot as { path: string }).path),
  ).rejects.toMatchObject({ code: 'ENOENT' });
  await session.close();
});

it('preserves the trusted per-create snapshot policy over client defaults', async () => {
  const defaultBase = join(base, 'defaults');
  const selectedBase = join(base, 'selected');
  const client = new UnixLocalSandboxClient({
    workspaceBaseDir: base,
    snapshot: { type: 'local', baseDir: defaultBase },
  });
  const session = await client.create(new Manifest(), {
    snapshot: { type: 'local', baseDir: selectedBase },
  });
  const saved = await client.serializeSessionState(session.state);
  expect(saved.snapshotSpec).toEqual({ type: 'local', baseDir: selectedBase });
  expect(
    (saved.snapshot as { path: string }).path.startsWith(selectedBase + '/'),
  ).toBe(true);
  await expect(stat(defaultBase)).rejects.toMatchObject({ code: 'ENOENT' });
  await session.close();
});

it('preserves an explicit noop policy when another client serializes the session', async () => {
  const client = new UnixLocalSandboxClient({
    workspaceBaseDir: base,
    snapshot: new NoopSnapshotSpec(),
  });
  const session = await client.create(new Manifest());
  const forbiddenBase = join(base, 'other-client-output');
  const saved = await new UnixLocalSandboxClient({
    snapshot: { type: 'local', baseDir: forbiddenBase },
  }).serializeSessionState(session.state);
  expect(saved.snapshot).toBeNull();
  expect(saved.snapshotSpec).toEqual({ type: 'noop' });
  await expect(stat(forbiddenBase)).rejects.toMatchObject({ code: 'ENOENT' });
  await session.close();
});
