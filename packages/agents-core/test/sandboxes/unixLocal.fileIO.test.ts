import * as childProcess from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, userInfo } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Manifest,
  UnixLocalSandboxClient,
  UnixLocalSandboxSession,
} from '../../src/sandbox/local';
import { UnixLocalFiles } from '../../src/sandbox/sandboxes/shared/unixLocalFiles';
import { UNIX_LOCAL_FILE_WORKER } from '../../src/sandbox/sandboxes/shared/unixLocalFileWorker';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
}));

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
  'base64',
);
const patch = '@@\n-before\n+after\n';

describe.skipIf(process.platform === 'win32')(
  'UnixLocal descriptor-owned file operations',
  () => {
    let root: string;
    let outside: string;
    let session: UnixLocalSandboxSession;

    beforeEach(async () => {
      root = await realpath(
        await mkdtemp(join(tmpdir(), 'unix-local-file-io-')),
      );
      outside = join(root, 'outside');
      await mkdir(outside);
      await writeFile(join(outside, 'note.txt'), 'outside\n');
      session = await new UnixLocalSandboxClient({
        workspaceBaseDir: root,
      }).create(
        new Manifest({
          entries: {
            nested: {
              type: 'dir',
              children: {
                'note.txt': { type: 'file', content: 'before\n' },
                'image.png': { type: 'file', content: png },
              },
            },
          },
        }),
      );
    });

    afterEach(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      await session.close();
      await rm(root, { recursive: true, force: true });
    });

    // Inject a swap at an OS boundary inside the real worker, while calling the public API.
    // This avoids scheduler-dependent loops and keeps every filesystem primitive real.
    function workerHook(source: string) {
      const spawn = childProcess.spawn;
      return vi.spyOn(childProcess, 'spawn').mockImplementation(((
        command: string,
        args: string[],
        options: childProcess.SpawnOptions,
      ) => {
        const rewritten = args.map((arg) =>
          arg === UNIX_LOCAL_FILE_WORKER
            ? arg.replace(
                'try:\n    run(json.loads(sys.argv[1]))',
                `${source}\ntry:\n    run(json.loads(sys.argv[1]))`,
              )
            : arg,
        );
        return spawn(command, rewritten, options);
      }) as typeof childProcess.spawn);
    }

    it('preserves binary reads, listings, image bytes and directory probes', async () => {
      expect(
        await session.readFile({ path: 'nested/image.png', maxBytes: 8 }),
      ).toEqual(png.subarray(0, 8));
      expect(await session.listDir({ path: 'nested' })).toEqual(
        expect.arrayContaining([
          { name: 'note.txt', path: 'nested/note.txt', type: 'file' },
        ]),
      );
      expect(
        await session.viewImage({ path: 'nested/image.png' }),
      ).toMatchObject({
        image: { data: Uint8Array.from(png), mediaType: 'image/png' },
      });
      expect(await session.directoryExists('nested', userInfo().username)).toBe(
        true,
      );
      expect(await session.directoryExists('nested/note.txt')).toBe(false);
    });

    // Root bypasses directory mode checks on supported Unix hosts.
    it.skipIf(process.getuid?.() === 0)(
      'returns false for a non-searchable final directory but rejects inaccessible ancestors',
      async () => {
        const blocked = join(session.state.workspaceRootPath, 'blocked');
        await mkdir(join(blocked, 'child'), { recursive: true });
        await chmod(blocked, 0o600);
        try {
          expect(await session.pathExists('blocked')).toBe(true);
          expect(
            await session.directoryExists('blocked', userInfo().username),
          ).toBe(false);
          await expect(
            session.directoryExists('blocked/child'),
          ).rejects.toThrow();
        } finally {
          await chmod(blocked, 0o700);
        }
      },
    );

    it('preserves exclusive creation and in-place patching', async () => {
      const editor = session.createEditor(userInfo().username);
      await editor.createFile({
        type: 'create_file',
        path: 'new/deep/note.txt',
        diff: '+before\n+',
      });
      await expect(
        editor.createFile({
          type: 'create_file',
          path: 'new/deep/note.txt',
          diff: '+duplicate',
        }),
      ).rejects.toMatchObject({ code: 'EEXIST' });
      await editor.updateFile({
        type: 'update_file',
        path: 'new/deep/note.txt',
        diff: patch,
      });
      expect(
        Buffer.from(
          await session.readFile({ path: 'new/deep/note.txt' }),
        ).toString(),
      ).toBe('after\n');
    });

    it('preserves moves and file-only deletion', async () => {
      const editor = session.createEditor();
      await editor.updateFile({
        type: 'update_file',
        path: 'nested/note.txt',
        moveTo: 'moved/note.txt',
        diff: patch,
      });
      expect(await session.pathExists('nested/note.txt')).toBe(false);
      expect(
        Buffer.from(
          await session.readFile({ path: 'moved/note.txt' }),
        ).toString(),
      ).toBe('after\n');
      await editor.deleteFile({ type: 'delete_file', path: 'moved/note.txt' });
      expect(await session.pathExists('moved/note.txt')).toBe(false);
      await expect(
        editor.deleteFile({ type: 'delete_file', path: 'nested' }),
      ).rejects.toThrow();
      expect(await session.pathExists('nested/image.png')).toBe(true);
    });

    it.each(['delete', 'move', 'move-to-target'] as const)(
      'preserves the target when a contained symlink is used for %s',
      async (operation) => {
        const workspace = session.state.workspaceRootPath;
        const target = join(workspace, 'nested/note.txt');
        const link = join(workspace, 'link.txt');
        await symlink(target, link);
        const editor = session.createEditor();
        if (operation === 'delete') {
          await editor.deleteFile({ type: 'delete_file', path: 'link.txt' });
        } else {
          await editor.updateFile({
            type: 'update_file',
            path: 'link.txt',
            diff: patch,
            moveTo: operation === 'move' ? 'moved.txt' : 'nested/note.txt',
          });
          expect(
            await readFile(
              join(
                workspace,
                operation === 'move' ? 'moved.txt' : 'nested/note.txt',
              ),
              'utf8',
            ),
          ).toBe('after\n');
        }
        await expect(lstat(link)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(target, 'utf8')).toBe(
          operation === 'move-to-target' ? 'after\n' : 'before\n',
        );
      },
    );

    it('deletes an explicitly granted file alias without deleting its target', async () => {
      const alias = join(root, 'granted.txt');
      await symlink(join(outside, 'note.txt'), alias);
      const granted = await new UnixLocalSandboxClient({
        workspaceBaseDir: root,
      }).create(
        new Manifest({ extraPathGrants: [{ path: alias, readOnly: false }] }),
      );
      try {
        await granted
          .createEditor()
          .deleteFile({ type: 'delete_file', path: alias });
        await expect(lstat(alias)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(join(outside, 'note.txt'), 'utf8')).toBe(
          'outside\n',
        );
      } finally {
        await granted.close();
      }
    });

    it.each([
      'read',
      'image',
      'list',
      'exists',
      'directoryExists',
      'create',
      'update',
      'delete',
    ] as const)(
      'rejects an ancestor replaced after authorization for %s',
      async (operation) => {
        const nested = join(session.state.workspaceRootPath, 'nested');
        const run = UnixLocalFiles.prototype.run;
        vi.spyOn(UnixLocalFiles.prototype, 'run').mockImplementationOnce(
          async function (this: UnixLocalFiles, request, options) {
            await rename(nested, `${nested}-original`);
            await symlink(outside, nested);
            return run.call(this, request, options);
          },
        );
        const editor = session.createEditor();
        const actions = {
          read: () => session.readFile({ path: 'nested/note.txt' }),
          image: () => session.viewImage({ path: 'nested/image.png' }),
          list: () => session.listDir({ path: 'nested' }),
          exists: () => session.pathExists('nested/note.txt'),
          directoryExists: () => session.directoryExists('nested'),
          create: () =>
            editor.createFile({
              type: 'create_file',
              path: 'nested/new.txt',
              diff: '+new',
            }),
          update: () =>
            editor.updateFile({
              type: 'update_file',
              path: 'nested/note.txt',
              diff: patch,
            }),
          delete: () =>
            editor.deleteFile({ type: 'delete_file', path: 'nested/note.txt' }),
        };
        await expect(actions[operation]()).rejects.toThrow();
        expect(await readFile(join(outside, 'note.txt'), 'utf8')).toBe(
          'outside\n',
        );
        await expect(lstat(join(outside, 'new.txt'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
        expect(
          await readFile(join(`${nested}-original`, 'note.txt'), 'utf8'),
        ).toBe('before\n');
      },
    );

    it('keeps a granted alias pinned across operations and manifest updates', async () => {
      const granted = join(root, 'granted');
      const alias = join(root, 'alias');
      await mkdir(granted);
      await writeFile(join(granted, 'note.txt'), 'granted\n');
      await symlink(granted, alias);
      await session.applyManifest(
        new Manifest({ extraPathGrants: [{ path: alias, readOnly: true }] }),
      );
      await rm(alias);
      await symlink(outside, alias);
      await session.applyManifest(new Manifest());
      expect(
        Buffer.from(
          await session.readFile({ path: join(alias, 'note.txt') }),
        ).toString(),
      ).toBe('granted\n');
      expect(await session.listDir({ path: alias })).toContainEqual({
        name: 'note.txt',
        path: join(alias, 'note.txt'),
        type: 'file',
      });
      await expect(
        session.createEditor().createFile({
          type: 'create_file',
          path: join(alias, 'missing/new.txt'),
          diff: '+blocked',
        }),
      ).rejects.toThrow(/read-only/);
      await expect(lstat(join(granted, 'missing'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(await readFile(join(outside, 'note.txt'), 'utf8')).toBe(
        'outside\n',
      );
    });

    it('rejects workspace root replacement and preserves contained symlink reads', async () => {
      await symlink(
        'nested/note.txt',
        join(session.state.workspaceRootPath, 'link.txt'),
      );
      expect(
        Buffer.from(await session.readFile({ path: 'link.txt' })).toString(),
      ).toBe('before\n');
      await rename(
        session.state.workspaceRootPath,
        `${session.state.workspaceRootPath}-original`,
      );
      await symlink(outside, session.state.workspaceRootPath);
      await expect(session.listDir({ path: '.' })).rejects.toThrow(/escapes/);
      expect(await readFile(join(outside, 'note.txt'), 'utf8')).toBe(
        'outside\n',
      );
    });

    it('keeps a writable local bind source alias pinned after replacement', async () => {
      const source = join(root, 'mount-source');
      const alias = join(root, 'mount-alias');
      await mkdir(source);
      await writeFile(join(source, 'note.txt'), 'before\n');
      await symlink(source, alias);
      await session.applyManifest(
        new Manifest({
          entries: {
            mounted: {
              type: 'mount',
              source: alias,
              readOnly: false,
              mountStrategy: { type: 'local_bind' },
            },
          },
        }),
      );
      await rm(alias);
      await symlink(outside, alias);
      await session.createEditor().updateFile({
        type: 'update_file',
        path: 'mounted/note.txt',
        diff: patch,
      });
      expect(await readFile(join(source, 'note.txt'), 'utf8')).toBe('after\n');
      expect(await readFile(join(outside, 'note.txt'), 'utf8')).toBe(
        'outside\n',
      );
    });

    it('creates missing parents without following a replacement directory', async () => {
      const created = join(session.state.workspaceRootPath, 'new');
      workerHook(`
original_mkdir = os.mkdir
def swapped_mkdir(name, *args, **kwargs):
    original_mkdir(name, *args, **kwargs)
    if name == "new":
        os.rename(${JSON.stringify(created)}, ${JSON.stringify(`${created}-original`)})
        os.symlink(${JSON.stringify(outside)}, ${JSON.stringify(created)})
os.mkdir = swapped_mkdir
`);
      await expect(
        session.createEditor().createFile({
          type: 'create_file',
          path: 'new/deep/note.txt',
          diff: '+blocked',
        }),
      ).rejects.toThrow();
      await expect(lstat(join(outside, 'deep'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(await readFile(join(outside, 'note.txt'), 'utf8')).toBe(
        'outside\n',
      );
    });

    it('uses the opened image even when its name is replaced before reading', async () => {
      const image = join(session.state.workspaceRootPath, 'nested/image.png');
      workerHook(`
original_fstat = os.fstat
swapped = False
def swapped_fstat(fd):
    global swapped
    info = original_fstat(fd)
    if stat.S_ISREG(info.st_mode) and not swapped:
        swapped = True
        os.rename(${JSON.stringify(image)}, ${JSON.stringify(`${image}-original`)})
        os.symlink(${JSON.stringify(join(outside, 'note.txt'))}, ${JSON.stringify(image)})
    return info
os.fstat = swapped_fstat
`);
      expect(
        await session.viewImage({ path: 'nested/image.png' }),
      ).toMatchObject({ image: { data: Uint8Array.from(png) } });
      expect(await readFile(join(outside, 'note.txt'), 'utf8')).toBe(
        'outside\n',
      );
    });

    it('keeps update writes and ownership on the opened source after leaf replacement', async () => {
      const note = join(session.state.workspaceRootPath, 'nested/note.txt');
      const outsideStat = await lstat(join(outside, 'note.txt'));
      workerHook(`
original_lseek = os.lseek
def swapped_lseek(fd, offset, whence):
    os.rename(${JSON.stringify(note)}, ${JSON.stringify(`${note}-original`)})
    os.symlink(${JSON.stringify(join(outside, 'note.txt'))}, ${JSON.stringify(note)})
    return original_lseek(fd, offset, whence)
os.lseek = swapped_lseek
`);
      await session.createEditor(userInfo().username).updateFile({
        type: 'update_file',
        path: 'nested/note.txt',
        diff: patch,
      });
      expect(await readFile(`${note}-original`, 'utf8')).toBe('after\n');
      expect(await readFile(join(outside, 'note.txt'), 'utf8')).toBe(
        'outside\n',
      );
      const after = await lstat(join(outside, 'note.txt'));
      expect([after.uid, after.gid, after.mode]).toEqual([
        outsideStat.uid,
        outsideStat.gid,
        outsideStat.mode,
      ]);
    });

    it('preserves source and destination when patch application fails', async () => {
      await expect(
        session.createEditor().updateFile({
          type: 'update_file',
          path: 'nested/note.txt',
          moveTo: 'new/note.txt',
          diff: '@@\n-missing\n+after\n',
        }),
      ).rejects.toThrow();
      expect(
        Buffer.from(
          await session.readFile({ path: 'nested/note.txt' }),
        ).toString(),
      ).toBe('before\n');
      expect(await session.pathExists('new')).toBe(false);
    });

    it('rejects a replacement destination without deleting the move source', async () => {
      const destination = join(
        session.state.workspaceRootPath,
        'destination.txt',
      );
      await writeFile(destination, 'destination\n');
      workerHook(`
original_open = os.open
def swapped_open(name, flags, *args, **kwargs):
    if name == "destination.txt" and flags & os.O_WRONLY:
        os.rename(${JSON.stringify(destination)}, ${JSON.stringify(`${destination}-original`)})
        os.symlink(${JSON.stringify(join(outside, 'note.txt'))}, ${JSON.stringify(destination)})
    return original_open(name, flags, *args, **kwargs)
os.open = swapped_open
`);
      await expect(
        session.createEditor().updateFile({
          type: 'update_file',
          path: 'nested/note.txt',
          moveTo: 'destination.txt',
          diff: patch,
        }),
      ).rejects.toThrow();
      expect(
        await readFile(
          join(session.state.workspaceRootPath, 'nested/note.txt'),
          'utf8',
        ),
      ).toBe('before\n');
      expect(await readFile(`${destination}-original`, 'utf8')).toBe(
        'destination\n',
      );
      expect(await readFile(join(outside, 'note.txt'), 'utf8')).toBe(
        'outside\n',
      );
    });

    it('unlinks a moved source relative to its opened parent after replacement', async () => {
      const nested = join(session.state.workspaceRootPath, 'nested');
      workerHook(`
original_unlink = os.unlink
def swapped_unlink(name, *args, **kwargs):
    os.rename(${JSON.stringify(nested)}, ${JSON.stringify(`${nested}-original`)})
    os.symlink(${JSON.stringify(outside)}, ${JSON.stringify(nested)})
    return original_unlink(name, *args, **kwargs)
os.unlink = swapped_unlink
`);
      await session.createEditor().updateFile({
        type: 'update_file',
        path: 'nested/note.txt',
        moveTo: 'destination.txt',
        diff: patch,
      });
      expect(
        await readFile(
          join(session.state.workspaceRootPath, 'destination.txt'),
          'utf8',
        ),
      ).toBe('after\n');
      await expect(
        lstat(join(`${nested}-original`, 'note.txt')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(outside, 'note.txt'), 'utf8')).toBe(
        'outside\n',
      );
    });

    it.each(['stop', 'close'] as const)(
      'reaps a pending file worker before %s completes',
      async (operation) => {
        const marker = join(root, 'worker-started');
        const spawn = workerHook(`
import time
with open(${JSON.stringify(marker)}, "w") as started:
    started.write("ready")
time.sleep(60)
`);
        const pending = session.readFile({ path: 'nested/note.txt' });
        const rejected = expect(pending).rejects.toThrow(/cancelled/);
        await expect
          .poll(async () => readFile(marker, 'utf8').catch(() => ''))
          .toBe('ready');
        const worker = spawn.mock.results[0].value as childProcess.ChildProcess;
        await Promise.all([session[operation](), session[operation]()]);
        await rejected;
        expect(worker.signalCode).toBe('SIGKILL');
        spawn.mockRestore();
        if (operation === 'stop') {
          expect(
            Buffer.from(
              await session.readFile({ path: 'nested/note.txt' }),
            ).toString(),
          ).toBe('before\n');
        } else {
          await expect(
            session.createEditor().createFile({
              type: 'create_file',
              path: 'late.txt',
              diff: '+late',
            }),
          ).rejects.toThrow();
          await expect(
            lstat(join(session.state.workspaceRootPath, 'late.txt')),
          ).rejects.toMatchObject({ code: 'ENOENT' });
        }
      },
    );

    it('does not load workspace modules or manifest environment in the trusted worker', async () => {
      await writeFile(
        join(session.state.workspaceRootPath, 'json.py'),
        'raise RuntimeError("workspace module loaded")',
      );
      vi.stubEnv('PYTHONPATH', session.state.workspaceRootPath);
      session.state.environment = {
        PYTHONPATH: session.state.workspaceRootPath,
        PATH: session.state.workspaceRootPath,
        OPENAI_API_KEY: 'sandbox-placeholder',
      };
      const spawn = vi.spyOn(childProcess, 'spawn');
      expect(
        Buffer.from(
          await session.readFile({ path: 'nested/note.txt' }),
        ).toString(),
      ).toBe('before\n');
      expect(spawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.arrayContaining(['-I', '-S']),
        expect.objectContaining({ cwd: '/', env: { PATH: '/usr/bin:/bin' } }),
      );
    });

    it('fails before writing when Python is unavailable', async () => {
      vi.stubEnv('OPENAI_AGENTS_PYTHON', join(root, 'missing-python'));
      await expect(
        session.createEditor().createFile({
          type: 'create_file',
          path: 'new/note.txt',
          diff: '+blocked',
        }),
      ).rejects.toThrow(/require Python 3/);
      await expect(
        lstat(join(session.state.workspaceRootPath, 'new')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('preserves an open failure when directory cleanup also fails', async () => {
      workerHook(`
original_open = os.open
original_close = os.close
failed = False
def failing_open(name, *args, **kwargs):
    global failed
    if name == "note.txt":
        failed = True
        raise PermissionError(errno.EACCES, "primary open failure")
    return original_open(name, *args, **kwargs)
def failing_close(fd):
    original_close(fd)
    if failed:
        raise OSError(errno.EIO, "secondary close failure")
os.open = failing_open
os.close = failing_close
`);
      await expect(
        session.readFile({ path: 'nested/note.txt' }),
      ).rejects.toMatchObject({
        code: 'EACCES',
        message: 'EACCES: primary open failure',
      });
    });

    it('rejects a substituted FIFO without blocking the operation', async () => {
      const note = join(session.state.workspaceRootPath, 'nested/note.txt');
      workerHook(`
os.unlink(${JSON.stringify(note)})
os.mkfifo(${JSON.stringify(note)})
`);
      await expect(
        session.readFile({ path: 'nested/note.txt' }),
      ).rejects.toMatchObject({ code: 'EINVAL' });
    });

    it('rejects image growth beyond the existing image limit', async () => {
      const image = join(session.state.workspaceRootPath, 'nested/image.png');
      await writeFile(image, Buffer.alloc(10 * 1024 * 1024 + 1));
      await expect(
        session.viewImage({ path: 'nested/image.png' }),
      ).rejects.toThrow(/10 MB/);
    });

    it('reads through search-only ancestors when the platform supports traversal handles', async () => {
      const nested = join(session.state.workspaceRootPath, 'nested');
      await chmod(nested, 0o111);
      try {
        expect(
          Buffer.from(
            await session.readFile({ path: 'nested/note.txt' }),
          ).toString(),
        ).toBe('before\n');
      } finally {
        await chmod(nested, 0o755);
      }
    });
  },
);
