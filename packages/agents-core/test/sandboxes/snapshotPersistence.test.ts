import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DockerSandboxClient,
  type DockerSandboxSessionState,
} from '../../src/sandbox/sandboxes/docker';
import {
  UnixLocalSandboxClient,
  type UnixLocalSandboxSessionState,
} from '../../src/sandbox/sandboxes/unixLocal';
import { Manifest } from '../../src/sandbox/manifest';
import { InMemoryRemoteSnapshotStore } from '../../src/sandbox/snapshot';
import { rebindPersistedPathGrants } from '../../src/sandbox/sandboxes/shared/manifestPersistence';

let base: string;
const cleanup: Array<() => Promise<void>> = [];
const releases: Array<() => void> = [];
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'snapshot-persistence-'));
});
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const close of cleanup.splice(0)) await close();
  vi.restoreAllMocks();
  await rm(base, { recursive: true, force: true });
});

it.each(['unix', 'parsed', 'docker'] as const)(
  'replaces superseded remote snapshots for overlapping %s serialization',
  async (kind) => {
    const fixture = await createFixture(kind);
    const barrier = holdSave(fixture.store);
    const first = fixture.serialize();
    await barrier.entered;
    const second = fixture.serialize();
    barrier.release();
    const [previous, latest] = await Promise.all([first, second]);
    expect(fixture.state.snapshot).toEqual(latest.snapshot);
    expect(
      await fixture.store.exists({
        id: (previous.snapshot as { id: string }).id,
      }),
    ).toBe(false);
    expect(
      await fixture.store.exists({
        id: (latest.snapshot as { id: string }).id,
      }),
    ).toBe(true);
  },
);

it.each(['unix', 'parsed', 'docker'] as const)(
  'allows queued %s serialization after a rejected save',
  async (kind) => {
    const fixture = await createFixture(kind);
    const barrier = holdSave(fixture.store, true);
    const first = expect(fixture.serialize()).rejects.toThrow(
      'synthetic save failure',
    );
    await barrier.entered;
    const second = fixture.serialize();
    barrier.release();
    await first;
    const latest = await second;
    expect(fixture.state.snapshot).toEqual(latest.snapshot);
    expect(
      await fixture.store.exists({
        id: (latest.snapshot as { id: string }).id,
      }),
    ).toBe(true);
  },
);

it('retains separate snapshot streams for SDK copies sharing lifecycle identity', async () => {
  const fixture = await createFixture('unix');
  const copy = rebindPersistedPathGrants(fixture.state, fixture.state.manifest);
  const barrier = holdSave(fixture.store);
  const first = fixture.serialize();
  await barrier.entered;
  const copied = await fixture.serialize(copy);
  barrier.release();
  const original = await first;
  expect(original.snapshot).not.toEqual(copied.snapshot);
  expect(fixture.state.snapshot).toEqual(original.snapshot);
  expect(copy.snapshot).toEqual(copied.snapshot);
  for (const result of [original, copied])
    expect(
      await fixture.store.exists({
        id: (result.snapshot as { id: string }).id,
      }),
    ).toBe(true);
});

it('allows store callbacks to apply manifests without holding the mutation queue', async () => {
  const fixture = await createFixture('unix');
  const save = vi.mocked(fixture.store.save).getMockImplementation()!;
  vi.mocked(fixture.store.save).mockImplementationOnce(async (args) => {
    await fixture.session!.applyManifest(
      new Manifest({
        entries: { 'callback.txt': { type: 'file', content: 'callback data' } },
      }),
    );
    return await save(args);
  });
  await expect(fixture.serialize()).rejects.toThrow(/manifest changed/);
  await expect(fixture.serialize()).resolves.toMatchObject({
    snapshot: { type: 'remote' },
  });
});

async function createFixture(kind: 'unix' | 'parsed' | 'docker') {
  const store = new InMemoryRemoteSnapshotStore();
  const save = store.save.bind(store);
  let sequence = 0;
  vi.spyOn(store, 'save').mockImplementation((args) =>
    save({ ...args, id: `snapshot-${++sequence}` }),
  );
  const snapshot = { type: 'remote' as const, store };
  let state: UnixLocalSandboxSessionState;
  let serialize: (
    target?: UnixLocalSandboxSessionState,
  ) => Promise<Record<string, unknown>>;
  let session:
    Awaited<ReturnType<UnixLocalSandboxClient['create']>> | undefined;
  if (kind === 'docker') {
    const root = join(base, 'docker-workspace');
    await mkdir(root);
    const dockerState: DockerSandboxSessionState = {
      manifest: new Manifest(),
      workspaceRootPath: root,
      workspaceRootOwned: false,
      environment: {},
      snapshotSpec: snapshot,
      snapshot: null,
      image: 'unused',
      containerId: 'unused',
      dockerVolumeNames: [],
    };
    const client = new DockerSandboxClient({ snapshot });
    state = dockerState;
    serialize = (target = state) =>
      client.serializeSessionState(target as DockerSandboxSessionState);
    await serialize();
  } else {
    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: base,
      snapshot,
    });
    session = await client.create(new Manifest());
    cleanup.push(() => session!.close());
    const saved = await client.serializeSessionState(session.state);
    state =
      kind === 'parsed'
        ? await client.deserializeSessionState(saved)
        : session.state;
    const serializer =
      kind === 'parsed'
        ? new UnixLocalSandboxClient({
            snapshot,
            resumeAuthority: {
              workspaceRootPath: session.state.workspaceRootPath,
              remoteSnapshotId: session.state.snapshot!.id,
            },
          })
        : client;
    serialize = (target = state) => serializer.serializeSessionState(target);
  }
  return { state, serialize, store, session };
}

function holdSave(store: InMemoryRemoteSnapshotStore, fail = false) {
  const save = vi.mocked(store.save).getMockImplementation()!;
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  releases.push(release);
  vi.mocked(store.save).mockImplementationOnce(async (args) => {
    enter();
    await held;
    if (fail) throw new Error('synthetic save failure');
    return await save(args);
  });
  return { entered, release };
}
