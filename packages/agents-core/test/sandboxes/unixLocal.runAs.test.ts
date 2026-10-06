import { execFileSync } from 'node:child_process';
import {
  chmod,
  chown,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  Manifest,
  UnixLocalSandboxClient,
  UnixLocalSandboxSession,
} from '../../src/sandbox/local';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
  'base64',
);
const patch = '@@\n-before\n+after\n';

describe.skipIf(process.platform === 'win32' || process.getuid?.() !== 0)(
  'UnixLocal filesystem runAs with real Unix permissions',
  () => {
    let root: string;
    let workspace: string;
    let session: UnixLocalSandboxSession;
    let uid: number;
    let gid: number;

    beforeAll(() => {
      uid = Number(execFileSync('id', ['-u', 'nobody'], { encoding: 'utf8' }));
      gid = Number(execFileSync('id', ['-g', 'nobody'], { encoding: 'utf8' }));
      expect(uid).not.toBe(0);
      expect(gid).not.toBe(process.getgid?.());
    });

    beforeEach(async () => {
      root = await realpath(
        await mkdtemp(join(tmpdir(), 'unix-local-run-as-')),
      );
      session = await new UnixLocalSandboxClient({
        workspaceBaseDir: root,
        fileIOProtection: 'required',
      }).create(new Manifest({ entries: {} }));
      workspace = session.state.workspaceRootPath;
      await chmod(root, 0o755);
      await chmod(workspace, 0o755);
      await writeFile(join(workspace, 'secret.txt'), 'private\n', {
        mode: 0o600,
      });
      await writeFile(join(workspace, 'secret.png'), png, { mode: 0o600 });
      await mkdir(join(workspace, 'private'), { mode: 0o700 });
      await writeFile(join(workspace, 'private/note.txt'), 'before\n');
      await mkdir(join(workspace, 'private/child'));
      await mkdir(join(workspace, 'owned'), { mode: 0o700 });
      await chown(join(workspace, 'owned'), uid, gid);
    });

    afterEach(async () => {
      await session?.close();
      if (root) await rm(root, { recursive: true, force: true });
    });

    it('reads an owner-only file as root and denies the same read as nobody', async () => {
      expect(
        Buffer.from(
          await session.readFile({
            path: 'secret.txt',
            runAs: userInfo().username,
          }),
        ).toString(),
      ).toBe('private\n');
      await expect(
        session.readFile({ path: 'secret.txt', runAs: 'nobody' }),
      ).rejects.toMatchObject({ code: 'EACCES' });
    });

    it('opens image bytes with the selected identity', async () => {
      await expect(
        session.viewImage({ path: 'secret.png' }),
      ).resolves.toMatchObject({
        image: { data: Uint8Array.from(png), mediaType: 'image/png' },
      });
      await expect(
        session.viewImage({ path: 'secret.png', runAs: 'nobody' }),
      ).rejects.toMatchObject({ code: 'EACCES' });
    });

    it('does not list another user’s private directory', async () => {
      expect(await session.listDir({ path: 'private' })).toContainEqual({
        name: 'note.txt',
        path: 'private/note.txt',
        type: 'file',
      });
      await expect(
        session.listDir({ path: 'private', runAs: 'nobody' }),
      ).rejects.toMatchObject({ code: 'EACCES' });
    });

    it('checks search permission on ancestors without hiding stat-able leaves', async () => {
      await expect(session.pathExists('private/note.txt')).resolves.toBe(true);
      await expect(session.pathExists('secret.txt', 'nobody')).resolves.toBe(
        true,
      );
      await expect(session.pathExists('missing.txt', 'nobody')).resolves.toBe(
        false,
      );
      await expect(
        session.pathExists('private/note.txt', 'nobody'),
      ).rejects.toMatchObject({ code: 'EACCES' });
      await expect(session.directoryExists('private')).resolves.toBe(true);
      await expect(session.directoryExists('private', 'nobody')).resolves.toBe(
        false,
      );
      await expect(
        session.directoryExists('private/child', 'nobody'),
      ).rejects.toMatchObject({ code: 'EACCES' });
    });

    it('does not retain the privileged host group for filesystem reads', async () => {
      await writeFile(join(workspace, 'host-group.txt'), 'host group only', {
        mode: 0o640,
      });
      await expect(
        session.readFile({ path: 'host-group.txt' }),
      ).resolves.toEqual(Buffer.from('host group only'));
      await expect(
        session.readFile({ path: 'host-group.txt', runAs: 'nobody' }),
      ).rejects.toMatchObject({ code: 'EACCES' });
    });

    it('denies creating files or parent directories under an inaccessible directory', async () => {
      await expect(
        session.createEditor('nobody').createFile({
          type: 'create_file',
          path: 'private/new/note.txt',
          diff: '+not allowed',
        }),
      ).rejects.toMatchObject({ code: 'EACCES' });
      await expect(lstat(join(workspace, 'private/new'))).rejects.toMatchObject(
        {
          code: 'ENOENT',
        },
      );
    });

    it('denies updating another user’s private file', async () => {
      await expect(
        session.createEditor('nobody').updateFile({
          type: 'update_file',
          path: 'private/note.txt',
          diff: patch,
        }),
      ).rejects.toMatchObject({ code: 'EACCES' });
      expect(await readFile(join(workspace, 'private/note.txt'), 'utf8')).toBe(
        'before\n',
      );
    });

    it('preserves the source if a move cannot write to the destination', async () => {
      const source = join(workspace, 'owned/source.txt');
      await writeFile(source, 'before\n');
      await chown(source, uid, gid);
      await expect(
        session.createEditor('nobody').updateFile({
          type: 'update_file',
          path: 'owned/source.txt',
          moveTo: 'private/new/note.txt',
          diff: patch,
        }),
      ).rejects.toMatchObject({ code: 'EACCES' });
      expect(await readFile(source, 'utf8')).toBe('before\n');
      await expect(lstat(join(workspace, 'private/new'))).rejects.toMatchObject(
        {
          code: 'ENOENT',
        },
      );
    });

    it.each([
      [0o755, 'EACCES'],
      [0o1777, 'EPERM'],
    ])(
      'leaves both files unchanged when source removal is denied (%i)',
      async (mode, code) => {
        const directory = join(workspace, 'source-parent');
        const source = join(directory, 'note.txt');
        const destination = join(workspace, 'owned/destination.txt');
        await mkdir(directory, { mode: mode as number });
        await chmod(directory, mode as number);
        await writeFile(source, 'before\n', { mode: 0o644 });
        await writeFile(destination, 'destination\n');
        await chown(destination, uid, gid);
        await expect(
          session.createEditor('nobody').updateFile({
            type: 'update_file',
            path: 'source-parent/note.txt',
            moveTo: 'owned/destination.txt',
            diff: patch,
          }),
        ).rejects.toMatchObject({ code });
        expect(await readFile(source, 'utf8')).toBe('before\n');
        expect(await readFile(destination, 'utf8')).toBe('destination\n');
      },
    );

    it('denies deleting an entry in another user’s private directory', async () => {
      await expect(
        session.createEditor('nobody').deleteFile({
          type: 'delete_file',
          path: 'private/note.txt',
        }),
      ).rejects.toMatchObject({ code: 'EACCES' });
      expect(await readFile(join(workspace, 'private/note.txt'), 'utf8')).toBe(
        'before\n',
      );
    });

    it('requires write access to an existing file even in a writable directory', async () => {
      const protectedFile = join(workspace, 'owned/protected.txt');
      const source = join(workspace, 'owned/source.txt');
      await writeFile(protectedFile, 'protected\n', { mode: 0o400 });
      await writeFile(source, 'before\n');
      await chown(protectedFile, uid, gid);
      await chown(source, uid, gid);
      const editor = session.createEditor('nobody');
      await expect(
        editor.updateFile({
          type: 'update_file',
          path: 'owned/protected.txt',
          diff: '@@\n-protected\n+changed\n',
        }),
      ).rejects.toMatchObject({ code: 'EACCES' });
      await expect(
        editor.updateFile({
          type: 'update_file',
          path: 'owned/source.txt',
          moveTo: 'owned/protected.txt',
          diff: patch,
        }),
      ).rejects.toMatchObject({ code: 'EACCES' });
      expect(await readFile(protectedFile, 'utf8')).toBe('protected\n');
      expect(await readFile(source, 'utf8')).toBe('before\n');
    });

    it.each(['grant', 'local_bind'] as const)(
      'checks the original %s source before following its alias',
      async (kind) => {
        const source = join(workspace, 'private/source');
        const target = join(workspace, 'owned');
        await symlink(target, source);
        await writeFile(join(target, 'note.txt'), 'before\n');
        await chown(join(target, 'note.txt'), uid, gid);
        const manifest =
          kind === 'grant'
            ? new Manifest({
                extraPathGrants: [{ path: source, readOnly: false }],
              })
            : new Manifest({
                entries: {
                  mounted: {
                    type: 'mount',
                    source,
                    readOnly: false,
                    mountStrategy: { type: 'local_bind' },
                  },
                },
              });
        const granted = await new UnixLocalSandboxClient({
          workspaceBaseDir: root,
        }).create(manifest);
        try {
          await chmod(granted.state.workspaceRootPath, 0o755);
          const path =
            kind === 'grant' ? join(source, 'note.txt') : 'mounted/note.txt';
          await expect(
            granted.readFile({ path, runAs: 'nobody' }),
          ).rejects.toMatchObject({ code: 'EACCES' });
          await expect(
            granted.createEditor('nobody').updateFile({
              type: 'update_file',
              path,
              diff: patch,
            }),
          ).rejects.toMatchObject({ code: 'EACCES' });
          expect(await readFile(join(target, 'note.txt'), 'utf8')).toBe(
            'before\n',
          );
          await chmod(join(workspace, 'private'), 0o755);
          await expect(
            granted.readFile({ path, runAs: 'nobody' }),
          ).resolves.toEqual(Buffer.from('before\n'));
          await granted.createEditor('nobody').updateFile({
            type: 'update_file',
            path,
            diff: patch,
          });
          expect(await readFile(join(target, 'note.txt'), 'utf8')).toBe(
            'after\n',
          );
        } finally {
          await granted.close();
        }
      },
    );

    describe('contained symlinks with inaccessible ancestors', () => {
      beforeEach(async () => {
        for (const name of [
          'readable.txt',
          'update.txt',
          'delete.txt',
          'source.txt',
        ]) {
          const path = join(workspace, 'owned', name);
          await writeFile(path, 'before\n');
          await chown(path, uid, gid);
        }
        const image = join(workspace, 'owned/image.png');
        await writeFile(image, png);
        await chown(image, uid, gid);
        await mkdir(join(workspace, 'owned/child'));
        await chown(join(workspace, 'owned/child'), uid, gid);
        await symlink(
          '../owned/readable.txt',
          join(workspace, 'private/readable-link.txt'),
        );
        await symlink(
          '../owned/image.png',
          join(workspace, 'private/image-link.png'),
        );
        await symlink(
          '../owned/update.txt',
          join(workspace, 'private/update-link.txt'),
        );
        await symlink('../owned', join(workspace, 'private/directory-link'));
        await symlink('owned', join(workspace, 'available'));
        await symlink(
          'owned/readable.txt',
          join(workspace, 'readable-link.txt'),
        );
      });

      it('denies reads and stats when leaf symlinks are behind a private ancestor', async () => {
        await expect
          .soft(
            session.readFile({
              path: 'private/readable-link.txt',
              runAs: 'nobody',
            }),
          )
          .rejects.toMatchObject({ code: 'EACCES' });
        await expect
          .soft(
            session.viewImage({
              path: 'private/image-link.png',
              runAs: 'nobody',
            }),
          )
          .rejects.toMatchObject({ code: 'EACCES' });
        await expect
          .soft(session.pathExists('private/readable-link.txt', 'nobody'))
          .rejects.toMatchObject({ code: 'EACCES' });
        await expect
          .soft(
            session.listDir({
              path: 'private/directory-link',
              runAs: 'nobody',
            }),
          )
          .rejects.toMatchObject({ code: 'EACCES' });
        await expect
          .soft(session.directoryExists('private/directory-link', 'nobody'))
          .rejects.toMatchObject({ code: 'EACCES' });
      });

      it('checks the original ancestors of intermediate directory symlinks', async () => {
        await expect
          .soft(
            session.readFile({
              path: 'private/directory-link/readable.txt',
              runAs: 'nobody',
            }),
          )
          .rejects.toMatchObject({ code: 'EACCES' });
        await expect
          .soft(
            session.viewImage({
              path: 'private/directory-link/image.png',
              runAs: 'nobody',
            }),
          )
          .rejects.toMatchObject({ code: 'EACCES' });
        await expect
          .soft(
            session.pathExists('private/directory-link/readable.txt', 'nobody'),
          )
          .rejects.toMatchObject({ code: 'EACCES' });
        await expect
          .soft(
            session.listDir({
              path: 'private/directory-link/child',
              runAs: 'nobody',
            }),
          )
          .rejects.toMatchObject({ code: 'EACCES' });
        await expect
          .soft(
            session.directoryExists('private/directory-link/child', 'nobody'),
          )
          .rejects.toMatchObject({ code: 'EACCES' });
      });

      it('denies edits through a private ancestor and leaves all targets intact', async () => {
        const editor = session.createEditor('nobody');
        await expect
          .soft(
            editor.createFile({
              type: 'create_file',
              path: 'private/directory-link/new/created.txt',
              diff: '+created',
            }),
          )
          .rejects.toMatchObject({ code: 'EACCES' });
        await expect
          .soft(
            editor.updateFile({
              type: 'update_file',
              path: 'private/update-link.txt',
              diff: patch,
            }),
          )
          .rejects.toMatchObject({ code: 'EACCES' });
        await expect
          .soft(
            editor.deleteFile({
              type: 'delete_file',
              path: 'private/directory-link/delete.txt',
            }),
          )
          .rejects.toMatchObject({ code: 'EACCES' });
        await expect
          .soft(
            editor.updateFile({
              type: 'update_file',
              path: 'owned/source.txt',
              moveTo: 'private/directory-link/moved/destination.txt',
              diff: patch,
            }),
          )
          .rejects.toMatchObject({ code: 'EACCES' });
        for (const name of ['update.txt', 'delete.txt', 'source.txt']) {
          await expect
            .soft(readFile(join(workspace, 'owned', name), 'utf8'))
            .resolves.toBe('before\n');
        }
        for (const name of ['new', 'moved']) {
          await expect
            .soft(lstat(join(workspace, 'owned', name)))
            .rejects.toMatchObject({ code: 'ENOENT' });
        }
      });

      it('reads and edits through contained symlinks that nobody can traverse', async () => {
        await expect(
          session.readFile({ path: 'readable-link.txt', runAs: 'nobody' }),
        ).resolves.toEqual(Buffer.from('before\n'));
        await expect(
          session.viewImage({ path: 'available/image.png', runAs: 'nobody' }),
        ).resolves.toMatchObject({
          image: { data: Uint8Array.from(png), mediaType: 'image/png' },
        });
        await expect(
          session.pathExists('available/readable.txt', 'nobody'),
        ).resolves.toBe(true);
        await expect(
          session.directoryExists('available/child', 'nobody'),
        ).resolves.toBe(true);
        expect(
          await session.listDir({ path: 'available', runAs: 'nobody' }),
        ).toContainEqual({
          name: 'readable.txt',
          path: 'available/readable.txt',
          type: 'file',
        });
        const editor = session.createEditor('nobody');
        await editor.createFile({
          type: 'create_file',
          path: 'available/new/created.txt',
          diff: '+before\n+',
        });
        await editor.updateFile({
          type: 'update_file',
          path: 'available/new/created.txt',
          moveTo: 'available/moved/destination.txt',
          diff: patch,
        });
        await expect(
          readFile(join(workspace, 'owned/moved/destination.txt'), 'utf8'),
        ).resolves.toBe('after\n');
        await editor.deleteFile({
          type: 'delete_file',
          path: 'available/moved/destination.txt',
        });
        await expect(
          lstat(join(workspace, 'owned/moved/destination.txt')),
        ).rejects.toMatchObject({
          code: 'ENOENT',
        });
      });
    });

    it('creates, patches, moves and deletes files in a directory owned by nobody', async () => {
      const editor = session.createEditor('nobody');
      await editor.createFile({
        type: 'create_file',
        path: 'owned/new/deep/note.txt',
        diff: '+before\n+',
      });
      for (const path of [
        'owned/new',
        'owned/new/deep',
        'owned/new/deep/note.txt',
      ]) {
        await expect(lstat(join(workspace, path))).resolves.toMatchObject({
          uid,
          gid,
        });
      }
      const original = join(workspace, 'owned/new/deep/note.txt');
      await chmod(original, 0o640);
      await editor.updateFile({
        type: 'update_file',
        path: 'owned/new/deep/note.txt',
        diff: patch,
      });
      expect(await readFile(original, 'utf8')).toBe('after\n');
      const info = await lstat(original);
      expect([info.uid, info.gid, info.mode & 0o777]).toEqual([
        uid,
        gid,
        0o640,
      ]);
      await editor.updateFile({
        type: 'update_file',
        path: 'owned/new/deep/note.txt',
        moveTo: 'owned/moved/note.txt',
        diff: '@@\n-after\n+moved\n',
      });
      await expect(lstat(original)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(
        await readFile(join(workspace, 'owned/moved/note.txt'), 'utf8'),
      ).toBe('moved\n');
      for (const path of ['owned/moved', 'owned/moved/note.txt']) {
        await expect(lstat(join(workspace, path))).resolves.toMatchObject({
          uid,
          gid,
        });
      }
      await editor.deleteFile({
        type: 'delete_file',
        path: 'owned/moved/note.txt',
      });
      await expect(
        lstat(join(workspace, 'owned/moved/note.txt')),
      ).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  },
);
