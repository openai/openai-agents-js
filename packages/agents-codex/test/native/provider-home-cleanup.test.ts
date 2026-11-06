import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { NativeProvider, type ProviderLease } from '../../src/runtime/provider';

const fixture = vi.hoisted(() => ({
  root: '',
  rm: vi.fn<typeof import('node:fs/promises').rm>(),
  rmdir: vi.fn<typeof import('node:fs/promises').rmdir>(),
}));
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  tmpdir: () => fixture.root,
}));
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  rm: fixture.rm,
  rmdir: fixture.rmdir,
}));
let fs: typeof import('node:fs/promises');
const providers: NativeProvider[] = [];
const leases: ProviderLease[] = [];
function realRemoval() {
  fixture.rm.mockReset().mockImplementation((...args) => fs.rm(...args));
  fixture.rmdir.mockReset().mockImplementation((...args) => fs.rmdir(...args));
}
async function lease() {
  const provider = new NativeProvider({ apiKey: 'fixture' });
  providers.push(provider);
  const lease = provider._acquire();
  leases.push(lease);
  return { provider, lease, ...(await lease.open()) };
}
async function absent(path: string) {
  await expect(fs.lstat(path)).rejects.toMatchObject({ code: 'ENOENT' });
}
function denied() {
  return Object.assign(new Error('injected asynchronous removal failure'), {
    code: 'EACCES',
  });
}
beforeEach(async () => {
  fs =
    await vi.importActual<typeof import('node:fs/promises')>(
      'node:fs/promises',
    );
  const os = await vi.importActual<typeof import('node:os')>('node:os');
  fixture.root = await fs.mkdtemp(join(os.tmpdir(), 'provider-home-cleanup-'));
  realRemoval();
});
afterEach(async () => {
  realRemoval();
  try {
    await Promise.all(leases.map((lease) => lease.release()));
    await Promise.all(providers.map((provider) => provider.close()));
  } finally {
    leases.length = providers.length = 0;
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

it('removes the real default empty-workspace shape and keeps release idempotent', async () => {
  const { provider, lease: owner, codex_home: home } = await lease();
  await expect(fs.readdir(home)).resolves.toEqual(['workspace']);
  await owner.release();
  await absent(home);
  // A later release must not remove a new object reusing the old pathname.
  await fs.mkdir(home);
  await fs.writeFile(join(home, 'replacement'), 'keep');
  await owner.release();
  await expect(fs.readFile(join(home, 'replacement'), 'utf8')).resolves.toBe(
    'keep',
  );
  await provider.close();
});
it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'removes an unreadable mode0300 home when permissions allow both rmdir operations',
  async () => {
    const { provider, lease: owner, codex_home: home } = await lease();
    await fs.chmod(home, 0o300);
    try {
      // Establish both the permission boundary and the original rm outcome.
      await expect(fs.readdir(home)).rejects.toMatchObject({ code: 'EACCES' });
      await expect(
        fs.rm(home, { recursive: true, force: true }),
      ).rejects.toMatchObject({
        code: 'EACCES',
      });
      await owner.release();
      await absent(home);
      await provider.close();
    } finally {
      // Restore access if the candidate fails, so afterEach can clean its parent.
      try {
        await fs.chmod(home, 0o700);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  },
);
it('falls back for unexpected files in the root and nonempty workspace', async () => {
  const { lease: owner, codex_home: home, cwd } = await lease();
  await fs.writeFile(join(home, 'unexpected'), 'root');
  await fs.mkdir(join(cwd, 'nested'));
  await fs.writeFile(join(cwd, 'nested', 'data'), 'workspace');
  await owner.release();
  await absent(home);
});
it('falls back for an unexpected root file beside an empty workspace', async () => {
  const { lease: owner, codex_home: home } = await lease();
  await fs.writeFile(join(home, 'unexpected'), 'root');
  await owner.release();
  await absent(home);
});
it('removes a regular file replacing the root', async () => {
  const { lease: owner, codex_home: home } = await lease();
  await fs.rename(home, join(fixture.root, 'moved'));
  await fs.writeFile(home, 'replacement');
  await owner.release();
  await absent(home);
  await expect(fs.readdir(join(fixture.root, 'moved'))).resolves.toEqual([
    'workspace',
  ]);
});
it('unlinks a dangling root symlink', async () => {
  const { lease: owner, codex_home: home } = await lease();
  await fs.rm(home, { recursive: true });
  await fs.symlink(
    join(fixture.root, 'missing'),
    home,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await owner.release();
  await absent(home);
});
it('removes an empty root when its workspace is missing', async () => {
  const { lease: owner, codex_home: home, cwd } = await lease();
  await fs.rmdir(cwd);
  await owner.release();
  await absent(home);
});
it('accepts an already missing home', async () => {
  const { lease: owner, codex_home: home } = await lease();
  await fs.rm(home, { recursive: true });
  await owner.release();
  await absent(home);
});
it('unlinks a stable replacement root symlink without visiting its target', async () => {
  const { lease: owner, codex_home: home } = await lease();
  const moved = join(fixture.root, 'original');
  const target = join(fixture.root, 'target');
  await fs.rename(home, moved);
  await fs.mkdir(join(target, 'workspace'), { recursive: true });
  await fs.writeFile(join(target, 'sentinel'), 'keep');
  await fs.symlink(
    target,
    home,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await owner.release();
  await absent(home);
  await expect(fs.readdir(join(target, 'workspace'))).resolves.toEqual([]);
  await expect(fs.readFile(join(target, 'sentinel'), 'utf8')).resolves.toBe(
    'keep',
  );
  await expect(fs.readdir(moved)).resolves.toEqual(['workspace']);
});
it('unlinks a stable workspace symlink without removing target contents', async () => {
  const { lease: owner, codex_home: home, cwd } = await lease();
  const target = join(fixture.root, 'target');
  await fs.rmdir(cwd);
  await fs.mkdir(target);
  await fs.writeFile(join(target, 'sentinel'), 'keep');
  await fs.symlink(
    target,
    cwd,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await owner.release();
  await absent(home);
  await expect(fs.readFile(join(target, 'sentinel'), 'utf8')).resolves.toBe(
    'keep',
  );
});
it('handles a root replaced just before its first removal syscall', async () => {
  const { lease: owner, codex_home: home } = await lease();
  const target = join(fixture.root, 'target');
  await fs.mkdir(join(target, 'workspace'), { recursive: true });
  fixture.rmdir.mockImplementationOnce(async (path, options) => {
    await fs.rename(home, join(fixture.root, 'moved'));
    await fs.symlink(
      target,
      home,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    return fs.rmdir(path, options);
  });
  await owner.release();
  await absent(home);
  await expect(fs.readdir(join(target, 'workspace'))).resolves.toEqual([]);
});
it('uses full fallback if a different directory replaces the root after its probe', async () => {
  const { lease: owner, codex_home: home } = await lease();
  fixture.rmdir.mockImplementationOnce(async (path, options) => {
    try {
      await fs.rmdir(path, options);
    } catch (error) {
      expect(error).toMatchObject({ code: 'ENOTEMPTY' });
      await fs.rename(home, join(fixture.root, 'moved'));
      await fs.mkdir(home);
      await fs.writeFile(join(home, 'late'), 'new contents');
      throw error;
    }
  });
  await owner.release();
  await absent(home);
  await expect(fs.readdir(join(fixture.root, 'moved'))).resolves.toEqual([
    'workspace',
  ]);
});
it('completes concurrent releases and leaves the provider closable', async () => {
  const { provider, lease: owner, codex_home: home } = await lease();
  await Promise.all([owner.release(), owner.release(), owner.release()]);
  await absent(home);
  await provider.close();
});
it('retains the original fallback error and permits retry after partial removal', async () => {
  const { provider, lease: owner, codex_home: home, cwd } = await lease();
  const failure = denied();
  let rootCalls = 0;
  fixture.rmdir.mockImplementation(async (path, options) => {
    if (path === home && ++rootCalls === 2) throw denied();
    return fs.rmdir(path, options);
  });
  fixture.rm.mockRejectedValueOnce(failure);
  await expect(owner.release()).rejects.toBe(failure);
  await absent(cwd);
  await expect(fs.lstat(home)).resolves.toBeDefined();
  await expect(provider.close()).rejects.toThrow('open or opening sessions');
  realRemoval();
  await owner.release();
  await absent(home);
  await provider.close();
});
it('preserves failed-opening diagnostics and provider-owned retry', async () => {
  const { provider, lease: owner, codex_home: home } = await lease();
  const primary = new Error('opening failed');
  const failure = denied();
  fixture.rmdir.mockRejectedValueOnce(denied());
  fixture.rm.mockRejectedValueOnce(failure);
  await expect(owner.failOpening(primary)).rejects.toMatchObject({
    cause: primary,
    errors: [primary, failure],
  });
  await expect(fs.lstat(home)).resolves.toBeDefined();
  realRemoval();
  await provider.close();
  await absent(home);
});

it('uses an installed native cleanup and preserves release idempotence', async () => {
  const cleanup = vi.fn(async (home: string) => {
    await fs.rmdir(join(home, 'workspace'));
    await fs.rmdir(home);
    return true;
  });
  const provider = new NativeProvider({ apiKey: 'fixture' });
  providers.push(provider);
  const owner = provider._acquire(undefined, cleanup);
  leases.push(owner);
  const { codex_home: home } = await owner.open();
  await owner.release();
  await absent(home);
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect(cleanup).toHaveBeenCalledWith(home);
  expect(fixture.rm).not.toHaveBeenCalled();
  expect(fixture.rmdir).not.toHaveBeenCalled();
  await fs.mkdir(home);
  await fs.writeFile(join(home, 'replacement'), 'keep');
  await owner.release();
  expect(cleanup).toHaveBeenCalledTimes(1);
  await expect(fs.readFile(join(home, 'replacement'), 'utf8')).resolves.toBe(
    'keep',
  );
});

it('preserves Node fallback failure and retry after native runtime rejection', async () => {
  const nativeFailure = new Error('native runtime is unavailable');
  const cleanup = vi.fn(async (_home: string): Promise<boolean> => {
    throw nativeFailure;
  });
  const provider = new NativeProvider({ apiKey: 'fixture' });
  providers.push(provider);
  const owner = provider._acquire(undefined, cleanup);
  leases.push(owner);
  const { codex_home: home } = await owner.open();
  const fallbackFailure = denied();
  fixture.rm.mockRejectedValueOnce(fallbackFailure);
  await expect(owner.release()).rejects.toBe(fallbackFailure);
  await expect(fs.readdir(home)).resolves.toEqual(['workspace']);
  expect(fixture.rm).toHaveBeenCalledWith(home, {
    recursive: true,
    force: true,
  });
  await owner.release();
  await absent(home);
  expect(cleanup).toHaveBeenCalledTimes(2);
  await provider.close();
});

it('finishes partial native cleanup through the unchanged Node fallback', async () => {
  const cleanup = vi.fn(async (home: string) => {
    await fs.rmdir(join(home, 'workspace'));
    return false;
  });
  const provider = new NativeProvider({ apiKey: 'fixture' });
  providers.push(provider);
  const owner = provider._acquire(undefined, cleanup);
  leases.push(owner);
  const { codex_home: home } = await owner.open();
  await fs.writeFile(join(home, 'unexpected'), 'fallback owns this file');
  await owner.release();
  await absent(home);
  expect(fixture.rm).toHaveBeenCalledTimes(1);
  expect(fixture.rm).toHaveBeenCalledWith(home, {
    recursive: true,
    force: true,
  });
  expect(fixture.rmdir).not.toHaveBeenCalled();
  await provider.close();
});
