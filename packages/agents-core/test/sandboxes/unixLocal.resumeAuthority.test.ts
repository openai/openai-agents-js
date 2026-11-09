import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as filesystem from 'node:fs/promises';
import { realpathSync } from 'node:fs';
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
import * as snapshots from '../../src/sandbox/sandboxes/shared/localSnapshots';
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

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
}));

let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'unix-resume-authority-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(base, { recursive: true, force: true });
});

it.each(['materializeEntry', 'applyManifest'] as const)(
  'retries serialization after %s overlaps snapshot replacement',
  async (mutation) => {
    const { client, session, snapshotPath } = await fixture();
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const remove = filesystem.rm;
    vi.spyOn(filesystem, 'rm').mockImplementation(async (path, options) => {
      if (path === snapshotPath) {
        entered();
        await released;
      }
      return remove(path, options);
    });
    const pending = client.serializeSessionState(session.state);
    const rejected = expect(pending).rejects.toThrow(/manifest changed/);
    try {
      await Promise.race([
        waiting,
        pending.then(() => {
          throw new Error('Snapshot cleanup was not observed');
        }),
      ]);
      const entry = { type: 'file' as const, content: 'changed' };
      if (mutation === 'materializeEntry') {
        await session.materializeEntry({ path: 'changed.txt', entry });
      } else {
        await session.applyManifest(
          new Manifest({ entries: { 'changed.txt': entry } }),
        );
      }
      release();
      await rejected;
      await expect(
        client.serializeSessionState(session.state),
      ).resolves.toMatchObject({
        snapshot: { type: 'local' },
      });
      const resumed = await client.resume(session.state);
      expect(
        Buffer.from(await resumed.readFile({ path: 'changed.txt' })).toString(),
      ).toBe('changed');
      await resumed.close();
    } finally {
      release();
      await pending.catch(() => {});
      await session.close();
    }
  },
);

it('keeps a failed copied serialization stale while its original can recover', async () => {
  const { client, session, snapshotPath } = await fixture();
  const copied = rebindPersistedPathGrants(
    session.state,
    session.state.manifest,
  );
  const barrier = holdSnapshotRemoval(snapshotPath);
  const pending = client.serializeSessionState(copied);
  const rejected = expect(pending).rejects.toThrow(/manifest changed/);
  try {
    await barrier.entered;
    await session.materializeEntry({
      path: 'changed.txt',
      entry: { type: 'file', content: 'changed' },
    });
    barrier.release();
    await rejected;
    await expect(client.serializeSessionState(copied)).rejects.toThrow(
      /manifest changed/,
    );
    await expect(client.resume(copied)).rejects.toThrow(/manifest changed/);
    expect(() =>
      rebindPersistedPathGrants(copied, session.state.manifest),
    ).toThrow(/manifest changed/);
    await expect(
      client.serializeSessionState(session.state),
    ).resolves.toMatchObject({ snapshot: { type: 'local' } });
  } finally {
    barrier.release();
    await pending.catch(() => {});
    await session.close();
  }
});

it('does not grant parsed state authority when a bound serialization is rejected', async () => {
  const { client, session, saved, snapshotPath } = await fixture();
  const state = await client.deserializeSessionState(saved);
  const bound = boundSerializationClient(
    session.state.workspaceRootPath,
    snapshotPath,
  );
  const barrier = holdSnapshotRemoval(snapshotPath);
  const pending = bound.serializeSessionState(state);
  const rejected = expect(pending).rejects.toThrow(/manifest changed/);
  try {
    await barrier.entered;
    await withExclusiveSandboxManifestMutation(state, async () => {});
    barrier.release();
    await rejected;
    await expect(client.resume(state)).rejects.toThrow(
      /trusted resumeAuthority/,
    );
    const copied = rebindPersistedPathGrants(state, state.manifest);
    await expect(client.resume(copied)).rejects.toThrow(
      /trusted resumeAuthority/,
    );
    await expect(bound.serializeSessionState(state)).resolves.toMatchObject({
      snapshot: { type: 'local' },
    });
  } finally {
    barrier.release();
    await pending.catch(() => {});
    await session.close();
  }
});

