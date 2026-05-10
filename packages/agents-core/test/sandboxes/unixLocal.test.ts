import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  Manifest,
  InMemoryRemoteSnapshotStore,
  NoopSnapshotSpec,
  skills,
  UnixLocalSandboxClient,
  urlForExposedPort,
} from '../../src/sandbox/local';
import {
  applyOwnershipRecursive,
  materializeLocalWorkspaceManifest,
  materializeLocalWorkspaceManifestMounts,
} from '../../src/sandbox/sandboxes/shared/localWorkspace';

const ONE_BY_ONE_PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAE/wH+gZ6kWQAAAABJRU5ErkJggg==',
    'base64',
  ),
);
const ACTIVE_PROCESS_POLL_MS = 50;
const ACTIVE_PROCESS_MAX_POLLS = 80;

describe('UnixLocalSandboxClient', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'agents-core-sandbox-test-'));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('materializes manifest entries and runs commands in the workspace', async () => {
    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: rootDir,
      snapshot: {
        type: 'local',
        baseDir: rootDir,
      },
    });
    const session = await client.create(
      new Manifest({
        entries: {
          'notes.txt': {
            type: 'file',
            content: 'hello sandbox\n',
          },
          assets: {
            type: 'dir',
            children: {
              'pixel.png': {
                type: 'file',
                content: ONE_BY_ONE_PNG,
              },
            },
          },
        },
      }),
    );

    const initialOutput = await session.execCommand({
      cmd: 'pwd && cat /workspace/notes.txt && ls /workspace/assets',
      shell: '/bin/sh',
      login: false,
      yieldTimeMs: 500,
    });
    const sessionId = Number(
      initialOutput.match(/Process running with session ID (\d+)/)?.[1],
    );
    const output = Number.isFinite(sessionId)
      ? `${initialOutput}${await writeUntilExit(
          {
            writeStdin: (args) => session.writeStdin(args),
          },
          sessionId,
          '',
        )}`
      : initialOutput;

    expect(output).toContain('Process exited with code 0');
    expect(output).toContain('/workspace');
    expect(output).toContain('hello sandbox');
    expect(output).toContain('pixel.png');
  });

  it('translates command paths only at the manifest root boundary', async () => {
    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: rootDir,
    });
    const session = await client.create(new Manifest({ root: '/workspace' }));
    const siblingWorkspace = `${session.state.workspaceRootPath}2`;
    await mkdir(siblingWorkspace);
    await writeFile(join(siblingWorkspace, 'leak.txt'), 'outside');

    const output = await session.execCommand({
      cmd: 'if test -e /workspace2/leak.txt; then printf bad; else printf ok; fi',
      shell: '/bin/sh',
      login: false,
      yieldTimeMs: 1_000,
    });

    expect(output).toMatch(/Output:\s*ok\s*$/u);
  });

  it('translates real workspace paths in command output back to the manifest root', async () => {
    const realBaseDir = await mkdtemp(
      join(tmpdir(), 'agents-core-sandbox-real-'),
    );
    const linkedBaseDir = join(rootDir, 'linked-base');
    await symlink(realBaseDir, linkedBaseDir, 'dir');

    try {
      const client = new UnixLocalSandboxClient({
        workspaceBaseDir: linkedBaseDir,
      });
      const session = await client.create(new Manifest({ root: '/workspace' }));
      const workspaceRootRealPath = await realpath(
        session.state.workspaceRootPath,
      );
      expect(workspaceRootRealPath).not.toBe(session.state.workspaceRootPath);

      const output = await session.execCommand({
        cmd: 'pwd -P',
        shell: '/bin/sh',
        login: false,
        yieldTimeMs: 1_000,
      });

      expect(output).toContain('/workspace');
      expect(output).not.toContain(workspaceRootRealPath);
      expect(output).not.toContain(session.state.workspaceRootPath);
    } finally {
      await rm(realBaseDir, { recursive: true, force: true });
    }
  });

  it('returns structured exec results before model-facing formatting', async () => {
    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: rootDir,
      snapshot: {
        type: 'local',
        baseDir: rootDir,
      },
    });
    const session = await client.create(new Manifest());

    const result = await session.exec({
      cmd: 'printf stdout; printf stderr >&2; exit 7',
      shell: '/bin/sh',
      login: false,
      yieldTimeMs: 1_000,
    });

    expect(result.exitCode).toBe(7);
    expect(result.sessionId).toBeUndefined();
    expect(result.stdout).toBe('stdout');
    expect(result.stderr).toBe('stderr');
    expect(result.output).toContain('stdout');
    expect(result.output).toContain('stderr');
    expect(result.wallTimeSeconds).toEqual(expect.any(Number));

    const formatted = await session.execCommand({
      cmd: 'printf formatted',
      shell: '/bin/sh',
      login: false,
      yieldTimeMs: 1_000,
    });
    expect(formatted).toContain('Process exited with code 0');
    expect(formatted).toContain('formatted');
  });

  it('does not inherit host process environment variables', async () => {
    const originalOpenAIKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'host-secret';

    try {
      const client = new UnixLocalSandboxClient({
        workspaceBaseDir: rootDir,
      });
      const session = await client.create(
        new Manifest({
          environment: {
            SANDBOX_FLAG: 'manifest',
          },
        }),
      );

      const output = await session.execCommand({
        cmd: 'printf "key=%s flag=%s" "${OPENAI_API_KEY:-}" "$SANDBOX_FLAG"',
        shell: '/bin/sh',
        login: false,
        yieldTimeMs: 2_000,
      });

      expect(output).toContain('key= flag=manifest');
      expect(output).not.toContain('host-secret');
    } finally {
      if (typeof originalOpenAIKey === 'undefined') {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalOpenAIKey;
      }
    }
  });

  it('resolves async manifest environment values before starting commands', async () => {
    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: rootDir,
      snapshot: {
        type: 'local',
        baseDir: rootDir,
      },
    });
    const session = await client.create(
      new Manifest({
        environment: {
          RESOLVED_ENV: {
            value: 'placeholder',
            resolve: async () => 'runtime-value',
            ephemeral: true,
          },
        },
      }),
    );

    const output = await session.execCommand({
      cmd: 'printf "%s" "$RESOLVED_ENV"',
      shell: '/bin/sh',
      login: false,
      yieldTimeMs: 1_000,
    });
    const serialized = await client.serializeSessionState(session.state);

    expect(output).toContain('runtime-value');
    expect(serialized.environment).not.toHaveProperty('RESOLVED_ENV');
  });

  it('rejects symbolic links inside local_dir entries', async () => {
    const sourceDir = join(rootDir, 'source');
    const outsideFile = join(rootDir, 'outside.txt');
    await mkdir(sourceDir);
    await writeFile(join(sourceDir, 'safe.txt'), 'safe');
    await writeFile(outsideFile, 'outside');
    await symlink(outsideFile, join(sourceDir, 'link.txt'));

    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: rootDir,
    });

    await expect(
      client.create(
        new Manifest({
          extraPathGrants: [{ path: sourceDir, readOnly: true }],
          entries: {
            data: {
              type: 'local_dir',
              src: sourceDir,
            },
          },
        }),
      ),
    ).rejects.toThrow(/local_dir entries do not support symbolic links/);
  });

  it('rejects symbolic links in local_file entries', async () => {
    const outsideFile = join(rootDir, 'outside.txt');
    const linkFile = join(rootDir, 'link.txt');
    await writeFile(outsideFile, 'outside');
    await symlink(outsideFile, linkFile);

    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: rootDir,
    });

    await expect(
      client.create(
        new Manifest({
          extraPathGrants: [{ path: rootDir, readOnly: true }],
          entries: {
            copied: {
              type: 'local_file',
              src: linkFile,
            },
          },
        }),
      ),
    ).rejects.toThrow(/local_file entries do not support symbolic links/);
  });

  it('rejects symbolic link ancestors in local_file entries', async () => {
    const targetDir = join(rootDir, 'target');
    await mkdir(join(targetDir, 'sub'), { recursive: true });
    await writeFile(join(targetDir, 'sub', 'secret.txt'), 'secret');
    await symlink(targetDir, join(rootDir, 'link'), 'dir');

    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: rootDir,
    });

    await expect(
      client.create(
        new Manifest({
          extraPathGrants: [{ path: rootDir, readOnly: true }],
          entries: {
            copied: {
              type: 'local_file',
              src: join(rootDir, 'link', 'sub', 'secret.txt'),
            },
          },
        }),
      ),
    ).rejects.toThrow(
      /local_file entries do not support symbolic link ancestors/,
    );
  });

  it('rejects symbolic link ancestors in local_dir entries', async () => {
    const targetDir = join(rootDir, 'target');
    await mkdir(join(targetDir, 'sub'), { recursive: true });
    await writeFile(join(targetDir, 'sub', 'safe.txt'), 'safe');
    await symlink(targetDir, join(rootDir, 'link'), 'dir');

    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: rootDir,
    });

    await expect(
      client.create(
        new Manifest({
          extraPathGrants: [{ path: rootDir, readOnly: true }],
          entries: {
            data: {
              type: 'local_dir',
              src: join(rootDir, 'link', 'sub'),
            },
          },
        }),
      ),
    ).rejects.toThrow(
      /local_dir entries do not support symbolic link ancestors/,
    );
  });

  it('skips symlinks when applying recursive ownership', async () => {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      return;
    }
    const outsideFile = join(rootDir, 'outside.txt');
    const linkPath = join(rootDir, 'link.txt');
    await writeFile(outsideFile, 'outside');
    await symlink(outsideFile, linkPath);

    await expect(applyOwnershipRecursive(linkPath, 0, 0)).resolves.toBe(
      undefined,
    );
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
  });

  it('validates materialization concurrency limits', async () => {
    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: rootDir,
      concurrencyLimits: {
        manifestEntries: 0,
      },
    });

    await expect(
      client.create(
        new Manifest({
          entries: {
            'notes.txt': {
              type: 'file',
              content: 'hello sandbox\n',
            },
          },
        }),
      ),
    ).rejects.toThrow(/Sandbox concurrency limits must be positive numbers/);
  });

  it('rejects local_file sources outside the local source base directory without a grant', async () => {
    const outside = join(rootDir, 'outside');
    const workspaceRootPath = join(rootDir, 'workspace');
    await mkdir(outside);
    await writeFile(join(outside, 'secret.txt'), 'secret');

    await expect(
      materializeLocalWorkspaceManifest(
        new Manifest({
          entries: {
            copied: {
              type: 'local_file',
              src: join(outside, 'secret.txt'),
            },
          },
        }),
        workspaceRootPath,
      ),
    ).rejects.toThrow(/local_file source must stay within/);

    await expect(
      readFile(join(workspaceRootPath, 'copied'), 'utf8'),
    ).rejects.toThrow();
  });

  it('allows local_file sources outside the local source base directory with a grant', async () => {
    const outside = join(rootDir, 'outside-granted');
    const workspaceRootPath = join(rootDir, 'workspace');
    await mkdir(outside);
    await writeFile(join(outside, 'secret.txt'), 'secret');

    await materializeLocalWorkspaceManifest(
      new Manifest({
        extraPathGrants: [{ path: outside, readOnly: true }],
        entries: {
          copied: {
            type: 'local_file',
            src: join(outside, 'secret.txt'),
          },
        },
      }),
      workspaceRootPath,
    );

    await expect(
      readFile(join(workspaceRootPath, 'copied'), 'utf8'),
    ).resolves.toBe('secret');
  });

  it('allows local_dir sources inside the local source base directory without a grant', async () => {
    const base = join(rootDir, 'base');
    const source = join(base, 'source');
    const workspaceRootPath = join(rootDir, 'workspace');
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'safe.txt'), 'safe');

    await materializeLocalWorkspaceManifest(
      new Manifest({
        entries: {
          copied: {
            type: 'local_dir',
            src: source,
          },
        },
      }),
      workspaceRootPath,
      {
        localSourceBaseDir: base,
      },
    );

    await expect(
      readFile(join(workspaceRootPath, 'copied', 'safe.txt'), 'utf8'),
    ).resolves.toBe('safe');
  });

  it('allows local_dir sources outside the local source base directory with a grant', async () => {
    const outside = join(rootDir, 'absolute-outside');
    const workspaceRootPath = join(rootDir, 'workspace');
    await mkdir(outside);
    await writeFile(join(outside, 'secret.txt'), 'secret');

    await materializeLocalWorkspaceManifest(
      new Manifest({
        extraPathGrants: [{ path: outside, readOnly: true }],
        entries: {
          copied: {
            type: 'local_dir',
            src: outside,
          },
        },
      }),
      workspaceRootPath,
    );

    await expect(
      readFile(join(workspaceRootPath, 'copied', 'secret.txt'), 'utf8'),
    ).resolves.toBe('secret');
  });

  it('applies explicit entry permissions during materialization', async () => {
    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: rootDir,
    });
    const session = await client.create(
      new Manifest({
        entries: {
          bin: {
            type: 'dir',
            permissions: 'drwxr-x---',
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
    );

    const binStat = await stat(join(session.state.workspaceRootPath, 'bin'));
    const runStat = await stat(
      join(session.state.workspaceRootPath, 'bin', 'run.sh'),
    );

    expect(binStat.mode & 0o777).toBe(0o750);
    expect(runStat.mode & 0o777).toBe(0o700);
  });

  it('applies default entry permissions during materialization', async () => {
    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: rootDir,
    });
    const session = await client.create(
      new Manifest({
        entries: {
          bin: {
            type: 'dir',
            children: {
              'run.sh': {
                type: 'file',
                content: '#!/bin/sh\n',
              },
            },
          },
        },
      }),
    );

    const binStat = await stat(join(session.state.workspaceRootPath, 'bin'));
    const runStat = await stat(
      join(session.state.workspaceRootPath, 'bin', 'run.sh'),
    );

    expect(binStat.mode & 0o777).toBe(0o755);
    expect(runStat.mode & 0o777).toBe(0o755);
  });

  it('rejects manifest identity metadata that cannot be enforced locally', async () => {
    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: rootDir,
    });

    await expect(
      client.create(
        new Manifest({
          users: [{ name: 'sandbox-user' }],
        }),
      ),
    ).rejects.toThrow(/does not support manifest users yet/);
    await expect(
      client.create(
        new Manifest({
          entries: {
            data: {
              type: 'mount',
              source: 's3://bucket/data',
              mountStrategy: { type: 'in_container' },
            },
          },
        }),
      ),
    ).rejects.toThrow(/does not support this mount entry: data/);

    const session = await client.create(new Manifest());
    await expect(
      session.materializeEntry({
        path: 'notes.txt',
        entry: {
          type: 'file',
          content: 'hello\n',
          group: { name: 'sandbox-group' },
        },
      }),
    ).rejects.toThrow(/does not support sandbox entry group ownership yet/);

    await session.close();
  });

  it('supports explicit read-write local bind mounts', async () => {
    const sourceDir = join(rootDir, 'bind-source');
    await mkdir(sourceDir);
    await writeFile(join(sourceDir, 'input.txt'), 'mounted\n');

    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: rootDir,
    });
    const session = await client.create(
      new Manifest({
        entries: {
          external: {
            type: 'mount',
            source: sourceDir,
            readOnly: false,
            mountPath: 'mounted/external',
            mountStrategy: { type: 'local_bind' },
          },
        },
      }),
      {
        snapshot: {
          type: 'local',
          baseDir: rootDir,
        },
      },
    );

    expect(await session.pathExists('mounted/external/input.txt')).toBe(true);
    await session.createEditor().createFile({
      type: 'create_file',
      path: 'mounted/external/output.txt',
      diff: '+created',
    });
    expect(await readFile(join(sourceDir, 'output.txt'), 'utf8')).toBe(
      'created',
    );
    const serialized = await client.serializeSessionState(session.state);
    const serializedManifest = serialized.manifest as Manifest;
    expect(serializedManifest.entries.external).toMatchObject({
      type: 'mount',
      source: sourceDir,
      readOnly: false,
      mountPath: 'mounted/external',
      mountStrategy: { type: 'local_bind' },
    });
    const snapshot = serialized.snapshot as { type: 'local'; path: string };
    await expect(
      stat(join(snapshot.path, 'mounted/external/input.txt')),
    ).rejects.toThrow();

    await session.close();
    const resumed = await client.resume(
      await client.deserializeSessionState(serialized),
    );
    const initialOutput = await resumed.execCommand({
      cmd: 'cat mounted/external/input.txt',
      shell: '/bin/sh',
      login: false,
      yieldTimeMs: 500,
    });
    const output = await collectActiveCommandOutput(resumed, initialOutput);
    expect(output).toContain('mounted');
    await resumed.close();
  });

  it('persists and hydrates local workspace archives', async () => {
    const sourceDir = join(rootDir, 'bind-source');
    await mkdir(sourceDir);
    await writeFile(join(sourceDir, 'input.txt'), 'mounted\n');
    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: rootDir,
    });
    const session = await client.create(
      new Manifest({
        entries: {
          'keep.txt': {
            type: 'file',
            content: 'keep\n',
          },
          scratch: {
            type: 'dir',
            ephemeral: true,
            children: {
              'temp.txt': {
                type: 'file',
                content: 'temp\n',
              },
            },
          },
          external: {
            type: 'mount',
            source: sourceDir,
            readOnly: false,
            mountPath: 'mounted/external',
            mountStrategy: { type: 'local_bind' },
          },
        },
      }),
    );

    const archive = await session.persistWorkspace();
    await writeFile(
      join(session.state.workspaceRootPath, 'keep.txt'),
      'mutated\n',
    );
    await writeFile(
      join(session.state.workspaceRootPath, 'stale.txt'),
      'stale\n',
    );

    await session.hydrateWorkspace(archive);

    await expect(
      readFile(join(session.state.workspaceRootPath, 'keep.txt'), 'utf8'),
    ).resolves.toBe('keep\n');
    await expect(
      stat(join(session.state.workspaceRootPath, 'stale.txt')),
    ).rejects.toThrow();
    await expect(
      stat(join(session.state.workspaceRootPath, 'scratch')),
    ).rejects.toThrow();
    expect(await session.pathExists('mounted/external/input.txt')).toBe(true);

    await session.close();
  });

  it('rejects local workspace archive hydration over resource limits', async () => {
    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: rootDir,
    });
    const session = await client.create(
      new Manifest({
        entries: {
          'one.txt': {
            type: 'file',
            content: '1',
          },
          'two.txt': {
            type: 'file',
            content: '2',
          },
        },
      }),
    );

    const archive = await session.persistWorkspace();

    await expect(
      session.hydrateWorkspace(archive, {
        archiveLimits: {
          maxInputBytes: null,
          maxExtractedBytes: null,
          maxMembers: 1,
        },
      }),
    ).rejects.toMatchObject({
      details: {
        reason: 'archive member count exceeds limit',
        limit: 1,
        actual: 2,
        member: 'two.txt',
      },
    });
    await expect(
      session.hydrateWorkspace(archive, {
        archiveLimits: {
          maxInputBytes: null,
          maxExtractedBytes: null,
          maxMembers: 2,
        },
      }),
    ).resolves.toBeUndefined();

    await session.close();
  });

  it('rejects read-only local bind mounts because host symlinks cannot enforce them', async () => {
    const sourceDir = join(rootDir, 'bind-source');
    await mkdir(sourceDir);
    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: rootDir,
    });

    await expect(
      client.create(
        new Manifest({
          entries: {
            external: {
              type: 'mount',
              source: sourceDir,
              mountStrategy: { type: 'local_bind' },
            },
          },
        }),
      ),
    ).rejects.toThrow(/cannot enforce read-only local bind mounts/);
  });

  it('allows filesystem helpers to use extra path grants', async () => {
    const readGrantDir = join(rootDir, 'read-grant');
    const writeGrantDir = join(rootDir, 'write-grant');
    const outsideDir = join(rootDir, 'outside');
    await mkdir(readGrantDir);
    await mkdir(writeGrantDir);
    await mkdir(outsideDir);
    await writeFile(join(readGrantDir, 'input.txt'), 'granted\n');
    await writeFile(join(outsideDir, 'secret.txt'), 'blocked\n');

    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: rootDir,
    });
    const session = await client.create(
      new Manifest({
        extraPathGrants: [
          {
            path: readGrantDir,
            readOnly: true,
          },
          {
            path: writeGrantDir,
          },
        ],
      }),
    );

    expect(await session.pathExists(join(readGrantDir, 'input.txt'))).toBe(
      true,
    );
    await expect(
      session.pathExists(join(outsideDir, 'secret.txt')),
    ).rejects.toThrow(/escapes the workspace root/);

    const editor = session.createEditor();
    await expect(
      editor.createFile({
        type: 'create_file',
        path: join(readGrantDir, 'blocked.txt'),
        diff: '+blocked',
      }),
    ).rejects.toThrow(/read-only extra path grant/);

    await editor.createFile({
      type: 'create_file',
      path: join(writeGrantDir, 'created.txt'),
      diff: '+created',
    });
    expect(await readFile(join(writeGrantDir, 'created.txt'), 'utf8')).toBe(
      'created',
    );
  });

  it('rejects symlink escapes in filesystem helpers', async () => {
    const outsideDir = join(rootDir, 'outside');
    await mkdir(outsideDir);
    await writeFile(join(outsideDir, 'secret.png'), ONE_BY_ONE_PNG);
    await writeFile(join(outsideDir, 'secret.txt'), 'outside\n');

    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: rootDir,
    });
    const session = await client.create(new Manifest());
    await symlink(outsideDir, join(session.state.workspaceRootPath, 'escape'));
    await symlink(
      join(outsideDir, 'secret.txt'),
      join(session.state.workspaceRootPath, 'secret-link.txt'),
    );

    await expect(session.pathExists('escape/secret.png')).rejects.toThrow(
      /escapes the workspace root/,
    );
    await expect(
      session.viewImage({ path: 'escape/secret.png' }),
    ).rejects.toThrow(/escapes the workspace root/);

    const editor = session.createEditor();
    await expect(
      editor.createFile({
        type: 'create_file',
        path: 'escape/created.txt',
        diff: '+created',
      }),
    ).rejects.toThrow(/escapes the workspace root/);
    await expect(
      editor.updateFile({
        type: 'update_file',
        path: 'secret-link.txt',
        diff: '@@\n-outside\n+patched\n',
      }),
    ).rejects.toThrow(/escapes the workspace root/);

    await expect(
      readFile(join(outsideDir, 'created.txt'), 'utf8'),
    ).rejects.toThrow();
    expect(await readFile(join(outsideDir, 'secret.txt'), 'utf8')).toBe(
      'outside\n',
    );
  });

  it('rejects symlink escapes during materialization', async () => {
    const outsideDir = join(rootDir, 'outside');
    await mkdir(outsideDir);
    await writeFile(join(outsideDir, 'target.txt'), 'outside\n');

    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: rootDir,
    });
    const session = await client.create(new Manifest());
    await symlink(outsideDir, join(session.state.workspaceRootPath, 'escape'));

    await expect(
      session.materializeEntry({
        path: 'escape/created.txt',
        entry: {
          type: 'file',
          content: 'created\n',
        },
      }),
    ).rejects.toThrow(/escapes the workspace root/);
    await expect(
      readFile(join(outsideDir, 'created.txt'), 'utf8'),
    ).rejects.toThrow();

    await mkdir(join(session.state.workspaceRootPath, 'data'));
    await symlink(
      join(outsideDir, 'target.txt'),
      join(session.state.workspaceRootPath, 'data', 'target.txt'),
    );

    await expect(
      session.materializeEntry({
        path: 'data/target.txt',
        entry: {
          type: 'file',
          content: 'patched\n',
        },
      }),
    ).rejects.toThrow(/symbolic link/);
    expect(await readFile(join(outsideDir, 'target.txt'), 'utf8')).toBe(
      'outside\n',
    );
  });

  it('supports apply_patch and view_image inside the sandbox', async () => {
    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: rootDir,
    });
    const session = await client.create(
      new Manifest({
        entries: {
          'notes.txt': {
            type: 'file',
            content: 'hello sandbox\n',
          },
          'pixel.png': {
            type: 'file',
            content: ONE_BY_ONE_PNG,
          },
          'vector.svg': {
            type: 'file',
            content:
              '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>',
          },
        },
      }),
    );

    await session.createEditor().updateFile({
      type: 'update_file',
      path: 'notes.txt',
      diff: '@@\n-hello sandbox\n+hello patched\n',
      moveTo: 'renamed/notes.txt',
    });
    await expect(
      session.createEditor().createFile({
        type: 'create_file',
        path: 'renamed/notes.txt',
        diff: '+overwrite\n',
      }),
    ).rejects.toThrow(/EEXIST|file already exists/i);

    const initialOutput = await session.execCommand({
      cmd: 'test ! -e notes.txt; cat renamed/notes.txt',
      shell: '/bin/sh',
      login: false,
      yieldTimeMs: 500,
    });
    const sessionId = Number(
      initialOutput.match(/Process running with session ID (\d+)/)?.[1],
    );
    const output = Number.isFinite(sessionId)
      ? `${initialOutput}${await writeUntilExit(
          {
            writeStdin: (args) => session.writeStdin(args),
          },
          sessionId,
          '',
        )}`
      : initialOutput;
    const image = await session.viewImage({
      path: 'pixel.png',
    });
    const svg = await session.viewImage({
      path: 'vector.svg',
    });

    expect(output).toContain('hello patched');
    expect(image).toMatchObject({
      type: 'image',
      image: {
        data: expect.any(Uint8Array),
        mediaType: 'image/png',
      },
    });
    expect(svg).toMatchObject({
      type: 'image',
      image: {
        data: expect.any(Uint8Array),
        mediaType: 'image/svg+xml',
      },
    });
  });

  it('supports incremental filesystem operations and manifest application', async () => {
    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: rootDir,
    });
    const session = await client.create(
      new Manifest({
        remoteMountCommandAllowlist: ['cat'],
      }),
    );

    expect(session.supportsPty()).toBe(true);
    expect(await session.pathExists('missing.txt')).toBe(false);
    expect(() => session.resolveSandboxPath('../outside.txt')).toThrow(
      /must not escape root/,
    );
    expect(session.resolveSandboxPath('..data')).toBe(
      join(session.state.workspaceRootPath, '..data'),
    );
    await expect(
      session.execCommand({
        cmd: 'pwd',
        workdir: '/tmp',
      }),
    ).rejects.toThrow(/escapes the workspace root/);
    expect(await session.writeStdin({ sessionId: 999 })).toContain(
      'session not found: 999',
    );

    await session.materializeEntry({
      path: 'nested/materialized.txt',
      entry: {
        type: 'file',
        content: 'materialized\n',
      },
    });
    expect(await session.pathExists('nested/materialized.txt')).toBe(true);
    expect(session.state.manifest.remoteMountCommandAllowlist).toEqual(['cat']);
    await session.materializeEntry({
      path: '..config',
      entry: {
        type: 'file',
        content: 'valid top-level dot path\n',
      },
    });
    expect(await session.pathExists('..config')).toBe(true);

    const editor = session.createEditor();
    await editor.createFile({
      type: 'create_file',
      path: 'created/file.txt',
      diff: '+created',
    });
    await editor.deleteFile({
      type: 'delete_file',
      path: 'created/file.txt',
    });
    expect(await session.pathExists('created/file.txt')).toBe(false);

    await session.applyManifest(
      new Manifest({
        entries: {
          'applied.txt': {
            type: 'file',
            content: 'applied\n',
          },
        },
        environment: {
          APPLIED_VALUE: 'yes',
        },
      }),
    );
    const output = await session.execCommand({
      cmd: 'printf "%s\\n" "$APPLIED_VALUE"; cat applied.txt nested/materialized.txt',
      shell: '/bin/sh',
      login: false,
      yieldTimeMs: 2_000,
    });

    expect(output).toContain('yes');
    expect(output).toContain('applied');
    expect(output).toContain('materialized');
    expect(session.state.manifest.remoteMountCommandAllowlist).toEqual(['cat']);
    await expect(session.viewImage({ path: 'missing.png' })).rejects.toThrow(
      /Image file not found/,
    );
    await expect(session.viewImage({ path: 'nested' })).rejects.toThrow(
      /Image path is not a file/,
    );
    await expect(session.viewImage({ path: 'applied.txt' })).rejects.toThrow(
      /Unsupported image format/,
    );
    expect(() => session.resolveSandboxPath('/tmp')).toThrow(
      /escapes the workspace root/,
    );
  });

  it('resolves localhost endpoints for exposed ports', async () => {
    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: rootDir,
      exposedPorts: [4173, 4173],
      snapshot: new NoopSnapshotSpec(),
    });
    const session = await client.create(new Manifest());

    const endpoint = await session.resolveExposedPort(4173);

    expect(session.state.configuredExposedPorts).toEqual([4173]);
    expect(endpoint).toEqual({
      host: '127.0.0.1',
      port: 4173,
      tls: false,
      query: '',
    });
    expect(session.state.exposedPorts).toEqual({
      '4173': endpoint,
    });
    expect(urlForExposedPort(endpoint, 'http')).toBe('http://127.0.0.1:4173/');
    expect(urlForExposedPort(endpoint, 'ws')).toBe('ws://127.0.0.1:4173/');
    await expect(session.resolveExposedPort(3000)).rejects.toThrow(
      /was not configured to expose port 3000/,
    );
    await expect(session.resolveExposedPort(0)).rejects.toThrow(
      /Exposed ports must be integers between 1 and 65535/,
    );

    const serialized = await client.serializeSessionState(session.state);
    expect(serialized.configuredExposedPorts).toEqual([4173]);
    const roundTripped = await client.deserializeSessionState(serialized);
    expect(roundTripped.configuredExposedPorts).toEqual([4173]);
  });

  it('accepts absolute sandbox paths when the manifest root is slash', async () => {
    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: rootDir,
    });
    const session = await client.create(
      new Manifest({
        root: '/',
        entries: {
          'tmp/notes.txt': {
            type: 'file',
            content: 'root path\n',
          },
        },
      }),
    );

    expect(session.resolveSandboxPath('/tmp/notes.txt')).toBe(
      join(session.state.workspaceRootPath, 'tmp/notes.txt'),
    );
    expect(await session.pathExists('/tmp/notes.txt')).toBe(true);

    const absoluteOutput = await session.execCommand({
      cmd: 'cat /tmp/notes.txt',
      shell: '/bin/sh',
      login: false,
      yieldTimeMs: 2_000,
    });
    expect(absoluteOutput).toContain('root path');

    const output = await session.execCommand({
      cmd: 'printf "%s" "$PWD"',
      workdir: '/tmp',
      shell: '/bin/sh',
      login: false,
      yieldTimeMs: 2_000,
    });

    expect(output).toContain('/tmp');
    await expect(session.pathExists('/../outside.txt')).rejects.toThrow(
      /must not escape root/,
    );
  });

  it('reattaches to a live workspace and falls back to a local snapshot restore', async () => {
    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: rootDir,
    });
    const session = await client.create(
      new Manifest({
        entries: {
          'notes.txt': {
            type: 'file',
            content: 'before\n',
          },
        },
      }),
      {
        snapshot: {
          type: 'local',
          baseDir: rootDir,
        },
      },
    );

    await session.createEditor().updateFile({
      type: 'update_file',
      path: 'notes.txt',
      diff: '@@\n-before\n+after\n',
    });

    const serialized = await client.serializeSessionState(session.state);
    const reattached = await client.resume(
      await client.deserializeSessionState(serialized),
    );
    const reattachedOutput = await reattached.execCommand({
      cmd: 'cat notes.txt',
      shell: '/bin/sh',
      login: false,
      yieldTimeMs: 500,
    });
    const completedReattachedOutput = await collectActiveCommandOutput(
      reattached,
      reattachedOutput,
    );

    expect(completedReattachedOutput).toContain('after');

    const priorWorkspaceRoot = session.state.workspaceRootPath;
    await rm(priorWorkspaceRoot, { recursive: true, force: true });
    const restored = await client.resume(
      await client.deserializeSessionState(serialized),
    );
    const restoredOutput = await restored.execCommand({
      cmd: 'cat notes.txt',
      shell: '/bin/sh',
      login: false,
      yieldTimeMs: 500,
    });
    const completedRestoredOutput = await collectActiveCommandOutput(
      restored,
      restoredOutput,
    );

    expect(restored.state.workspaceRootPath).not.toBe(priorWorkspaceRoot);
    expect(restored.state.snapshotSpec).toEqual({
      type: 'local',
      baseDir: rootDir,
    });
    expect(completedRestoredOutput).toContain('after');
  });

  it('restores a local snapshot over a drifted live workspace', async () => {
    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: rootDir,
    });
    const session = await client.create(
      new Manifest({
        entries: {
          'notes.txt': {
            type: 'file',
            content: 'before\n',
          },
        },
      }),
      {
        snapshot: {
          type: 'local',
          baseDir: rootDir,
        },
      },
    );

    await session.createEditor().updateFile({
      type: 'update_file',
      path: 'notes.txt',
      diff: '@@\n-before\n+snapshot\n',
    });

    const serialized = await client.serializeSessionState(session.state);
    expect(serialized.snapshotFingerprint).toEqual(expect.any(String));
    expect(serialized.snapshotFingerprintVersion).toBe(
      'workspace_tree_sha256_v1',
    );

    await writeFile(
      join(session.state.workspaceRootPath, 'notes.txt'),
      'drifted\n',
      'utf8',
    );

    const restored = await client.resume(
      await client.deserializeSessionState(serialized),
    );
    const initialRestoredOutput = await restored.execCommand({
      cmd: 'cat notes.txt',
      shell: '/bin/sh',
      login: false,
      yieldTimeMs: 500,
    });
    const restoredOutput = await collectActiveCommandOutput(
      restored,
      initialRestoredOutput,
    );

    expect(restored.state.workspaceRootPath).toBe(
      session.state.workspaceRootPath,
    );
    expect(restoredOutput).toContain('snapshot');
    expect(restoredOutput).not.toContain('drifted');
  });

  it('serializes persistent state without ephemeral manifest data', async () => {
    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: rootDir,
    });
    const session = await client.create(
      new Manifest({
        entries: {
          'keep.txt': {
            type: 'file',
            content: 'keep\n',
          },
          'tmp.txt': {
            type: 'file',
            content: 'tmp\n',
            ephemeral: true,
          },
          dir: {
            type: 'dir',
            children: {
              'nested.tmp': {
                type: 'file',
                content: 'nested\n',
                ephemeral: true,
              },
            },
          },
        },
        environment: {
          KEEP_ENV: 'keep',
          SECRET_ENV: {
            value: 'secret',
            ephemeral: true,
          },
        },
      }),
      {
        snapshot: {
          type: 'local',
          baseDir: rootDir,
        },
      },
    );
    session.state.environment.KEEP_ENV = 'runtime-keep';
    session.state.environment.RUNTIME_ENV = 'runtime-only';
    session.state.environment.SECRET_ENV = 'runtime-secret';

    const firstSerialized = await client.serializeSessionState(session.state);
    const firstSnapshot = firstSerialized.snapshot as {
      type: 'local';
      path: string;
    };
    await expect(
      stat(join(firstSnapshot.path, 'keep.txt')),
    ).resolves.toBeTruthy();

    const serialized = await client.serializeSessionState(session.state);
    const serializedManifest = serialized.manifest as Manifest;
    const snapshot = serialized.snapshot as { type: 'local'; path: string };

    expect(serializedManifest.entries).toHaveProperty('keep.txt');
    expect(serializedManifest.entries).toHaveProperty('dir');
    expect(serializedManifest.entries).not.toHaveProperty('tmp.txt');
    expect(
      (
        serializedManifest.entries.dir as {
          children: Record<string, unknown>;
        }
      ).children,
    ).not.toHaveProperty('nested.tmp');
    expect(serialized.environment).toEqual({
      KEEP_ENV: 'runtime-keep',
      RUNTIME_ENV: 'runtime-only',
    });
    const resumed = await client.resume(
      await client.deserializeSessionState(serialized),
    );
    const output = await resumed.execCommand({
      cmd: 'printf "%s:%s:%s\\n" "$KEEP_ENV" "$RUNTIME_ENV" "$SECRET_ENV"',
      shell: '/bin/sh',
      login: false,
      yieldTimeMs: 500,
    });

    expect(output).toContain('runtime-keep:runtime-only:');
    expect(output).not.toContain('runtime-secret');
    expect(snapshot).toMatchObject({
      type: 'local',
    });
    expect(snapshot.path).not.toBe(firstSnapshot.path);
    await expect(stat(firstSnapshot.path)).rejects.toThrow();
    await expect(stat(join(snapshot.path, 'keep.txt'))).resolves.toBeTruthy();
    await expect(stat(join(snapshot.path, 'tmp.txt'))).rejects.toThrow();
    await expect(stat(join(snapshot.path, 'dir/nested.tmp'))).rejects.toThrow();
  });

  it('excludes an ephemeral root entry from local snapshots', async () => {
    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: rootDir,
    });
    const session = await client.create(
      new Manifest({
        entries: {
          '.': {
            type: 'dir',
            ephemeral: true,
            children: {
              'keep.txt': {
                type: 'file',
                content: 'skip root\n',
              },
              dir: {
                type: 'dir',
                children: {
                  'nested.txt': {
                    type: 'file',
                    content: 'skip nested\n',
                  },
                },
              },
            },
          },
        },
      }),
      {
        snapshot: {
          type: 'local',
          baseDir: rootDir,
        },
      },
    );

    const serialized = await client.serializeSessionState(session.state);
    const snapshot = serialized.snapshot as { type: 'local'; path: string };

    await expect(stat(join(snapshot.path, 'keep.txt'))).rejects.toThrow();
    await expect(stat(join(snapshot.path, 'dir'))).rejects.toThrow();
  });

  it('calls custom mount materializers once per mount target', async () => {
    const workspaceRootPath = join(rootDir, 'workspace');
    await mkdir(workspaceRootPath, { recursive: true });
    const calls: Array<{ logicalPath: string; source?: string }> = [];
    const manifest = new Manifest({
      entries: {
        data: {
          type: 'mount',
          source: 's3://bucket/data',
          mountStrategy: { type: 'in_container' },
        },
      },
    });

    await materializeLocalWorkspaceManifestMounts(manifest, workspaceRootPath, {
      supportsMount: () => true,
      materializeMount: async ({ logicalPath, entry }) => {
        calls.push({
          logicalPath,
          source: entry.type === 'mount' ? entry.source : undefined,
        });
      },
    });

    expect(calls).toEqual([
      { logicalPath: 'data', source: 's3://bucket/data' },
    ]);
  });

  it('materializes parent mount targets before nested targets', async () => {
    const workspaceRootPath = join(rootDir, 'workspace');
    await mkdir(workspaceRootPath, { recursive: true });
    const calls: string[] = [];
    const manifest = new Manifest({
      entries: {
        parent: {
          type: 'mount',
          source: 's3://bucket/parent',
          mountPath: 'mounted',
          mountStrategy: { type: 'in_container' },
        },
        child: {
          type: 'mount',
          source: 's3://bucket/child',
          mountPath: 'mounted/cache',
          mountStrategy: { type: 'in_container' },
        },
        other: {
          type: 'mount',
          source: 's3://bucket/other',
          mountStrategy: { type: 'in_container' },
        },
      },
    });

    await materializeLocalWorkspaceManifestMounts(manifest, workspaceRootPath, {
      supportsMount: () => true,
      materializeMount: async ({ logicalPath }) => {
        calls.push(logicalPath);
      },
    });

    expect(calls).toEqual(['parent', 'other', 'child']);
  });

  it('materializes initial manifest mounts after normal entries in parent-first order', async () => {
    const workspaceRootPath = join(rootDir, 'workspace');
    const calls: string[] = [];
    const manifest = new Manifest({
      entries: {
        child: {
          type: 'mount',
          source: 's3://bucket/child',
          mountPath: 'mounted/cache',
          mountStrategy: { type: 'in_container' },
        },
        notes: {
          type: 'file',
          content: 'notes',
        },
        parent: {
          type: 'mount',
          source: 's3://bucket/parent',
          mountPath: 'mounted',
          mountStrategy: { type: 'in_container' },
        },
      },
    });

    await materializeLocalWorkspaceManifest(manifest, workspaceRootPath, {
      supportsMount: () => true,
      materializeMount: async ({ logicalPath }) => {
        calls.push(logicalPath);
      },
    });

    expect(await readFile(join(workspaceRootPath, 'notes'), 'utf8')).toBe(
      'notes',
    );
    expect(calls).toEqual(['parent', 'child']);
  });

  it('uses the stable default local snapshot directory when baseDir is omitted', async () => {
    const originalSnapshotDir = process.env.OPENAI_AGENTS_SANDBOX_SNAPSHOT_DIR;
    const snapshotBaseDir = join(rootDir, 'stable-snapshots');
    process.env.OPENAI_AGENTS_SANDBOX_SNAPSHOT_DIR = snapshotBaseDir;

    try {
      const client = new UnixLocalSandboxClient({
        workspaceBaseDir: rootDir,
        snapshot: {
          type: 'local',
        },
      });
      const session = await client.create(
        new Manifest({
          entries: {
            'notes.txt': {
              type: 'file',
              content: 'stable\n',
            },
          },
        }),
      );

      const serialized = await client.serializeSessionState(session.state);
      const snapshot = serialized.snapshot as { type: 'local'; path: string };

      expect(snapshot.path.startsWith(`${snapshotBaseDir}/`)).toBe(true);
      await expect(
        readFile(join(snapshot.path, 'notes.txt'), 'utf8'),
      ).resolves.toBe('stable\n');
    } finally {
      if (originalSnapshotDir === undefined) {
        delete process.env.OPENAI_AGENTS_SANDBOX_SNAPSHOT_DIR;
      } else {
        process.env.OPENAI_AGENTS_SANDBOX_SNAPSHOT_DIR = originalSnapshotDir;
      }
    }
  });

  it('does not follow symlinks when creating local snapshots', async () => {
    const hostSecretPath = join(rootDir, 'host-secret.txt');
    await writeFile(hostSecretPath, 'host secret\n', 'utf8');

    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: rootDir,
    });
    const session = await client.create(
      new Manifest({
        entries: {
          'safe.txt': {
            type: 'file',
            content: 'safe\n',
          },
        },
      }),
      {
        snapshot: {
          type: 'local',
          baseDir: rootDir,
        },
      },
    );
    await symlink(
      hostSecretPath,
      join(session.state.workspaceRootPath, 'link'),
    );

    const serialized = await client.serializeSessionState(session.state);
    const snapshot = serialized.snapshot as { type: 'local'; path: string };

    await expect(lstat(join(snapshot.path, 'safe.txt'))).resolves.toBeTruthy();
    await expect(lstat(join(snapshot.path, 'link'))).rejects.toThrow();
    await expect(
      readFile(join(snapshot.path, 'link'), 'utf8'),
    ).rejects.toThrow();
  });

  it('skips and clears local snapshots for noop snapshot specs', async () => {
    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: rootDir,
      snapshot: {
        type: 'local',
        baseDir: rootDir,
      },
    });
    const session = await client.create(
      new Manifest({
        entries: {
          'notes.txt': {
            type: 'file',
            content: 'keep\n',
          },
        },
      }),
    );

    const firstSerialized = await client.serializeSessionState(session.state);
    const firstSnapshot = firstSerialized.snapshot as {
      type: 'local';
      path: string;
    };
    await expect(
      stat(join(firstSnapshot.path, 'notes.txt')),
    ).resolves.toBeTruthy();

    session.state.snapshotSpec = new NoopSnapshotSpec();
    const serialized = await client.serializeSessionState(session.state);

    expect(serialized.snapshotSpec).toEqual({ type: 'noop' });
    expect(serialized.snapshot).toBeNull();
    await expect(stat(firstSnapshot.path)).rejects.toThrow();

    const priorWorkspaceRoot = session.state.workspaceRootPath;
    await rm(priorWorkspaceRoot, { recursive: true, force: true });
    await expect(
      client.resume(await client.deserializeSessionState(serialized)),
    ).rejects.toThrow(/no local snapshot could be restored/);
  });

  it('persists and restores remote snapshots through a snapshot store', async () => {
    const store = new InMemoryRemoteSnapshotStore();
    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: rootDir,
      snapshot: {
        type: 'remote',
        id: 'remote-snapshot',
        store,
      },
    });
    const session = await client.create(
      new Manifest({
        entries: {
          'keep.txt': {
            type: 'file',
            content: 'keep\n',
          },
          'skip.txt': {
            type: 'file',
            content: 'skip\n',
            ephemeral: true,
          },
        },
      }),
    );

    const serialized = JSON.parse(
      JSON.stringify(await client.serializeSessionState(session.state)),
    ) as Record<string, unknown>;
    const snapshot = serialized.snapshot as { type: 'remote'; id: string };
    expect(serialized.snapshotSpec).toEqual({
      type: 'remote',
      id: 'remote-snapshot',
    });
    await rm(session.state.workspaceRootPath, { recursive: true, force: true });

    const deserialized = await client.deserializeSessionState(serialized);
    expect((deserialized.snapshotSpec as any)?.store).toBe(store);
    const restored = await client.resume(deserialized);

    expect(snapshot).toEqual({ type: 'remote', id: 'remote-snapshot' });
    await expect(
      readFile(join(restored.state.workspaceRootPath, 'keep.txt'), 'utf8'),
    ).resolves.toBe('keep\n');
    await expect(
      readFile(join(restored.state.workspaceRootPath, 'skip.txt'), 'utf8'),
    ).rejects.toThrow();
  });

  it('applies archive limits before restoring remote snapshots', async () => {
    const store = new InMemoryRemoteSnapshotStore();
    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: rootDir,
      snapshot: {
        type: 'remote',
        id: 'remote-snapshot',
        store,
      },
      archiveLimits: {
        maxInputBytes: null,
        maxExtractedBytes: 4,
        maxMembers: null,
      },
    });
    const session = await client.create(
      new Manifest({
        entries: {
          'keep.txt': {
            type: 'file',
            content: 'keep\n',
          },
        },
      }),
    );

    const serialized = JSON.parse(
      JSON.stringify(await client.serializeSessionState(session.state)),
    ) as Record<string, unknown>;
    await rm(session.state.workspaceRootPath, { recursive: true, force: true });

    await expect(
      client.resume(await client.deserializeSessionState(serialized)),
    ).rejects.toMatchObject({
      details: {
        reason: 'archive extracted size exceeds limit',
        limit: 4,
        actual: 5,
        member: 'keep.txt',
      },
    });
  });

  it('rejects restoring remote snapshots into a symlinked workspace root', async () => {
    const store = new InMemoryRemoteSnapshotStore();
    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: rootDir,
      snapshot: {
        type: 'remote',
        id: 'remote-snapshot',
        store,
      },
    });
    const session = await client.create(
      new Manifest({
        entries: {
          'keep.txt': {
            type: 'file',
            content: 'keep\n',
          },
        },
      }),
    );

    const serialized = JSON.parse(
      JSON.stringify(await client.serializeSessionState(session.state)),
    ) as Record<string, unknown>;
    const priorWorkspaceRoot = session.state.workspaceRootPath;
    const outsideDir = join(rootDir, 'outside-root');
    await mkdir(outsideDir);
    await writeFile(join(outsideDir, 'outside.txt'), 'outside\n');
    await rm(priorWorkspaceRoot, { recursive: true, force: true });
    await symlink(outsideDir, priorWorkspaceRoot);

    await expect(
      client.resume(await client.deserializeSessionState(serialized)),
    ).rejects.toThrow(/snapshot path changed while copying/);
    await expect(
      readFile(join(outsideDir, 'outside.txt'), 'utf8'),
    ).resolves.toBe('outside\n');
    await expect(
      readFile(join(outsideDir, 'keep.txt'), 'utf8'),
    ).rejects.toThrow();
  });

  it('tears down owned workspaces when the session closes', async () => {
    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: rootDir,
    });
    const session = await client.create(new Manifest());
    const workspaceRootPath = session.state.workspaceRootPath;

    await session.close();

    await expect(stat(workspaceRootPath)).rejects.toThrow();
  });

  it('materializes lazy skills through sandbox session hooks', async () => {
    const skillsRoot = join(rootDir, 'skills');
    const dynamicSkillDir = join(skillsRoot, 'dynamic-skill');
    await mkdir(dynamicSkillDir, { recursive: true });
    await writeFile(
      join(dynamicSkillDir, 'SKILL.md'),
      '# dynamic skill\n',
      'utf8',
    );

    const client = new UnixLocalSandboxClient({
      workspaceBaseDir: rootDir,
    });
    const session = await client.create(
      new Manifest({
        extraPathGrants: [{ path: skillsRoot, readOnly: true }],
      }),
    );
    const capability = skills({
      lazyFrom: {
        source: {
          type: 'local_dir',
          src: skillsRoot,
        },
        index: [
          {
            name: 'dynamic-skill',
            description: 'dynamic',
          },
        ],
      },
    });
    capability.bind(session);
    const [tool] = capability.tools();

    const first = await (tool as any).invoke(
      undefined,
      JSON.stringify({ skill_name: 'dynamic-skill' }),
    );
    const second = await (tool as any).invoke(
      undefined,
      JSON.stringify({ skill_name: 'dynamic-skill' }),
    );
    const output = await session.execCommand({
      cmd: 'cat .agents/dynamic-skill/SKILL.md',
    });

    expect(first).toEqual({
      status: 'loaded',
      skill_name: 'dynamic-skill',
      path: '.agents/dynamic-skill',
    });
    expect(second).toEqual({
      status: 'already_loaded',
      skill_name: 'dynamic-skill',
      path: '.agents/dynamic-skill',
    });
    expect(output).toContain('# dynamic skill');
  });
});

