import { execFileSync } from 'node:child_process';
import * as childProcess from 'node:child_process';
import {
  chmod,
  chown,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  Manifest,
  UnixLocalSandboxClient,
  UnixLocalSandboxSession,
} from '../../src/sandbox/local';
import { UNIX_LOCAL_FILE_WORKER } from '../../src/sandbox/sandboxes/shared/unixLocalFileWorker';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
}));

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
      vi.restoreAllMocks();
      await session?.close();
      if (root) await rm(root, { recursive: true, force: true });
    });

    it('lets a primary-group writer replace a foreign-owned file with a restrictive umask', async () => {
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

      const spawn = childProcess.spawn;
      vi.spyOn(childProcess, 'spawn').mockImplementation(((
        command: string,
        args: string[],
        options: childProcess.SpawnOptions,
      ) => {
        const rewritten = [...args];
        if (args.includes(UNIX_LOCAL_FILE_WORKER)) {
          // Set the real worker's umask without changing concurrent Vitest workers.
          rewritten[3] = `import os
os.umask(0o777)
${rewritten[3]}`;
        }
        return spawn(command, rewritten, options);
      }) as typeof childProcess.spawn);

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

      await session.createEditor('nobody').createFile({
        type: 'create_file',
        path: 'shared/new.txt',
        diff: '+new',
      });
      expect((await lstat(join(shared, 'new.txt'))).mode & 0o777).toBe(0);
      expect(await readFile(join(shared, 'new.txt'), 'utf8')).toBe('new');
    });

    it.each(['finish', 'stop'] as const)(
      'keeps pending foreign-owned replacement contents private from other processes of the selected user on %s',
      async (ending) => {
        const shared = join(workspace, 'shared');
        await mkdir(shared);
        await chown(shared, nobodyUid, nobodyGid);
        await chmod(shared, 0o1770);
        const file = join(shared, 'note.txt');
        await writeFile(file, 'before\n');
        await chown(file, 0, nobodyGid);
        await chmod(file, 0o660);
        const original = join(root, 'outside', 'note.txt');
        await link(file, original);
        const before = await lstat(original);

        const spawn = childProcess.spawn;
        let finishUpdate: (() => void) | undefined;
        let workerPid: number | undefined;
        vi.spyOn(childProcess, 'spawn').mockImplementation(((
          command: string,
          args: string[],
          options: childProcess.SpawnOptions,
        ) => {
          const child = spawn(command, args, options);
          if (args.includes(UNIX_LOCAL_FILE_WORKER)) {
            workerPid = child.pid;
            // Keep the worker pending after W until the private tree is inspected.
            const stdin = child.stdin!;
            const end = stdin.end.bind(stdin);
            vi.spyOn(stdin, 'end').mockImplementation(((chunk: string) => {
              stdin.write(chunk);
              finishUpdate = () => end();
              return stdin;
            }) as typeof stdin.end);
          }
          return child;
        }) as typeof childProcess.spawn);

        const update = session.createEditor('nobody').updateFile({
          type: 'update_file',
          path: 'shared/note.txt',
          diff: patch,
        });
        try {
          let stage!: string;
          await expect
            .poll(async () => {
              const candidates = (await readdir(shared)).filter((name) =>
                name.startsWith('.openai-agents-'),
              );
              if (candidates.length !== 1) return false;
              stage = join(shared, candidates[0]!);
              const entries = await readdir(stage, { recursive: true });
              return entries.some(
                (entry) => entry === 'content' || entry.endsWith('/content'),
              );
            })
            .toBe(true);

          const listing = childProcess.spawnSync(
            process.execPath,
            [
              '-e',
              "require('node:fs').readdirSync(process.argv[1], { recursive: true })",
              stage,
            ],
            { uid: nobodyUid, gid: nobodyGid, encoding: 'utf8' },
          );
          expect(listing.status).toBe(1);
          expect(listing.stderr).toContain('EACCES');
          if (process.platform === 'linux') {
            const descriptors = childProcess.spawnSync(
              process.execPath,
              [
                '-e',
                "require('node:fs').readdirSync(process.argv[1])",
                `/proc/${workerPid}/fd`,
              ],
              { uid: nobodyUid, gid: nobodyGid, encoding: 'utf8' },
            );
            expect(descriptors.status).toBe(1);
            expect(descriptors.stderr).toContain('EACCES');
          }

          if (ending === 'stop') {
            const cancelled = expect(update).rejects.toThrow(/cancelled/);
            await session.stop();
            await cancelled;
            finishUpdate = undefined;
          } else {
            finishUpdate!();
            finishUpdate = undefined;
            await update;
          }

          expect(await readFile(file, 'utf8')).toBe(
            ending === 'finish' ? 'after\n' : 'before\n',
          );
          expect(await readFile(original, 'utf8')).toBe('before\n');
          const retained = await lstat(original);
          const replacement = await lstat(file);
          expect([
            retained.ino,
            retained.uid,
            retained.gid,
            retained.mode,
          ]).toEqual([before.ino, before.uid, before.gid, before.mode]);
          if (ending === 'finish') expect(replacement.ino).not.toBe(before.ino);
          else expect(replacement.ino).toBe(before.ino);
          expect([replacement.uid, replacement.gid, replacement.mode]).toEqual([
            before.uid,
            before.gid,
            before.mode,
          ]);
          expect(await readdir(shared)).toEqual(['note.txt']);
        } finally {
          if (finishUpdate) {
            finishUpdate();
            await update;
          }
        }
      },
    );

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
