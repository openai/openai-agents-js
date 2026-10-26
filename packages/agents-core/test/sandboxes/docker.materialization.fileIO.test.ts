import * as childProcess from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DockerSandboxSession } from '../../src/sandbox/local';
import * as localWorkspace from '../../src/sandbox/sandboxes/shared/localWorkspace';
import { createDockerFileIOFixture } from './fixtures/dockerFileIO';

const dockerProcess = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../../src/sandbox/sandboxes/shared/runProcess', () => ({
  runSandboxProcess: dockerProcess.run,
  formatSandboxProcessError: (result: { stderr: string }) => result.stderr,
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
}));

describe.skipIf(process.platform === 'win32')(
  'Docker resource materialization file operations',
  () => {
    let root: string;
    let workspace: string;
    let host: string;
    let outside: string;
    let session: DockerSandboxSession;
    let commands: string[][];
    let fixture: Awaited<ReturnType<typeof createDockerFileIOFixture>>;

    beforeEach(async () => {
      fixture = await createDockerFileIOFixture(dockerProcess.run);
      ({ root, workspace, host, outside, session, commands } = fixture);
    });

    afterEach(async () => {
      await session.close();
      vi.restoreAllMocks();
      await rm(root, { recursive: true, force: true });
    });

    it('sends file bytes to Docker before reading the remaining source files', async () => {
      let writtenBytes = 0;
      const spawn = vi.mocked(childProcess.spawn);
      const implementation = spawn.getMockImplementation()!;
      spawn.mockImplementation(((
        command: string,
        args: string[],
        options: childProcess.SpawnOptions,
      ) => {
        const child = implementation(
          command,
          args,
          options,
        ) as childProcess.ChildProcessWithoutNullStreams;
        if (args.includes('/usr/bin/tar')) {
          const write = child.stdin.write.bind(child.stdin);
          vi.spyOn(child.stdin, 'write').mockImplementation(((
            chunk: Uint8Array,
            ...rest: unknown[]
          ) => {
            writtenBytes += chunk.byteLength;
            return Reflect.apply(write, child.stdin, [chunk, ...rest]);
          }) as typeof child.stdin.write);
        }
        return child;
      }) as typeof childProcess.spawn);
      vi.spyOn(localWorkspace, 'readLocalWorkspaceEntry').mockImplementation(
        async function* () {
          yield { type: 'dir', path: '' };
          yield {
            type: 'file',
            path: 'first',
            content: new Uint8Array(1024 * 1024).fill(65),
          };
          expect(writtenBytes).toBeGreaterThanOrEqual(1024 * 1024);
          yield {
            type: 'file',
            path: 'second',
            content: Buffer.from('second file'),
          };
        },
      );
      await session.materializeEntry({
        path: 'streamed',
        entry: { type: 'dir' },
      });
      expect((await readFile(join(workspace, 'streamed/first'))).length).toBe(
        1024 * 1024,
      );
      expect(await readFile(join(workspace, 'streamed/second'), 'utf8')).toBe(
        'second file',
      );
    });

    it('reports a mid-stream source failure without publishing the manifest', async () => {
      const manifest = session.state.manifest;
      vi.spyOn(localWorkspace, 'readLocalWorkspaceEntry').mockImplementation(
        async function* () {
          yield { type: 'dir', path: '' };
          yield {
            type: 'file',
            path: 'first',
            content: new Uint8Array(1024 * 1024),
          };
          throw new Error('source read failed');
        },
      );
      await expect(
        session.materializeEntry({ path: 'partial', entry: { type: 'dir' } }),
      ).rejects.toThrow('source read failed');
      expect(session.state.manifest).toBe(manifest);
    });

    it('closes the source when Docker exits before consuming the archive', async () => {
      let sourceClosed = false;
      vi.spyOn(localWorkspace, 'readLocalWorkspaceEntry').mockImplementation(
        async function* () {
          try {
            yield { type: 'dir', path: '' };
            for (let index = 0; index < 10; index++) {
              yield {
                type: 'file',
                path: String(index),
                content: new Uint8Array(1024 * 1024),
              };
            }
          } finally {
            sourceClosed = true;
          }
        },
      );
      const native =
        await vi.importActual<typeof import('node:child_process')>(
          'node:child_process',
        );
      const spawn = vi.mocked(childProcess.spawn);
      const implementation = spawn.getMockImplementation()!;
      spawn.mockImplementation(((
        command: string,
        args: string[],
        options: childProcess.SpawnOptions,
      ) =>
        args.includes('/usr/bin/tar')
          ? native.spawn(process.execPath, ['-e', 'process.exit(1)'], options)
          : implementation(
              command,
              args,
              options,
            )) as typeof childProcess.spawn);
      const manifest = session.state.manifest;
      await expect(
        session.materializeEntry({ path: 'rejected', entry: { type: 'dir' } }),
      ).rejects.toThrow(/failed to copy entry/);
      expect(sourceClosed).toBe(true);
      expect(session.state.manifest).toBe(manifest);
    });

    it('copies local-directory skill bytes and modes only through Docker', async () => {
      const source = join(root, 'skill');
      await mkdir(join(source, 'empty'), { recursive: true });
      await writeFile(join(source, 'SKILL.md'), 'Configured skill');
      await writeFile(join(source, 'SKILL.md '), 'Trailing space');
      await writeFile(
        join(source, "quote'; $(touch INJECTED); `touch INJECTED`"),
        'Literal shell syntax',
      );
      await mkdir(join(source, ' '));
      await writeFile(join(source, ' ', ' leading\\name\n'), 'Literal name');
      const bytes = Buffer.from([0, 255, 128, 10]);
      await writeFile(join(source, 'asset.bin'), bytes);
      session.state.manifest.extraPathGrants.push({
        path: source,
        readOnly: true,
      });
      await mkdir(join(workspace, '.agents', 'demo'), { recursive: true });
      await writeFile(join(workspace, '.agents', 'demo', 'asset.bin'), 'old');
      await chmod(join(workspace, '.agents', 'demo', 'asset.bin'), 0o600);
      await symlink(outside, join(host, '.agents'));
      const applicationMask = vi.spyOn(process, 'umask').mockReturnValue(0o027);
      try {
        await session.materializeEntry({
          path: '.agents/demo',
          entry: { type: 'local_dir', src: source, permissions: 0o700 },
        });
      } finally {
        applicationMask.mockRestore();
      }
      expect(
        await readFile(join(workspace, '.agents/demo/SKILL.md'), 'utf8'),
      ).toBe('Configured skill');
      expect(
        await readFile(join(workspace, '.agents/demo/SKILL.md '), 'utf8'),
      ).toBe('Trailing space');
      expect(
        await readFile(
          join(
            workspace,
            '.agents/demo',
            "quote'; $(touch INJECTED); `touch INJECTED`",
          ),
          'utf8',
        ),
      ).toBe('Literal shell syntax');
      expect(commands.some((args) => args.includes('/bin/sh'))).toBe(false);
      expect(
        commands.filter((args) => args.includes('/usr/bin/tar')),
      ).toHaveLength(1);
      expect(commands.every((args) => args[0] === 'exec')).toBe(true);
      expect(
        await readFile(
          join(workspace, '.agents/demo', ' ', ' leading\\name\n'),
          'utf8',
        ),
      ).toBe('Literal name');
      expect(await readFile(join(workspace, '.agents/demo/asset.bin'))).toEqual(
        bytes,
      );
      expect(
        (await lstat(join(workspace, '.agents/demo/asset.bin'))).mode & 0o777,
      ).toBe(0o600);
      expect(
        (await lstat(join(workspace, '.agents/demo/SKILL.md'))).mode & 0o777,
      ).toBe(0o640);
      expect(
        (await lstat(join(workspace, '.agents/demo/empty'))).mode & 0o777,
      ).toBe(0o750);
      expect((await lstat(join(workspace, '.agents/demo'))).mode & 0o777).toBe(
        0o700,
      );
      await expect(lstat(join(outside, 'demo'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe(
        'outside sentinel\n',
      );
    });

    it('loads nested inline and local resources through the same container writer', async () => {
      const source = join(root, 'source');
      await mkdir(source);
      await writeFile(join(source, 'local.txt'), 'Local bytes');
      session.state.manifest.extraPathGrants.push({
        path: source,
        readOnly: true,
      });
      const mask = vi.spyOn(process, 'umask').mockReturnValue(0o027);
      try {
        await session.materializeEntry({
          path: 'skill',
          entry: {
            type: 'dir',
            permissions: 0o750,
            children: {
              'nested/config.txt': {
                type: 'file',
                content: 'Inline bytes',
                permissions: 0o600,
              },
              local: {
                type: 'local_file',
                src: join(source, 'local.txt'),
                permissions: 0o640,
              },
              assets: { type: 'local_dir', src: source, permissions: 0o700 },
            },
          },
        });
      } finally {
        mask.mockRestore();
      }
      expect(
        await readFile(join(workspace, 'skill/nested/config.txt'), 'utf8'),
      ).toBe('Inline bytes');
      expect(await readFile(join(workspace, 'skill/local'), 'utf8')).toBe(
        'Local bytes',
      );
      expect(
        await readFile(join(workspace, 'skill/assets/local.txt'), 'utf8'),
      ).toBe('Local bytes');
      expect((await lstat(join(workspace, 'skill/nested'))).mode & 0o777).toBe(
        0o750,
      );
      expect(
        (await lstat(join(workspace, 'skill/nested/config.txt'))).mode & 0o777,
      ).toBe(0o600);
      expect((await lstat(join(workspace, 'skill/assets'))).mode & 0o777).toBe(
        0o700,
      );
      await expect(lstat(join(host, 'skill'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(commands.some((args) => args.includes('/bin/sh'))).toBe(false);
    });

    it('checks the actual destination of a literal skill filename', async () => {
      const source = join(root, 'skill');
      await mkdir(source);
      await writeFile(join(source, 'SKILL.md '), 'Configured skill');
      session.state.manifest.extraPathGrants.push({
        path: source,
        readOnly: true,
      });
      await mkdir(join(workspace, '.agents', 'demo'), { recursive: true });
      await symlink(
        join(outside, 'secret.txt'),
        join(workspace, '.agents', 'demo', 'SKILL.md '),
      );
      await expect(
        session.materializeEntry({
          path: '.agents/demo',
          entry: { type: 'local_dir', src: source },
        }),
      ).rejects.toThrow(/escapes the workspace/);
      expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe(
        'outside sentinel\n',
      );
    });

    it('retains source grants and symlink rejection for local-directory skills', async () => {
      const source = join(root, 'skill');
      await mkdir(source);
      await writeFile(join(source, 'SKILL.md'), 'Configured skill');
      const load = () =>
        session.materializeEntry({
          path: '.agents/demo',
          entry: { type: 'local_dir', src: source },
        });
      await expect(load()).rejects.toThrow(
        /local source base directory or manifest.extraPathGrants/,
      );
      expect(commands).toEqual([]);
      session.state.manifest.extraPathGrants.push({
        path: source,
        readOnly: true,
      });
      await symlink(join(outside, 'secret.txt'), join(source, 'secret'));
      await expect(load()).rejects.toThrow(/symbolic links/);
      await expect(
        lstat(join(workspace, '.agents/demo/secret')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe(
        'outside sentinel\n',
      );
    });

    it('leaves the manifest unchanged when Docker rejects the copy', async () => {
      const source = join(root, 'skill');
      await mkdir(source);
      await writeFile(join(source, 'SKILL.md'), 'Configured skill');
      session.state.manifest.extraPathGrants.push({
        path: source,
        readOnly: true,
      });
      const manifest = session.state.manifest;
      const currentSpawn = childProcess.spawn;
      const native =
        await vi.importActual<typeof import('node:child_process')>(
          'node:child_process',
        );
      const implementation = vi.mocked(currentSpawn).getMockImplementation()!;
      vi.mocked(currentSpawn).mockImplementation(((
        command: string,
        args: string[],
        options: childProcess.SpawnOptions,
      ) => {
        if (args.includes('/usr/bin/tar'))
          return native.spawn(
            process.execPath,
            [
              '-e',
              'process.stdin.resume(); process.stdin.on("end", () => process.exit(1));',
            ],
            options,
          );
        return implementation(command, args, options);
      }) as typeof childProcess.spawn);
      await expect(
        session.materializeEntry({
          path: '.agents/demo',
          entry: { type: 'local_dir', src: source },
        }),
      ).rejects.toThrow(/failed to copy entry/);
      expect(session.state.manifest).toBe(manifest);
      await expect(lstat(join(workspace, '.agents'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });

    it('rejects nested mount declarations before starting a resource copy', async () => {
      const manifest = session.state.manifest;
      await expect(
        session.materializeEntry({
          path: 'skill',
          entry: {
            type: 'dir',
            children: {
              data: {
                type: 'mount',
                source: outside,
                readOnly: false,
                mountStrategy: { type: 'local_bind' },
              },
            },
          },
        }),
      ).rejects.toThrow(/does not support this mount entry/);
      expect(session.state.manifest).toBe(manifest);
      await expect(
        session.materializeEntry({
          path: 'skill',
          entry: {
            type: 'mount',
            source: outside,
            readOnly: false,
            mountStrategy: { type: 'local_bind' },
          },
        }),
      ).rejects.toThrow(/must be configured when creating the sandbox/);
      expect(commands).toEqual([]);
    });
  },
);