async function writeUntilExit(
  session: {
    writeStdin(args: {
      sessionId: number;
      chars?: string;
      yieldTimeMs?: number;
    }): Promise<string>;
  },
  sessionId: number,
  chars: string,
): Promise<string> {
  let output = await session.writeStdin({
    sessionId,
    chars,
    yieldTimeMs: ACTIVE_PROCESS_POLL_MS,
  });
  let combinedOutput = output;

  for (
    let attempt = 0;
    attempt < ACTIVE_PROCESS_MAX_POLLS &&
    !output.includes('Process exited with code');
    attempt += 1
  ) {
    output = await session.writeStdin({
      sessionId,
      chars: '',
      yieldTimeMs: ACTIVE_PROCESS_POLL_MS,
    });
    combinedOutput += output;
  }

  return combinedOutput;
}

async function collectActiveCommandOutput(
  session: {
    writeStdin(args: {
      sessionId: number;
      chars?: string;
      yieldTimeMs?: number;
    }): Promise<string>;
  },
  initialOutput: string,
): Promise<string> {
  const sessionId = Number(
    initialOutput.match(/Process running with session ID (\d+)/)?.[1],
  );
  if (!Number.isFinite(sessionId)) {
    return initialOutput;
  }

  return `${initialOutput}${await writeUntilExit(session, sessionId, '')}`;
}
