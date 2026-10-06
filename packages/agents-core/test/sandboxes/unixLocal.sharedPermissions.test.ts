import { execFileSync } from 'node:child_process';
import {
  chmod,
  chown,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  Manifest,
  UnixLocalSandboxClient,
  UnixLocalSandboxSession,
} from '../../src/sandbox/local';

const patch = '@@\n-before\n+after\n';
const supplementalGroup = process.env.UNIX_LOCAL_TEST_SUPPLEMENTAL_GID;

describe.skipIf(process.platform === 'win32' || process.getuid?.() !== 0)(
  'UnixLocal shared Unix permissions',
  () => {
    let root: string;
    let workspace: string;
    let session: UnixLocalSandboxSession;
    let nobodyUid: number;
    let nobodyGid: number;

    beforeAll(() => {
      nobodyUid = Number(
        execFileSync('id', ['-u', 'nobody'], { encoding: 'utf8' }),
      );
      nobodyGid = Number(
        execFileSync('id', ['-g', 'nobody'], { encoding: 'utf8' }),
      );
      expect(nobodyUid).not.toBe(0);
    });

    beforeEach(async () => {
      root = await realpath(
        await mkdtemp(join(tmpdir(), 'unix-local-shared-permissions-')),
      );
      await chmod(root, 0o755);
      await mkdir(join(root, 'outside'));
      session = await new UnixLocalSandboxClient({
        workspaceBaseDir: root,
      }).create(
        new Manifest({
          extraPathGrants: [{ path: join(root, 'outside'), readOnly: true }],
        }),
      );
      workspace = session.state.workspaceRootPath;
      await chmod(workspace, 0o755);
    });

    afterEach(async () => {
      await session?.close();
      if (root) await rm(root, { recursive: true, force: true });
    });

    it('lets a primary-group writer replace a foreign-owned file while preserving the owner and other hardlinks', async () => {
      const shared = join(workspace, 'shared');
      await mkdir(shared);
      await chown(shared, 0, nobodyGid);
      await chmod(shared, 0o2770);
      const file = join(shared, 'note.txt');
      await writeFile(file, 'before\n');
      await chown(file, 0, nobodyGid);
      await chmod(file, 0o660);
      const original = join(root, 'outside', 'note.txt');
      await link(file, original);
      const before = await lstat(original);

      await session.createEditor('nobody').updateFile({
        type: 'update_file',
        path: 'shared/note.txt',
        diff: patch,
      });

      expect(await readFile(file, 'utf8')).toBe('after\n');
      expect(await readFile(original, 'utf8')).toBe('before\n');
      const retained = await lstat(original);
      const replacement = await lstat(file);
      expect([retained.ino, retained.uid, retained.gid, retained.mode]).toEqual(
        [before.ino, before.uid, before.gid, before.mode],
      );
      expect(replacement.ino).not.toBe(before.ino);
      expect([replacement.uid, replacement.gid, replacement.mode]).toEqual([
        before.uid,
        before.gid,
        before.mode,
      ]);
    });

    // Set this only in a disposable root container whose account database already
    // assigns nobody to that group. Tests never edit the host account database.
    it.skipIf(!supplementalGroup)(
      'uses the selected account’s supplementary groups for directory traversal and reads',
      async () => {
        const gid = Number(supplementalGroup);
        expect(Number.isSafeInteger(gid)).toBe(true);
        expect(gid).not.toBe(nobodyGid);
        const accountGroups = execFileSync('id', ['-G', 'nobody'], {
          encoding: 'utf8',
        })
          .trim()
          .split(/\s+/u)
          .map(Number);
        expect(accountGroups).toContain(gid);

        const shared = join(workspace, 'supplemental');
        await mkdir(shared);
        await chown(shared, 0, gid);
        await chmod(shared, 0o750);
        const file = join(shared, 'note.txt');
        await writeFile(file, 'group readable\n');
        await chown(file, 0, gid);
        await chmod(file, 0o640);

        await expect(
          session.readFile({ path: 'supplemental/note.txt', runAs: 'nobody' }),
        ).resolves.toEqual(Buffer.from('group readable\n'));
        await expect(
          session.listDir({ path: 'supplemental', runAs: 'nobody' }),
        ).resolves.toContainEqual({
          name: 'note.txt',
          path: 'supplemental/note.txt',
          type: 'file',
        });
      },
    );
  },
);
