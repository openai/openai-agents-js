import * as childProcess from 'node:child_process';
import { writeFileSync } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DockerSandboxSession,
  Manifest,
  dockerVolumeMountStrategy,
} from '../../src/sandbox/local';

const dockerProcess = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../../src/sandbox/sandboxes/shared/runProcess', () => ({
  runSandboxProcess: dockerProcess.run,
  formatSandboxProcessError: (result: { stderr: string }) => result.stderr,
}));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
}));

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
  'base64',
);
const success = {
  status: 0,
  stdout: '',
  stderr: '',
  signal: null,
  timedOut: false,
};

// Execute Docker's shell payloads against a distinct local filesystem. Only the
// Docker transport/user boundary and GNU utility spelling are adapted. Path
// resolution, symlinks, permissions, shell redirection and byte I/O remain real.
// This is command-boundary evidence, not a live-container integration test.
describe.skipIf(process.platform === 'win32')(
  'Docker container file operations',
  () => {
    let root: string;
    let workspace: string;
    let host: string;
    let outside: string;
    let session: DockerSandboxSession;
    let commands: string[][];
    let beforeCommand: ((command: string) => void) | undefined;

    beforeEach(async () => {
      root = await realpath(await mkdtemp(join(tmpdir(), 'docker-file-io-')));
      workspace = join(root, 'container');
      host = join(root, 'host');
      outside = join(root, 'outside');
      await Promise.all([mkdir(workspace), mkdir(host), mkdir(outside)]);
      await writeFile(join(workspace, 'note.txt'), 'before\n');
      await writeFile(join(host, 'note.txt'), 'host sentinel\n');
      await writeFile(join(outside, 'secret.txt'), 'outside sentinel\n');
      commands = [];
      beforeCommand = undefined;
      dockerProcess.run.mockReset().mockResolvedValue(success);
      const native =
        await vi.importActual<typeof import('node:child_process')>(
          'node:child_process',
        );
      vi.spyOn(childProcess, 'spawn').mockImplementation(((
        command: string,
        args: string[],
        options: childProcess.SpawnOptions,
      ) => {
        expect(command).toBe('docker');
        commands.push(args);
        if (args.includes('/usr/bin/realpath')) {
          // Use real OS path resolution, including missing tails, on macOS too.
          return native.spawn(
            process.execPath,
            [
              '-e',
              `
const fs = require('node:fs');
const path = require('node:path');
let current = process.argv[1];
const tail = [];
while (true) {
  try { process.stdout.write(path.resolve(fs.realpathSync(current), ...tail) + '\\n'); break; }
  catch (error) {
    if (error.code !== 'ENOENT' || path.dirname(current) === current) throw error;
    tail.unshift(path.basename(current)); current = path.dirname(current);
  }
}
`,
              args.at(-1)!,
            ],
            { ...options, env: { PATH: '/usr/bin:/bin' } },
          );
        }
        let script = args.at(-1)!;
        beforeCommand?.(script);
        if (process.platform === 'darwin') {
          // Preserve base64's exit status instead of using shell redirection.
          script = script.replace(/base64 -- /gu, 'base64 -i ');
          // Preserve GNU find's type/name records using portable host utilities.
          script = script.replace(
            "-printf '%y\\0%f\\0'",
            `-exec /bin/sh -c 'for file do kind=o; if [ -L "$file" ]; then kind=l; elif [ -d "$file" ]; then kind=d; elif [ -f "$file" ]; then kind=f; fi; printf "%s\\0%s\\0" "$kind" "\${file##*/}"; done' sh {} +`,
          );
        }
        const environment: Record<string, string> = {
          PATH: '/usr/bin:/bin',
          ...session.state.environment,
        };
        for (let index = 0; index < args.length; index += 1) {
          if (args[index] !== '-e') continue;
          const assignment = args[++index]!;
          const separator = assignment.indexOf('=');
          environment[assignment.slice(0, separator)] = assignment.slice(
            separator + 1,
          );
        }
        const launcher = args.indexOf('/usr/bin/env');
        return native.spawn(
          launcher >= 0 ? '/usr/bin/env' : '/bin/sh',
          // Keep container commands away from the host's login profile.
          launcher >= 0
            ? [...args.slice(launcher + 1, -1), script]
            : ['-c', script],
          {
            ...options,
            cwd: '/',
            env: environment,
          },
        );
      }) as typeof childProcess.spawn);
      session = new DockerSandboxSession({
        state: {
          manifest: new Manifest({ root: workspace }),
          workspaceRootPath: host,
          workspaceRootOwned: false,
          environment: {},
          containerId: 'test-container',
          image: 'test:image',
          defaultUser: 'container-user',
        },
      });
    });

    afterEach(async () => {
      await session.close();
      vi.restoreAllMocks();
      await rm(root, { recursive: true, force: true });
    });

    it('isolates file helpers from application environment and retains mount environment', async () => {
      const manifest = new Manifest({
        root: workspace,
        environment: {
          PATH: '/application-only/bin',
          APP_MODE: 'application',
          POSIXLY_CORRECT: '1',
        },
      });
      session.state.manifest = manifest;
      session.state.environment = await manifest.resolveEnvironment();

      expect(
        await session.execCommand({
          cmd: 'printf "%s:%s\\n" "$PATH" "$APP_MODE"',
          login: false,
        }),
      ).toContain('/application-only/bin:application');
      commands.length = 0;
      expect(
        Buffer.from(await session.readFile({ path: 'note.txt' })).toString(),
      ).toBe('before\n');
      expect(await session.pathExists('missing.txt')).toBe(false);
      expect(await session.directoryExists('.')).toBe(true);
      expect(await session.listDir({ path: '.' })).toEqual([
        { name: 'note.txt', path: 'note.txt', type: 'file' },
      ]);
      await writeFile(join(workspace, 'image.png'), png);
      expect(await session.viewImage({ path: 'image.png' })).toMatchObject({
        image: { data: Uint8Array.from(png), mediaType: 'image/png' },
      });
      const editor = session.createEditor();
      await editor.createFile({
        type: 'create_file',
        path: 'nested/new.txt',
        diff: '+draft\n+',
      });
      await editor.updateFile({
        type: 'update_file',
        path: 'nested/new.txt',
        moveTo: 'moved.txt',
        diff: '@@\n-draft\n+after\n',
      });
      expect(
        Buffer.from(await session.readFile({ path: 'moved.txt' })).toString(),
      ).toBe('after\n');
      await editor.deleteFile({ type: 'delete_file', path: 'moved.txt' });
      for (const args of commands.filter(
        (args) => !args.includes('/usr/bin/realpath'),
      )) {
        expect(args).toEqual(
          expect.arrayContaining([
            '/usr/bin/env',
            '-i',
            'PATH=/usr/bin:/bin',
            'LC_ALL=C',
            '/bin/sh',
            '-c',
          ]),
        );
        expect(args).not.toContain('APP_MODE=application');
        expect(args).not.toContain('-lc');
      }
      expect(
        await session.runDockerMountCommand(
          '/usr/bin/printenv APP_MODE',
          'inspect mount environment',
        ),
      ).toBe('application\n');
      expect(
        await session.runDockerMountCommand(
          '/usr/bin/printenv APP_MODE',
          'inspect explicit mount environment',
          { environment: { APP_MODE: 'mount' } },
        ),
      ).toBe('mount\n');
    });

    it('reads container bytes with the default or explicit user, including after stop', async () => {
      expect(session.fileIOBackend).toBe('docker');
      const bytes = Buffer.from([0, 255, 128, 10, 13, 1]);
      await writeFile(join(workspace, 'bytes.bin'), bytes);
      expect(
        await session.readFile({ path: 'bytes.bin', maxBytes: 4 }),
      ).toEqual(bytes.subarray(0, 4));
      expect(commands).toHaveLength(2);
      expect(commands[0]).toEqual(
        expect.arrayContaining(['-u', 'root', '/usr/bin/realpath']),
      );
      expect(commands[1]).toEqual(
        expect.arrayContaining(['-u', 'container-user']),
      );
      await session.stop();
      expect(
        Buffer.from(
          await session.readFile({ path: 'note.txt', runAs: 'alice' }),
        ).toString(),
      ).toBe('before\n');
      expect(commands.at(-1)).toEqual(expect.arrayContaining(['-u', 'alice']));
      expect(await readFile(join(host, 'note.txt'), 'utf8')).toBe(
        'host sentinel\n',
      );
    });

    it('creates, patches, moves and unlinks container files without touching host files', async () => {
      const editor = session.createEditor();
      await editor.createFile({
        type: 'create_file',
        path: 'nested/new.txt',
        diff: '+before\n+',
      });
      expect(commands).toHaveLength(2);
      await editor.updateFile({
        type: 'update_file',
        path: 'nested/new.txt',
        moveTo: 'moved.txt',
        diff: '@@\n-before\n+after\n',
      });
      expect(await readFile(join(workspace, 'moved.txt'), 'utf8')).toBe(
        'after\n',
      );
      await expect(
        lstat(join(workspace, 'nested/new.txt')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await symlink('moved.txt', join(workspace, 'alias.txt'));
      await editor.deleteFile({ type: 'delete_file', path: 'alias.txt' });
      expect(await readFile(join(workspace, 'moved.txt'), 'utf8')).toBe(
        'after\n',
      );
      await editor.deleteFile({ type: 'delete_file', path: 'note.txt' });
      expect(await readFile(join(host, 'note.txt'), 'utf8')).toBe(
        'host sentinel\n',
      );
      await expect(
        editor.deleteFile({ type: 'delete_file', path: 'missing.txt' }),
      ).rejects.toThrow();
    });

    it('does not overwrite files created after validation or existing symlink targets', async () => {
      const editor = session.createEditor();
      beforeCommand = (script) => {
        if (script.includes('set -C'))
          writeFileSync(join(workspace, 'new.txt'), 'concurrent');
      };
      await expect(
        editor.createFile({
          type: 'create_file',
          path: 'new.txt',
          diff: '+replacement',
        }),
      ).rejects.toThrow();
      expect(await readFile(join(workspace, 'new.txt'), 'utf8')).toBe(
        'concurrent',
      );
      beforeCommand = undefined;
      await symlink('note.txt', join(workspace, 'alias.txt'));
      await expect(
        editor.createFile({
          type: 'create_file',
          path: 'alias.txt',
          diff: '+replacement',
        }),
      ).rejects.toThrow();
      expect(await readFile(join(workspace, 'note.txt'), 'utf8')).toBe(
        'before\n',
      );
    });

    it('rejects a large create collision without an unhandled pipe error', async () => {
      // The real exclusive-create shell exits before reading this pipe-sized input.
      await expect(
        session.createEditor().createFile({
          type: 'create_file',
          path: 'note.txt',
          diff: `+${'x'.repeat(2 * 1024 * 1024)}`,
        }),
      ).rejects.toThrow('File already exists.');
      expect(await readFile(join(workspace, 'note.txt'), 'utf8')).toBe(
        'before\n',
      );
      expect(
        Buffer.from(await session.readFile({ path: 'note.txt' })).toString(),
      ).toBe('before\n');
    });

    it('rejects a FIFO volume move destination and preserves the regular source', async () => {
      await mkdir(join(workspace, 'volume'));
      const fifo = join(workspace, 'volume/pipe');
      childProcess.execFileSync('/usr/bin/mkfifo', [fifo], { stdio: 'pipe' });
      const mounted = new DockerSandboxSession({
        state: {
          ...session.state,
          manifest: new Manifest({
            root: workspace,
            entries: {
              volume: {
                type: 's3_mount',
                bucket: 'bucket',
                readOnly: false,
                mountStrategy: dockerVolumeMountStrategy({ driver: 'rclone' }),
              },
            },
          }),
        },
      });
      await expect(
        mounted.createEditor().updateFile({
          type: 'update_file',
          path: 'note.txt',
          moveTo: 'volume/pipe',
          diff: '@@\n-before\n+after\n',
        }),
      ).rejects.toThrow('Destination is not a regular file.');
      expect(await readFile(join(workspace, 'note.txt'), 'utf8')).toBe(
        'before\n',
      );
      expect((await lstat(fifo)).isFIFO()).toBe(true);
      // A distinct destination spelling can still refer to the source inode.
      await symlink('../note.txt', join(workspace, 'volume/alias.txt'));
      await expect(
        mounted.createEditor().updateFile({
          type: 'update_file',
          path: 'note.txt',
          moveTo: 'volume/alias.txt',
          diff: '@@\n-before\n+after\n',
        }),
      ).rejects.toThrow('Cannot move a file onto itself.');
      expect(await readFile(join(workspace, 'note.txt'), 'utf8')).toBe(
        'before\n',
      );
      expect(await readFile(join(workspace, 'volume/alias.txt'), 'utf8')).toBe(
        'before\n',
      );
    });

    it('rejects escaping symlinks and read-only grant targets before move side effects', async () => {
      await symlink(join(outside, 'secret.txt'), join(workspace, 'escape.txt'));
      await expect(session.readFile({ path: 'escape.txt' })).rejects.toThrow(
        /escapes/,
      );
      const granted = new DockerSandboxSession({
        state: {
          ...session.state,
          manifest: new Manifest({
            root: workspace,
            extraPathGrants: [{ path: outside, readOnly: true }],
          }),
        },
      });
      const editor = granted.createEditor();
      await expect(
        editor.updateFile({
          type: 'update_file',
          path: 'escape.txt',
          moveTo: 'copy.txt',
          diff: '@@\n-outside sentinel\n+changed\n',
        }),
      ).rejects.toThrow(/read-only/);
      await expect(lstat(join(workspace, 'copy.txt'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe(
        'outside sentinel\n',
      );
      expect(commands.every((args) => args.includes('/usr/bin/realpath'))).toBe(
        true,
      );
    });

    it('enforces read-only mount metadata for direct and symlinked paths', async () => {
      await mkdir(join(workspace, 'mounted'));
      await writeFile(join(workspace, 'mounted/note.txt'), 'before\n');
      await symlink('mounted/note.txt', join(workspace, 'alias.txt'));
      const mounted = new DockerSandboxSession({
        state: {
          ...session.state,
          manifest: new Manifest({
            root: workspace,
            entries: {
              mounted: { type: 's3_mount', bucket: 'bucket', readOnly: true },
            },
          }),
        },
      });
      await expect(
        mounted.createEditor().createFile({
          type: 'create_file',
          path: 'mounted/new.txt',
          diff: '+blocked',
        }),
      ).rejects.toThrow(/read-only mount/);
      await expect(
        mounted.createEditor().updateFile({
          type: 'update_file',
          path: 'alias.txt',
          diff: '@@\n-before\n+changed\n',
        }),
      ).rejects.toThrow(/read-only mount/);
      expect(await readFile(join(workspace, 'mounted/note.txt'), 'utf8')).toBe(
        'before\n',
      );
    });

    it('rejects a canonical target that becomes allowed only after trimming', async () => {
      const target = `${workspace} `;
      await writeFile(target, 'outside sentinel\n');
      await symlink(target, join(workspace, 'space-alias.txt'));
      await expect(
        session.readFile({ path: 'space-alias.txt' }),
      ).rejects.toThrow('normalization changed the resolved target');
      await expect(
        session.createEditor().updateFile({
          type: 'update_file',
          path: 'space-alias.txt',
          diff: '@@\n-outside sentinel\n+changed\n',
        }),
      ).rejects.toThrow('normalization changed the resolved target');
      expect(await readFile(target, 'utf8')).toBe('outside sentinel\n');
      expect(commands.every((args) => args.includes('/usr/bin/realpath'))).toBe(
        true,
      );
    });

    it('preserves names and symlink types in listings and checks directory targets', async () => {
      await mkdir(join(workspace, 'nested'));
      await writeFile(join(workspace, 'nested/space tab\tline\n.txt'), 'data');
      await symlink('space tab\tline\n.txt', join(workspace, 'nested/alias'));
      await symlink('nested', join(workspace, 'directory-alias'));
      expect(await session.listDir({ path: 'directory-alias' })).toEqual(
        expect.arrayContaining([
          {
            name: 'space tab\tline\n.txt',
            path: 'directory-alias/space tab\tline\n.txt',
            type: 'file',
          },
          { name: 'alias', path: 'directory-alias/alias', type: 'other' },
        ]),
      );
      expect(await session.directoryExists('directory-alias')).toBe(true);
      expect(await session.pathExists('missing.txt')).toBe(false);
      await expect(session.listDir({ path: 'note.txt' })).rejects.toThrow();
      await expect(
        session.readFile({ path: 'missing.txt' }),
      ).rejects.toMatchObject({ code: 'workspace_read_not_found' });
    });

    it('preserves image bytes, non-file errors and the 10 MB limit', async () => {
      await writeFile(join(workspace, 'image.png'), png);
      expect(await session.viewImage({ path: 'image.png' })).toMatchObject({
        image: { data: Uint8Array.from(png), mediaType: 'image/png' },
      });
      await writeFile(
        join(workspace, 'large.png'),
        Buffer.alloc(10 * 1024 * 1024 + 1),
      );
      await expect(session.viewImage({ path: 'large.png' })).rejects.toThrow(
        /10 MB/,
      );
      await expect(session.viewImage({ path: '.' })).rejects.toThrow(
        /not a file/,
      );
      await expect(session.viewImage({ path: 'missing.png' })).rejects.toThrow(
        /not found/,
      );
    });

    it('keeps operations closed after failed removal and allows cleanup to retry', async () => {
      const editor = session.createEditor();
      dockerProcess.run.mockRejectedValueOnce(new Error('remove failed'));

      await expect(session.close()).rejects.toThrow('remove failed');
      await expect(session.readFile({ path: 'note.txt' })).rejects.toThrow(
        /closed/,
      );
      expect(() => session.createEditor()).toThrow(/closed/);
      await expect(
        editor.createFile({
          type: 'create_file',
          path: 'after-close.txt',
          diff: '+content',
        }),
      ).rejects.toThrow(/closed/);
      expect(commands).toEqual([]);
      expect(dockerProcess.run).toHaveBeenCalledTimes(1);

      await session.close();
      expect(dockerProcess.run).toHaveBeenCalledTimes(2);
      expect(dockerProcess.run.mock.calls[1]?.[1]).toEqual([
        'rm',
        '-f',
        'test-container',
      ]);
      await expect(session.pathExists('note.txt')).rejects.toThrow(/closed/);
      expect(commands).toEqual([]);
    });

    it('keeps operations closed while a concurrent container removal is pending', async () => {
      const removals: Array<{ finish: () => void; fail: () => void }> = [];
      dockerProcess.run.mockImplementation(
        () =>
          new Promise((resolve, reject) => {
            removals.push({
              finish: () => resolve(success),
              fail: () => reject(new Error('remove failed')),
            });
          }),
      );
      const first = session.close();
      const second = session.close();
      const firstFailure = expect(first).rejects.toThrow('remove failed');
      removals[0]!.fail();
      await firstFailure;
      await expect(session.readFile({ path: 'note.txt' })).rejects.toThrow(
        /closed/,
      );
      expect(commands).toEqual([]);
      removals[1]!.finish();
      await second;
      expect(() => session.createEditor()).toThrow(/closed/);
      await expect(session.pathExists('note.txt')).rejects.toThrow(/closed/);
    });
  },
);
