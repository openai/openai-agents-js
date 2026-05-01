import {
  Manifest,
  SandboxArchiveError,
  SandboxLifecycleError,
  SandboxProviderError,
  SandboxUnsupportedFeatureError,
} from '@openai/agents-core/sandbox';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  decodeNativeSnapshotRef,
  encodeNativeSnapshotRef,
} from '../../src/sandbox/shared';
import { VercelSandboxClient } from '../../src/sandbox/vercel';
import { resolvedRemotePathFromValidationCommand } from './remotePathValidation';
import { makeTarArchive } from './tarFixture';

const createMock = vi.fn();
const getMock = vi.fn();
const runCommandMock = vi.fn();
const mkDirMock = vi.fn();
const readFileToBufferMock = vi.fn();
const writeFilesMock = vi.fn();
const stopMock = vi.fn();
const snapshotMock = vi.fn();
const domainMock = vi.fn();
const getAuthMock = vi.fn();
const refreshTokenMock = vi.fn();
const updateAuthConfigMock = vi.fn();
const remoteFilePaths = new Set<string>();

function makeSandbox(
  sandboxId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    sandboxId,
    runCommand: runCommandMock,
    mkDir: mkDirMock,
    readFileToBuffer: readFileToBufferMock,
    writeFiles: writeFilesMock,
    stop: stopMock,
    snapshot: snapshotMock,
    domain: domainMock,
    ...overrides,
  };
}

function vercelAlreadyExistsError(path: string): unknown {
  return {
    json: {
      error: {
        code: 'file_error',
        message: `error creating directory: cannot create directory '${path}': File exists`,
      },
    },
  };
}

function testExistsPath(command: string): string | undefined {
  return command.match(/^test -e '([^']+)'$/u)?.[1];
}

vi.mock('@vercel/sandbox', () => ({
  Sandbox: {
    create: createMock,
    get: getMock,
  },
}));

vi.mock('@vercel/sandbox/dist/auth/index.js', () => ({
  getAuth: getAuthMock,
  OAuth: async () => ({
    refreshToken: refreshTokenMock,
  }),
  updateAuthConfig: updateAuthConfigMock,
}));

