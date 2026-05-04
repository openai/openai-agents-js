import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  assertSandboxEntryMetadataSupported,
  assertSandboxManifestMetadataSupported,
  assertRunAsUnsupported,
  applyInlineManifestEntryToState,
  cloneManifestWithRoot,
  cloneManifestWithoutMountEntries,
  createPtyProcessEntry,
  deserializePersistedEnvironmentForRuntime,
  deserializeManifest,
  entryContainsLocalSource,
  formatExecResponse,
  formatPtyExecUpdate,
  hydrateRemoteWorkspaceTar,
  manifestContainsLocalSource,
  markPtyDone,
  materializeEnvironment,
  materializeInlineManifest,
  materializeInlineManifestEntry,
  mergeManifestDelta,
  mergeMaterializedEnvironment,
  normalizeGitRepository,
  persistRemoteWorkspaceTar,
  PtyProcessRegistry,
  RemoteSandboxEditor,
  deserializeRemoteSandboxSessionStateValues,
  resolveSandboxAbsolutePath,
  resolveSandboxWorkdir,
  serializeRemoteSandboxSessionState,
  serializeRuntimeEnvironmentForPersistence,
  serializeManifestRecord,
  sniffImageMediaType,
  toUint8Array,
  truncateOutput,
  validateRemoteSandboxPath,
  validateRemoteSandboxPathForManifest,
  validateWorkspaceTarArchive,
  withSandboxSpan,
  workspaceTarExcludeArgs,
} from '../../src/sandbox/shared';
import {
  applyLocalSourceManifestEntryToState,
  applyLocalSourceManifestToState,
  materializeLocalSourceManifest,
  materializeLocalSourceManifestEntry,
} from '../../src/sandbox/shared/localSources';
import {
  isRcloneCloudBucketMountEntry,
  mountRcloneCloudBucket,
  unmountRcloneMount,
} from '../../src/sandbox/shared/inContainerMounts';
import { makeTarArchive } from './tarFixture';
import {
  Manifest,
  SandboxArchiveError,
  SandboxPathResolutionError,
  SandboxUnsupportedFeatureError,
  boxMount,
  file,
  gitRepo,
  isHostPathStrictlyWithinRoot,
  isHostPathWithinRoot,
  localDir,
  localFile,
  mount,
  relativeHostPathEscapesRoot,
  relativeHostPathEscapesRootOrSelf,
  type S3Mount,
} from '@openai/agents-core/sandbox';

