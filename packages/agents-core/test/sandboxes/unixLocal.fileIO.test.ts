import * as childProcess from 'node:child_process';
import {
  chmod,
  link,
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
        fileIOProtection: 'required',
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

    it('preserves exclusive creation and patching', async () => {
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

    it.each(['dangling', 'outside'] as const)(
      'deletes a contained symlink when its target is %s',
      async (targetKind) => {
        const target = join(
          outside,
          targetKind === 'dangling' ? 'missing.txt' : 'note.txt',
        );
        const link = join(session.state.workspaceRootPath, 'link.txt');
        await symlink(target, link);
        const editor = session.createEditor(userInfo().username);

        await expect(session.readFile({ path: 'link.txt' })).rejects.toThrow(
          /escapes the workspace root/,
        );
        await expect(
          editor.updateFile({
            type: 'update_file',
            path: 'link.txt',
            diff: patch,
          }),
        ).rejects.toThrow(/escapes the workspace root/);

        await editor.deleteFile({ type: 'delete_file', path: 'link.txt' });
        await expect(lstat(link)).rejects.toMatchObject({ code: 'ENOENT' });
        if (targetKind === 'dangling') {
          await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
        } else {
          expect(await readFile(target, 'utf8')).toBe('outside\n');
        }
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

    it('keeps a granted file alias when its target changes before deletion', async () => {
      const alias = join(root, 'granted.txt');
      const original = join(outside, 'note.txt');
      const replacement = join(outside, 'replacement.txt');
      await writeFile(replacement, 'replacement\n');
      await symlink(original, alias);
      const granted = await new UnixLocalSandboxClient({
        workspaceBaseDir: root,
      }).create(
        new Manifest({ extraPathGrants: [{ path: alias, readOnly: false }] }),
      );
      try {
        await rm(alias);
        await symlink(replacement, alias);
        await expect(
          granted
            .createEditor()
            .deleteFile({ type: 'delete_file', path: alias }),
        ).rejects.toMatchObject({ code: 'ELOOP' });
        expect((await lstat(alias)).isSymbolicLink()).toBe(true);
        expect(await readFile(alias, 'utf8')).toBe('replacement\n');
        expect(await readFile(original, 'utf8')).toBe('outside\n');
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

    it('rejects a changed granted alias across operations and manifest updates', async () => {
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
      await expect(
        session.readFile({ path: join(alias, 'note.txt') }),
      ).rejects.toMatchObject({ code: 'ELOOP' });
      await expect(session.listDir({ path: alias })).rejects.toMatchObject({
        code: 'ELOOP',
      });
      expect(await readFile(join(granted, 'note.txt'), 'utf8')).toBe(
        'granted\n',
      );
      await rm(alias);
      await symlink(granted, alias);
      expect(
        Buffer.from(
          await session.readFile({ path: join(alias, 'note.txt') }),
        ).toString(),
      ).toBe('granted\n');
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

    it('rejects a changed local bind source alias until restored', async () => {
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
      await expect(
        session.createEditor().updateFile({
          type: 'update_file',
          path: 'mounted/note.txt',
          diff: patch,
        }),
      ).rejects.toMatchObject({ code: 'ELOOP' });
      expect(await readFile(join(source, 'note.txt'), 'utf8')).toBe('before\n');
      expect(await readFile(join(outside, 'note.txt'), 'utf8')).toBe(
        'outside\n',
      );
      await rm(alias);
      await symlink(source, alias);
      await session.createEditor().updateFile({
        type: 'update_file',
        path: 'mounted/note.txt',
        diff: patch,
      });
      expect(await readFile(join(source, 'note.txt'), 'utf8')).toBe('after\n');
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

    it('replaces the authorized entry without changing a substituted symlink target', async () => {
      const note = join(session.state.workspaceRootPath, 'nested/note.txt');
      const outsideStat = await lstat(join(outside, 'note.txt'));
      workerHook(`
original_rename = os.rename
def swapped_rename(source, destination, *args, **kwargs):
    original_rename(${JSON.stringify(note)}, ${JSON.stringify(`${note}-original`)})
    os.symlink(${JSON.stringify(join(outside, 'note.txt'))}, ${JSON.stringify(note)})
    return original_rename(source, destination, *args, **kwargs)
os.rename = swapped_rename
`);
      await session.createEditor(userInfo().username).updateFile({
        type: 'update_file',
        path: 'nested/note.txt',
        diff: patch,
      });
      expect(await readFile(`${note}-original`, 'utf8')).toBe('before\n');
      expect(await readFile(note, 'utf8')).toBe('after\n');
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

    it.each(['update', 'move-destination'] as const)(
      'leaves a read-only grant unchanged when its hardlink is the %s',
      async (operation) => {
        const original = join(outside, 'note.txt');
        await writeFile(original, 'before\n');
        await chmod(original, 0o640);
        await session.applyManifest(
          new Manifest({
            extraPathGrants: [{ path: outside, readOnly: true }],
          }),
        );
        const linked = join(session.state.workspaceRootPath, 'linked.txt');
        await link(original, linked);
        const before = await lstat(original);
        await session.createEditor().updateFile({
          type: 'update_file',
          path: operation === 'update' ? 'linked.txt' : 'nested/note.txt',
          moveTo: operation === 'move-destination' ? 'linked.txt' : undefined,
          diff: patch,
        });
        expect(await readFile(linked, 'utf8')).toBe('after\n');
        expect(await readFile(original, 'utf8')).toBe('before\n');
        const after = await lstat(original);
        expect([after.ino, after.uid, after.gid, after.mode]).toEqual([
          before.ino,
          before.uid,
          before.gid,
          before.mode,
        ]);
        const replacement = await lstat(linked);
        expect(replacement.ino).not.toBe(before.ino);
        expect([replacement.uid, replacement.gid, replacement.mode]).toEqual([
          before.uid,
          before.gid,
          before.mode,
        ]);
      },
    );

    it('leaves a hardlink created after the source was opened unchanged', async () => {
      const note = join(session.state.workspaceRootPath, 'nested/note.txt');
      const alias = join(outside, 'late-link.txt');
      workerHook(`
original_regular = regular
linked = False
def linking_regular(fd, path):
    global linked
    info = original_regular(fd, path)
    if not linked and path == ${JSON.stringify(note)}:
        linked = True
        os.link(${JSON.stringify(note)}, ${JSON.stringify(alias)})
    return info
regular = linking_regular
`);
      await session.createEditor().updateFile({
        type: 'update_file',
        path: 'nested/note.txt',
        diff: patch,
      });
      expect(await readFile(note, 'utf8')).toBe('after\n');
      expect(await readFile(alias, 'utf8')).toBe('before\n');
    });

    it('preserves the original and removes its temporary file when replacement fails', async () => {
      workerHook(`
def failing_rename(*args, **kwargs):
    raise PermissionError(errno.EACCES, "replacement denied")
os.rename = failing_rename
`);
      await expect(
        session.createEditor().updateFile({
          type: 'update_file',
          path: 'nested/note.txt',
          diff: patch,
        }),
      ).rejects.toMatchObject({ code: 'EACCES' });
      expect(
        await readFile(
          join(session.state.workspaceRootPath, 'nested/note.txt'),
          'utf8',
        ),
      ).toBe('before\n');
      expect(await session.listDir({ path: 'nested' })).toHaveLength(2);
    });

    it.each(['update', 'move'] as const)(
      'keeps a newer destination installed during %s',
      async (operation) => {
        const workspace = session.state.workspaceRootPath;
        const source = join(workspace, 'nested/note.txt');
        const destination =
          operation === 'move'
            ? join(workspace, 'nested/destination.txt')
            : source;
        if (operation === 'move') await writeFile(destination, 'destination\n');
        workerHook(`
original_input_file = input_file
def replacing_input_file(fd):
    original_input_file(fd)
    os.rename(${JSON.stringify(destination)}, ${JSON.stringify(`${destination}-old`)})
    with open(${JSON.stringify(destination)}, "w") as replacement:
        replacement.write("newer contents\\n")
input_file = replacing_input_file
`);
        await expect(
          session.createEditor().updateFile({
            type: 'update_file',
            path: 'nested/note.txt',
            diff: patch,
            ...(operation === 'move'
              ? { moveTo: 'nested/destination.txt' }
              : {}),
          }),
        ).rejects.toMatchObject({ code: 'ESTALE' });
        expect(await readFile(destination, 'utf8')).toBe('newer contents\n');
        expect(await readFile(`${destination}-old`, 'utf8')).toBe(
          operation === 'move' ? 'destination\n' : 'before\n',
        );
        if (operation === 'move')
          expect(await readFile(source, 'utf8')).toBe('before\n');
        expect(
          (await session.listDir({ path: 'nested' })).map(
            (entry) => entry.name,
          ),
        ).not.toEqual(
          expect.arrayContaining([expect.stringMatching(/^\.openai-agents-/)]),
        );
      },
    );

    it('preserves a mode change made while receiving replacement contents', async () => {
      const note = join(session.state.workspaceRootPath, 'nested/note.txt');
      const alias = join(outside, 'original.txt');
      await link(note, alias);
      workerHook(`
original_input_file = input_file
def changing_input_file(fd):
    os.chmod(${JSON.stringify(note)}, 0o400)
    original_input_file(fd)
input_file = changing_input_file
`);
      await session.createEditor().updateFile({
        type: 'update_file',
        path: 'nested/note.txt',
        diff: patch,
      });
      expect(await readFile(note, 'utf8')).toBe('after\n');
      expect((await lstat(note)).mode & 0o777).toBe(0o400);
      expect(await readFile(alias, 'utf8')).toBe('before\n');
      expect(await session.listDir({ path: 'nested' })).toHaveLength(2);
    });

    it.skipIf(process.platform !== 'linux')(
      'preserves an attribute change made while receiving move contents',
      async () => {
        const destination = join(
          session.state.workspaceRootPath,
          'nested/destination.txt',
        );
        const alias = join(outside, 'original.txt');
        await writeFile(destination, 'destination\n');
        await link(destination, alias);
        workerHook(`
original_input_file = input_file
def changing_input_file(fd):
    os.setxattr(${JSON.stringify(destination)}, "user.agents-test", b"new value")
    original_input_file(fd)
input_file = changing_input_file
`);
        await session.createEditor().updateFile({
          type: 'update_file',
          path: 'nested/note.txt',
          moveTo: 'nested/destination.txt',
          diff: patch,
        });
        expect(await readFile(destination, 'utf8')).toBe('after\n');
        expect(await readFile(alias, 'utf8')).toBe('destination\n');
        expect(await session.pathExists('nested/note.txt')).toBe(false);
        expect(
          childProcess.execFileSync(
            process.env.OPENAI_AGENTS_PYTHON ?? 'python3',
            [
              '-I',
              '-S',
              '-c',
              'import os, sys; sys.stdout.buffer.write(os.getxattr(sys.argv[1], "user.agents-test"))',
              destination,
            ],
            { stdio: 'pipe' },
          ),
        ).toEqual(Buffer.from('new value'));
        expect(await session.listDir({ path: 'nested' })).toHaveLength(2);
      },
    );

    it.skipIf(process.platform !== 'linux').each([true, false])(
      'preserves an inherited SELinux label without relabeling when matching=%s',
      async (matching) => {
        const note = join(session.state.workspaceRootPath, 'nested/note.txt');
        const original = (await lstat(note)).ino;
        // Model the kernel's label policy; all file operations still use the real worker.
        workerHook(`
original_listxattr = os.listxattr
original_getxattr = os.getxattr
original_setxattr = os.setxattr
def labeled_attributes(fd):
    return original_listxattr(fd) + ["security.selinux"]
def label_value(fd, attribute):
    if attribute == "security.selinux":
        return b"original" if ${matching ? 'True' : 'False'} or os.fstat(fd).st_ino == ${original} else b"different"
    return original_getxattr(fd, attribute)
def denied_relabel(fd, attribute, value):
    if attribute == "security.selinux":
        raise PermissionError(errno.EPERM, "Relabeling is not permitted")
    return original_setxattr(fd, attribute, value)
os.listxattr = labeled_attributes
os.getxattr = label_value
os.setxattr = denied_relabel
`);
        const update = session.createEditor().updateFile({
          type: 'update_file',
          path: 'nested/note.txt',
          diff: patch,
        });
        if (matching) await update;
        else await expect(update).rejects.toMatchObject({ code: 'EPERM' });
        expect(await readFile(note, 'utf8')).toBe(
          matching ? 'after\n' : 'before\n',
        );
        expect(await session.listDir({ path: 'nested' })).toHaveLength(2);
      },
    );

    it
      .skipIf(process.platform !== 'linux')
      .each(['security.ima', 'security.evm'])(
      'rejects replacement of content protected by %s',
      async (attribute) => {
        // Integrity signatures describe the old data and cannot be copied to a patched file.
        workerHook(`
original_listxattr = os.listxattr
original_getxattr = os.getxattr
original_setxattr = os.setxattr
def signed_attributes(fd):
    return original_listxattr(fd) + [${JSON.stringify(attribute)}]
def signature_value(fd, name):
    return b"old content signature" if name == ${JSON.stringify(attribute)} else original_getxattr(fd, name)
def permit_signature_copy(fd, name, value):
    if name != ${JSON.stringify(attribute)}:
        original_setxattr(fd, name, value)
os.listxattr = signed_attributes
os.getxattr = signature_value
os.setxattr = permit_signature_copy
`);
        await expect(
          session.createEditor().updateFile({
            type: 'update_file',
            path: 'nested/note.txt',
            diff: patch,
          }),
        ).rejects.toMatchObject({ code: 'ENOTSUP' });
        expect(
          await readFile(
            join(session.state.workspaceRootPath, 'nested/note.txt'),
            'utf8',
          ),
        ).toBe('before\n');
        expect(await session.listDir({ path: 'nested' })).toHaveLength(2);
      },
    );

    it.skipIf(process.platform !== 'linux')(
      'preserves access rules when the parent has a default ACL',
      async () => {
        const note = join(session.state.workspaceRootPath, 'nested/note.txt');
        const python = process.env.OPENAI_AGENTS_PYTHON ?? 'python3';
        childProcess.execFileSync(
          python,
          [
            '-I',
            '-S',
            '-c',
            [
              'import os, struct, sys',
              'os.setxattr(sys.argv[1], "user.agents-test", b"preserved")',
              // A replacement must not acquire extra access from its parent's default ACL.
              'entries = [(1, 7, -1), (2, 4, os.getuid()), (4, 0, -1), (16, 4, -1), (32, 0, -1)]',
              'acl = struct.pack("<I", 2) + b"".join(struct.pack("<HHI", tag, perm, uid & 0xffffffff) for tag, perm, uid in entries)',
              'os.setxattr(os.path.dirname(sys.argv[1]), "system.posix_acl_default", acl)',
            ].join('; '),
            note,
          ],
          { stdio: 'pipe' },
        );
        await session.createEditor().updateFile({
          type: 'update_file',
          path: 'nested/note.txt',
          diff: patch,
        });
        expect(
          childProcess.execFileSync(
            python,
            [
              '-I',
              '-S',
              '-c',
              [
                'import os, sys',
                'assert "system.posix_acl_access" not in os.listxattr(sys.argv[1])',
                'sys.stdout.buffer.write(os.getxattr(sys.argv[1], "user.agents-test"))',
              ].join('; '),
              note,
            ],
            { stdio: 'pipe' },
          ),
        ).toEqual(Buffer.from('preserved'));
      },
    );

    it.skipIf(process.platform !== 'darwin')(
      'preserves macOS access rules and extended attributes',
      async () => {
        const note = join(session.state.workspaceRootPath, 'nested/note.txt');
        childProcess.execFileSync(
          '/usr/bin/xattr',
          ['-w', 'com.openai.agents-test', 'preserved', note],
          { stdio: 'pipe' },
        );
        childProcess.execFileSync(
          '/bin/chmod',
          ['+a', 'everyone allow read', note],
          { stdio: 'pipe' },
        );
        const accessRules = () =>
          childProcess
            .execFileSync('/bin/ls', ['-le', note], {
              encoding: 'utf8',
              stdio: 'pipe',
            })
            .split('\n')
            .filter((line) => /^\s*\d+:/.test(line));
        const before = accessRules();
        expect(before).toHaveLength(1);
        await session.createEditor().updateFile({
          type: 'update_file',
          path: 'nested/note.txt',
          diff: patch,
        });
        expect(accessRules()).toEqual(before);
        expect(
          childProcess
            .execFileSync(
              '/usr/bin/xattr',
              ['-p', 'com.openai.agents-test', note],
              { encoding: 'utf8', stdio: 'pipe' },
            )
            .trim(),
        ).toBe('preserved');
      },
    );

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

    it.each([false, true])(
      'uses native deletion access when allowed is %s',
      async (allowed) => {
        const destination = join(
          session.state.workspaceRootPath,
          'destination.txt',
        );
        await writeFile(destination, 'destination\n');
        workerHook(`
original_check_removal = check_removal
def mac_check_removal(*args):
    platform = sys.platform
    sys.platform = "darwin"
    try:
        return original_check_removal(*args)
    finally:
        sys.platform = platform
check_removal = mac_check_removal
original_access = os.access
def deletion_access(path, mode, *args, **kwargs):
    if mode == 1 << 12:
        return ${allowed ? 'True' : 'False'}
    return ${allowed ? 'False' : 'original_access(path, mode, *args, **kwargs)'}
os.access = deletion_access
original_unlink = os.unlink
def denied_unlink(name, *args, **kwargs):
    if name == "note.txt" and ${allowed ? 'False' : 'True'}:
        raise PermissionError(errno.EACCES, "Deletion denied by file access rules")
    return original_unlink(name, *args, **kwargs)
os.unlink = denied_unlink
`);
        const move = session.createEditor().updateFile({
          type: 'update_file',
          path: 'nested/note.txt',
          moveTo: 'destination.txt',
          diff: patch,
        });
        if (allowed) {
          await move;
          expect(await readFile(destination, 'utf8')).toBe('after\n');
          await expect(
            lstat(join(session.state.workspaceRootPath, 'nested/note.txt')),
          ).rejects.toMatchObject({ code: 'ENOENT' });
          return;
        }
        await expect(move).rejects.toThrow();
        expect(await readFile(destination, 'utf8')).toBe('destination\n');
        await expect(
          session.createEditor().updateFile({
            type: 'update_file',
            path: 'nested/missing.txt',
            moveTo: 'destination.txt',
            diff: patch,
          }),
        ).rejects.toMatchObject({ code: 'ENOENT' });
        expect(
          await readFile(
            join(session.state.workspaceRootPath, 'nested/note.txt'),
            'utf8',
          ),
        ).toBe('before\n');
      },
    );

    it
      .skipIf(process.platform !== 'darwin' || process.getuid?.() === 0)
      .each([false, true])(
      'honors macOS deletion ACLs when allowed is %s',
      async (allowed) => {
        const parent = join(session.state.workspaceRootPath, 'nested');
        const source = join(parent, 'note.txt');
        const destination = join(
          session.state.workspaceRootPath,
          'destination.txt',
        );
        const username = userInfo().username;
        await writeFile(destination, 'destination\n');
        try {
          if (allowed) {
            childProcess.execFileSync('/bin/chmod', [
              '+a',
              `${username} allow delete`,
              source,
            ]);
            await chmod(parent, 0o555);
          } else {
            childProcess.execFileSync('/bin/chmod', [
              '+a',
              `${username} deny delete`,
              source,
            ]);
            childProcess.execFileSync('/bin/chmod', [
              '+a',
              `${username} deny delete_child`,
              parent,
            ]);
          }
          const move = session.createEditor().updateFile({
            type: 'update_file',
            path: 'nested/note.txt',
            moveTo: 'destination.txt',
            diff: patch,
          });
          if (allowed) {
            await move;
            expect(await readFile(destination, 'utf8')).toBe('after\n');
            await expect(lstat(source)).rejects.toMatchObject({
              code: 'ENOENT',
            });
            return;
          }
          await expect(move).rejects.toThrow();
          expect(await readFile(destination, 'utf8')).toBe('destination\n');
          expect(await readFile(source, 'utf8')).toBe('before\n');
        } finally {
          await chmod(parent, 0o700);
          childProcess.execFileSync('/bin/chmod', ['-N', parent]);
          if (!allowed) {
            childProcess.execFileSync('/bin/chmod', ['-N', source]);
          }
        }
      },
    );

    it('unlinks a moved source relative to its opened parent after replacement', async () => {
      const nested = join(session.state.workspaceRootPath, 'nested');
      workerHook(`
original_unlink = os.unlink
def swapped_unlink(name, *args, **kwargs):
    if name == "note.txt":
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
        expect(worker.exitCode !== null || worker.signalCode !== null).toBe(
          true,
        );
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

    it('keeps the selected interpreter when the host environment changes', async () => {
      vi.stubEnv('OPENAI_AGENTS_PYTHON', join(root, 'missing-python'));
      await session.createEditor().createFile({
        type: 'create_file',
        path: 'new/note.txt',
        diff: '+created',
      });
      expect(
        await readFile(
          join(session.state.workspaceRootPath, 'new/note.txt'),
          'utf8',
        ),
      ).toBe('created');
      expect(session.fileIOBackend).toBe('python');
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
