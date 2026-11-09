import { afterEach, beforeEach, expect, it } from 'vitest';
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
  InMemoryRemoteSnapshotStore,
  NoopSnapshotSpec,
} from '../../src/sandbox/local';
import { markRunStateSessionState } from '../../src/sandbox/internal/sessionStateTrust';

let base: string;
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'unix-resume-authority-'));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
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