describe('VercelSandboxClient', () => {
  beforeEach(() => {
    createMock.mockReset();
    getMock.mockReset();
    runCommandMock.mockReset();
    mkDirMock.mockReset();
    readFileToBufferMock.mockReset();
    writeFilesMock.mockReset();
    stopMock.mockReset();
    snapshotMock.mockReset();
    domainMock.mockReset();
    getAuthMock.mockReset();
    refreshTokenMock.mockReset();
    updateAuthConfigMock.mockReset();
    remoteFilePaths.clear();

    createMock.mockResolvedValue(makeSandbox('vercel_test'));
    getMock.mockResolvedValue(makeSandbox('vercel_test'));
    runCommandMock.mockImplementation(
      async (params: { args?: string[] } = {}) => {
        const command = params.args?.[1] ?? '';
        const path = testExistsPath(command);
        if (path) {
          return {
            exitCode: remoteFilePaths.has(path) ? 0 : 1,
            output: vi.fn().mockResolvedValue(''),
          };
        }
        const resolvedPath = resolvedRemotePathFromValidationCommand(command);
        return {
          exitCode: 0,
          output: vi
            .fn()
            .mockResolvedValue(
              resolvedPath ? `${resolvedPath}\n` : 'README.md\n',
            ),
        };
      },
    );
    mkDirMock.mockResolvedValue(undefined);
    readFileToBufferMock.mockResolvedValue(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]),
    );
    writeFilesMock.mockImplementation(
      async (files: Array<{ path?: unknown }> = []) => {
        for (const file of files) {
          if (typeof file.path === 'string') {
            remoteFilePaths.add(file.path);
          }
        }
      },
    );
    stopMock.mockResolvedValue(undefined);
    snapshotMock.mockResolvedValue({ snapshotId: 'snap_test' });
    domainMock.mockReturnValue('https://3000-vercel.example.test');
  });

  test('rejects unsupported core create options instead of ignoring them', async () => {
    const client = new VercelSandboxClient();

    await expect(
      client.create({
        manifest: new Manifest(),
        snapshot: { type: 'remote' },
      }),
    ).rejects.toBeInstanceOf(SandboxUnsupportedFeatureError);
    await expect(
      client.create({
        manifest: new Manifest(),
        concurrencyLimits: { manifestEntries: 2 },
      }),
    ).rejects.toBeInstanceOf(SandboxUnsupportedFeatureError);
    expect(createMock).not.toHaveBeenCalled();
  });

  test('creates a sandbox, remaps the default root, and executes commands', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(
      new Manifest({
        entries: {
          'README.md': {
            type: 'file',
            content: '# Hello\n',
          },
        },
      }),
    );
    const output = await session.execCommand({ cmd: 'ls' });

    expect(session.state.manifest.root).toBe('/vercel/sandbox');
    expect(writeFilesMock).toHaveBeenCalledWith([
      {
        path: '/vercel/sandbox/README.md',
        content: '# Hello\n',
      },
    ]);
    expect(mkDirMock).not.toHaveBeenCalledWith('/vercel/sandbox');
    expect(runCommandMock).toHaveBeenCalledWith({
      cmd: '/bin/sh',
      args: ['-lc', 'ls'],
      cwd: '/vercel/sandbox',
      env: {},
    });
    expect(output).toContain('README.md');
  });

  test('treats missing command exit codes as failures', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest());
    runCommandMock.mockResolvedValueOnce({
      exitCode: null,
      output: vi.fn().mockResolvedValue('lost exit\n'),
    });

    const output = await session.execCommand({ cmd: 'lost-exit' });

    expect(output).toContain('Process exited with code 1');
    expect(output).toContain('lost exit');
  });

  test('does not pass partial project credentials when using OIDC auth', async () => {
    const client = new VercelSandboxClient({
      projectId: 'prj_linked',
      teamId: 'team_linked',
    });

    await client.create(new Manifest());

    expect(createMock).toHaveBeenCalledWith(
      expect.not.objectContaining({
        projectId: expect.any(String),
        teamId: expect.any(String),
      }),
    );
  });

  test('merges explicit project credentials with env access token', async () => {
    vi.stubEnv('VERCEL_PROJECT_ID', 'prj_env');
    vi.stubEnv('VERCEL_TEAM_ID', 'team_env');
    vi.stubEnv('VERCEL_TOKEN', 'env_token');
    try {
      const client = new VercelSandboxClient({
        projectId: 'prj_explicit',
        teamId: 'team_explicit',
      });

      await client.create(new Manifest());

      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'prj_explicit',
          teamId: 'team_explicit',
          token: 'env_token',
        }),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test('merges explicit project credentials with Vercel CLI access token', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vercel-cli-auth-'));
    const authDir = join(root, 'auth');
    const projectRoot = join(root, 'project');
    mkdirSync(authDir, { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectRoot);
    getAuthMock.mockReturnValue({
      token: 'cli_access_token',
      refreshToken: 'cli_refresh_token',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    vi.stubEnv('VERCEL_AUTH_CONFIG_DIR', authDir);
    vi.stubEnv('INIT_CWD', projectRoot);
    vi.stubEnv('PWD', projectRoot);

    try {
      const client = new VercelSandboxClient({
        projectId: 'prj_explicit',
        teamId: 'team_explicit',
      });

      await client.create(new Manifest());

      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'prj_explicit',
          teamId: 'team_explicit',
          token: 'cli_access_token',
        }),
      );
    } finally {
      cwdSpy.mockRestore();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('uses Vercel CLI auth and linked project when no explicit credentials are provided', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vercel-cli-auth-'));
    const authDir = join(root, 'auth');
    const projectRoot = join(root, 'project');
    mkdirSync(authDir, { recursive: true });
    mkdirSync(join(projectRoot, '.vercel'), { recursive: true });
    getAuthMock.mockReturnValue({
      token: 'cli_access_token',
      refreshToken: 'cli_refresh_token',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    writeFileSync(
      join(projectRoot, '.vercel', 'project.json'),
      JSON.stringify({
        projectId: 'prj_cli',
        orgId: 'team_cli',
        projectName: 'sandbox-tests',
      }),
    );
    vi.stubEnv('VERCEL_AUTH_CONFIG_DIR', authDir);
    vi.stubEnv('INIT_CWD', projectRoot);

    try {
      const client = new VercelSandboxClient();

      await client.create(new Manifest());

      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'prj_cli',
          teamId: 'team_cli',
          token: 'cli_access_token',
        }),
      );
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('uses Vercel CLI auth token without a linked project', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vercel-cli-auth-'));
    const authDir = join(root, 'auth');
    const projectRoot = join(root, 'project');
    mkdirSync(authDir, { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(projectRoot);
    getAuthMock.mockReturnValue({
      token: 'cli_access_token',
      refreshToken: 'cli_refresh_token',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    vi.stubEnv('VERCEL_AUTH_CONFIG_DIR', authDir);
    vi.stubEnv('INIT_CWD', projectRoot);
    vi.stubEnv('PWD', projectRoot);

    try {
      const client = new VercelSandboxClient();

      await client.create(new Manifest());

      expect(createMock).toHaveBeenCalledWith(
        expect.objectContaining({
          token: 'cli_access_token',
        }),
      );
      expect(createMock).toHaveBeenCalledWith(
        expect.not.objectContaining({
          projectId: expect.any(String),
          teamId: expect.any(String),
        }),
      );
    } finally {
      cwdSpy.mockRestore();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('serializes Vercel CLI credentials resolved during create', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vercel-cli-auth-'));
    const authDir = join(root, 'auth');
    const projectRoot = join(root, 'project');
    mkdirSync(authDir, { recursive: true });
    mkdirSync(join(projectRoot, '.vercel'), { recursive: true });
    getAuthMock.mockReturnValue({
      token: 'cli_access_token',
      refreshToken: 'cli_refresh_token',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    writeFileSync(
      join(projectRoot, '.vercel', 'project.json'),
      JSON.stringify({
        projectId: 'prj_cli',
        orgId: 'team_cli',
        projectName: 'sandbox-tests',
      }),
    );
    vi.stubEnv('VERCEL_AUTH_CONFIG_DIR', authDir);
    vi.stubEnv('INIT_CWD', projectRoot);

    let session: Awaited<ReturnType<VercelSandboxClient['create']>> | undefined;
    try {
      const client = new VercelSandboxClient();
      session = await client.create(new Manifest(), {
        workspacePersistence: 'snapshot',
      });
      expect(session.state.token).toBe('cli_access_token');
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
    if (!session) {
      throw new Error('Expected Vercel sandbox session.');
    }

    const client = new VercelSandboxClient();
    getMock.mockClear();

    const serialized = await client.serializeSessionState(session.state, {
      willCloseAfterSerialize: true,
    });

    expect(getMock).toHaveBeenCalledWith({
      sandboxId: 'vercel_test',
      projectId: 'prj_cli',
      teamId: 'team_cli',
      token: 'cli_access_token',
    });
    expect(serialized).toMatchObject({
      projectId: 'prj_cli',
      teamId: 'team_cli',
      token: 'cli_access_token',
      sandboxId: 'vercel_test',
      workspacePersistence: 'snapshot',
      snapshotId: 'snap_test',
    });
  });

  test('passes complete access token credentials to Vercel', async () => {
    const client = new VercelSandboxClient({
      projectId: 'prj_access_token',
      teamId: 'team_access_token',
      token: 'vercel_test_token',
    });

    await client.create(new Manifest());

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'prj_access_token',
        teamId: 'team_access_token',
        token: 'vercel_test_token',
      }),
    );
  });

  test('preserves access token credentials when hydrating native snapshots', async () => {
    const client = new VercelSandboxClient({
      projectId: 'prj_access_token',
      teamId: 'team_access_token',
      token: 'vercel_test_token',
    });
    const session = await client.create(new Manifest(), {
      workspacePersistence: 'snapshot',
    });
    createMock.mockClear();
    createMock.mockResolvedValueOnce(makeSandbox('vercel_restored'));

    await session.hydrateWorkspace(
      encodeNativeSnapshotRef({
        provider: 'vercel',
        snapshotId: 'snap_restore',
      }),
    );

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'prj_access_token',
        teamId: 'team_access_token',
        token: 'vercel_test_token',
        source: {
          type: 'snapshot',
          snapshotId: 'snap_restore',
        },
      }),
    );
  });

  test('reuses resolved manifest environment values during create', async () => {
    let tokenVersion = 0;
    const resolveToken = vi.fn(async () => `token-${++tokenVersion}`);
    const client = new VercelSandboxClient({
      env: {
        CLIENT_ENV: 'client',
      },
    });

    const session = await client.create(
      new Manifest({
        environment: {
          TOKEN: {
            value: 'placeholder',
            resolve: resolveToken,
          },
        },
      }),
    );

    expect(resolveToken).toHaveBeenCalledOnce();
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        env: {
          CLIENT_ENV: 'client',
          TOKEN: 'token-1',
        },
      }),
    );
    expect(session.state.environment).toEqual({
      CLIENT_ENV: 'client',
      TOKEN: 'token-1',
    });
  });

  test('rejects unsupported manifest metadata after remapping the default root', async () => {
    const client = new VercelSandboxClient();

    await expect(
      client.create(
        new Manifest({
          extraPathGrants: [{ path: '/tmp/data' }],
        }),
      ),
    ).rejects.toThrow(/does not support extra path grants yet/);
    expect(createMock).not.toHaveBeenCalled();
  });

  test('rejects serialized sessions with roots outside the Vercel workspace', async () => {
    const client = new VercelSandboxClient();

    await expect(
      client.deserializeSessionState({
        manifest: new Manifest({
          root: '/tmp',
        }),
        sandboxId: 'vercel_existing',
        workspacePersistence: 'tar',
        environment: {},
      }),
    ).rejects.toThrow(
      'Vercel sandboxes require manifest.root to stay within "/vercel/sandbox".',
    );
  });

  test('rejects serialized sessions with unsupported manifest metadata', async () => {
    const client = new VercelSandboxClient();

    await expect(
      client.deserializeSessionState({
        manifest: new Manifest({
          extraPathGrants: [{ path: '/tmp/data' }],
        }),
        sandboxId: 'vercel_existing',
        workspacePersistence: 'tar',
        environment: {},
      }),
    ).rejects.toThrow(/does not support extra path grants yet/);
  });

  test('does not recreate an existing directory for sibling files', async () => {
    mkDirMock.mockImplementation(async (path: string) => {
      if (path === '/vercel/sandbox/project') {
        const callsForPath = mkDirMock.mock.calls.filter(
          ([calledPath]) => calledPath === path,
        ).length;
        if (callsForPath > 1) {
          throw vercelAlreadyExistsError(path);
        }
      }
    });

    const client = new VercelSandboxClient();
    await client.create(
      new Manifest({
        entries: {
          'project/status.md': {
            type: 'file',
            content: '# Status\n',
          },
          'project/tasks.md': {
            type: 'file',
            content: '# Tasks\n',
          },
        },
      }),
    );

    expect(
      mkDirMock.mock.calls.filter(
        ([path]) => path === '/vercel/sandbox/project',
      ),
    ).toHaveLength(1);
  });

  test('creates parent directories recursively before file writes', async () => {
    const createdDirs = new Set(['/vercel/sandbox']);
    mkDirMock.mockImplementation(async (path: string) => {
      const lastSlash = path.lastIndexOf('/');
      const parent = lastSlash > 0 ? path.slice(0, lastSlash) : '/';
      if (!createdDirs.has(parent)) {
        throw new Error(`missing parent: ${parent}`);
      }
      createdDirs.add(path);
    });

    const client = new VercelSandboxClient();
    await client.create(
      new Manifest({
        entries: {
          'a/b/file.txt': {
            type: 'file',
            content: 'nested\n',
          },
        },
      }),
    );

    expect(mkDirMock.mock.calls.map(([path]) => path)).toEqual([
      '/vercel/sandbox/a',
      '/vercel/sandbox/a/b',
    ]);
    expect(writeFilesMock).toHaveBeenCalledWith([
      {
        path: '/vercel/sandbox/a/b/file.txt',
        content: 'nested\n',
      },
    ]);
  });

  test('creates configured workspace roots before initial writes', async () => {
    const createdDirs = new Set(['/vercel/sandbox']);
    mkDirMock.mockImplementation(async (path: string) => {
      const lastSlash = path.lastIndexOf('/');
      const parent = lastSlash > 0 ? path.slice(0, lastSlash) : '/';
      if (!createdDirs.has(parent)) {
        throw new Error(`missing parent: ${parent}`);
      }
      createdDirs.add(path);
    });

    const client = new VercelSandboxClient();
    await client.create(
      new Manifest({
        root: '/vercel/sandbox/app',
        entries: {
          'README.md': {
            type: 'file',
            content: '# App\n',
          },
        },
      }),
    );

    expect(mkDirMock).toHaveBeenCalledWith('/vercel/sandbox/app');
    expect(writeFilesMock).toHaveBeenCalledWith([
      {
        path: '/vercel/sandbox/app/README.md',
        content: '# App\n',
      },
    ]);
  });

  test('uses idempotent editor mkdir operations', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest());
    const editor = session.createEditor?.();
    if (!editor) {
      throw new Error('Expected VercelSandboxSession.createEditor().');
    }
    mkDirMock.mockClear();
    writeFilesMock.mockClear();
    mkDirMock.mockImplementation(async (path: string) => {
      if (path === '/vercel/sandbox') {
        throw vercelAlreadyExistsError(path);
      }
    });

    await editor.createFile({
      type: 'create_file',
      path: 'notes.txt',
      diff: '+hello\n',
    });

    expect(mkDirMock).not.toHaveBeenCalledWith('/vercel/sandbox');
    expect(writeFilesMock).toHaveBeenCalledWith([
      {
        path: '/vercel/sandbox/notes.txt',
        content: 'hello',
      },
    ]);
  });

  test('fails editor deletes when remote rm fails', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest());
    const editor = session.createEditor?.();
    if (!editor) {
      throw new Error('Expected VercelSandboxSession.createEditor().');
    }
    runCommandMock.mockImplementation(
      async (params: { args?: string[] } = {}) => {
        const command = params.args?.[1] ?? '';
        if (command.includes("rm -f -- '/vercel/sandbox/old.txt'")) {
          return {
            exitCode: 1,
            output: vi.fn().mockResolvedValue('delete denied'),
          };
        }
        const resolvedPath = resolvedRemotePathFromValidationCommand(command);
        return {
          exitCode: 0,
          output: vi
            .fn()
            .mockResolvedValue(
              resolvedPath ? `${resolvedPath}\n` : 'README.md\n',
            ),
        };
      },
    );

    await expect(
      editor.deleteFile({
        type: 'delete_file',
        path: 'old.txt',
      }),
    ).rejects.toMatchObject({
      details: {
        provider: 'vercel',
        operation: 'delete path',
        sandboxId: 'vercel_test',
        path: '/vercel/sandbox/old.txt',
        exitCode: 1,
        output: 'delete denied',
      },
    });
  });

  test('stores materialized absolute workspace paths as relative manifest keys', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest());

    await session.materializeEntry({
      path: '/vercel/sandbox/extra.txt',
      entry: {
        type: 'file',
        content: 'extra\n',
      },
    });

    expect(writeFilesMock).toHaveBeenCalledWith([
      {
        path: '/vercel/sandbox/extra.txt',
        content: 'extra\n',
      },
    ]);
    expect(session.state.manifest.entries).toHaveProperty('extra.txt');
    expect(session.state.manifest.entries).not.toHaveProperty(
      '/vercel/sandbox/extra.txt',
    );
  });

  test('remaps default manifest roots when applying manifests to sessions', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest());
    writeFilesMock.mockClear();

    await session.applyManifest(
      new Manifest({
        entries: {
          'next.txt': {
            type: 'file',
            content: 'next\n',
          },
        },
      }),
    );

    expect(writeFilesMock).toHaveBeenCalledWith([
      {
        path: '/vercel/sandbox/next.txt',
        content: 'next\n',
      },
    ]);
    expect(session.state.manifest.root).toBe('/vercel/sandbox');
    expect(session.state.manifest.entries).toHaveProperty('next.txt');
  });

  test('captures snapshot ids on close and resumes from snapshots', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest(), {
      workspacePersistence: 'snapshot',
    });

    await session.close();
    getMock.mockRejectedValueOnce(new Error('sandbox gone'));
    await client.resume(session.state);

    expect(snapshotMock).toHaveBeenCalledOnce();
    expect(stopMock).toHaveBeenCalledOnce();
    expect(session.state.snapshotId).toBe('snap_test');
    expect(createMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        source: {
          type: 'snapshot',
          snapshotId: 'snap_test',
        },
      }),
    );
  });

  test('retains serialized access token credentials when resuming live sandboxes', async () => {
    const client = new VercelSandboxClient();
    const state = await client.deserializeSessionState({
      manifest: new Manifest(),
      sandboxId: 'vercel_existing',
      workspacePersistence: 'tar',
      environment: {},
      projectId: 'prj_serialized',
      teamId: 'team_serialized',
      token: 'serialized_token',
    });

    await client.resume(state);

    expect(getMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxId: 'vercel_existing',
        projectId: 'prj_serialized',
        teamId: 'team_serialized',
        token: 'serialized_token',
      }),
    );
  });

  test('refreshes expired serialized CLI credentials when resuming live sandboxes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vercel-cli-refresh-'));
    const authDir = join(root, 'auth');
    mkdirSync(authDir, { recursive: true });
    getAuthMock.mockReturnValue({
      token: 'cli_access_token',
      refreshToken: 'cli_refresh_token',
      expiresAt: new Date(Date.now() - 1_000),
    });
    refreshTokenMock.mockResolvedValue({
      access_token: 'cli_refreshed_token',
      expires_in: 3_600,
      refresh_token: 'cli_next_refresh_token',
    });
    vi.stubEnv('VERCEL_AUTH_CONFIG_DIR', authDir);

    try {
      const client = new VercelSandboxClient();
      const state = await client.deserializeSessionState({
        manifest: new Manifest(),
        sandboxId: 'vercel_existing',
        workspacePersistence: 'tar',
        environment: {},
        projectId: 'prj_serialized',
        teamId: 'team_serialized',
        token: 'cli_access_token',
      });

      await client.resume(state);

      expect(refreshTokenMock).toHaveBeenCalledWith('cli_refresh_token');
      expect(updateAuthConfigMock).toHaveBeenCalledWith(
        expect.objectContaining({
          token: 'cli_refreshed_token',
          refreshToken: 'cli_next_refresh_token',
          expiresAt: expect.any(Date),
        }),
      );
      expect(getMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxId: 'vercel_existing',
          projectId: 'prj_serialized',
          teamId: 'team_serialized',
          token: 'cli_refreshed_token',
        }),
      );
      expect(state.token).toBe('cli_refreshed_token');
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('drops expired serialized CLI tokens when refresh cannot run', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vercel-cli-expired-'));
    const authDir = join(root, 'auth');
    mkdirSync(authDir, { recursive: true });
    getAuthMock.mockReturnValue({
      token: 'cli_access_token',
      expiresAt: new Date(Date.now() - 1_000),
    });
    vi.stubEnv('VERCEL_AUTH_CONFIG_DIR', authDir);

    try {
      const client = new VercelSandboxClient();
      const state = await client.deserializeSessionState({
        manifest: new Manifest(),
        sandboxId: 'vercel_existing',
        workspacePersistence: 'tar',
        environment: {},
        projectId: 'prj_serialized',
        teamId: 'team_serialized',
        token: 'cli_access_token',
      });

      await client.resume(state);

      expect(refreshTokenMock).not.toHaveBeenCalled();
      expect(getMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxId: 'vercel_existing',
          projectId: 'prj_serialized',
          teamId: 'team_serialized',
        }),
      );
      expect(getMock.mock.calls[0]?.[0]).not.toHaveProperty('token');
      expect(state.token).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('retains serialized access token credentials when resuming snapshot sandboxes', async () => {
    createMock.mockResolvedValueOnce(makeSandbox('vercel_restored'));
    const client = new VercelSandboxClient();
    const state = await client.deserializeSessionState({
      manifest: new Manifest(),
      sandboxId: 'vercel_original',
      workspacePersistence: 'snapshot',
      environment: {},
      snapshotId: 'snap_original',
      snapshotSandboxId: 'vercel_original',
      projectId: 'prj_serialized',
      teamId: 'team_serialized',
      token: 'serialized_token',
    });

    await client.resume(state);

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'prj_serialized',
        teamId: 'team_serialized',
        token: 'serialized_token',
        source: {
          type: 'snapshot',
          snapshotId: 'snap_original',
        },
      }),
    );
  });

  test('reattaches live sandboxes when snapshot freshness was invalidated', async () => {
    getMock.mockResolvedValueOnce(makeSandbox('vercel_live'));
    const client = new VercelSandboxClient();
    const state = await client.deserializeSessionState({
      manifest: new Manifest(),
      sandboxId: 'vercel_live',
      workspacePersistence: 'snapshot',
      environment: {},
      snapshotId: 'snap_stale',
    });

    const session = await client.resume(state);

    expect(createMock).not.toHaveBeenCalled();
    expect(getMock).toHaveBeenCalledWith({
      sandboxId: 'vercel_live',
    });
    expect(session.state.sandboxId).toBe('vercel_live');
    expect(session.state.snapshotId).toBe('snap_stale');
    expect(session.state.snapshotSandboxId).toBeUndefined();
  });

  test('wraps resume lookup provider errors', async () => {
    getMock.mockRejectedValueOnce(new Error('auth failed'));
    const client = new VercelSandboxClient();
    const state = await client.deserializeSessionState({
      manifest: new Manifest(),
      sandboxId: 'vercel_existing',
      workspacePersistence: 'tar',
      environment: {},
    });

    await expect(client.resume(state)).rejects.toMatchObject({
      details: {
        provider: 'vercel',
        operation: 'resume sandbox',
        sandboxId: 'vercel_existing',
        cause: 'auth failed',
      },
    });
  });

  test('wraps resume snapshot provider errors', async () => {
    createMock.mockRejectedValueOnce(new Error('snapshot restore failed'));
    const client = new VercelSandboxClient();
    const state = await client.deserializeSessionState({
      manifest: new Manifest(),
      sandboxId: 'vercel_original',
      workspacePersistence: 'snapshot',
      environment: {},
      snapshotId: 'snap_original',
      snapshotSandboxId: 'vercel_original',
    });

    await expect(client.resume(state)).rejects.toMatchObject({
      details: {
        provider: 'vercel',
        operation: 'resume sandbox from snapshot',
        sandboxId: 'vercel_original',
        snapshotId: 'snap_original',
        cause: 'snapshot restore failed',
      },
    });
  });

  test('wraps snapshot capture provider errors during explicit persistence', async () => {
    snapshotMock.mockRejectedValueOnce(new Error('snapshot failed'));
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest(), {
      workspacePersistence: 'snapshot',
    });

    await expect(session.persistWorkspace()).rejects.toMatchObject({
      details: {
        provider: 'vercel',
        operation: 'capture snapshot',
        sandboxId: 'vercel_test',
        cause: 'snapshot failed',
      },
    });
  });

  test('stores the live sandbox id after resuming from a snapshot', async () => {
    createMock.mockResolvedValueOnce(makeSandbox('vercel_resumed'));
    const client = new VercelSandboxClient();
    const state = await client.deserializeSessionState({
      manifest: new Manifest(),
      sandboxId: 'vercel_original',
      workspacePersistence: 'snapshot',
      environment: {},
      snapshotId: 'snap_original',
      snapshotSandboxId: 'vercel_original',
    });

    const session = await client.resume(state);

    expect(getMock).not.toHaveBeenCalled();
    expect(session.state.sandboxId).toBe('vercel_resumed');
    expect(session.state.snapshotId).toBe('snap_original');
    expect(session.state.snapshotSandboxId).toBeUndefined();
  });

  test('clears exposed port caches after resuming from a snapshot', async () => {
    createMock.mockResolvedValueOnce(makeSandbox('vercel_resumed'));
    const client = new VercelSandboxClient();
    const state = await client.deserializeSessionState({
      manifest: new Manifest(),
      sandboxId: 'vercel_original',
      workspacePersistence: 'snapshot',
      configuredExposedPorts: [3000],
      environment: {},
      exposedPorts: {
        '3000': {
          host: 'old-vercel.example.test',
          port: 443,
          tls: true,
          query: '',
        },
      },
      snapshotId: 'snap_original',
      snapshotSandboxId: 'vercel_original',
    });

    const session = await client.resume(state);
    const endpoint = await session.resolveExposedPort(3000);

    expect(domainMock).toHaveBeenCalledOnce();
    expect(endpoint.host).toBe('3000-vercel.example.test');
    expect(session.state.exposedPorts?.['3000']).toBe(endpoint);
  });

  test('stops snapshot replacements when resume readiness times out', async () => {
    const nowSpy = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValue(31_000);
    try {
      createMock.mockResolvedValueOnce(makeSandbox('vercel_resumed'));
      const client = new VercelSandboxClient();
      const state = await client.deserializeSessionState({
        manifest: new Manifest(),
        sandboxId: 'vercel_original',
        workspacePersistence: 'snapshot',
        environment: {},
        snapshotId: 'snap_original',
        snapshotSandboxId: 'vercel_original',
      });

      await expect(client.resume(state)).rejects.toBeInstanceOf(
        SandboxLifecycleError,
      );

      expect(stopMock).toHaveBeenCalledOnce();
    } finally {
      nowSpy.mockRestore();
    }
  });

  test('captures and stops a live sandbox resumed from a snapshot', async () => {
    createMock.mockResolvedValueOnce(makeSandbox('vercel_resumed'));
    snapshotMock.mockResolvedValueOnce({ snapshotId: 'snap_resumed' });
    const client = new VercelSandboxClient();
    const state = await client.deserializeSessionState({
      manifest: new Manifest(),
      sandboxId: 'vercel_original',
      workspacePersistence: 'snapshot',
      environment: {},
      snapshotId: 'snap_original',
      snapshotSandboxId: 'vercel_original',
    });
    const session = await client.resume(state);

    await session.close();

    expect(snapshotMock).toHaveBeenCalledOnce();
    expect(stopMock).toHaveBeenCalledOnce();
    expect(session.state.snapshotId).toBe('snap_resumed');
    expect(session.state.snapshotSandboxId).toBe('vercel_resumed');
  });

  test('restores snapshot sessions instead of reattaching to the source sandbox', async () => {
    createMock.mockResolvedValueOnce(makeSandbox('vercel_restored'));
    const client = new VercelSandboxClient();
    const state = await client.deserializeSessionState({
      manifest: new Manifest(),
      sandboxId: 'vercel_preserved',
      workspacePersistence: 'snapshot',
      environment: {},
      snapshotId: 'snap_preserved',
      snapshotSandboxId: 'vercel_preserved',
    });

    const session = await client.resume(state);

    expect(getMock).not.toHaveBeenCalled();
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: {
          type: 'snapshot',
          snapshotId: 'snap_preserved',
        },
      }),
    );
    expect(session.state.sandboxId).toBe('vercel_restored');
    expect(session.state.snapshotId).toBe('snap_preserved');
    expect(session.state.snapshotSandboxId).toBeUndefined();
  });

  test('surfaces stop failures when replacing snapshot sandboxes', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest(), {
      workspacePersistence: 'snapshot',
    });
    createMock.mockResolvedValueOnce(makeSandbox('vercel_restored'));
    stopMock
      .mockRejectedValueOnce(new Error('stop failed'))
      .mockResolvedValueOnce(undefined);

    let thrown: unknown;
    try {
      await session.hydrateWorkspace(
        encodeNativeSnapshotRef({
          provider: 'vercel',
          snapshotId: 'snap_restore',
        }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SandboxProviderError);
    expect((thrown as SandboxProviderError).details).toMatchObject({
      provider: 'vercel',
      sandboxId: 'vercel_test',
      replacementSandboxId: 'vercel_restored',
      cause: 'stop failed',
    });
    expect(stopMock).toHaveBeenCalledTimes(2);
    expect(session.state.sandboxId).toBe('vercel_test');
    expect(session.state.snapshotId).toBeUndefined();
  });

  test('stops snapshot replacements when hydrate readiness times out', async () => {
    const replacementStopMock = vi.fn().mockResolvedValue(undefined);
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest(), {
      workspacePersistence: 'snapshot',
    });
    createMock.mockResolvedValueOnce(
      makeSandbox('vercel_restored', {
        stop: replacementStopMock,
      }),
    );
    stopMock.mockClear();

    const nowSpy = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValue(31_000);
    try {
      await expect(
        session.hydrateWorkspace(
          encodeNativeSnapshotRef({
            provider: 'vercel',
            snapshotId: 'snap_restore',
          }),
        ),
      ).rejects.toBeInstanceOf(SandboxLifecycleError);

      expect(replacementStopMock).toHaveBeenCalledOnce();
      expect(stopMock).not.toHaveBeenCalled();
      expect(session.state.sandboxId).toBe('vercel_test');
    } finally {
      nowSpy.mockRestore();
    }
  });

  test('serializes snapshot sessions without capturing new snapshots', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest(), {
      workspacePersistence: 'snapshot',
    });

    const serialized = await client.serializeSessionState(session.state);

    expect(snapshotMock).not.toHaveBeenCalled();
    expect(stopMock).not.toHaveBeenCalled();
    expect(serialized).toMatchObject({
      sandboxId: 'vercel_test',
      workspacePersistence: 'snapshot',
    });
  });

  test('serializes snapshot state with create-time access token credentials', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest(), {
      workspacePersistence: 'snapshot',
      projectId: 'prj_create',
      teamId: 'team_create',
      token: 'create_token',
    });
    getMock.mockClear();

    const serialized = await client.serializeSessionState(session.state);

    expect(getMock).not.toHaveBeenCalled();
    expect(snapshotMock).not.toHaveBeenCalled();
    expect(serialized).toMatchObject({
      projectId: 'prj_create',
      teamId: 'team_create',
      token: 'create_token',
      sandboxId: 'vercel_test',
      workspacePersistence: 'snapshot',
    });
  });

  test('captures snapshots before serializing preserved snapshot sessions', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest(), {
      workspacePersistence: 'snapshot',
      projectId: 'prj_create',
      teamId: 'team_create',
      token: 'create_token',
    });
    getMock.mockClear();

    const serialized = await client.serializeSessionState(session.state, {
      preserveOwnedSession: true,
      reuseLiveSession: false,
    });

    expect(getMock).toHaveBeenCalledWith({
      sandboxId: 'vercel_test',
      projectId: 'prj_create',
      teamId: 'team_create',
      token: 'create_token',
    });
    expect(snapshotMock).toHaveBeenCalledOnce();
    expect(stopMock).not.toHaveBeenCalled();
    expect(serialized).toMatchObject({
      sandboxId: 'vercel_test',
      workspacePersistence: 'snapshot',
      snapshotId: 'snap_test',
      snapshotSandboxId: 'vercel_test',
    });
  });

  test('captures snapshots before serializing snapshot sessions marked for close', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest(), {
      workspacePersistence: 'snapshot',
      projectId: 'prj_create',
      teamId: 'team_create',
      token: 'create_token',
    });
    getMock.mockClear();

    const serialized = await client.serializeSessionState(session.state, {
      willCloseAfterSerialize: true,
    });

    expect(getMock).toHaveBeenCalledWith({
      sandboxId: 'vercel_test',
      projectId: 'prj_create',
      teamId: 'team_create',
      token: 'create_token',
    });
    expect(snapshotMock).toHaveBeenCalledOnce();
    expect(serialized).toMatchObject({
      sandboxId: 'vercel_test',
      workspacePersistence: 'snapshot',
      snapshotId: 'snap_test',
      snapshotSandboxId: 'vercel_test',
    });
  });

  test('captures snapshots during close after non-destructive serialization', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest(), {
      workspacePersistence: 'snapshot',
    });

    await client.serializeSessionState(session.state);
    await session.close();

    expect(snapshotMock).toHaveBeenCalledOnce();
    expect(stopMock).toHaveBeenCalledOnce();
  });

  test('captures live sandbox snapshots without resolving credentials', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest(), {
      workspacePersistence: 'snapshot',
    });
    getAuthMock.mockImplementation(() => {
      throw new Error('credential lookup should not run');
    });

    await session.close();

    expect(getAuthMock).not.toHaveBeenCalled();
    expect(snapshotMock).toHaveBeenCalledOnce();
    expect(stopMock).toHaveBeenCalledOnce();
  });

  test('ignores stop failures after a close snapshot already shut down the sandbox', async () => {
    stopMock.mockRejectedValueOnce(new Error('sandbox already stopped'));
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest(), {
      workspacePersistence: 'snapshot',
    });

    await expect(session.close()).resolves.toBeUndefined();
    await session.delete();

    expect(snapshotMock).toHaveBeenCalledOnce();
    expect(stopMock).toHaveBeenCalledOnce();
    expect(session.state.snapshotId).toBe('snap_test');
    expect(session.state.snapshotSandboxId).toBe('vercel_test');
  });

  test('invalidates snapshot freshness after workspace writes', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest(), {
      workspacePersistence: 'snapshot',
    });
    const editor = session.createEditor?.();
    if (!editor) {
      throw new Error('Expected VercelSandboxSession.createEditor().');
    }

    await session.persistWorkspace();
    expect(session.state.snapshotSandboxId).toBe('vercel_test');
    snapshotMock.mockClear();

    await editor.createFile({
      type: 'create_file',
      path: 'notes.txt',
      diff: '+fresh\n',
    });
    expect(session.state.snapshotSandboxId).toBeUndefined();

    await session.close();

    expect(snapshotMock).toHaveBeenCalledOnce();
    expect(stopMock).toHaveBeenCalledTimes(2);
  });

  test('persists and hydrates tar workspaces through safe archive helpers', async () => {
    const archive = makeTarArchive([
      { name: 'keep.txt', content: 'keep' },
      { name: 'nested/file.txt', content: 'nested' },
    ]);
    readFileToBufferMock.mockResolvedValue(archive);
    const client = new VercelSandboxClient({
      workspacePersistence: 'tar',
    });
    const session = await client.create(new Manifest());

    await expect(session.persistWorkspace()).resolves.toEqual(archive);
    await session.hydrateWorkspace(archive);

    expect(
      runCommandMock.mock.calls.some(([params]) =>
        String(params.args?.[1]).includes('tar -C'),
      ),
    ).toBe(true);
    expect(writeFilesMock).toHaveBeenCalledWith([
      expect.objectContaining({
        content: archive,
      }),
    ]);
  });

  test('clears cached directories after hydrating tar workspaces', async () => {
    const archive = makeTarArchive([{ name: 'keep.txt', content: 'keep' }]);
    const client = new VercelSandboxClient({
      workspacePersistence: 'tar',
    });
    const session = await client.create(
      new Manifest({
        entries: {
          'cache/old.txt': {
            type: 'file',
            content: 'old\n',
          },
        },
      }),
    );
    const editor = session.createEditor?.();
    if (!editor) {
      throw new Error('Expected VercelSandboxSession.createEditor().');
    }

    await session.hydrateWorkspace(archive);
    mkDirMock.mockClear();
    writeFilesMock.mockClear();

    await editor.createFile({
      type: 'create_file',
      path: 'cache/new.txt',
      diff: '+new\n',
    });

    expect(mkDirMock).toHaveBeenCalledWith('/vercel/sandbox/cache');
    expect(writeFilesMock).toHaveBeenCalledWith([
      {
        path: '/vercel/sandbox/cache/new.txt',
        content: 'new',
      },
    ]);
  });

  test('clears cached directories after shell commands', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(
      new Manifest({
        entries: {
          'cache/old.txt': {
            type: 'file',
            content: 'old\n',
          },
        },
      }),
    );
    const editor = session.createEditor?.();
    if (!editor) {
      throw new Error('Expected VercelSandboxSession.createEditor().');
    }
    mkDirMock.mockClear();
    writeFilesMock.mockClear();

    await session.execCommand({ cmd: 'rm -rf /vercel/sandbox/cache' });
    await editor.createFile({
      type: 'create_file',
      path: 'cache/new.txt',
      diff: '+new\n',
    });

    expect(mkDirMock).toHaveBeenCalledWith('/vercel/sandbox/cache');
    expect(writeFilesMock).toHaveBeenCalledWith([
      {
        path: '/vercel/sandbox/cache/new.txt',
        content: 'new',
      },
    ]);
  });

  test('rejects unsafe tar payloads before hydrate writes them', async () => {
    const client = new VercelSandboxClient({
      workspacePersistence: 'tar',
    });
    const session = await client.create(new Manifest());
    writeFilesMock.mockClear();

    await expect(
      session.hydrateWorkspace(
        makeTarArchive([{ name: '../escape.txt', content: 'bad' }]),
      ),
    ).rejects.toBeInstanceOf(SandboxArchiveError);
    expect(writeFilesMock).not.toHaveBeenCalled();
  });

  test('persists Vercel snapshots as Python-compatible native refs', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest(), {
      workspacePersistence: 'snapshot',
    });

    const ref = decodeNativeSnapshotRef(await session.persistWorkspace());

    expect(snapshotMock).toHaveBeenCalledOnce();
    expect(ref).toEqual({
      provider: 'vercel',
      snapshotId: 'snap_test',
      workspacePersistence: undefined,
    });
  });

  test('rebinds live snapshot persistence to a replacement sandbox', async () => {
    const sourceStopMock = vi.fn().mockResolvedValue(undefined);
    const replacementRunCommandMock = vi.fn(async () => ({
      exitCode: 0,
      output: vi.fn().mockResolvedValue('replacement\n'),
    }));
    createMock
      .mockResolvedValueOnce(
        makeSandbox('vercel_source', {
          stop: sourceStopMock,
        }),
      )
      .mockResolvedValueOnce(
        makeSandbox('vercel_replacement', {
          runCommand: replacementRunCommandMock,
        }),
      );
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest(), {
      workspacePersistence: 'snapshot',
    });
    createMock.mockClear();
    stopMock.mockClear();

    const ref = decodeNativeSnapshotRef(await session.persistWorkspace());

    expect(ref).toMatchObject({
      provider: 'vercel',
      snapshotId: 'snap_test',
    });
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: {
          type: 'snapshot',
          snapshotId: 'snap_test',
        },
      }),
    );
    expect(sourceStopMock).toHaveBeenCalledOnce();
    expect(stopMock).not.toHaveBeenCalled();
    expect(session.state).toMatchObject({
      sandboxId: 'vercel_replacement',
      snapshotId: 'snap_test',
      snapshotSandboxId: 'vercel_replacement',
    });
    expect(replacementRunCommandMock).toHaveBeenCalledWith({
      cmd: '/bin/sh',
      args: ['-lc', 'true'],
      cwd: '/',
      env: {},
    });

    replacementRunCommandMock.mockClear();
    await session.execCommand({ cmd: 'echo after-persist' });

    expect(replacementRunCommandMock).toHaveBeenCalledWith({
      cmd: '/bin/sh',
      args: ['-lc', 'echo after-persist'],
      cwd: '/vercel/sandbox',
      env: {},
    });
  });

  test('keeps restored snapshot persistence when the snapshotted source is already stopped', async () => {
    const sourceStopMock = vi
      .fn()
      .mockRejectedValue(new Error('sandbox already stopped'));
    const replacementStopMock = vi.fn().mockResolvedValue(undefined);
    createMock
      .mockResolvedValueOnce(
        makeSandbox('vercel_source', {
          stop: sourceStopMock,
        }),
      )
      .mockResolvedValueOnce(
        makeSandbox('vercel_replacement', {
          stop: replacementStopMock,
        }),
      );
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest(), {
      workspacePersistence: 'snapshot',
    });

    await expect(session.persistWorkspace()).resolves.toEqual(
      encodeNativeSnapshotRef({
        provider: 'vercel',
        snapshotId: 'snap_test',
      }),
    );

    expect(sourceStopMock).toHaveBeenCalledOnce();
    expect(replacementStopMock).not.toHaveBeenCalled();
    expect(session.state).toMatchObject({
      sandboxId: 'vercel_replacement',
      snapshotId: 'snap_test',
      snapshotSandboxId: 'vercel_replacement',
    });
  });

  test('does not rebind snapshot persistence when the previous sandbox stop fails', async () => {
    const sourceStopMock = vi
      .fn()
      .mockRejectedValue(new Error('network timeout'));
    const firstReplacementStopMock = vi.fn().mockResolvedValue(undefined);
    const secondReplacementStopMock = vi.fn().mockResolvedValue(undefined);
    createMock
      .mockResolvedValueOnce(
        makeSandbox('vercel_source', {
          stop: sourceStopMock,
        }),
      )
      .mockResolvedValueOnce(
        makeSandbox('vercel_replacement_1', {
          stop: firstReplacementStopMock,
        }),
      )
      .mockResolvedValueOnce(
        makeSandbox('vercel_replacement_2', {
          stop: secondReplacementStopMock,
        }),
      );
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest(), {
      workspacePersistence: 'snapshot',
    });

    await expect(session.persistWorkspace()).rejects.toMatchObject({
      details: {
        provider: 'vercel',
        sandboxId: 'vercel_source',
        snapshotId: 'snap_test',
      },
    });

    expect(sourceStopMock).toHaveBeenCalledTimes(2);
    expect(firstReplacementStopMock).toHaveBeenCalledOnce();
    expect(secondReplacementStopMock).toHaveBeenCalledOnce();
    expect(session.state.sandboxId).toBe('vercel_source');
    expect(session.state.snapshotSandboxId).toBe('vercel_source');
  });

  test('uses refreshed state token when restoring persisted snapshots', async () => {
    createMock
      .mockResolvedValueOnce(makeSandbox('vercel_source'))
      .mockResolvedValueOnce(makeSandbox('vercel_replacement'));
    const client = new VercelSandboxClient({
      projectId: 'prj_cli',
      teamId: 'team_cli',
      token: 'cli_access_token',
    });
    const session = await client.create(new Manifest(), {
      workspacePersistence: 'snapshot',
    });
    session.state.token = 'cli_refreshed_token';
    createMock.mockClear();

    await session.persistWorkspace();

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'prj_cli',
        teamId: 'team_cli',
        token: 'cli_refreshed_token',
        source: {
          type: 'snapshot',
          snapshotId: 'snap_test',
        },
      }),
    );
    expect(session.state.token).toBe('cli_refreshed_token');
  });

  test('stops each previous sandbox during repeated snapshot persistence', async () => {
    const sourceStopMock = vi.fn().mockResolvedValue(undefined);
    const firstReplacementStopMock = vi.fn().mockResolvedValue(undefined);
    const secondReplacementStopMock = vi.fn().mockResolvedValue(undefined);
    createMock
      .mockResolvedValueOnce(
        makeSandbox('vercel_source', {
          stop: sourceStopMock,
        }),
      )
      .mockResolvedValueOnce(
        makeSandbox('vercel_replacement_1', {
          stop: firstReplacementStopMock,
        }),
      )
      .mockResolvedValueOnce(
        makeSandbox('vercel_replacement_2', {
          stop: secondReplacementStopMock,
        }),
      );
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest(), {
      workspacePersistence: 'snapshot',
    });

    await session.persistWorkspace();
    await session.persistWorkspace();

    expect(sourceStopMock).toHaveBeenCalledOnce();
    expect(firstReplacementStopMock).toHaveBeenCalledOnce();
    expect(secondReplacementStopMock).not.toHaveBeenCalled();
    expect(stopMock).not.toHaveBeenCalled();
    expect(session.state).toMatchObject({
      sandboxId: 'vercel_replacement_2',
      snapshotId: 'snap_test',
      snapshotSandboxId: 'vercel_replacement_2',
    });
  });

  test('recovers live snapshot persistence when replacement restore fails', async () => {
    const recoveredRunCommandMock = vi.fn(async () => ({
      exitCode: 0,
      output: vi.fn().mockResolvedValue('recovered\n'),
    }));
    createMock
      .mockResolvedValueOnce(makeSandbox('vercel_source'))
      .mockRejectedValueOnce(new Error('restore failed'))
      .mockResolvedValueOnce(
        makeSandbox('vercel_recovered', {
          runCommand: recoveredRunCommandMock,
        }),
      );
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest(), {
      workspacePersistence: 'snapshot',
    });
    createMock.mockClear();

    const ref = decodeNativeSnapshotRef(await session.persistWorkspace());

    expect(ref).toMatchObject({
      provider: 'vercel',
      snapshotId: 'snap_test',
    });
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(stopMock).toHaveBeenCalledOnce();
    expect(session.state).toMatchObject({
      sandboxId: 'vercel_recovered',
      snapshotId: 'snap_test',
      snapshotSandboxId: 'vercel_recovered',
    });

    recoveredRunCommandMock.mockClear();
    await session.execCommand({ cmd: 'echo after-recovery' });

    expect(recoveredRunCommandMock).toHaveBeenCalledWith({
      cmd: '/bin/sh',
      args: ['-lc', 'echo after-recovery'],
      cwd: '/vercel/sandbox',
      env: {},
    });
  });

  test('stops the sandbox when snapshot capture fails during close', async () => {
    snapshotMock.mockRejectedValueOnce(new Error('snapshot failed'));
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest(), {
      workspacePersistence: 'snapshot',
    });

    await expect(session.close()).rejects.toMatchObject({
      details: {
        provider: 'vercel',
        operation: 'capture snapshot',
        sandboxId: 'vercel_test',
        cause: 'snapshot failed',
      },
    });

    expect(snapshotMock).toHaveBeenCalledOnce();
    expect(stopMock).toHaveBeenCalledOnce();
  });

  test('stops the sandbox when manifest application fails during create', async () => {
    writeFilesMock.mockRejectedValueOnce(new Error('write failed'));
    const client = new VercelSandboxClient();

    await expect(
      client.create(
        new Manifest({
          entries: {
            'README.md': {
              type: 'file',
              content: '# Hello\n',
            },
          },
        }),
      ),
    ).rejects.toThrow('write failed');

    expect(createMock).toHaveBeenCalledOnce();
    expect(stopMock).toHaveBeenCalledOnce();
  });

  test('does not reuse preserved snapshot sessions as live handles', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest(), {
      workspacePersistence: 'snapshot',
    });

    await client.serializeSessionState(session.state);

    expect(client.canReusePreservedOwnedSession(session.state)).toBe(false);
  });

  test('does not stop a sandbox twice across shutdown and delete lifecycle hooks', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest());

    await session.shutdown();
    await session.delete();

    expect(stopMock).toHaveBeenCalledOnce();
    expect(stopMock).toHaveBeenCalledWith();
  });

  test('retries close after a stop failure', async () => {
    stopMock
      .mockRejectedValueOnce(new Error('stop failed'))
      .mockResolvedValueOnce(undefined);
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest());

    await expect(session.close()).rejects.toThrow('stop failed');
    await session.delete();

    expect(stopMock).toHaveBeenCalledTimes(2);
  });

  test('preserves missing optional Vercel sandbox methods', async () => {
    createMock.mockResolvedValueOnce(
      makeSandbox('vercel_test', {
        domain: undefined,
        stop: undefined,
        snapshot: undefined,
      }),
    );
    const client = new VercelSandboxClient({
      exposedPorts: [3000],
      workspacePersistence: 'snapshot',
    });
    const session = await client.create(new Manifest());
    getMock.mockClear();

    await expect(session.resolveExposedPort(3000)).rejects.toBeInstanceOf(
      SandboxProviderError,
    );
    expect(session.state.snapshotSupported).toBe(false);
    expect(client.canPersistOwnedSessionState(session.state)).toBe(false);
    expect(client.canReusePreservedOwnedSession(session.state)).toBe(true);
    await expect(
      client.serializeSessionState(session.state, {
        willCloseAfterSerialize: true,
      }),
    ).resolves.toMatchObject({
      workspacePersistence: 'snapshot',
      snapshotSupported: false,
    });
    expect(getMock).not.toHaveBeenCalled();
    expect(snapshotMock).not.toHaveBeenCalled();
    await expect(session.persistWorkspace()).rejects.toThrow(
      'Vercel snapshot persistence requires @vercel/sandbox snapshot support.',
    );
    await expect(session.close()).resolves.toBeUndefined();
    expect(stopMock).not.toHaveBeenCalled();
  });

  test('accepts absolute workspace paths for remote file checks', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(
      new Manifest({
        entries: {
          'README.md': {
            type: 'file',
            content: '# Hello\n',
          },
        },
      }),
    );

    const exists = await session.pathExists('/vercel/sandbox/README.md');

    expect(exists).toBe(true);
    expect(runCommandMock).toHaveBeenCalledWith({
      cmd: '/bin/sh',
      args: ['-lc', "test -e '/vercel/sandbox/README.md'"],
      cwd: '/vercel/sandbox',
      env: {},
    });
    await expect(
      session.pathExists('/vercel/sandbox/../tmp/README.md'),
    ).rejects.toThrow(/escapes the workspace root/);
  });

  test('resolves configured exposed ports through Vercel domains', async () => {
    const client = new VercelSandboxClient({
      exposedPorts: [3000],
    });
    const session = await client.create(new Manifest());

    const endpoint = await session.resolveExposedPort(3000);
    const cachedEndpoint = await session.resolveExposedPort(3000);

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ports: [3000],
      }),
    );
    expect(domainMock).toHaveBeenCalledWith(3000);
    expect(domainMock).toHaveBeenCalledOnce();
    expect(endpoint).toMatchObject({
      host: '3000-vercel.example.test',
      port: 443,
      tls: true,
    });
    expect(cachedEndpoint).toBe(endpoint);
    expect(session.state.exposedPorts?.['3000']).toBe(endpoint);
  });

  test('rejects unsupported PTY execution with a typed error', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest());

    await expect(
      session.execCommand({ cmd: 'sh', tty: true }),
    ).rejects.toBeInstanceOf(SandboxUnsupportedFeatureError);
  });

  test('rejects command runAs instead of sudoing as root', async () => {
    const client = new VercelSandboxClient();
    const session = await client.create(new Manifest());
    runCommandMock.mockClear();

    await expect(
      session.execCommand({ cmd: 'id', runAs: 'root' }),
    ).rejects.toThrow(/does not support runAs yet/);
    expect(runCommandMock).not.toHaveBeenCalled();
  });
});
