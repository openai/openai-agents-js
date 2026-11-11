import { execFile } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  Manifest,
  SandboxArchiveError,
  mount,
} from '@openai/agents-core/sandbox';
import {
  hydrateRemoteWorkspaceTar,
  persistRemoteWorkspaceTar,
  validateWorkspaceTarArchive,
} from '../../src/sandbox/shared/archive';
import { shellQuote } from '../../src/sandbox/shared/paths';
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
            manifest: new Manifest({ root: physicalRoot }),
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

    test.each([true, false])(
      'preserves a nested mounted subtree during hydration (ephemeral: %s)',
      async (ephemeral) => {
        const { root, archivePath } = await fixture();
        const mountPath = join(root, 'cache', 'mounted[1]*?');
        await mkdir(mountPath, { recursive: true });
        await writeFile(join(mountPath, 'remote.txt'), 'remote object');
        await writeFile(join(root, 'ephemeral.txt'), 'local runtime data');
        await writeFile(join(root, 'cache', 'stale.txt'), 'stale');
        await writeFile(join(root, 'stale.txt'), 'stale');
        const manifest = new Manifest({
          root,
          entries: {
            'ephemeral.txt': {
              type: 'file',
              content: 'local runtime data',
              ephemeral: true,
            },
            remote: mount({
              source: 's3://bucket/data',
              mountPath: 'cache/mounted[1]*?',
              ephemeral,
              mountStrategy: { type: 'in_container' },
            }),
          },
        });

        await hydrateRemoteWorkspaceTar({
          providerName: 'LocalTest',
          manifest,
          archivePath,
          data: makeTarArchive([{ name: 'fresh.txt', content: 'fresh' }]),
          io: { mkdir, writeFile, readFile, runCommand },
        });

        expect(await readFile(join(mountPath, 'remote.txt'), 'utf8')).toBe(
          'remote object',
        );
        expect(await readFile(join(root, 'ephemeral.txt'), 'utf8')).toBe(
          'local runtime data',
        );
        expect(await readFile(join(root, 'fresh.txt'), 'utf8')).toBe('fresh');
        await expect(stat(join(root, 'stale.txt'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
        await expect(
          stat(join(root, 'cache', 'stale.txt')),
        ).rejects.toMatchObject({
          code: 'ENOENT',
        });
      },
    );

    test('preserves ephemeral data reached through an alias', async () => {
      const { root, archivePath } = await fixture();
      await mkdir(join(root, 'physical'));
      await symlink(join(root, 'physical'), join(root, 'alias'));
      await writeFile(join(root, 'physical', 'runtime.txt'), 'runtime data');
      await writeFile(join(root, 'physical', 'stale.txt'), 'stale');
      await hydrateRemoteWorkspaceTar({
        providerName: 'LocalTest',
        manifest: new Manifest({
          root,
          entries: {
            'alias/runtime.txt': {
              type: 'file',
              content: 'runtime data',
              ephemeral: true,
            },
          },
        }),
        archivePath,
        data: makeTarArchive([{ name: 'fresh.txt', content: 'fresh' }]),
        io: { mkdir, writeFile, readFile, runCommand },
      });
      expect(await readFile(join(root, 'alias', 'runtime.txt'), 'utf8')).toBe(
        'runtime data',
      );
      await expect(
        stat(join(root, 'physical', 'stale.txt')),
      ).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(await readFile(join(root, 'fresh.txt'), 'utf8')).toBe('fresh');
    });

    test('rejects archive writes into a non-ephemeral mount before cleanup', async () => {
      const { root, archivePath } = await fixture();
      const mountPath = join(root, 'cache', 'mounted');
      await mkdir(mountPath, { recursive: true });
      await writeFile(join(mountPath, 'remote.txt'), 'remote object');
      await writeFile(join(root, 'stale.txt'), 'keep on rejection');
      const manifest = new Manifest({
        root,
        entries: {
          remote: mount({
            source: 's3://bucket/data',
            mountPath: 'cache/mounted',
            ephemeral: false,
            mountStrategy: { type: 'in_container' },
          }),
        },
      });

      await expect(
        hydrateRemoteWorkspaceTar({
          providerName: 'LocalTest',
          manifest,
          archivePath,
          data: makeTarArchive([
            { name: 'cache/mounted/remote.txt', content: 'untrusted' },
          ]),
          io: { mkdir, writeFile, readFile, runCommand },
        }),
      ).rejects.toThrow('archive member overlaps protected path');
      expect(await readFile(join(mountPath, 'remote.txt'), 'utf8')).toBe(
        'remote object',
      );
      expect(await readFile(join(root, 'stale.txt'), 'utf8')).toBe(
        'keep on rejection',
      );
      await expect(stat(archivePath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    test('preserves a mount reached through a symlinked ancestor', async () => {
      const { root, archivePath } = await fixture();
      const mountPath = join(root, 'physical', 'mounted');
      await mkdir(mountPath, { recursive: true });
      await writeFile(join(mountPath, 'remote.txt'), 'remote object');
      await writeFile(join(root, 'stale.txt'), 'stale');
      await symlink(join(root, 'physical'), join(root, 'alias'));
      const manifest = new Manifest({
        root,
        entries: {
          remote: mount({
            source: 's3://bucket/data',
            mountPath: 'alias/mounted',
            mountStrategy: { type: 'in_container' },
          }),
        },
      });

      await hydrateRemoteWorkspaceTar({
        providerName: 'LocalTest',
        manifest,
        archivePath,
        data: makeTarArchive([]),
        io: { mkdir, writeFile, readFile, runCommand },
      });
      expect(await readFile(join(mountPath, 'remote.txt'), 'utf8')).toBe(
        'remote object',
      );
      await expect(stat(join(root, 'stale.txt'))).rejects.toMatchObject({
        code: 'ENOENT',
      });

      await writeFile(join(root, 'later.txt'), 'keep on rejection');
      await expect(
        hydrateRemoteWorkspaceTar({
          providerName: 'LocalTest',
          manifest,
          archivePath,
          data: makeTarArchive([
            { name: 'physical/mounted/remote.txt', content: 'untrusted' },
          ]),
          io: { mkdir, writeFile, readFile, runCommand },
        }),
      ).rejects.toThrow('archive member overlaps protected path');
      expect(await readFile(join(mountPath, 'remote.txt'), 'utf8')).toBe(
        'remote object',
      );
      expect(await readFile(join(root, 'later.txt'), 'utf8')).toBe(
        'keep on rejection',
      );

      await expect(
        hydrateRemoteWorkspaceTar({
          providerName: 'LocalTest',
          manifest,
          archivePath,
          data: makeTarArchive([{ name: 'alias/', type: '5', mode: 0o755 }]),
          io: { mkdir, writeFile, readFile, runCommand },
        }),
      ).rejects.toThrow('archive member overlaps protected path');
      expect((await lstat(join(root, 'alias'))).isSymbolicLink()).toBe(true);
      expect(
        await readFile(join(root, 'alias', 'mounted', 'remote.txt'), 'utf8'),
      ).toBe('remote object');
    });

    test('rejects hydration after an attached mount alias changes', async () => {
      const { root, archivePath } = await fixture();
      const mountPath = join(root, 'physical', 'mounted');
      await mkdir(mountPath, { recursive: true });
      await mkdir(join(root, 'other', 'mounted'), { recursive: true });
      await symlink(join(root, 'physical'), join(root, 'alias'));
      await writeFile(join(mountPath, 'remote.txt'), 'remote object');
      const manifest = new Manifest({
        root,
        entries: {
          remote: mount({
            source: 's3://bucket/data',
            mountPath: 'alias/mounted',
            mountStrategy: { type: 'in_container' },
          }),
        },
      });
      await rm(join(root, 'alias'));
      await symlink(join(root, 'other'), join(root, 'alias'));

      await expect(
        hydrateRemoteWorkspaceTar({
          providerName: 'LocalTest',
          manifest,
          archivePath,
          activeMountPaths: [mountPath],
          data: makeTarArchive([{ name: 'fresh.txt', content: 'fresh' }]),
          io: { mkdir, writeFile, readFile, runCommand },
        }),
      ).rejects.toThrow(
        'Workspace mount no longer matches an active attachment',
      );

      expect(await readFile(join(mountPath, 'remote.txt'), 'utf8')).toBe(
        'remote object',
      );
      await expect(stat(join(root, 'fresh.txt'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      await expect(stat(archivePath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    test('rejects an effective filesystem root before archive IO', async () => {
      const { root, archivePath } = await fixture();
      await rm(root, { recursive: true });
      await symlink('/', root);
      const commands: string[] = [];
      const write = vi.fn(async () => {
        throw new Error('Unexpected archive upload');
      });
      const args = {
        providerName: 'LocalTest',
        manifest: new Manifest({ root }),
        archivePath,
        io: {
          mkdir,
          writeFile: write,
          readFile,
          runCommand: async (command: string) => {
            commands.push(command);
            if (command.includes('find ') || command.includes('tar ')) {
              return { status: 53 };
            }
            return runCommand(command);
          },
        },
      };

      await expect(persistRemoteWorkspaceTar(args)).rejects.toThrow(
        'filesystem root',
      );
      await expect(
        hydrateRemoteWorkspaceTar({
          ...args,
          data: makeTarArchive([{ name: 'fresh.txt', content: 'fresh' }]),
        }),
      ).rejects.toThrow('filesystem root');

      expect(write).not.toHaveBeenCalled();
      expect(
        commands.some(
          (command) => command.includes('find ') || command.includes('tar '),
        ),
      ).toBe(false);
    });

    test.each(['other', 'filesystem'])(
      'rejects root retargeting to %s before cleanup or extraction',
      async (kind) => {
        const { root, archivePath } = await fixture();
        const directory = join(root, '..');
        const moved = join(directory, 'moved');
        const other = join(directory, 'other');
        const bin = join(directory, 'bin');
        const called = join(directory, 'mutation-called');
        const attached = join(root, 'mounted');
        await mkdir(attached);
        await mkdir(other);
        await mkdir(bin);
        await writeFile(join(attached, 'remote.txt'), 'remote object');
        await writeFile(join(root, 'stale.txt'), 'original workspace');
        await writeFile(join(other, 'sentinel.txt'), 'outside workspace');
        for (const name of ['find', 'tar']) {
          await writeFile(
            join(bin, name),
            `#!/bin/sh\nprintf called >> ${shellQuote(called)}\nexit 53\n`,
            { mode: 0o700 },
          );
        }
        const manifest = new Manifest({
          root,
          entries: {
            data: mount({
              source: 's3://bucket/data',
              mountPath: 'mounted',
              mountStrategy: { type: 'in_container' },
              ephemeral: false,
            }),
          },
        });
        await expect(
          hydrateRemoteWorkspaceTar({
            providerName: 'LocalTest',
            manifest,
            archivePath,
            activeMountPaths: [attached],
            data: makeTarArchive([{ name: 'fresh.txt', content: 'fresh' }]),
            io: {
              mkdir,
              writeFile,
              readFile,
              runCommand: async (command: string) => {
                if (command.includes('find ') && command.includes('tar -C')) {
                  await rename(root, moved);
                  await symlink(kind === 'filesystem' ? '/' : other, root);
                  return runCommand(
                    `PATH=${shellQuote(`${bin}:/usr/bin:/bin`)} /bin/sh -c ${shellQuote(command)}`,
                  );
                }
                return runCommand(command);
              },
            },
          }),
        ).rejects.toBeInstanceOf(SandboxArchiveError);

        await expect(stat(called)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(join(moved, 'stale.txt'), 'utf8')).toBe(
          'original workspace',
        );
        expect(
          await readFile(join(moved, 'mounted', 'remote.txt'), 'utf8'),
        ).toBe('remote object');
        expect(await readFile(join(other, 'sentinel.txt'), 'utf8')).toBe(
          'outside workspace',
        );
      },
    );

    test('keeps cleanup and extraction in the bound workspace when its path changes', async () => {
      const { root, archivePath } = await fixture();
      const directory = join(root, '..');
      const moved = join(directory, 'moved');
      const other = join(directory, 'other');
      const bin = join(directory, 'bin');
      const attached = join(root, 'mounted');
      await mkdir(attached);
      await mkdir(other);
      await mkdir(bin);
      await writeFile(join(root, 'stale.txt'), 'remove during restore');
      await writeFile(join(attached, 'remote.txt'), 'remote object');
      await writeFile(join(other, 'sentinel.txt'), 'outside workspace');
      await writeFile(
        join(bin, 'find'),
        `#!/bin/sh\nmv -- ${shellQuote(root)} ${shellQuote(moved)} && ln -s -- ${shellQuote(other)} ${shellQuote(root)} && exec /usr/bin/find "$@"\n`,
        { mode: 0o700 },
      );
      await hydrateRemoteWorkspaceTar({
        providerName: 'LocalTest',
        manifest: new Manifest({
          root,
          entries: {
            data: mount({
              source: 's3://bucket/data',
              mountPath: 'mounted',
              mountStrategy: { type: 'in_container' },
              ephemeral: false,
            }),
          },
        }),
        archivePath,
        activeMountPaths: [attached],
        data: makeTarArchive([
          { name: 'saved.txt', content: 'restored workspace' },
        ]),
        io: {
          mkdir,
          writeFile,
          readFile,
          runCommand: async (command: string) => {
            if (command.includes('find ') && command.includes('tar -C')) {
              return runCommand(
                `PATH=${shellQuote(`${bin}:/usr/bin:/bin`)} /bin/sh -c ${shellQuote(command)}`,
              );
            }
            return runCommand(command);
          },
        },
      });

      await expect(stat(join(moved, 'stale.txt'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(await readFile(join(moved, 'saved.txt'), 'utf8')).toBe(
        'restored workspace',
      );
      expect(await readFile(join(moved, 'mounted', 'remote.txt'), 'utf8')).toBe(
        'remote object',
      );
      expect(await readFile(join(other, 'sentinel.txt'), 'utf8')).toBe(
        'outside workspace',
      );
      await expect(stat(join(other, 'saved.txt'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });

    test('checks retained attachments before exporting an empty mounted workspace root', async () => {
      const { root, archivePath } = await fixture();
      const attached = join(root, 'physical');
      const other = join(root, 'other');
      const alias = join(root, 'alias');
      await mkdir(attached);
      await mkdir(other);
      await symlink(attached, alias);
      await writeFile(join(attached, 'remote.txt'), 'remote object');
      const args = {
        providerName: 'LocalTest',
        manifest: new Manifest({
          root: alias,
          entries: {
            remote: mount({
              source: 's3://bucket/data',
              mountPath: alias,
              mountStrategy: { type: 'in_container' },
              ephemeral: false,
              readOnly: true,
            }),
          },
        }),
        archivePath,
        activeMountPaths: [attached],
        io: { mkdir, writeFile, readFile, runCommand },
      };
      validateWorkspaceTarArchive(await persistRemoteWorkspaceTar(args));
      await rm(alias);
      await symlink(other, alias);

      await expect(persistRemoteWorkspaceTar(args)).rejects.toThrow(
        'Workspace mount no longer matches an active attachment',
      );

      expect(await readFile(join(attached, 'remote.txt'), 'utf8')).toBe(
        'remote object',
      );
      await expect(stat(`${archivePath}.d`)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });

    test('does not extract through another alias into a mounted subtree', async () => {
      const { root, archivePath } = await fixture();
      const mountPath = join(root, 'physical', 'mounted');
      await mkdir(mountPath, { recursive: true });
      await symlink(join(root, 'physical'), join(root, 'otheralias'));
      await writeFile(join(mountPath, 'remote.txt'), 'remote object');
      const manifest = new Manifest({
        root,
        entries: {
          remote: mount({
            source: 's3://bucket/data',
            mountPath: 'physical/mounted',
            mountStrategy: { type: 'in_container' },
          }),
        },
      });

      await hydrateRemoteWorkspaceTar({
        providerName: 'LocalTest',
        manifest,
        archivePath,
        activeMountPaths: [mountPath],
        data: makeTarArchive([
          { name: 'otheralias/mounted/remote.txt', content: 'local copy' },
        ]),
        io: { mkdir, writeFile, readFile, runCommand },
      });
      expect(await readFile(join(mountPath, 'remote.txt'), 'utf8')).toBe(
        'remote object',
      );
      expect(
        await readFile(
          join(root, 'otheralias', 'mounted', 'remote.txt'),
          'utf8',
        ),
      ).toBe('local copy');
    });

    test('preserves a workspace rooted inside a mount', async () => {
      const { root, archivePath } = await fixture();
      await writeFile(join(root, 'remote.txt'), 'remote object');
      const manifest = new Manifest({
        root,
        entries: {
          remote: mount({
            source: 's3://bucket/data',
            mountPath: join(root, '..'),
            mountStrategy: { type: 'in_container' },
          }),
        },
      });

      await hydrateRemoteWorkspaceTar({
        providerName: 'LocalTest',
        manifest,
        archivePath,
        data: makeTarArchive([]),
        io: { mkdir, writeFile, readFile, runCommand },
      });
      expect(await readFile(join(root, 'remote.txt'), 'utf8')).toBe(
        'remote object',
      );
    });

    test('fails before cleanup when a mount path cannot be resolved', async () => {
      const { root, archivePath } = await fixture();
      await writeFile(join(root, 'stale.txt'), 'keep on failure');
      const manifest = new Manifest({
        root,
        entries: {
          remote: mount({
            source: 's3://bucket/data',
            mountPath: 'cache/mounted',
            mountStrategy: { type: 'in_container' },
          }),
        },
      });
      const upload = vi.fn(writeFile);

      await expect(
        hydrateRemoteWorkspaceTar({
          providerName: 'LocalTest',
          manifest,
          archivePath,
          data: makeTarArchive([]),
          io: {
            mkdir,
            writeFile: upload,
            readFile,
            runCommand: async (command) =>
              command.includes('/usr/bin/realpath -m')
                ? { status: 1, stderr: 'path resolution failed' }
                : runCommand(command),
          },
        }),
      ).rejects.toThrow('path resolution failed');
      expect(upload).not.toHaveBeenCalled();
      expect(await readFile(join(root, 'stale.txt'), 'utf8')).toBe(
        'keep on failure',
      );
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