it('keeps the new SDK snapshot authorized when old snapshot cleanup fails', async () => {
  const { client, session, snapshotPath } = await fixture();
  const remove = filesystem.rm;
  let fail = true;
  vi.spyOn(filesystem, 'rm').mockImplementation(async (path, options) => {
    if (path === snapshotPath && fail) {
      fail = false;
      throw new Error('old snapshot cleanup failed');
    }
    return remove(path, options);
  });
  try {
    await expect(client.serializeSessionState(session.state)).rejects.toThrow(
      'old snapshot cleanup failed',
    );
    expect(await stat(snapshotPath)).toBeTruthy();
    await expect(
      client.serializeSessionState(session.state),
    ).resolves.toMatchObject({ snapshot: { type: 'local' } });
  } finally {
    await session.close();
  }
});

it('does not advance authority when snapshot assignment fails', async () => {
  const { client, session, snapshotPath } = await fixture();
  Object.defineProperty(session.state, 'snapshot', { writable: false });
  try {
    await expect(client.serializeSessionState(session.state)).rejects.toThrow(
      /read only|readonly/,
    );
    expect(session.state.snapshot).toMatchObject({ path: snapshotPath });
    expect(await stat(snapshotPath)).toBeTruthy();
    Object.defineProperty(session.state, 'snapshot', { writable: true });
    await expect(
      client.serializeSessionState(session.state),
    ).resolves.toMatchObject({ snapshot: { type: 'local' } });
  } finally {
    Object.defineProperty(session.state, 'snapshot', { writable: true });
    await session.close();
  }
});

it.each(['live', 'parsed'] as const)(
  'invalidates the caller when a %s publication observer fails',
  async (kind) => {
    const { client, session, saved, snapshotPath } = await fixture();
    const state =
      kind === 'live'
        ? session.state
        : await client.deserializeSessionState(saved);
    const serializer =
      kind === 'live'
        ? client
        : boundSerializationClient(
            session.state.workspaceRootPath,
            snapshotPath,
          );
    const persist = snapshots.persistLocalSnapshot;
    vi.spyOn(snapshots, 'persistLocalSnapshot').mockImplementationOnce(
      (provider, current, spec, capture, observer) =>
        persist(provider, current, spec, capture, (published) => {
          observer?.(published);
          throw new Error('publication observer failed');
        }),
    );
    try {
      await expect(serializer.serializeSessionState(state)).rejects.toThrow(
        'publication observer failed',
      );
      expect(await stat(snapshotPath)).toBeTruthy();
      await expect(client.resume(state)).rejects.toThrow(/unavailable/);
      await expect(serializer.serializeSessionState(state)).rejects.toThrow(
        /unavailable/,
      );
      if (kind === 'parsed') {
        // Rebinding untrusted bytes must not transfer a failed operation's capability.
        const copied = rebindPersistedPathGrants(state, state.manifest);
        await expect(client.resume(copied)).rejects.toThrow(
          /trusted resumeAuthority/,
        );
      }
    } finally {
      await session.close();
    }
  },
);