const tempDirs: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('remote sandbox path helpers', () => {
  test('mounts Box entries through the shared rclone helper', async () => {
    const commands: string[] = [];
    const entry = boxMount({
      path: '/Shared/Docs',
      clientId: 'box-client-id',
      clientSecret: 'box-client-secret',
      accessToken: 'box-access-token',
      token: '{"access_token":"token"}',
      boxConfigFile: '/run/secrets/box.json',
      configCredentials: '{"boxAppSettings":{}}',
      boxSubType: 'enterprise',
      rootFolderId: 'root-id',
      impersonate: '123456',
      ownedBy: 'owner@example.com',
      readOnly: false,
      mountStrategy: {
        type: 'test_cloud_bucket',
        pattern: {
          type: 'rclone',
          mode: 'fuse',
          remote: 'boxremote',
          args: ['--vfs-cache-mode', 'writes'],
        },
      },
    });

    expect(isRcloneCloudBucketMountEntry(entry, 'test_cloud_bucket')).toBe(
      true,
    );

    await mountRcloneCloudBucket({
      providerName: 'TestSandboxClient',
      providerId: 'test',
      strategyType: 'test_cloud_bucket',
      entry,
      mountPath: '/workspace/box docs',
      pattern: {
        type: 'rclone',
        mode: 'fuse',
        remote: 'boxremote',
        args: ['--vfs-cache-mode', 'writes'],
      },
      runCommand: async (command) => {
        commands.push(command);
        if (command === 'id -u; id -g') {
          return { status: 0, stdout: '1000\n1000\n' };
        }
        return { status: 0 };
      },
    });

    const configCommand = commands.find((command) =>
      command.includes('printf %s'),
    );
    const mountCommand = commands.find((command) =>
      command.startsWith("'rclone' 'mount'"),
    );

    expect(configCommand).toContain('[boxremote]');
    expect(configCommand).toContain('type = box');
    expect(configCommand).toContain('client_id = box-client-id');
    expect(configCommand).toContain('client_secret = box-client-secret');
    expect(configCommand).toContain('box_config_file = /run/secrets/box.json');
    expect(configCommand).toContain(
      'config_credentials = {"boxAppSettings":{}}',
    );
    expect(configCommand).toContain('access_token = box-access-token');
    expect(configCommand).toContain('token = {"access_token":"token"}');
    expect(configCommand).toContain('box_sub_type = enterprise');
    expect(configCommand).toContain('root_folder_id = root-id');
    expect(configCommand).toContain('impersonate = 123456');
    expect(configCommand).toContain('owned_by = owner@example.com');
    expect(mountCommand).toContain("'boxremote:Shared/Docs'");
    expect(mountCommand).toContain("'/workspace/box docs'");
    expect(mountCommand).toContain("'--uid' '1000' '--gid' '1000'");
    expect(mountCommand).toContain("'--vfs-cache-mode' 'writes'");
    expect(mountCommand).not.toContain("'--read-only'");
  });

  test('validates rclone NFS pidfiles before cleanup kill commands', async () => {
    const commands: string[] = [];

    await unmountRcloneMount({
      providerName: 'TestSandboxClient',
      providerId: 'test',
      mountPath: '/workspace/data',
      runCommand: async (command) => {
        commands.push(command);
        return { status: 0 };
      },
    });

    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain('openai_agents_kill_pidfile()');
    expect(commands[0]).toContain("''|0|*[!0-9]*) return 0");
    expect(commands[0]).toContain(
      "cmdline=$(tr '\\000' ' ' < \"/proc/$pid/cmdline\"",
    );
    expect(commands[0]).toContain(
      "openai_agents_kill_pidfile $pidfile 'rclone' 'serve' 'nfs'",
    );
    expect(commands[0]).not.toContain('kill "$(cat "$pidfile")"');
  });

  test('validates rclone NFS pidfiles during failed mount cleanup', async () => {
    const commands: string[] = [];
    const entry: S3Mount = {
      type: 's3_mount',
      bucket: 'agent-logs',
      mountStrategy: {
        type: 'test_cloud_bucket',
        pattern: {
          type: 'rclone',
          mode: 'nfs',
          remote: 'logs',
        },
      },
    };

    await expect(
      mountRcloneCloudBucket({
        providerName: 'TestSandboxClient',
        providerId: 'test',
        strategyType: 'test_cloud_bucket',
        entry,
        mountPath: '/workspace/logs',
        pattern: {
          type: 'rclone',
          mode: 'nfs',
          remote: 'logs',
        },
        runCommand: async (command) => {
          commands.push(command);
          if (command.includes('mount -v -t nfs')) {
            return { status: 1, stderr: 'mount failed' };
          }
          return { status: 0, stdout: '' };
        },
      }),
    ).rejects.toThrow(
      'TestSandboxClient cloud bucket mount failed while trying to mount rclone nfs client.',
    );

    const cleanupCommand = commands.find(
      (command) =>
        command.includes('/tmp/openai-agents-test-logs.nfs.pid') &&
        command.includes('openai_agents_kill_pidfile()'),
    );
    expect(cleanupCommand).toContain('openai_agents_kill_pidfile()');
    expect(cleanupCommand).toContain(
      "openai_agents_kill_pidfile '/tmp/openai-agents-test-logs.nfs.pid' 'rclone' 'serve' 'nfs'",
    );
    expect(cleanupCommand).not.toContain('kill "$(cat');
  });

  test('accept in-root absolute workspace paths', () => {
    expect(
      resolveSandboxAbsolutePath('/workspace', '/workspace/file.txt'),
    ).toBe('/workspace/file.txt');
    expect(
      resolveSandboxAbsolutePath('/workspace', '/workspace/src/../file.txt'),
    ).toBe('/workspace/file.txt');
    expect(resolveSandboxWorkdir('/workspace', '/workspace/src')).toBe(
      '/workspace/src',
    );
    expect(resolveSandboxWorkdir('/workspace', '/workspace/src/..')).toBe(
      '/workspace',
    );
  });

  test('reject workspace escapes', () => {
    expect(() =>
      resolveSandboxAbsolutePath('/workspace', '/tmp/file.txt'),
    ).toThrow(/escapes the workspace root/);
    expect(() =>
      resolveSandboxAbsolutePath('/workspace', '/workspace/../tmp/file.txt'),
    ).toThrow(/escapes the workspace root/);
    expect(() => resolveSandboxWorkdir('/workspace', '/tmp')).toThrow(
      /escapes the workspace root/,
    );
    expect(() =>
      resolveSandboxWorkdir('/workspace', '/workspace/../tmp'),
    ).toThrow(/escapes the workspace root/);
  });

  test('detects host relative paths that escape a root', () => {
    expect(relativeHostPathEscapesRoot('')).toBe(false);
    expect(relativeHostPathEscapesRoot('..')).toBe(true);
    expect(relativeHostPathEscapesRoot('../secret.txt')).toBe(true);
    expect(relativeHostPathEscapesRoot('/tmp/secret.txt')).toBe(true);
    expect(relativeHostPathEscapesRoot('safe/file.txt')).toBe(false);
    expect(relativeHostPathEscapesRootOrSelf('')).toBe(true);
    expect(relativeHostPathEscapesRootOrSelf('..')).toBe(true);
    expect(relativeHostPathEscapesRootOrSelf('../secret.txt')).toBe(true);
    expect(relativeHostPathEscapesRootOrSelf('/tmp/secret.txt')).toBe(true);
    expect(relativeHostPathEscapesRootOrSelf('safe/file.txt')).toBe(false);
    expect(
      isHostPathStrictlyWithinRoot('/tmp/root', '/tmp/root/file.txt'),
    ).toBe(true);
    expect(isHostPathWithinRoot('/tmp/root', '/tmp/root')).toBe(true);
    expect(isHostPathStrictlyWithinRoot('/tmp/root', '/tmp/root')).toBe(false);
    expect(isHostPathStrictlyWithinRoot('/tmp/root', '/tmp/secret.txt')).toBe(
      false,
    );
  });

  test('accept extra path grants and read-only grant policy', () => {
    expect(
      resolveSandboxAbsolutePath('/workspace', '/mnt/data/input.txt', {
        extraPathGrants: [
          {
            path: '/mnt/data',
            readOnly: true,
          },
        ],
      }),
    ).toBe('/mnt/data/input.txt');
    expect(() =>
      resolveSandboxAbsolutePath('/workspace', '/mnt/data/output.txt', {
        extraPathGrants: [
          {
            path: '/mnt/data',
            readOnly: true,
          },
        ],
        forWrite: true,
      }),
    ).toThrow(/read-only extra path grant/);
  });

  test('validates remote paths with manifest extra path grants', async () => {
    const manifest = new Manifest({
      extraPathGrants: [{ path: '/mnt/data', readOnly: true }],
    });
    const commands: string[] = [];

    await expect(
      validateRemoteSandboxPathForManifest({
        manifest,
        path: '/mnt/data/input.txt',
        runCommand: async (command) => {
          commands.push(command);
          return { status: 0, stdout: '/mnt/data/input.txt\n' };
        },
      }),
    ).resolves.toBe('/mnt/data/input.txt');
    expect(commands[0]).toContain('/mnt/data');

    await expect(
      validateRemoteSandboxPathForManifest({
        manifest,
        path: '/mnt/data/output.txt',
        options: { forWrite: true },
        runCommand: async () => ({ status: 0 }),
      }),
    ).rejects.toThrow(/read-only extra path grant/);
  });

  test('normalizes git repository shorthands', () => {
    expect(normalizeGitRepository('openai/openai-agents-js')).toBe(
      'https://github.com/openai/openai-agents-js.git',
    );
    expect(normalizeGitRepository('https://example.test/repo.git')).toBe(
      'https://example.test/repo.git',
    );
    expect(normalizeGitRepository('git@example.test:owner/repo.git')).toBe(
      'git@example.test:owner/repo.git',
    );
  });

  test('strips ephemeral manifest data during persistence', () => {
    const manifest = new Manifest({
      entries: {
        keep: {
          type: 'file',
          content: 'keep\n',
        },
        secret: {
          type: 'file',
          content: 'secret\n',
          ephemeral: true,
        },
        nested: {
          type: 'dir',
          children: {
            keep: {
              type: 'file',
              content: 'keep\n',
            },
            secret: {
              type: 'file',
              content: 'secret\n',
              ephemeral: true,
            },
          },
        },
      },
      environment: {
        KEEP: 'ok',
        SECRET: {
          value: 'secret',
          ephemeral: true,
        },
      },
      users: [{ name: 'sandbox-user' }],
      groups: [{ name: 'sandbox-group', users: [{ name: 'sandbox-user' }] }],
      extraPathGrants: [{ path: '/tmp/data', readOnly: true }],
      remoteMountCommandAllowlist: ['ls', 'cat'],
    });

    expect(serializeManifestRecord(manifest)).toMatchObject({
      entries: {
        keep: {
          type: 'file',
          content: 'keep\n',
        },
        nested: {
          type: 'dir',
          children: {
            keep: {
              type: 'file',
              content: 'keep\n',
            },
          },
        },
      },
      environment: {
        KEEP: {
          value: 'ok',
        },
      },
      users: [{ name: 'sandbox-user' }],
      groups: [{ name: 'sandbox-group', users: [{ name: 'sandbox-user' }] }],
      extraPathGrants: [{ path: '/tmp/data', readOnly: true }],
      remoteMountCommandAllowlist: ['ls', 'cat'],
    });
    expect(
      serializeRuntimeEnvironmentForPersistence(manifest, {
        KEEP: 'ok',
        SECRET: 'secret',
        OVERRIDE: 'persist',
      }),
    ).toEqual({
      KEEP: 'ok',
    });
  });

  test('restores client env overrides without persisting them', () => {
    const manifest = new Manifest({
      environment: {
        KEEP: 'manifest',
        SECRET: {
          value: 'secret',
          ephemeral: true,
        },
      },
    });

    expect(
      serializeRuntimeEnvironmentForPersistence(manifest, {
        KEEP: 'runtime-override',
        SECRET: 'secret',
        API_KEY: 'client-secret',
      }),
    ).toEqual({
      KEEP: 'manifest',
    });

    expect(
      deserializePersistedEnvironmentForRuntime(
        manifest,
        {
          KEEP: 'manifest',
          API_KEY: 'previous-secret',
        },
        {
          KEEP: 'client-override',
          API_KEY: 'client-secret',
        },
      ),
    ).toEqual({
      KEEP: 'manifest',
      API_KEY: 'client-secret',
    });
  });

  test('persists remote runtime environment values outside the manifest', () => {
    const manifest = new Manifest({
      environment: {
        KEEP: 'manifest',
        SECRET: {
          value: 'secret',
          ephemeral: true,
        },
      },
    });

    const serialized = serializeRemoteSandboxSessionState({
      manifest,
      environment: {
        KEEP: 'runtime-override',
        SECRET: 'runtime-secret',
        API_KEY: 'runtime-secret',
        FEATURE_FLAG: 'enabled',
      },
    });
    const restored = deserializeRemoteSandboxSessionStateValues(serialized);
    const restoredWithConfiguredEnv =
      deserializeRemoteSandboxSessionStateValues(serialized, {
        API_KEY: 'configured-secret',
      });

    expect(serialized.environment).toEqual({
      API_KEY: 'runtime-secret',
      FEATURE_FLAG: 'enabled',
      KEEP: 'manifest',
    });
    expect(restored.environment).toEqual({
      API_KEY: 'runtime-secret',
      FEATURE_FLAG: 'enabled',
      KEEP: 'manifest',
    });
    expect(restoredWithConfiguredEnv.environment).toEqual({
      API_KEY: 'configured-secret',
      FEATURE_FLAG: 'enabled',
      KEEP: 'manifest',
    });
  });

  test('materializes and merges environment values', async () => {
    const previous = new Manifest({
      environment: {
        KEEP: 'previous',
        OVERRIDE: 'old',
      },
    });
    const next = new Manifest({
      environment: {
        KEEP: 'next',
        OVERRIDE: 'next-manifest',
        NEW_VALUE: 'new',
      },
    });

    expect(
      await materializeEnvironment(previous, {
        OVERRIDE: 'runtime',
        TOKEN: 'client',
      }),
    ).toEqual({
      KEEP: 'previous',
      OVERRIDE: 'old',
      TOKEN: 'client',
    });
    expect(
      await mergeMaterializedEnvironment(previous, next, {
        KEEP: 'previous',
        OVERRIDE: 'runtime',
        TOKEN: 'client',
      }),
    ).toEqual({
      KEEP: 'next',
      OVERRIDE: 'next-manifest',
      NEW_VALUE: 'new',
      TOKEN: 'client',
    });
  });

  test('applies local source manifests to remote state', async () => {
    const written = new Map<string, string | Uint8Array>();
    const resolvedPaths: Array<{ path: string; forWrite: boolean }> = [];
    const state = {
      manifest: new Manifest({
        root: '/workspace',
        entries: {
          'base.txt': file({ content: 'base' }),
        },
        environment: {
          KEEP: 'previous',
        },
      }),
      environment: {
        KEEP: 'previous',
        TOKEN: 'runtime',
      },
    };
    const manifest = new Manifest({
      entries: {
        'next.txt': file({ content: 'next' }),
      },
      environment: {
        KEEP: 'next',
        ADDED: 'yes',
      },
    });

    await applyLocalSourceManifestToState(
      state,
      manifest,
      'fake-provider',
      {
        mkdir: vi.fn(),
        writeFile: async (path, content) => {
          written.set(path, content);
        },
      },
      async (path, options) => {
        resolvedPaths.push({
          path,
          forWrite: options?.forWrite ?? false,
        });
        return `/workspace/${path}`;
      },
    );

    expect(written.get('/workspace/next.txt')).toBe('next');
    expect(resolvedPaths).toEqual([{ path: 'next.txt', forWrite: true }]);
    expect(state.manifest.entries).toEqual({
      'base.txt': file({ content: 'base' }),
      'next.txt': file({ content: 'next' }),
    });
    expect(state.environment).toEqual({
      KEEP: 'next',
      ADDED: 'yes',
      TOKEN: 'runtime',
    });
  });

  test('applies manifest entry concurrency limits to local source manifests', async () => {
    const state = {
      manifest: new Manifest({ root: '/workspace' }),
      environment: {},
    };
    let activeWrites = 0;
    let maxActiveWrites = 0;

    await applyLocalSourceManifestToState(
      state,
      new Manifest({
        entries: {
          'a.txt': file({ content: 'a' }),
          'b.txt': file({ content: 'b' }),
          'c.txt': file({ content: 'c' }),
        },
      }),
      'fake-provider',
      {
        mkdir: vi.fn(),
        writeFile: async () => {
          activeWrites += 1;
          maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
          await new Promise((resolve) => setTimeout(resolve, 10));
          activeWrites -= 1;
        },
      },
      async (path) => `/workspace/${path}`,
      {
        concurrencyLimits: {
          manifestEntries: 2,
        },
      },
    );

    expect(maxActiveWrites).toBe(2);
  });

  test('applies local_dir file concurrency limits to local source manifests', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'agents-local-dir-'));
    tempDirs.push(tempDir);
    await writeFile(join(tempDir, 'a.txt'), 'a');
    await writeFile(join(tempDir, 'b.txt'), 'b');
    await writeFile(join(tempDir, 'c.txt'), 'c');
    const state = {
      manifest: new Manifest({ root: '/workspace' }),
      environment: {},
    };
    let activeWrites = 0;
    let maxActiveWrites = 0;

    await applyLocalSourceManifestToState(
      state,
      new Manifest({
        entries: {
          copied: localDir({ src: tempDir }),
        },
      }),
      'fake-provider',
      {
        mkdir: vi.fn(),
        writeFile: async () => {
          activeWrites += 1;
          maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
          await new Promise((resolve) => setTimeout(resolve, 10));
          activeWrites -= 1;
        },
      },
      async (path) => `/workspace/${path}`,
      {
        concurrencyLimits: {
          localDirFiles: 2,
        },
      },
    );

    expect(maxActiveWrites).toBe(2);
  });

  test('applies single local source entries to remote state', async () => {
    const written = new Map<string, string | Uint8Array>();
    const state = {
      manifest: new Manifest({
        root: '/workspace',
        entries: {
          'base.txt': file({ content: 'base' }),
        },
      }),
    };

    await applyLocalSourceManifestEntryToState(
      state,
      '/workspace/nested/next.txt',
      file({ content: 'next' }),
      'fake-provider',
      {
        mkdir: vi.fn(),
        writeFile: async (path, content) => {
          written.set(path, content);
        },
      },
      async (path) => `/workspace/${path}`,
    );

    expect(written.get('/workspace/nested/next.txt')).toBe('next');
    expect(state.manifest.entries).toEqual({
      'base.txt': file({ content: 'base' }),
      'nested/next.txt': file({ content: 'next' }),
    });
  });

  test('detects local source entries in manifests', () => {
    expect(entryContainsLocalSource(file({ content: 'inline' }))).toBe(false);
    expect(
      entryContainsLocalSource(localFile({ src: '/tmp/source.txt' })),
    ).toBe(true);
    expect(
      entryContainsLocalSource({
        type: 'dir',
        children: {
          nested: gitRepo({ repo: 'openai/openai-agents-js' }),
        },
      }),
    ).toBe(true);
    expect(
      manifestContainsLocalSource(
        new Manifest({
          entries: {
            data: localDir({ src: '/tmp/project' }),
          },
        }),
      ),
    ).toBe(true);
    expect(
      manifestContainsLocalSource(
        new Manifest({
          entries: {
            'README.md': file({ content: 'readme' }),
          },
        }),
      ),
    ).toBe(false);
  });

  test('materializes async environment resolvers', async () => {
    const manifest = new Manifest({
      environment: {
        TOKEN: {
          value: 'placeholder',
          resolve: async () => 'resolved-token',
        },
      },
    });

    await expect(materializeEnvironment(manifest)).resolves.toEqual({
      TOKEN: 'resolved-token',
    });
    expect(
      serializeRuntimeEnvironmentForPersistence(manifest, {
        TOKEN: 'resolved-token',
      }),
    ).toEqual({
      TOKEN: 'resolved-token',
    });
  });

  test('deserializes manifests and merges manifest deltas', () => {
    const base = new Manifest({
      root: '/workspace',
      entries: {
        old: {
          type: 'file',
          content: 'old',
        },
      },
      environment: {
        KEEP: 'base',
      },
      users: [{ name: 'base-user' }],
      groups: [{ name: 'base-group', users: [{ name: 'base-user' }] }],
      extraPathGrants: [{ path: '/tmp/base', readOnly: true }],
      remoteMountCommandAllowlist: ['ls'],
    });
    const update = new Manifest({
      version: 2,
      entries: {
        next: {
          type: 'file',
          content: 'next',
        },
      },
      environment: {
        KEEP: 'updated',
        ADDED: 'yes',
      },
      users: [{ name: 'next-user' }],
      groups: [{ name: 'next-group', users: [{ name: 'next-user' }] }],
      extraPathGrants: [{ path: '/tmp/next', readOnly: false }],
      remoteMountCommandAllowlist: ['cat'],
    });

    expect(deserializeManifest(undefined).root).toBe('/workspace');
    expect(mergeManifestDelta(base, update)).toMatchObject({
      version: 2,
      root: '/workspace',
      entries: {
        old: {
          type: 'file',
          content: 'old',
        },
        next: {
          type: 'file',
          content: 'next',
        },
      },
      environment: {
        KEEP: {
          value: 'updated',
        },
        ADDED: {
          value: 'yes',
        },
      },
      users: [{ name: 'base-user' }, { name: 'next-user' }],
      groups: [
        { name: 'base-group', users: [{ name: 'base-user' }] },
        { name: 'next-group', users: [{ name: 'next-user' }] },
      ],
      extraPathGrants: [
        { path: '/tmp/base', readOnly: true },
        { path: '/tmp/next', readOnly: false },
      ],
      remoteMountCommandAllowlist: ['cat'],
    });

    expect(
      mergeManifestDelta(
        base,
        new Manifest({
          entries: {
            implicit: {
              type: 'file',
              content: 'implicit',
            },
          },
        }),
      ).remoteMountCommandAllowlist,
    ).toEqual(['ls']);
  });

  test('edits remote sandbox files through apply_patch operations', async () => {
    const files = new Map<string, string>();
    const mkdirMock = vi.fn();
    const editor = new RemoteSandboxEditor({
      mkdir: mkdirMock,
      pathExists: async (path) => files.has(path),
      readText: async (path) => files.get(path) ?? '',
      writeText: async (path, content) => {
        files.set(path, content);
      },
      deletePath: async (path) => {
        files.delete(path);
      },
    });

    await editor.createFile({
      type: 'create_file',
      path: 'src/new.txt',
      diff: '+hello',
    });
    await editor.updateFile({
      type: 'update_file',
      path: 'src/new.txt',
      diff: '-hello\n+hello world',
    });
    expect(files.get('src/new.txt')).toBe('hello world');

    await editor.updateFile({
      type: 'update_file',
      path: 'src/new.txt',
      diff: '-hello world\n+hello moved',
      moveTo: 'renamed/new.txt',
    });
    expect(files.get('renamed/new.txt')).toBe('hello moved');
    expect(files.has('src/new.txt')).toBe(false);

    await expect(
      editor.createFile({
        type: 'create_file',
        path: 'renamed/new.txt',
        diff: '+overwrite',
      }),
    ).rejects.toThrow('Cannot create file because it already exists');
    expect(files.get('renamed/new.txt')).toBe('hello moved');

    await editor.deleteFile({
      type: 'delete_file',
      path: 'renamed/new.txt',
    });

    expect(mkdirMock).toHaveBeenCalledWith('src');
    expect(mkdirMock).toHaveBeenCalledWith('renamed');
    expect(files.has('renamed/new.txt')).toBe(false);
  });

  test('validates remote sandbox paths against resolved realpaths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agents-remote-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'agents-remote-outside-'));
    tempDirs.push(root, outside);
    const resolvedRoot = await realpath(root);
    await mkdir(join(root, 'safe'));
    await writeFile(join(root, 'safe', 'target.txt'), 'inside\n');
    await symlink(join(root, 'safe', 'target.txt'), join(root, 'link.txt'));
    await writeFile(join(outside, 'secret.txt'), 'secret\n');
    await symlink(outside, join(root, 'escape'));

    const runCommand = async (command: string) => {
      try {
        const { stdout, stderr } = await execFileAsync('/bin/sh', [
          '-lc',
          command,
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
    };

    await expect(
      validateRemoteSandboxPath({
        root,
        path: 'escape/secret.txt',
        runCommand,
      }),
    ).rejects.toBeInstanceOf(SandboxPathResolutionError);
    await expect(
      validateRemoteSandboxPath({
        root,
        path: 'link.txt',
        runCommand,
      }),
    ).resolves.toBe(join(resolvedRoot, 'safe', 'target.txt'));
    await expect(
      validateRemoteSandboxPath({
        root,
        path: 'safe/new.txt',
        options: { forWrite: true },
        runCommand,
      }),
    ).resolves.toBe(join(resolvedRoot, 'safe/new.txt'));
    await expect(
      validateRemoteSandboxPath({
        root: '/',
        path: 'src/app.ts',
        runCommand,
      }),
    ).resolves.toBe('/src/app.ts');
  }, 15_000);

  test('validates workspace tar archives before hydrate', () => {
    expect(() =>
      validateWorkspaceTarArchive(
        makeTarArchive([{ name: 'safe/file.txt', content: 'ok' }]),
      ),
    ).not.toThrow();

    for (const archive of [
      makeTarArchive([{ name: '/etc/passwd', content: 'bad' }]),
      makeTarArchive([{ name: '../escape.txt', content: 'bad' }]),
      makeTarArchive([{ name: 'C:/escape.txt', content: 'bad' }]),
      makeTarArchive([{ name: 'safe\\file.txt', content: 'bad' }]),
      makeTarArchive([{ name: 'hardlink', type: '1', linkName: 'safe' }]),
      makeTarArchive([
        { name: 'safe/file.txt', content: 'ok' },
        { name: 'safe/file.txt/child.txt', content: 'bad' },
      ]),
      makeTarArchive([
        { name: 'link', type: '2', linkName: '/tmp/outside' },
        { name: 'link/child.txt', content: 'bad' },
      ]),
    ]) {
      expect(() => validateWorkspaceTarArchive(archive)).toThrow(
        SandboxArchiveError,
      );
    }

    const symlinkArchive = makeTarArchive([
      { name: 'link', type: '2', linkName: 'safe/file.txt' },
    ]);
    expect(() => validateWorkspaceTarArchive(symlinkArchive)).not.toThrow();
    expect(() =>
      validateWorkspaceTarArchive(symlinkArchive, { allowSymlinks: false }),
    ).toThrow(SandboxArchiveError);
  });

  test('rejects symbolic links before hydrating tar archives', async () => {
    const writeFile = vi.fn();

    await expect(
      hydrateRemoteWorkspaceTar({
        providerName: 'FakeProvider',
        manifest: new Manifest({ root: '/custom/workspace' }),
        data: makeTarArchive([
          { name: 'link', type: '2', linkName: 'safe/file.txt' },
        ]),
        io: {
          mkdir: vi.fn(),
          readFile: vi.fn(),
          writeFile,
          runCommand: vi.fn(),
        },
      }),
    ).rejects.toBeInstanceOf(SandboxArchiveError);
    expect(writeFile).not.toHaveBeenCalled();
  });

  test('clears remote workspace root before hydrating tar archives', async () => {
    const archive = makeTarArchive([{ name: 'safe/file.txt', content: 'ok' }]);
    const commands: string[] = [];

    await hydrateRemoteWorkspaceTar({
      providerName: 'FakeProvider',
      manifest: new Manifest({ root: '/custom/workspace' }),
      data: archive,
      io: {
        mkdir: vi.fn(),
        readFile: vi.fn(),
        writeFile: vi.fn(),
        runCommand: vi.fn(async (command: string) => {
          commands.push(command);
          if (command.includes('resolve-workspace-path.sh')) {
            return {
              status: 0,
              stdout: '/custom/workspace\n',
              stderr: '',
            };
          }
          return {
            status: 0,
            stdout: '',
            stderr: '',
          };
        }),
      },
    });

    const hydrateCommand = commands.find((command) =>
      command.includes('tar -C'),
    );
    expect(hydrateCommand).toContain(
      "find '/custom/workspace' -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +",
    );
    expect(hydrateCommand!.indexOf('find')).toBeLessThan(
      hydrateCommand!.indexOf('tar -C'),
    );
  });

  test('rejects filesystem root before hydrating tar archives', async () => {
    const archive = makeTarArchive([{ name: 'safe/file.txt', content: 'ok' }]);
    const io = {
      mkdir: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      runCommand: vi.fn(),
    };

    await expect(
      hydrateRemoteWorkspaceTar({
        providerName: 'FakeProvider',
        manifest: new Manifest({ root: '/' }),
        data: archive,
        io,
      }),
    ).rejects.toThrow(SandboxArchiveError);

    expect(io.writeFile).not.toHaveBeenCalled();
    expect(io.runCommand).not.toHaveBeenCalled();
  });

  test('rejects filesystem root before persisting tar archives', async () => {
    const io = {
      mkdir: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn(),
      runCommand: vi.fn(),
    };

    await expect(
      persistRemoteWorkspaceTar({
        providerName: 'FakeProvider',
        manifest: new Manifest({ root: '/' }),
        io,
      }),
    ).rejects.toThrow(SandboxArchiveError);

    expect(io.readFile).not.toHaveBeenCalled();
    expect(io.runCommand).not.toHaveBeenCalled();
  });

  test('builds tar exclude args from ephemeral entries and mount targets', () => {
    const manifest = new Manifest({
      entries: {
        keep: { type: 'file', content: 'keep' },
        secret: { type: 'file', content: 'secret', ephemeral: true },
        mounted: mount({
          source: 's3://bucket/data',
          mountPath: 'cache',
          ephemeral: true,
          mountStrategy: { type: 'in_container' },
        }),
      },
    });

    expect(workspaceTarExcludeArgs(manifest)).toEqual([
      "--exclude='cache'",
      "--exclude='./cache'",
      "--exclude='mounted'",
      "--exclude='./mounted'",
      "--exclude='secret'",
      "--exclude='./secret'",
    ]);
  });

  test('materializes inline file and directory entries', async () => {
    const directories: string[] = [];
    const files = new Map<string, string | Uint8Array>();
    const writer = {
      mkdir: async (path: string) => {
        directories.push(path);
      },
      writeFile: async (path: string, content: string | Uint8Array) => {
        files.set(path, content);
      },
    };

    await materializeInlineManifestEntry(
      writer,
      '/workspace/project',
      {
        type: 'dir',
        children: {
          'README.md': {
            type: 'file',
            content: 'readme',
          },
        },
      },
      'test',
    );

    expect(directories).toContain('/workspace/project');
    expect(files.get('/workspace/project/README.md')).toBe('readme');
    await expect(
      materializeInlineManifestEntry(
        writer,
        '/workspace/local.txt',
        {
          type: 'local_file',
          src: '/tmp/local.txt',
        },
        'test',
      ),
    ).rejects.toThrow(/cannot materialize local_file entries/);
    await expect(
      materializeInlineManifestEntry(
        writer,
        '/workspace/bad',
        { type: 'bad' } as any,
        'test',
      ),
    ).rejects.toThrow(/Unsupported sandbox entry type/);
    await expect(
      materializeInlineManifestEntry(
        writer,
        '/workspace/mount',
        mount({
          source: 's3://bucket/data',
          mountStrategy: { type: 'in_container' },
        }),
        'test',
      ),
    ).rejects.toBeInstanceOf(SandboxUnsupportedFeatureError);
  });

  test('clones manifests with provider-specific roots', () => {
    const manifest = new Manifest({
      root: '/workspace',
      entries: {
        'README.md': {
          type: 'file',
          content: 'readme',
        },
      },
      environment: {
        TOKEN: {
          value: 'placeholder',
          description: 'provider token',
        },
      },
      extraPathGrants: [{ path: '/mnt/data', readOnly: true }],
    });

    const cloned = cloneManifestWithRoot(manifest, '/provider/workspace');

    expect(cloned.root).toBe('/provider/workspace');
    expect(cloned.entries).toEqual(manifest.entries);
    expect(cloned.entries).not.toBe(manifest.entries);
    expect(cloned.environment.TOKEN.normalized()).toEqual({
      value: 'placeholder',
      description: 'provider token',
    });
    expect(cloned.extraPathGrants).toEqual([
      {
        path: '/mnt/data',
        readOnly: true,
      },
    ]);
    expect(manifest.root).toBe('/workspace');
  });

  test('rebases root-scoped absolute mount paths when cloning manifests with provider-specific roots', () => {
    const manifest = new Manifest({
      root: '/workspace',
      entries: {
        relative: mount({
          source: 's3://bucket/relative',
          mountPath: 'mounted/relative',
        }),
        absolute: mount({
          source: 's3://bucket/absolute',
          mountPath: '/workspace/mounted/absolute',
        }),
        external: mount({
          source: 's3://bucket/external',
          mountPath: '/mnt/external',
        }),
        nested: {
          type: 'dir',
          children: {
            absolute: mount({
              source: 's3://bucket/nested',
              mountPath: '/workspace/nested/mounted',
            }),
          },
        },
      },
    });

    const cloned = cloneManifestWithRoot(manifest, '/provider/workspace');

    expect(cloned.entries.relative).toMatchObject({
      mountPath: 'mounted/relative',
    });
    expect(cloned.entries.absolute).toMatchObject({
      mountPath: '/provider/workspace/mounted/absolute',
    });
    expect(cloned.entries.external).toMatchObject({
      mountPath: '/mnt/external',
    });
    expect(cloned.entries.nested).toMatchObject({
      children: {
        absolute: {
          mountPath: '/provider/workspace/nested/mounted',
        },
      },
    });
    expect(manifest.entries.absolute).toMatchObject({
      mountPath: '/workspace/mounted/absolute',
    });
  });

  test('clones manifests without mount entries', () => {
    const manifest = new Manifest({
      entries: {
        keep: {
          type: 'dir',
          children: {
            'file.txt': {
              type: 'file',
              content: 'file',
            },
            mounted: {
              type: 'mount',
              source: '/mnt/data',
            },
          },
        },
        rootMount: {
          type: 'mount',
          source: '/mnt/root',
        },
      },
      environment: {
        TOKEN: {
          value: 'placeholder',
          description: 'provider token',
        },
      },
    });

    const cloned = cloneManifestWithoutMountEntries(manifest);

    expect(cloned.entries).toEqual({
      keep: {
        type: 'dir',
        children: {
          'file.txt': {
            type: 'file',
            content: 'file',
          },
        },
      },
    });
    expect(cloned.environment.TOKEN.normalized()).toEqual({
      value: 'placeholder',
      description: 'provider token',
    });
    expect(manifest.entries.rootMount).toMatchObject({
      type: 'mount',
      source: '/mnt/root',
    });
  });

  test('normalizes top-level manifest paths before remote materialization', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'agents-shared-test-'));
    tempDirs.push(tempDir);
    const sourceFile = join(tempDir, 'source.txt');
    await writeFile(sourceFile, 'local source');

    const resolvedPaths: string[] = [];
    const directories: string[] = [];
    const files = new Map<string, string | Uint8Array>();
    const writer = {
      mkdir: async (path: string) => {
        directories.push(path);
      },
      writeFile: async (path: string, content: string | Uint8Array) => {
        files.set(path, content);
      },
    };
    const resolvePath = async (path: string) => {
      resolvedPaths.push(path);
      return `/workspace/${path}`;
    };

    await materializeInlineManifest(
      writer,
      new Manifest({
        entries: {
          ' ./src//README.md ': file({ content: 'readme' }),
          dir: {
            type: 'dir',
            children: {
              ' ./nested//note.txt ': file({ content: 'note' }),
            },
          },
        },
      }),
      'test',
      resolvePath,
    );
    await materializeLocalSourceManifest(
      writer,
      new Manifest({
        entries: {
          ' ./copied//source.txt ': {
            type: 'local_file',
            src: sourceFile,
          },
        },
      }),
      'test',
      resolvePath,
    );

    expect(resolvedPaths).toEqual([
      'src/README.md',
      'dir',
      'dir/nested/note.txt',
      'copied/source.txt',
    ]);
    expect(directories).toContain('/workspace/dir');
    expect(files.get('/workspace/src/README.md')).toBe('readme');
    expect(files.get('/workspace/dir/nested/note.txt')).toBe('note');
    expect(Buffer.from(files.get('/workspace/copied/source.txt')!)).toEqual(
      Buffer.from('local source'),
    );
  });

  test('re-resolves nested manifest child paths before remote writes', async () => {
    const files = new Map<string, string | Uint8Array>();
    const resolvedPaths: string[] = [];
    const writer = {
      mkdir: vi.fn(),
      writeFile: async (path: string, content: string | Uint8Array) => {
        files.set(path, content);
      },
    };

    await expect(
      materializeInlineManifest(
        writer,
        new Manifest({
          entries: {
            dir: {
              type: 'dir',
              children: {
                'link/file.txt': file({ content: 'blocked' }),
              },
            },
          },
        }),
        'test',
        async (path) => {
          resolvedPaths.push(path);
          if (path === 'dir/link/file.txt') {
            throw new Error('Sandbox path escapes the workspace root.');
          }
          return `/workspace/${path}`;
        },
      ),
    ).rejects.toThrow(/escapes the workspace root/);

    expect(resolvedPaths).toEqual(['dir', 'dir/link/file.txt']);
    expect(files.size).toBe(0);
  });

  test('materializes remote manifest mounts after entries in parent-first order', async () => {
    const operations: string[] = [];
    const resolvedPaths: string[] = [];
    const writer = {
      mkdir: async (path: string) => {
        operations.push(`mkdir:${path}`);
      },
      writeFile: async (path: string, _content: string | Uint8Array) => {
        operations.push(`write:${path}`);
      },
    };

    await materializeInlineManifest(
      writer,
      new Manifest({
        entries: {
          child: mount({
            source: 's3://bucket/child',
            mountPath: 'mounted/cache',
            mountStrategy: { type: 'in_container' },
          }),
          app: {
            type: 'dir',
            children: {
              'note.txt': file({ content: 'note' }),
              nested: mount({
                source: 's3://bucket/nested',
                mountPath: 'mounted/cache/nested',
                mountStrategy: { type: 'in_container' },
              }),
            },
          },
          parent: mount({
            source: 's3://bucket/parent',
            mountPath: 'mounted',
            mountStrategy: { type: 'in_container' },
          }),
        },
      }),
      'test',
      async (path) => {
        resolvedPaths.push(path);
        return `/workspace/${path}`;
      },
      {
        materializeMount: async (absolutePath) => {
          operations.push(`mount:${absolutePath}`);
        },
      },
    );

    expect(operations).toEqual([
      'mkdir:/workspace/app',
      'write:/workspace/app/note.txt',
      'mount:/workspace/mounted',
      'mount:/workspace/mounted/cache',
      'mount:/workspace/mounted/cache/nested',
    ]);
    expect(resolvedPaths).toEqual([
      'app',
      'app/note.txt',
      'app/nested',
      'mounted',
      'mounted/cache',
      'mounted/cache/nested',
    ]);
  });

  test('materializes local source manifest mounts after source entries', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'agents-shared-test-'));
    tempDirs.push(tempDir);
    const sourceFile = join(tempDir, 'source.txt');
    await writeFile(sourceFile, 'local source');

    const operations: string[] = [];
    const resolvedPaths: string[] = [];
    const writer = {
      mkdir: async (path: string) => {
        operations.push(`mkdir:${path}`);
      },
      writeFile: async (path: string, _content: string | Uint8Array) => {
        operations.push(`write:${path}`);
      },
    };

    await materializeLocalSourceManifest(
      writer,
      new Manifest({
        entries: {
          child: mount({
            source: 's3://bucket/child',
            mountPath: 'mounted/cache',
            mountStrategy: { type: 'in_container' },
          }),
          'copied/source.txt': {
            type: 'local_file',
            src: sourceFile,
          },
          parent: mount({
            source: 's3://bucket/parent',
            mountPath: 'mounted',
            mountStrategy: { type: 'in_container' },
          }),
        },
      }),
      'test',
      async (path) => {
        resolvedPaths.push(path);
        return `/workspace/${path}`;
      },
      {
        materializeMount: async (absolutePath) => {
          operations.push(`mount:${absolutePath}`);
        },
      },
    );

    expect(operations).toEqual([
      'write:/workspace/copied/source.txt',
      'mount:/workspace/mounted',
      'mount:/workspace/mounted/cache',
    ]);
    expect(resolvedPaths).toEqual([
      'copied/source.txt',
      'mounted',
      'mounted/cache',
    ]);
  });

  test('materializes single remote manifest entry mounts after nested entries', async () => {
    const state = {
      manifest: new Manifest({
        root: '/workspace',
      }),
    };
    const operations: string[] = [];
    const resolvedPaths: string[] = [];
    const writer = {
      mkdir: async (path: string) => {
        operations.push(`mkdir:${path}`);
      },
      writeFile: async (path: string, _content: string | Uint8Array) => {
        operations.push(`write:${path}`);
      },
    };

    await applyInlineManifestEntryToState(
      state,
      '/workspace/project',
      {
        type: 'dir',
        children: {
          child: mount({
            source: 's3://bucket/child',
            mountPath: 'project/mounted/cache',
            mountStrategy: { type: 'in_container' },
          }),
          'note.txt': file({ content: 'note' }),
          parent: mount({
            source: 's3://bucket/parent',
            mountPath: 'project/mounted',
            mountStrategy: { type: 'in_container' },
          }),
        },
      },
      'test',
      writer,
      async (path) => {
        resolvedPaths.push(path);
        return `/remote/${path}`;
      },
      {
        materializeMount: async (absolutePath) => {
          operations.push(`mount:${absolutePath}`);
        },
      },
    );

    expect(operations).toEqual([
      'mkdir:/remote/project',
      'write:/remote/project/note.txt',
      'mount:/remote/project/mounted',
      'mount:/remote/project/mounted/cache',
    ]);
    expect(resolvedPaths).toEqual([
      'project',
      'project/child',
      'project/note.txt',
      'project/parent',
      'project/mounted',
      'project/mounted/cache',
    ]);
    expect(state.manifest.entries.project).toMatchObject({
      type: 'dir',
    });
  });

  test('materializes local file and local directory entries with Node sources', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'agents-shared-test-'));
    tempDirs.push(tempDir);
    const sourceFile = join(tempDir, 'source.txt');
    const sourceDir = join(tempDir, 'source-dir');
    await writeFile(sourceFile, 'local file');
    await mkdir(sourceDir);
    await writeFile(join(sourceDir, 'nested.txt'), 'nested');

    const directories: string[] = [];
    const files = new Map<string, string | Uint8Array>();
    const writer = {
      mkdir: async (path: string) => {
        directories.push(path);
      },
      writeFile: async (path: string, content: string | Uint8Array) => {
        files.set(path, content);
      },
    };

    await materializeLocalSourceManifestEntry(
      writer,
      '/workspace/project',
      {
        type: 'dir',
        children: {
          'README.md': {
            type: 'file',
            content: 'readme',
          },
          'local.txt': {
            type: 'local_file',
            src: sourceFile,
          },
          data: {
            type: 'local_dir',
            src: sourceDir,
          },
        },
      },
      'test',
    );

    expect(directories).toContain('/workspace/project');
    expect(directories).toContain('/workspace/project/data');
    expect(files.get('/workspace/project/README.md')).toBe('readme');
    expect(Buffer.from(files.get('/workspace/project/local.txt')!)).toEqual(
      Buffer.from('local file'),
    );
    expect(
      Buffer.from(files.get('/workspace/project/data/nested.txt')!),
    ).toEqual(Buffer.from('nested'));
    await expect(
      materializeLocalSourceManifestEntry(
        writer,
        '/workspace/mount',
        mount({
          source: 's3://bucket/data',
          mountStrategy: { type: 'in_container' },
        }),
        'test',
      ),
    ).rejects.toBeInstanceOf(SandboxUnsupportedFeatureError);
  });

  test('rejects symbolic links inside local directory entries', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'agents-shared-test-'));
    tempDirs.push(tempDir);
    const sourceDir = join(tempDir, 'source-dir');
    const outsideFile = join(tempDir, 'outside.txt');
    await mkdir(sourceDir);
    await writeFile(join(sourceDir, 'safe.txt'), 'safe');
    await writeFile(outsideFile, 'outside');
    await symlink(outsideFile, join(sourceDir, 'link.txt'));

    const writer = {
      mkdir: async (_path: string) => {},
      writeFile: async (_path: string, _content: string | Uint8Array) => {},
    };

    await expect(
      materializeLocalSourceManifestEntry(
        writer,
        '/workspace/project',
        {
          type: 'local_dir',
          src: sourceDir,
        },
        'test',
      ),
    ).rejects.toThrow(/local_dir entries do not support symbolic links/);
  });

  test('rejects symbolic link ancestors in local directory entries', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'agents-shared-test-'));
    tempDirs.push(tempDir);
    const realRoot = join(tempDir, 'real-root');
    const linkedRoot = join(tempDir, 'linked-root');
    const sourceDir = join(realRoot, 'source-dir');
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, 'safe.txt'), 'safe');
    await symlink(realRoot, linkedRoot, 'dir');

    const writer = {
      mkdir: async (_path: string) => {},
      writeFile: async (_path: string, _content: string | Uint8Array) => {},
    };

    await expect(
      materializeLocalSourceManifestEntry(
        writer,
        '/workspace/project',
        {
          type: 'local_dir',
          src: join(linkedRoot, 'source-dir'),
        },
        'test',
      ),
    ).rejects.toThrow(
      /local_dir entries do not support symbolic link ancestors/,
    );
  });

  test('rejects symbolic links in local file entries', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'agents-shared-test-'));
    tempDirs.push(tempDir);
    const outsideFile = join(tempDir, 'outside.txt');
    const linkFile = join(tempDir, 'link.txt');
    await writeFile(outsideFile, 'outside');
    await symlink(outsideFile, linkFile);

    const writer = {
      mkdir: async (_path: string) => {},
      writeFile: async (_path: string, _content: string | Uint8Array) => {},
    };

    await expect(
      materializeLocalSourceManifestEntry(
        writer,
        '/workspace/copied.txt',
        {
          type: 'local_file',
          src: linkFile,
        },
        'test',
      ),
    ).rejects.toThrow(/local_file entries do not support symbolic links/);
  });

  test('rejects symbolic link ancestors in local file entries', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'agents-shared-test-'));
    tempDirs.push(tempDir);
    const realRoot = join(tempDir, 'real-root');
    const linkedRoot = join(tempDir, 'linked-root');
    await mkdir(realRoot);
    await writeFile(join(realRoot, 'source.txt'), 'source');
    await symlink(realRoot, linkedRoot, 'dir');

    const writer = {
      mkdir: async (_path: string) => {},
      writeFile: async (_path: string, _content: string | Uint8Array) => {},
    };

    await expect(
      materializeLocalSourceManifestEntry(
        writer,
        '/workspace/copied.txt',
        {
          type: 'local_file',
          src: join(linkedRoot, 'source.txt'),
        },
        'test',
      ),
    ).rejects.toThrow(
      /local_file entries do not support symbolic link ancestors/,
    );
  });

  test('formats command output and truncates token output', () => {
    expect(truncateOutput('0123456789abcdef', 1)).toEqual({
      text: 'Total output lines: 1\n\n01...3 tokens truncated...ef',
      originalTokenCount: 4,
    });
    expect(truncateOutput('one two', 3)).toEqual({ text: 'one two' });
    expect(truncateOutput('one two')).toEqual({ text: 'one two' });

    const running = formatExecResponse({
      output: 'partial',
      wallTimeSeconds: 1.23456,
      sessionId: 7,
      originalTokenCount: 10,
    });
    expect(running).toContain('Process running with session ID 7');
    expect(running).toContain('Original token count: 10');
    expect(running).toContain('partial');

    const exited = formatExecResponse({
      output: 'done',
      wallTimeSeconds: 0,
      exitCode: 0,
    });
    expect(exited).toContain('Process exited with code 0');
    expect(exited).toContain('done');
  });

  test('formats indeterminate PTY exits as failures', async () => {
    const registry = new PtyProcessRegistry();
    const entry = createPtyProcessEntry({});
    const { sessionId } = registry.register(entry);
    markPtyDone(entry);

    const output = await formatPtyExecUpdate({
      registry,
      sessionId,
      entry,
      startTime: Date.now(),
      yieldTimeMs: 1,
    });

    expect(output).toContain('Process exited with code 1');
  });

  test('detects image media types', () => {
    expect(sniffImageMediaType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))).toBe(
      'image/png',
    );
    expect(sniffImageMediaType(Uint8Array.from([0xff, 0xd8, 0xff]))).toBe(
      'image/jpeg',
    );
    expect(sniffImageMediaType(Uint8Array.from([0x47, 0x49, 0x46, 0x38]))).toBe(
      'image/gif',
    );
    expect(
      sniffImageMediaType(
        Uint8Array.from([
          0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
        ]),
      ),
    ).toBe('image/webp');
    expect(sniffImageMediaType(Uint8Array.from([0]))).toBeNull();
  });

  test('normalizes binary-like values to Uint8Array', async () => {
    const bytes = Uint8Array.from([1, 2, 3]);
    const cloned = await toUint8Array(bytes);
    expect(cloned).toEqual(bytes);
    expect(cloned).not.toBe(bytes);

    expect(await toUint8Array(undefined)).toEqual(new Uint8Array());
    expect(await toUint8Array('ok')).toEqual(new TextEncoder().encode('ok'));
    expect(await toUint8Array(new Uint8Array([4, 5]).buffer)).toEqual(
      Uint8Array.from([4, 5]),
    );
    expect(await toUint8Array(Buffer.from('buf'))).toEqual(
      new TextEncoder().encode('buf'),
    );
    expect(await toUint8Array(new Blob(['blob']))).toEqual(
      new TextEncoder().encode('blob'),
    );
  });

  test('guards unsupported runAs and runs functions without an active trace', async () => {
    expect(() => assertRunAsUnsupported('Provider')).not.toThrow();
    expect(() => assertRunAsUnsupported('Provider', 'root')).toThrowError(
      SandboxUnsupportedFeatureError,
    );
    await expect(
      withSandboxSpan('span', { key: 'value' }, async () => 42),
    ).resolves.toBe(42);
  });

  test('guards unsupported manifest metadata for remote providers', () => {
    expect(() =>
      assertSandboxManifestMetadataSupported(
        'Provider',
        new Manifest({
          users: [{ name: 'sandbox-user' }],
        }),
      ),
    ).toThrowError(SandboxUnsupportedFeatureError);
    expect(() =>
      assertSandboxManifestMetadataSupported(
        'Provider',
        new Manifest({
          groups: [{ name: 'sandbox-group' }],
        }),
      ),
    ).toThrowError(SandboxUnsupportedFeatureError);
    expect(() =>
      assertSandboxManifestMetadataSupported(
        'Provider',
        new Manifest({
          extraPathGrants: [{ path: '/tmp/data' }],
        }),
      ),
    ).toThrowError(SandboxUnsupportedFeatureError);
    expect(() =>
      assertSandboxManifestMetadataSupported(
        'Provider',
        new Manifest({
          entries: {
            dir: {
              type: 'dir',
              children: {
                'run.sh': {
                  type: 'file',
                  content: '#!/bin/sh\n',
                  permissions: '-rwx------',
                },
              },
            },
          },
        }),
      ),
    ).toThrowError(SandboxUnsupportedFeatureError);
  });

  test('guards unsupported entry group ownership for remote providers', () => {
    expect(() =>
      assertSandboxEntryMetadataSupported('Provider', 'bin', {
        type: 'dir',
        children: {
          'run.sh': {
            type: 'file',
            content: '#!/bin/sh\n',
            group: { name: 'sandbox-group' },
          },
        },
      }),
    ).toThrowError(SandboxUnsupportedFeatureError);
  });

  test('guards unsupported mount entries for remote providers', () => {
    expect(() =>
      assertSandboxEntryMetadataSupported(
        'Provider',
        'data',
        mount({
          source: 's3://bucket/data',
          mountStrategy: { type: 'in_container' },
        }),
      ),
    ).toThrowError(SandboxUnsupportedFeatureError);
  });
});
