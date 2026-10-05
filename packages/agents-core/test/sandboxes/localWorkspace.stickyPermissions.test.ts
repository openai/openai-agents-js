import type { FileHandle } from 'node:fs/promises';
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { Manifest } from '../../src/sandbox/manifest';
import { restoreLocalWorkspaceManifestStickyPermissions } from '../../src/sandbox/sandboxes/shared/localWorkspace';

const race = vi.hoisted(() => ({
  afterRealpath: undefined as undefined | ((path: unknown) => Promise<void>),
  afterOpen: undefined as
    undefined | ((path: unknown, handle: FileHandle) => Promise<void>),
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...fs,
    realpath: async (...args: Parameters<typeof fs.realpath>) => {
      const result = await fs.realpath(...args);
      await race.afterRealpath?.(args[0]);
      return result;
    },
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      await race.afterOpen?.(args[0], handle);
      return handle;
    },
  };
});
let root: string;
afterEach(async () => {
  race.afterRealpath = undefined;
  race.afterOpen = undefined;
  if (root) await rm(root, { recursive: true, force: true });
});

// The helper owns the descriptor boundary; controlled filesystem swaps here avoid
// timing-dependent processes while exercising real directories and chmod effects.
it.each(['symlink', 'directory', 'after-open'] as const)(
  'binds sticky chmod to the validated directory during a %s swap',
  async (swap) => {
    root = await mkdtemp(join(tmpdir(), 'sticky-restore-race-'));
    const workspace = join(root, 'workspace');
    const target = join(workspace, 'shared');
    const moved = join(workspace, 'original');
    const outside = join(root, 'private.txt');
    await mkdir(target, { recursive: true });
    await chmod(target, 0o755);
    await writeFile(outside, 'private');
    await chmod(outside, 0o600);
    let opened: Awaited<ReturnType<typeof open>> | undefined;
    const replace = async (
      path: unknown,
      handle?: Awaited<ReturnType<typeof open>>,
    ) => {
      if (path !== target) return;
      race.afterRealpath = undefined;
      race.afterOpen = undefined;
      opened = handle;
      await rename(target, moved);
      if (swap === 'directory') {
        await mkdir(target);
        await chmod(target, 0o755);
      } else {
        await symlink(outside, target);
      }
    };
    if (swap === 'after-open') race.afterOpen = replace;
    else race.afterRealpath = replace;
    const restored = restoreLocalWorkspaceManifestStickyPermissions(
      new Manifest({
        entries: { shared: { type: 'dir', permissions: 'drwxrwxrwt' } },
      }),
      workspace,
    );
    if (swap === 'after-open') {
      await restored;
      expect((await stat(moved)).mode & 0o7777).toBe(0o1755);
      expect(opened).toBeDefined();
    } else {
      const error = await restored.then(
        () => undefined,
        (failure: unknown) => failure,
      );
      expect((await stat(outside)).mode & 0o7777).toBe(0o600);
      expect(error).toBeInstanceOf(Error);
      expect((await stat(moved)).mode & 0o7777).toBe(0o755);
      if (swap === 'directory')
        expect((await stat(target)).mode & 0o7777).toBe(0o755);
    }
    expect((await stat(outside)).mode & 0o7777).toBe(0o600);
    if (opened) await expect(opened.stat()).rejects.toThrow();
  },
);