it('pins previous cleanup and output policy before asynchronous capture', async () => {
  const { client, session, snapshotPath, victim } = await fixture();
  const barrier = holdSnapshotRead(
    join(session.state.workspaceRootPath, 'note.txt'),
  );
  const pending = client.serializeSessionState(session.state);
  const forbiddenBase = join(victim, 'untrusted-output');
  try {
    await barrier.entered;
    if (session.state.snapshot?.type !== 'local')
      throw new Error('Expected local snapshot');
    session.state.snapshot.path = victim;
    Object.assign(session.state.snapshotSpec!, { baseDir: forbiddenBase });
    barrier.release();
    const saved = await pending;
    expect(await readFile(join(victim, 'secret.txt'), 'utf8')).toBe(
      'synthetic host data',
    );
    await expect(stat(snapshotPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(forbiddenBase)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((saved.snapshot as { path: string }).path.startsWith(base)).toBe(
      true,
    );
  } finally {
    barrier.release();
    await pending.catch(() => {});
    await session.close();
  }
});

it('does not capture a snapshot path changed by public-state publication', async () => {
  const { client, session, victim } = await fixture();
  const descriptor = Object.getOwnPropertyDescriptor(
    session.state,
    'snapshot',
  )!;
  let value = session.state.snapshot;
  let createdPath: string | undefined;
  Object.defineProperty(session.state, 'snapshot', {
    configurable: true,
    enumerable: true,
    get: () => value,
    set: (next) => {
      value = next;
      if (next?.type === 'local') {
        createdPath = next.path;
        next.path = victim;
      }
    },
  });
  try {
    await expect(client.serializeSessionState(session.state)).rejects.toThrow(
      /localSnapshotPath/,
    );
    await expect(client.resume(session.state)).rejects.toThrow(
      /localSnapshotPath/,
    );
    expect(await readFile(join(victim, 'secret.txt'), 'utf8')).toBe(
      'synthetic host data',
    );
    if (value?.type !== 'local' || !createdPath)
      throw new Error('Expected published local snapshot');
    value.path = createdPath;
    Object.defineProperty(session.state, 'snapshot', { ...descriptor, value });
    await expect(
      client.serializeSessionState(session.state),
    ).resolves.toMatchObject({ snapshot: { type: 'local' } });
  } finally {
    Object.defineProperty(session.state, 'snapshot', { ...descriptor, value });
    await session.close();
  }
});

it('does not capture snapshot paths changed during parsed-input propagation', async () => {
  const { client, session, saved, snapshotPath, victim } = await fixture();
  const state = await client.deserializeSessionState(saved);
  const bound = boundSerializationClient(
    session.state.workspaceRootPath,
    snapshotPath,
  );
  let value = state.snapshot;
  Object.defineProperty(state, 'snapshot', {
    configurable: true,
    get: () => value,
    set: (next) => {
      value = next;
      if (next?.type === 'local') next.path = victim;
    },
  });
  try {
    await bound.serializeSessionState(state);
    await expect(client.resume(state)).rejects.toThrow(/localSnapshotPath/);
    expect(await readFile(join(victim, 'secret.txt'), 'utf8')).toBe(
      'synthetic host data',
    );
  } finally {
    await session.close();
  }
});

it('retains trusted cleanup ownership through parsed-input setters', async () => {
  const { client, session, saved, snapshotPath } = await fixture();
  const root = session.state.workspaceRootPath;
  const state = await client.deserializeSessionState(saved);
  const bound = boundSerializationClient(root, snapshotPath);
  let value = state.snapshot;
  Object.defineProperty(state, 'snapshot', {
    configurable: true,
    get: () => value,
    set: (next) => {
      value = next;
      state.workspaceRootOwned = true;
    },
  });
  try {
    await bound.serializeSessionState(state);
    const resumed = await client.resume(state);
    await resumed.close();
    expect(await stat(root)).toBeTruthy();
  } finally {
    await session.close();
  }
});

it('does not mint authority after reentrant parsed-input propagation', async () => {
  const { client, session, saved, snapshotPath } = await fixture();
  const state = await client.deserializeSessionState(saved);
  const bound = boundSerializationClient(
    session.state.workspaceRootPath,
    snapshotPath,
  );
  let value = state.snapshot;
  let mutation: Promise<void> | undefined;
  Object.defineProperty(state, 'snapshot', {
    configurable: true,
    get: () => value,
    set: (next) => {
      value = next;
      mutation = withExclusiveSandboxManifestMutation(state, async () => {});
    },
  });
  try {
    await expect(bound.serializeSessionState(state)).rejects.toThrow(
      /manifest changed/,
    );
    await mutation;
    await expect(client.resume(state)).rejects.toThrow(
      /trusted resumeAuthority/,
    );
    await expect(
      client.resume(rebindPersistedPathGrants(state, state.manifest)),
    ).rejects.toThrow(/trusted resumeAuthority/);
  } finally {
    await mutation;
    await session.close();
  }
});

it('propagates the approved root rather than recapturing changed parsed input', async () => {
  const { client, session, saved, snapshotPath, victim } = await fixture();
  const root = session.state.workspaceRootPath;
  const state = await client.deserializeSessionState(saved);
  const bound = boundSerializationClient(root, snapshotPath);
  const barrier = holdSnapshotRead(join(root, 'note.txt'));
  const pending = bound.serializeSessionState(state);
  try {
    await barrier.entered;
    state.workspaceRootPath = victim;
    barrier.release();
    await pending;
    expect(state.workspaceRootPath).toBe(root);
    expect(await readFile(join(victim, 'secret.txt'), 'utf8')).toBe(
      'synthetic host data',
    );
    const resumed = await client.resume(state);
    expect(
      Buffer.from(await resumed.readFile({ path: 'note.txt' })).toString(),
    ).toBe('snapshot contents');
    await resumed.close();
  } finally {
    barrier.release();
    await pending.catch(() => {});
    await session.close();
  }
});

it('rejects a live workspace path changed during snapshot capture', async () => {
  const { client, session, victim } = await fixture();
  const root = session.state.workspaceRootPath;
  const barrier = holdSnapshotRead(join(root, 'note.txt'));
  const pending = client.serializeSessionState(session.state);
  const rejected = expect(pending).rejects.toThrow(
    /workspace path does not match/,
  );
  try {
    await barrier.entered;
    session.state.workspaceRootPath = victim;
    barrier.release();
    await rejected;
    await expect(client.resume(session.state)).rejects.toThrow(
      /workspace path does not match/,
    );
    expect(await readFile(join(victim, 'secret.txt'), 'utf8')).toBe(
      'synthetic host data',
    );
    session.state.workspaceRootPath = root;
    await expect(
      client.serializeSessionState(session.state),
    ).resolves.toMatchObject({ snapshot: { type: 'local' } });
  } finally {
    barrier.release();
    await pending.catch(() => {});
    session.state.workspaceRootPath = root;
    await session.close();
  }
});

it.each(['live', 'copied'] as const)(
  'pins the approved %s workspace during resume',
  async (kind) => {
    const { client, session, victim } = await fixture();
    const root = session.state.workspaceRootPath;
    const state =
      kind === 'live'
        ? session.state
        : rebindPersistedPathGrants(session.state, session.state.manifest);
    const pending = client.resume(state);
    state.workspaceRootPath = victim;
    let resumed: UnixLocalSandboxSession | undefined;
    try {
      resumed = await pending;
      expect(resumed.state.workspaceRootPath).toBe(root);
      expect(await readFile(join(victim, 'secret.txt'), 'utf8')).toBe(
        'synthetic host data',
      );
      expect(
        Buffer.from(await resumed.readFile({ path: 'note.txt' })).toString(),
      ).toBe('snapshot contents');
    } finally {
      await resumed?.close();
      await session.close();
    }
  },
);

it.each([
  ['live', false],
  ['live', true],
  ['parsed', false],
  ['parsed', true],
  ['copied', false],
  ['copied', true],
] as const)(
  'pins the approved %s snapshot during resume (drift: %s)',
  async (kind, drift) => {
    const { client, session, saved, snapshotPath, victim } = await fixture();
    const root = session.state.workspaceRootPath;
    const state =
      kind === 'parsed'
        ? await client.deserializeSessionState(saved)
        : kind === 'copied'
          ? rebindPersistedPathGrants(session.state, session.state.manifest)
          : session.state;
    if (drift) await writeFile(join(root, 'note.txt'), 'workspace drift');
    const pending =
      kind === 'parsed'
        ? boundSerializationClient(root, snapshotPath).resume(state)
        : client.resume(state);
    if (state.snapshot?.type !== 'local')
      throw new Error('Expected local snapshot');
    state.snapshot.path = victim;
    let resumed: UnixLocalSandboxSession | undefined;
    try {
      resumed = await pending;
      expect(resumed.state.snapshot).toMatchObject({ path: snapshotPath });
      expect(
        Buffer.from(await resumed.readFile({ path: 'note.txt' })).toString(),
      ).toBe('snapshot contents');
      await expect(stat(join(root, 'secret.txt'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(await readFile(join(victim, 'secret.txt'), 'utf8')).toBe(
        'synthetic host data',
      );
    } finally {
      await resumed?.close();
      await session.close();
    }
  },
);

it('pins manifest mount sources during asynchronous resume', async () => {
  const source = join(base, 'mount-source');
  const victim = join(base, 'mount-victim');
  await mkdir(source);
  await mkdir(victim);
  await writeFile(join(source, 'note.txt'), 'approved mount');
  await writeFile(join(victim, 'secret.txt'), 'synthetic host data');
  const client = new UnixLocalSandboxClient({
    workspaceBaseDir: base,
    snapshot: { type: 'local', baseDir: base },
  });
  const session = await client.create(
    new Manifest({
      entries: {
        mount: {
          type: 'mount',
          source,
          readOnly: false,
          mountStrategy: { type: 'local_bind' },
        },
      },
    }),
  );
  await client.serializeSessionState(session.state);
  await writeFile(join(session.state.workspaceRootPath, 'drift.txt'), 'drift');
  const pending = client.resume(session.state);
  (session.state.manifest.entries.mount as { source: string }).source = victim;
  let resumed: UnixLocalSandboxSession | undefined;
  try {
    resumed = await pending;
    expect(
      Buffer.from(
        await resumed.readFile({ path: 'mount/note.txt' }),
      ).toString(),
    ).toBe('approved mount');
    await expect(
      resumed.readFile({ path: 'mount/secret.txt' }),
    ).rejects.toThrow();
  } finally {
    await resumed?.close();
    await session.close();
  }
});

it('pins trusted resume policy and cleanup ownership before awaiting', async () => {
  const { client, session, victim } = await fixture();
  const root = session.state.workspaceRootPath;
  const pending = client.resume(session.state);
  session.state.workspaceRootOwned = false;
  if (session.state.snapshotSpec?.type === 'local')
    session.state.snapshotSpec.baseDir = victim;
  let resumed: UnixLocalSandboxSession | undefined;
  try {
    resumed = await pending;
    expect(resumed.state.workspaceRootOwned).toBe(true);
    expect(resumed.state.snapshotSpec).toEqual({
      type: 'local',
      baseDir: base,
    });
    await resumed.close();
    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(victim, 'secret.txt'), 'utf8')).toBe(
      'synthetic host data',
    );
  } finally {
    await resumed?.close();
    await session.close();
  }
});

it('replaces the preceding local snapshot when serialization calls overlap', async () => {
  const { client, session } = await fixture();
  const barrier = holdSnapshotRead(
    join(session.state.workspaceRootPath, 'note.txt'),
  );
  const first = client.serializeSessionState(session.state);
  try {
    await barrier.entered;
    const second = client.serializeSessionState(session.state);
    barrier.release();
    const [previous, latest] = await Promise.all([first, second]);
    await expect(
      stat((previous.snapshot as { path: string }).path),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(session.state.snapshot).toEqual(latest.snapshot);
    expect(await stat((latest.snapshot as { path: string }).path)).toBeTruthy();
  } finally {
    barrier.release();
    await first.catch(() => {});
    await session.close();
  }
});

function boundSerializationClient(
  workspaceRootPath: string,
  localSnapshotPath: string,
) {
  return new UnixLocalSandboxClient({
    snapshot: { type: 'local', baseDir: base },
    resumeAuthority: { workspaceRootPath, localSnapshotPath },
  });
}

function holdSnapshotRemoval(target: string) {
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const remove = filesystem.rm;
  vi.spyOn(filesystem, 'rm').mockImplementation(async (path, options) => {
    if (path === target) {
      enter();
      await released;
    }
    return remove(path, options);
  });
  return { entered, release };
}

function holdSnapshotRead(target: string) {
  const physicalTarget = realpathSync(target);
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const open = filesystem.open;
  vi.spyOn(filesystem, 'open').mockImplementation(async (...args) => {
    if (args[0] === target || args[0] === physicalTarget) {
      enter();
      await released;
    }
    return open(...args);
  });
  return { entered, release };
}

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
