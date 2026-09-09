import * as childProcess from 'node:child_process';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Manifest,
  UnixLocalSandboxClient,
  UnixLocalSandboxSession,
  type LocalFileIOProtection,
} from '../../src/sandbox/local';
import { markRunStateSessionState } from '../../src/sandbox/internal/sessionStateTrust';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
}));

describe.skipIf(process.platform === 'win32')(
  'UnixLocal file protection selection',
  () => {
    let root: string;
    const sessions: UnixLocalSandboxSession[] = [];
    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'unix-local-file-mode-'));
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      for (const session of sessions.splice(0)) await session.close();
      await rm(root, { recursive: true, force: true });
    });
    async function create(mode?: LocalFileIOProtection) {
      const session = await new UnixLocalSandboxClient({
        workspaceBaseDir: root,
        fileIOProtection: mode,
        snapshot: { type: 'local', baseDir: join(root, 'snapshots') },
      }).create(
        new Manifest({
          entries: { 'note.txt': { type: 'file', content: 'before\n' } },
        }),
      );
      sessions.push(session);
      return session;
    }

    it('selects Python by default once, and ignores manifest interpreter configuration', async () => {
      const probe = vi.spyOn(childProcess, 'spawnSync');
      const session = await create();
      expect(session.fileIOBackend).toBe('python');
      const calls = probe.mock.calls.length;
      expect(calls).toBeGreaterThan(0);
      session.state.environment.OPENAI_AGENTS_PYTHON =
        '/missing-manifest-python';
      vi.stubEnv('OPENAI_AGENTS_PYTHON', '/missing-host-python');
      expect(
        Buffer.from(await session.readFile({ path: 'note.txt' })).toString(),
      ).toBe('before\n');
      expect(await session.pathExists('note.txt')).toBe(true);
      expect(probe).toHaveBeenCalledTimes(calls);
    });

    it.each(['auto', 'off'] as const)(
      'preserves Node file and editor behavior in %s mode without Python',
      async (mode) => {
        vi.stubEnv('OPENAI_AGENTS_PYTHON', join(root, 'missing-python'));
        const probe = vi.spyOn(childProcess, 'spawnSync');
        const session = await create(mode);
        expect(session.fileIOBackend).toBe('node');
        expect(probe).not.toHaveBeenCalled();
        vi.unstubAllEnvs();
        const editor = session.createEditor();
        await editor.createFile({
          type: 'create_file',
          path: 'nested/new.txt',
          diff: '+before\n+',
        });
        expect(await session.directoryExists('nested')).toBe(true);
        expect(
          Buffer.from(
            await session.readFile({ path: 'nested/new.txt', maxBytes: 3 }),
          ).toString(),
        ).toBe('bef');
        expect(await session.listDir({ path: 'nested' })).toEqual([
          { name: 'new.txt', path: 'nested/new.txt', type: 'file' },
        ]);
        await symlink(
          'new.txt',
          join(session.state.workspaceRootPath, 'nested/link.txt'),
        );
        await editor.deleteFile({
          type: 'delete_file',
          path: 'nested/link.txt',
        });
        expect(await session.pathExists('nested/new.txt')).toBe(true);
        await editor.updateFile({
          type: 'update_file',
          path: 'nested/new.txt',
          moveTo: 'moved.txt',
          diff: '@@\n-before\n+after\n',
        });
        expect(
          await readFile(
            join(session.state.workspaceRootPath, 'moved.txt'),
            'utf8',
          ),
        ).toBe('after\n');
        expect(await session.pathExists('nested/new.txt')).toBe(false);
        await editor.deleteFile({ type: 'delete_file', path: 'moved.txt' });
        expect(await session.pathExists('moved.txt')).toBe(false);
        const png = Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
          'base64',
        );
        await writeFile(
          join(session.state.workspaceRootPath, 'image.png'),
          png,
        );
        expect(await session.viewImage({ path: 'image.png' })).toMatchObject({
          image: { data: Uint8Array.from(png), mediaType: 'image/png' },
        });
        expect(session.fileIOBackend).toBe('node');
        expect(probe).not.toHaveBeenCalled();
      },
    );

    it('skips interpreter discovery in off mode even with a usable installation', async () => {
      const probe = vi.spyOn(childProcess, 'spawnSync');
      expect((await create('off')).fileIOBackend).toBe('node');
      expect(probe).not.toHaveBeenCalled();
    });

    it('rejects required protection before workspace or environment setup', async () => {
      vi.stubEnv('OPENAI_AGENTS_PYTHON', join(root, 'missing-python'));
      const manifest = new Manifest();
      const environment = vi.spyOn(manifest, 'resolveEnvironment');
      await expect(
        new UnixLocalSandboxClient({
          workspaceBaseDir: root,
          fileIOProtection: 'off',
        }).create(manifest, { fileIOProtection: 'required' }),
      ).rejects.toThrow(/Required file I\/O protection/);
      expect(environment).not.toHaveBeenCalled();
      expect(await readdir(root)).toEqual([]);
    });

    it('uses the capability probe result for auto and required modes', async () => {
      // Model an installed interpreter that lacks the worker's OS capabilities.
      vi.spyOn(childProcess, 'spawnSync').mockReturnValue({
        status: 1,
        signal: null,
        pid: 1,
        output: [],
        stdout: '',
        stderr: 'unsupported',
      });
      expect((await create()).fileIOBackend).toBe('node');
      await expect(create('required')).rejects.toThrow(
        /descriptor-relative filesystem support/,
      );
    });

    it('does not retry failed Python writes with Node in auto mode', async () => {
      const session = await create();
      const spawn = childProcess.spawn;
      // Fail in the selected worker before writing an otherwise valid file.
      vi.spyOn(childProcess, 'spawn').mockImplementation(((
        command: string,
        args: string[],
        options: childProcess.SpawnOptions,
      ) =>
        spawn(
          command,
          ['-I', '-S', '-c', 'raise PermissionError("worker denied")'],
          options,
        )) as typeof childProcess.spawn);
      await expect(
        session.createEditor().createFile({
          type: 'create_file',
          path: 'new.txt',
          diff: '+blocked',
        }),
      ).rejects.toThrow();
      expect(await readdir(session.state.workspaceRootPath)).toEqual([
        'note.txt',
      ]);
      expect(session.fileIOBackend).toBe('python');
    });

    it('reselects from current resume options and ignores serialized protection fields', async () => {
      const original = await create('off');
      const client = new UnixLocalSandboxClient({
        fileIOProtection: 'required',
      });
      const serialized = await client.serializeSessionState(original.state);
      expect(serialized).not.toHaveProperty('fileIOProtection');
      expect(serialized).not.toHaveProperty('fileIOBackend');
      const state = await client.deserializeSessionState({
        ...serialized,
        fileIOProtection: 'off',
        fileIOBackend: 'node',
      });
      const restored = await client.resume(state);
      sessions.push(restored);
      expect(restored.fileIOBackend).toBe('python');
      const overridden = await client.resume(state, {
        clientOptions: { fileIOProtection: 'off' },
      });
      sessions.push(overridden);
      expect(overridden.fileIOBackend).toBe('node');
      const trusted = markRunStateSessionState(state, {
        clientOptions: { fileIOProtection: 'required' },
      });
      const resumed = await new UnixLocalSandboxClient({
        fileIOProtection: 'off',
      }).resume(trusted);
      sessions.push(resumed);
      expect(resumed.fileIOBackend).toBe('python');
    });

    it('prepares direct session constructors from current options', async () => {
      const original = await create('off');
      const direct = new UnixLocalSandboxSession({
        state: original.state,
        fileIOProtection: 'required',
      });
      sessions.push(direct);
      expect(direct.fileIOBackend).toBe('python');
    });
  },
);
