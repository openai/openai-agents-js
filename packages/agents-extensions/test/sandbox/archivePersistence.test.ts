import { execFile } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, test } from 'vitest';
import { Manifest, SandboxArchiveError } from '@openai/agents-core/sandbox';
import {
  hydrateRemoteWorkspaceTar,
  persistRemoteWorkspaceTar,
  validateWorkspaceTarArchive,
} from '../../src/sandbox/shared/archive';
import { makePaxRecord, makeTarArchive } from './tarFixture';

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'agents-export-test-'));
  tempDirs.push(directory);
  const root = join(directory, 'workspace');
  await mkdir(root);
  const archivePath = join(directory, "export's\narchive.tar");
  return { root, archivePath, archiveDirectory: `${archivePath}.d` };
}

async function runCommand(command: string, umask = '022') {
  try {
    const { stdout, stderr } = await execFileAsync('/bin/sh', [
      '-c',
      `umask ${umask}; ${command}`,
    ]);
    return { status: 0, stdout, stderr };
  } catch (error) {
    const failure = error as Error & {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      status: failure.code ?? 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

describe.skipIf(process.platform === 'win32')(
  'remote workspace export permissions',
  () => {
    test.each(['direct', 'nested', 'root alias', 'staging alias'])(
      'excludes only its own staging directory inside a %s workspace path',
      async (location) => {
        const { root: physicalRoot, archivePath: savedArchive } =
          await fixture();
        let root = physicalRoot;
        const stageName = 'stage[1]*?.tar.d';
        let parent = location === 'nested' ? join(root, 'cache') : root;
        if (location === 'root alias' || location === 'staging alias') {
          const alias = join(physicalRoot, '..', 'workspace-alias');
          await symlink(physicalRoot, alias);
          if (location === 'root alias') {
            root = alias;
          } else {
            parent = alias;
          }
        }
        await mkdir(parent, { recursive: true });
        const archivePath = join(parent, 'stage[1]*?.tar');
        await writeFile(
          join(parent, `${stageName}-keep.txt`),
          'prefix sibling',
        );
        await mkdir(join(root, 'other', stageName), { recursive: true });
        await writeFile(
          join(root, 'other', stageName, 'keep.txt'),
          'nested sibling',
        );
        const manifest = new Manifest({ root });
        const io = { mkdir, writeFile, readFile, runCommand };

        for (let cycle = 0; cycle < 2; cycle += 1) {
          const archive = await persistRemoteWorkspaceTar({
            providerName: 'LocalTest',
            manifest,
            archivePath,
            io,
          });
          await writeFile(savedArchive, archive);
          const { stdout } = await execFileAsync('tar', ['-tf', savedArchive]);
          const names = stdout.trim().split('\n');
          const stageRelPath =
            location === 'nested' ? `cache/${stageName}` : stageName;
          expect(names).not.toContain(`./${stageRelPath}/`);
          expect(names).toContain(`./${stageRelPath}-keep.txt`);
          expect(names).toContain(`./other/${stageName}/keep.txt`);
          await hydrateRemoteWorkspaceTar({
            providerName: 'LocalTest',
            manifest,
            data: archive,
            io,
          });
          await expect(stat(`${archivePath}.d`)).rejects.toMatchObject({
            code: 'ENOENT',
          });
          expect(
            await readFile(join(parent, `${stageName}-keep.txt`), 'utf8'),
          ).toBe('prefix sibling');
        }
      },
    );

    test.each(['022', '000'])(
      'keeps archive bytes private from creation with ambient umask %s',
      async (umask) => {
        const { root, archivePath, archiveDirectory } = await fixture();
        await writeFile(join(root, 'private.txt'), 'private workspace bytes', {
          mode: 0o600,
        });
        await writeFile(join(root, 'ephemeral.txt'), 'do not export');
        const directoryModes: number[] = [];
        let archiveMode: number | undefined;
        const archive = await persistRemoteWorkspaceTar({
          providerName: 'LocalTest',
          manifest: new Manifest({
            root,
            entries: {
              'ephemeral.txt': {
                type: 'file',
                content: 'do not export',
                ephemeral: true,
              },
            },
          }),
          archivePath,
          io: {
            mkdir,
            writeFile,
            readFile: async (path) => {
              archiveMode = (await stat(path)).mode & 0o777;
              return readFile(path);
            },
            runCommand: async (command) => {
              const result = await runCommand(command, umask);
              const info = await stat(archiveDirectory).catch(() => undefined);
              if (info) {
                directoryModes.push(info.mode & 0o777);
              }
              return result;
            },
          },
        });

        expect(directoryModes.length).toBeGreaterThan(0);
        expect(directoryModes.every((mode) => mode === 0o700)).toBe(true);
        expect(archiveMode).toBe(0o600);
        validateWorkspaceTarArchive(archive);
        expect(
          Buffer.from(archive).includes(Buffer.from('private workspace bytes')),
        ).toBe(true);
        expect(
          Buffer.from(archive).includes(Buffer.from('do not export')),
        ).toBe(false);
        await expect(stat(archiveDirectory)).rejects.toMatchObject({
          code: 'ENOENT',
        });
        expect((await stat(join(root, 'private.txt'))).mode & 0o777).toBe(
          0o600,
        );
      },
    );

    test('rejects sparse PAX files before clearing the workspace', async () => {
      const { root, archivePath } = await fixture();
      const sentinel = join(root, 'sentinel.txt');
      await writeFile(sentinel, 'keep');
      const archive = makeTarArchive([
        {
          name: 'sparse-pax',
          type: 'x',
          content: [
            makePaxRecord('GNU.sparse.size', '1048576'),
            makePaxRecord('GNU.sparse.numblocks', '1'),
            makePaxRecord('GNU.sparse.offset', '1048575'),
            makePaxRecord('GNU.sparse.numbytes', '1'),
          ].join(''),
        },
        { name: 'large.txt', content: 'x' },
      ]);
      const io = { mkdir, writeFile, readFile, runCommand };

      await expect(
        hydrateRemoteWorkspaceTar({
          providerName: 'LocalTest',
          manifest: new Manifest({ root }),
          archivePath,
          data: archive,
          archiveLimits: { maxExtractedBytes: 4 },
          io,
        }),
      ).rejects.toThrow(/PAX GNU.sparse.size override not allowed/);
      expect(await readFile(sentinel, 'utf8')).toBe('keep');
      await expect(stat(join(root, 'large.txt'))).rejects.toMatchObject({
        code: 'ENOENT',
      });

      const ordinaryArchive = makeTarArchive([
        {
          name: 'ordinary-pax',
          type: 'x',
          content: makePaxRecord('comment', 'ordinary metadata'),
        },
        { name: 'small.txt', content: 'ok' },
      ]);
      await hydrateRemoteWorkspaceTar({
        providerName: 'LocalTest',
        manifest: new Manifest({ root }),
        archivePath,
        data: ordinaryArchive,
        archiveLimits: { maxExtractedBytes: 4 },
        io,
      });
      expect(await readFile(join(root, 'small.txt'), 'utf8')).toBe('ok');
    });

    test.each(['file', 'symlink', 'fifo', 'directory'])(
      'rejects an existing %s without changing or removing it',
      async (kind) => {
        const { root, archivePath, archiveDirectory } = await fixture();
        const target = join(root, 'sentinel.txt');
        await writeFile(target, 'leave intact');
        if (kind === 'file') {
          await writeFile(archiveDirectory, 'leave intact', { mode: 0o644 });
        } else if (kind === 'symlink') {
          await symlink(target, archiveDirectory);
        } else if (kind === 'fifo') {
          await execFileAsync('mkfifo', [archiveDirectory]);
        } else {
          await mkdir(archiveDirectory);
          await writeFile(join(archiveDirectory, 'sentinel'), 'leave intact');
        }
        await expect(
          persistRemoteWorkspaceTar({
            providerName: 'LocalTest',
            manifest: new Manifest({ root }),
            archivePath,
            io: { mkdir, writeFile, readFile, runCommand },
          }),
        ).rejects.toThrow(SandboxArchiveError);
        expect(await readFile(target, 'utf8')).toBe('leave intact');
        const info = await lstat(archiveDirectory);
        expect(info.isSymbolicLink()).toBe(kind === 'symlink');
        expect(info.isFIFO()).toBe(kind === 'fifo');
        expect(info.isDirectory()).toBe(kind === 'directory');
        if (kind === 'file' || kind === 'symlink') {
          expect(await readFile(archiveDirectory, 'utf8')).toBe('leave intact');
        } else if (kind === 'directory') {
          expect(
            await readFile(join(archiveDirectory, 'sentinel'), 'utf8'),
          ).toBe('leave intact');
        }
      },
    );

    test.each(['empty', 'read failure'])(
      'cleans up the reserved archive after %s export',
      async (scenario) => {
        const { root, archivePath, archiveDirectory } = await fixture();
        const result = persistRemoteWorkspaceTar({
          providerName: 'LocalTest',
          manifest: new Manifest({ root }),
          archivePath,
          io: {
            mkdir,
            writeFile,
            runCommand,
            readFile: async (path) => {
              if (scenario === 'read failure') {
                throw new Error('download failed');
              }
              return readFile(path);
            },
          },
        });
        if (scenario === 'read failure') {
          await expect(result).rejects.toThrow(SandboxArchiveError);
        } else {
          validateWorkspaceTarArchive(await result);
        }
        await expect(stat(archiveDirectory)).rejects.toMatchObject({
          code: 'ENOENT',
        });
      },
    );
  },
);
