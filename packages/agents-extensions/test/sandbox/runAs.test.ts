import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  Manifest,
  SandboxProviderError,
  SandboxWorkspaceReadNotFoundError,
  type SandboxSessionState,
} from '@openai/agents-core/sandbox';
import { describe, expect, test } from 'vitest';
import {
  createRunAsRemoteEditor,
  RemoteSandboxSessionBase,
  writeRunAsRemoteText,
  type RemoteSandboxCommandOptions,
} from '../../src/sandbox/shared';

const execFileAsync = promisify(execFile);

// Check Unix access for an unrelated user, independently of the shell commands
// used by the writer. This does not require privileged users on the test host.
async function readableByOtherUser(path: string): Promise<boolean> {
  if (((await stat(path)).mode & 0o004) === 0) {
    return false;
  }
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    if (((await stat(parent)).mode & 0o001) === 0) {
      return false;
    }
    if (parent === dirname(parent)) {
      return true;
    }
  }
}

async function runShell(command: string) {
  return await runShellWithPath(command, process.env.PATH);
}

async function runShellWithPath(command: string, path?: string) {
  try {
    const { stdout, stderr } = await execFileAsync('/bin/sh', ['-c', command], {
      env: { ...process.env, PATH: path },
    });
    return { status: 0, stdout, stderr };
  } catch (error) {
    const result = error as { code: number; stdout: string; stderr: string };
    return {
      status: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }
}

class ShellSession extends RemoteSandboxSessionBase<
  SandboxSessionState & { environment: Record<string, string> }
> {
  constructor(
    root: string,
    private readonly upload: (
      path: string,
      content: string | Uint8Array,
    ) => Promise<void>,
    private readonly command: typeof runShell,
  ) {
    super({
      state: { manifest: new Manifest({ root }), environment: {} },
      options: { providerName: 'ShellSandboxClient', providerId: 'shell' },
    });
  }

  protected override async runRemoteCommand(
    command: string,
    _options: RemoteSandboxCommandOptions,
  ) {
    return await this.command(command);
  }

  protected override async mkdirRemote(path: string) {
    await mkdir(path, { recursive: true });
  }

  protected override async readRemoteText(path: string) {
    return await readFile(path, 'utf8');
  }

  protected override async readRemoteFile(path: string) {
    return await readFile(path);
  }

  protected override async writeRemoteFile(
    path: string,
    content: string | Uint8Array,
  ) {
    await this.upload(path, content);
  }

  protected override async deleteRemotePath(path: string) {
    await rm(path);
  }

  protected override async resolveRemotePath(path = '') {
    return join(this.state.manifest.root, path);
  }

  protected override assertFilesystemRunAs() {}
}

describe.skipIf(process.platform === 'win32')('private runAs staging', () => {
  test('rejects partial read errors under shells that enable errexit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bounded-read-partial-'));
    await writeFile(join(root, 'note.txt'), 'synthetic');
    const session = new ShellSession(
      root,
      async () => {},
      async (command) =>
        // Model a storage read that produces a binary prefix and then fails.
        runShell(
          `set -e; head() { printf '\\n000\\n'; return 1; }; ${command}`,
        ),
    );
    try {
      await expect(
        session.readFile({ path: 'note.txt', maxBytes: 5 }),
      ).rejects.toBeInstanceOf(SandboxProviderError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform !== 'linux')(
    'rejects a capped read when a regular descriptor returns a read error',
    async () => {
      const session = new ShellSession('/proc/self', async () => {}, runShell);
      await expect(
        session.readFile({ path: 'mem', maxBytes: 4 }),
      ).rejects.toBeInstanceOf(SandboxProviderError);
    },
  );

  test.skipIf(process.getuid?.() === 0)(
    'preserves permission failures beneath an inaccessible ancestor',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'bounded-read-permission-'));
      const directory = join(root, 'private');
      await mkdir(directory);
      await writeFile(join(directory, 'note.txt'), 'synthetic');
      const session = new ShellSession(root, async () => {}, runShell);
      try {
        await chmod(directory, 0);
        await expect(
          session.readFile({ path: 'private/note.txt', maxBytes: 4 }),
        ).rejects.toBeInstanceOf(SandboxProviderError);
      } finally {
        await chmod(directory, 0o700);
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test('capped base reads transfer only the prefix and retain file errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bounded-remote-read-'));
    try {
      const large = join(root, 'large.bin');
      await writeFile(large, Buffer.from([0, 255, 128, 10]));
      await truncate(large, 8 * 1024 * 1024);
      const bin = join(root, 'bin');
      await mkdir(bin);
      await writeFile(join(bin, 'head'), '#!/bin/sh\ncat\n', { mode: 0o755 });
      let transferred = 0;
      const session = new ShellSession(
        root,
        async () => {},
        async (command) => {
          const result = await runShellWithPath(
            command,
            `${bin}:${process.env.PATH}`,
          );
          transferred += result.stdout.length;
          return result;
        },
      );
      expect(
        Array.from(await session.readFile({ path: 'large.bin', maxBytes: 4 })),
      ).toEqual([0, 255, 128, 10]);
      expect(transferred).toBeLessThan(32);
      await expect(
        session.readFile({ path: 'missing.bin', maxBytes: 0 }),
      ).rejects.toBeInstanceOf(SandboxWorkspaceReadNotFoundError);
      expect(
        Array.from(await session.readFile({ path: 'large.bin', maxBytes: 0 })),
      ).toEqual([]);
      await writeFile(join(root, 'small.txt'), 'hello');
      expect(await session.readFile({ path: 'small.txt' })).toEqual(
        Buffer.from('hello'),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each(['shared helper', 'base session'] as const)(
    '%s keeps uploads and provider copies private, preserving the destination',
    async (entrypoint) => {
      const root = await mkdtemp(join(tmpdir(), 'agents-runas-test-'));
      const destination = join(root, 'private.txt');
      const stagingFiles: string[] = [];
      const visible: boolean[] = [];
      // The shell runs as the current user so this regression needs no sudo.
      const runAs = String(process.getuid!());
      const group = String(process.getgid!());
      const command = async (value: string) => {
        // Numeric UID and GID may differ on developer machines.
        const result = await runShell(
          value.replaceAll(`'${runAs}':'${runAs}'`, `'${runAs}':'${group}'`),
        );
        if (value.includes('chown ')) {
          for (const path of stagingFiles) {
            visible.push(await readableByOtherUser(path));
          }
        }
        return result;
      };
      const upload = async (path: string, content: string | Uint8Array) => {
        // Some providers create/chmod the upload parent and write sibling files.
        await mkdir(dirname(path), { recursive: true });
        if (dirname(path) !== tmpdir()) {
          await chmod(dirname(path), 0o755);
        }
        const sibling = `${path}.provider-copy`;
        for (const staged of [path, sibling]) {
          await writeFile(staged, content);
          await chmod(staged, 0o644);
          stagingFiles.push(staged);
          visible.push(await readableByOtherUser(staged));
        }
      };
      try {
        await writeFile(destination, 'secret\nold', { mode: 0o600 });
        const before = await stat(destination);
        const editor =
          entrypoint === 'shared helper'
            ? createRunAsRemoteEditor({
                providerName: 'ShellSandboxClient',
                providerId: 'shell',
                runAs,
                resolvePath: async (path) => join(root, path),
                runCommand: command,
                writer: {
                  mkdir: async (path) => {
                    await mkdir(path, { recursive: true });
                  },
                  writeFile: upload,
                },
              })
            : new ShellSession(root, upload, command).createEditor(runAs);
        await editor.updateFile({
          type: 'update_file',
          path: 'private.txt',
          diff: '-old\n+updated',
        });
        expect(await readFile(destination, 'utf8')).toBe('secret\nupdated');
        const after = await stat(destination);
        expect([after.mode, after.uid, after.gid]).toEqual([
          before.mode,
          before.uid,
          before.gid,
        ]);
        expect(visible).toEqual([false, false, false, false]);
        for (const path of stagingFiles) {
          await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
        }
      } finally {
        // Also remove baseline reproducer files after the expected failing run.
        for (const path of stagingFiles) {
          await rm(path, { force: true });
        }
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test.each(['shared helper', 'base session'] as const)(
    '%s cleans up a partially failed upload without changing the destination',
    async (entrypoint) => {
      const root = await mkdtemp(join(tmpdir(), 'agents-runas-test-'));
      const destination = join(root, 'private.txt');
      let uploadedPath: string | undefined;
      const failure = new Error('upload interrupted');
      const upload = async (path: string, content: string | Uint8Array) => {
        uploadedPath = path;
        await writeFile(path, content);
        throw failure;
      };
      const runAs = String(process.getuid!());
      try {
        await writeFile(destination, 'secret\nold', { mode: 0o600 });
        const editor =
          entrypoint === 'shared helper'
            ? createRunAsRemoteEditor({
                providerName: 'ShellSandboxClient',
                providerId: 'shell',
                runAs,
                resolvePath: async (path) => join(root, path),
                runCommand: runShell,
                writer: {
                  mkdir: async (path) => {
                    await mkdir(path, { recursive: true });
                  },
                  writeFile: upload,
                },
              })
            : new ShellSession(root, upload, runShell).createEditor(runAs);
        await expect(
          editor.updateFile({
            type: 'update_file',
            path: 'private.txt',
            diff: '-old\n+updated',
          }),
        ).rejects.toBe(failure);
        expect(await readFile(destination, 'utf8')).toBe('secret\nold');
        expect(uploadedPath).toBeDefined();
        await expect(
          stat(dirname(dirname(uploadedPath!))),
        ).rejects.toMatchObject({
          code: 'ENOENT',
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test('does not upload or remove a directory when exclusive creation fails', async () => {
    const commands: string[] = [];
    let uploaded = false;
    await expect(
      writeRunAsRemoteText({
        providerName: 'ShellSandboxClient',
        providerId: 'shell',
        path: '/workspace/private.txt',
        content: 'secret',
        runAs: 'sandbox-user',
        runCommand: async (command) => {
          commands.push(command);
          return { status: 1, stderr: 'File exists' };
        },
        writer: {
          mkdir: async () => {},
          writeFile: async () => {
            uploaded = true;
          },
        },
      }),
    ).rejects.toMatchObject({
      code: 'provider_error',
      details: { provider: 'shell' },
    });
    expect(uploaded).toBe(false);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain('mkdir --');
  });
});
