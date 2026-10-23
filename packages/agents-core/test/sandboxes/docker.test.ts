import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { skills, type Entry } from '../../src/sandbox';
import { RunContext } from '../../src/runContext';
import { shellQuote } from '../../src/sandbox/shared/shell';
import {
  DockerSandboxClient,
  InMemoryRemoteSnapshotStore,
  inContainerMountStrategy,
  Manifest,
  NoopSnapshotSpec,
} from '../../src/sandbox/local';

const ONE_BY_ONE_PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAE/wH+gZ6kWQAAAABJRU5ErkJggg==',
    'base64',
  ),
);

// Match the client's default image, including its GNU filesystem utilities.
const DOCKER_TEST_IMAGE = 'python:3.14-slim';
const DOCKER_CLI_TIMEOUT_MS = 30_000;
const DOCKER_TEST_TIMEOUT_MS = 180_000;
const ACTIVE_PROCESS_POLL_MS = 50;
const ACTIVE_PROCESS_MAX_POLLS = 80;
const dockerAvailable = isDockerAvailable();
const itIfDocker = dockerAvailable ? it : it.skip;

describe('DockerSandboxClient', () => {
  let rootDir: string;
  const cleanupContainerIds = new Set<string>();

  afterEach(async () => {
    for (const containerId of cleanupContainerIds) {
      removeDockerContainer(containerId);
    }
    cleanupContainerIds.clear();

    if (rootDir) {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  itIfDocker.each([
    ['local_dir', false],
    ['local_dir', true],
    ['dir', false],
    ['dir', true],
    ['git_repo', false],
    ['git_repo', true],
  ] as const)(
    'loads a %s skill inside Docker (path swaps: %s)',
    async (sourceType, race) => {
      rootDir = await mkdtemp(join(process.cwd(), '.docker-skill-source-'));
      const source = join(rootDir, 'skills');
      await mkdir(join(source, 'demo', 'empty'), { recursive: true });
      await writeFile(join(source, 'demo', 'SKILL.md'), 'Configured skill');
      if (sourceType === 'local_dir')
        await writeFile(join(source, 'demo', 'SKILL.md '), 'Trailing space');
      const literalName = "quote'; $(touch INJECTED); `touch INJECTED`";
      const longName = 'ü'.repeat(80);
      await writeFile(
        join(source, 'demo', literalName),
        'Literal shell syntax',
      );
      await writeFile(join(source, 'demo', longName), 'Long Unicode name');
      if (sourceType === 'local_dir') {
        await mkdir(join(source, 'demo', ' '));
        await writeFile(
          join(source, 'demo', ' ', ' leading\\name\n'),
          'Literal name',
        );
      }
      await writeFile(
        join(source, 'demo', 'asset.bin'),
        Buffer.from([0, 255, 128]),
      );
      const outside = join(rootDir, 'host-only');
      await mkdir(join(outside, 'demo'), { recursive: true });
      const victim = join(outside, 'demo', 'SKILL.md');
      await writeFile(victim, 'host marker');
      await chmod(victim, 0o640);
      const session = await new DockerSandboxClient({
        image: DOCKER_TEST_IMAGE,
        snapshot: new NoopSnapshotSpec(),
      }).create(new Manifest());
      cleanupContainerIds.add(session.state.containerId);
      let skillSource: Entry = { type: 'local_dir', src: source };
      if (sourceType === 'dir') {
        skillSource = {
          type: 'dir',
          children: {
            demo: {
              type: 'dir',
              children: {
                'SKILL.md': { type: 'file', content: 'Configured skill' },
                [literalName]: {
                  type: 'file',
                  content: 'Literal shell syntax',
                },
                [longName]: { type: 'file', content: 'Long Unicode name' },
                asset: {
                  type: 'local_dir',
                  src: join(source, 'demo', 'empty'),
                },
                empty: { type: 'dir' },
                'asset.bin': {
                  type: 'local_file',
                  src: join(source, 'demo', 'asset.bin'),
                },
              },
            },
          },
        };
      } else if (sourceType === 'git_repo') {
        for (const args of [
          ['init'],
          ['add', '.'],
          [
            '-c',
            'user.name=Test',
            '-c',
            'user.email=test@example.invalid',
            'commit',
            '-m',
            'skill',
          ],
        ]) {
          expect(spawnSync('git', ['-C', source, ...args]).status).toBe(0);
        }
        skillSource = { type: 'git_repo', repo: `file://${source}` };
      }
      const materialization = vi.spyOn(session, 'materializeEntry');
      const capability = skills({
        lazyFrom: {
          source: skillSource,
          index: [{ name: 'demo', description: 'Configured skill' }],
        },
      }).bind(session);
      const tool = capability
        .tools()
        .find((tool) => tool.name === 'load_skill');
      if (!tool || tool.type !== 'function')
        throw new Error('Missing load_skill');
      if (race) {
        const script = `import os, time, ctypes
libc = ctypes.CDLL(None, use_errno=True)
os.makedirs('/workspace/.agents', exist_ok=True)
os.symlink(${JSON.stringify(outside)}, '/workspace/agents-swap')
count = 0
deadline = time.monotonic() + 30
while time.monotonic() < deadline and not os.path.exists('/workspace/stop-swaps'):
 for delay in (.0003, .001):
  if libc.renameat2(-100, b'/workspace/.agents', -100, b'/workspace/agents-swap', 2):
   raise OSError(ctypes.get_errno(), 'renameat2 failed')
  count += 1
  time.sleep(delay)
open('/workspace/swaps-done', 'w').write(str(count))
`;
        expect(
          await session.execCommand({
            cmd: `test ! -e ${shellQuote(outside)} && echo host-unavailable`,
          }),
        ).toContain('host-unavailable');
        await session.execCommand({
          cmd: `python3 -c ${shellQuote(script)}`,
          yieldTimeMs: 100,
        });
      }
      for (let attempt = 0; attempt < (race ? 20 : 1); attempt++) {
        const result = await tool.invoke(
          new RunContext(),
          JSON.stringify({ skill_name: 'demo' }),
        );
        if (!race) {
          if (typeof result === 'string')
            await materialization.mock.results.at(-1)?.value;
          expect(result).toMatchObject({
            status: 'loaded',
            skill_name: 'demo',
          });
          expect(
            Buffer.from(
              await session.readFile({ path: '.agents/demo/SKILL.md' }),
            ).toString(),
          ).toBe('Configured skill');
          const copied = join(
            session.state.workspaceRootPath,
            '.agents',
            'demo',
          );
          if (sourceType === 'local_dir')
            expect(await readFile(join(copied, 'SKILL.md '), 'utf8')).toBe(
              'Trailing space',
            );
          expect(await readFile(join(copied, literalName), 'utf8')).toBe(
            'Literal shell syntax',
          );
          expect(await readFile(join(copied, longName), 'utf8')).toBe(
            'Long Unicode name',
          );
          if (typeof process.getuid === 'function') {
            expect((await stat(join(copied, 'SKILL.md'))).uid).toBe(
              process.getuid(),
            );
          }
          if (sourceType === 'local_dir') {
            expect(
              await readFile(join(copied, ' ', ' leading\\name\n'), 'utf8'),
            ).toBe('Literal name');
          }
          expect(
            Buffer.from(
              await session.readFile({ path: '.agents/demo/asset.bin' }),
            ),
          ).toEqual(Buffer.from([0, 255, 128]));
          if (sourceType !== 'git_repo')
            expect(await session.directoryExists('.agents/demo/empty')).toBe(
              true,
            );
        } else {
          // Ensure a successful earlier load does not skip all later copies.
          await session.execCommand({
            cmd: 'rm -f /workspace/.agents/demo/SKILL.md',
          });
        }
        expect(await readFile(victim, 'utf8')).toBe('host marker');
        expect((await stat(victim)).mode & 0o777).toBe(0o640);
      }
      if (race) {
        await session.execCommand({ cmd: 'touch /workspace/stop-swaps' });
        await expect.poll(() => session.pathExists('swaps-done')).toBe(true);
        expect(
          Number(
            Buffer.from(
              await session.readFile({ path: 'swaps-done' }),
            ).toString(),
          ),
        ).toBeGreaterThan(0);
      }
      await session.close();
      cleanupContainerIds.delete(session.state.containerId);
    },
    DOCKER_TEST_TIMEOUT_MS,
  );

  (dockerAvailable &&
    typeof process.getuid === 'function' &&
    process.getuid() !== 0
    ? it
    : it.skip)(
    'cannot load a skill over files protected from the sandbox and SDK user',
    async () => {
      rootDir = await mkdtemp(
        join(process.cwd(), '.docker-skill-permissions-'),
      );
      await mkdir(join(rootDir, 'demo'));
      await writeFile(join(rootDir, 'demo', 'SKILL.md'), 'Configured skill');
      await writeFile(join(rootDir, 'demo', 'protected.txt'), 'Replacement');
      const session = await new DockerSandboxClient({
        image: DOCKER_TEST_IMAGE,
      }).create(new Manifest());
      const cid = session.state.containerId;
      cleanupContainerIds.add(cid);
      try {
        expect(
          spawnSync('docker', [
            'exec',
            '-u',
            '0',
            cid,
            'python3',
            '-c',
            "import os;os.makedirs('/workspace/.agents/demo',exist_ok=True);open('/workspace/.agents/demo/protected.txt','w').write('Protected');os.chmod('/workspace/.agents/demo',0o755);os.chmod('/workspace/.agents/demo/protected.txt',0o644)",
          ]).status,
        ).toBe(0);
        const target = join(
          session.state.workspaceRootPath,
          '.agents/demo/protected.txt',
        );
        await expect(writeFile(target, 'SDK write')).rejects.toMatchObject({
          code: 'EACCES',
        });
        expect(
          spawnSync('docker', [
            'exec',
            cid,
            'python3',
            '-c',
            "open('/workspace/.agents/demo/protected.txt','w').write('Agent write')",
          ]).status,
        ).not.toBe(0);
        const load = skills({
          lazyFrom: {
            source: { type: 'local_dir', src: rootDir },
            index: [{ name: 'demo', description: 'Configured skill' }],
          },
        })
          .bind(session)
          .tools()
          .find((tool) => tool.name === 'load_skill');
        if (!load || load.type !== 'function')
          throw new Error('Missing load_skill');
        const previousManifest = session.state.manifest;
        const result = await load.invoke(
          new RunContext(),
          JSON.stringify({ skill_name: 'demo' }),
        );
        expect(result).not.toMatchObject({ status: 'loaded' });
        expect(await readFile(target, 'utf8')).toBe('Protected');
        await expect(
          stat(join(session.state.workspaceRootPath, '.agents/demo/SKILL.md')),
        ).rejects.toMatchObject({ code: 'ENOENT' });
        expect(session.state.manifest).toBe(previousManifest);
      } finally {
        expect(
          spawnSync('docker', [
            'exec',
            '-u',
            '0',
            cid,
            'chown',
            '-R',
            session.state.defaultUser!,
            '/workspace',
          ]).status,
        ).toBe(0);
        await session.close();
        cleanupContainerIds.delete(cid);
      }
    },
    DOCKER_TEST_TIMEOUT_MS,
  );

  itIfDocker(
    'materializes a nested Git repository with executable files and links',
    async () => {
      rootDir = await mkdtemp(join(process.cwd(), '.docker-git-source-'));
      await writeFile(join(rootDir, 'run.sh'), 'echo configured script\n');
      await chmod(join(rootDir, 'run.sh'), 0o755);
      await symlink('run.sh', join(rootDir, 'run-link'));
      for (const args of [
        ['init'],
        ['add', '.'],
        [
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.invalid',
          'commit',
          '-m',
          'source',
        ],
      ])
        expect(spawnSync('git', ['-C', rootDir, ...args]).status).toBe(0);
      const session = await new DockerSandboxClient({
        image: DOCKER_TEST_IMAGE,
      }).create(new Manifest());
      cleanupContainerIds.add(session.state.containerId);
      const entry: Entry = {
        type: 'dir',
        children: {
          app: { type: 'git_repo', repo: `file://${rootDir}` },
        },
      };
      await session.materializeEntry({ path: 'skill', entry });
      const copied = join(session.state.workspaceRootPath, 'skill/app');
      expect(await readFile(join(copied, 'run.sh'), 'utf8')).toBe(
        'echo configured script\n',
      );
      expect((await stat(join(copied, 'run.sh'))).mode & 0o111).toBe(0o111);
      expect((await lstat(join(copied, 'run-link'))).isSymbolicLink()).toBe(
        true,
      );
      expect(await readlink(join(copied, 'run-link'))).toBe('run.sh');
      const manifest = session.state.manifest;
      await expect(
        session.materializeEntry({ path: 'skill', entry }),
      ).rejects.toThrow('git_repo destination must be an empty directory');
      expect(session.state.manifest).toBe(manifest);
      await session.close();
      cleanupContainerIds.delete(session.state.containerId);
    },
    DOCKER_TEST_TIMEOUT_MS,
  );

  itIfDocker(
    'updates a writable skill file without needing to delete it',
    async () => {
      const uid = process.getuid?.();
      const gid = process.getgid?.();
      if (uid === undefined || gid === undefined || uid === 0) return;
      rootDir = await mkdtemp(join(process.cwd(), '.docker-writable-source-'));
      await mkdir(join(rootDir, 'nested'));
      await writeFile(join(rootDir, 'nested/value'), 'configured');
      const session = await new DockerSandboxClient({
        image: DOCKER_TEST_IMAGE,
      }).create(new Manifest());
      cleanupContainerIds.add(session.state.containerId);
      const destination = join(
        session.state.workspaceRootPath,
        'skill/nested/value',
      );
      try {
        const setup = spawnSync('docker', [
          'exec',
          '-u',
          '0',
          session.state.containerId,
          'python3',
          '-c',
          `import os;os.makedirs('/workspace/skill/nested');os.chown('/workspace/skill',${uid},${gid});os.chmod('/workspace/skill/nested',0o755);open('/workspace/skill/nested/value','w').write('old');os.chmod('/workspace/skill/nested/value',0o666)`,
        ]);
        expect(setup.status).toBe(0);
        const before = await stat(destination);
        await writeFile(destination, 'SDK write');
        const direct = spawnSync('docker', [
          'exec',
          '-u',
          `${uid}:${gid}`,
          session.state.containerId,
          'python3',
          '-c',
          "open('/workspace/skill/nested/value','w').write('Agent write')",
        ]);
        expect(direct.status).toBe(0);
        await session.materializeEntry({
          path: 'skill',
          entry: { type: 'local_dir', src: rootDir },
        });
        expect(await readFile(destination, 'utf8')).toBe('configured');
        const after = await stat(destination);
        expect(after.uid).toBe(before.uid);
        expect(after.mode & 0o777).toBe(0o666);
      } finally {
        spawnSync('docker', [
          'exec',
          '-u',
          '0',
          session.state.containerId,
          'chown',
          '-R',
          `${uid}:${gid}`,
          '/workspace/skill',
        ]);
        await session.close();
        cleanupContainerIds.delete(session.state.containerId);
      }
    },
    DOCKER_TEST_TIMEOUT_MS,
  );

  itIfDocker(
    'applies restrictive directory modes after its child permissions',
    async () => {
      const session = await new DockerSandboxClient({
        image: DOCKER_TEST_IMAGE,
      }).create(new Manifest());
      cleanupContainerIds.add(session.state.containerId);
      const destination = join(session.state.workspaceRootPath, 'locked');
      try {
        await session.materializeEntry({
          path: 'locked',
          entry: {
            type: 'dir',
            permissions: 0o400,
            children: {
              value: {
                type: 'file',
                permissions: 0o600,
                content: 'configured',
              },
            },
          },
        });
        expect((await stat(destination)).mode & 0o777).toBe(0o400);
        await chmod(destination, 0o700);
        expect((await stat(join(destination, 'value'))).mode & 0o777).toBe(
          0o600,
        );
        expect(await readFile(join(destination, 'value'), 'utf8')).toBe(
          'configured',
        );
      } finally {
        await chmod(destination, 0o700).catch(() => {});
        await session.close();
        cleanupContainerIds.delete(session.state.containerId);
      }
    },
    DOCKER_TEST_TIMEOUT_MS,
  );

  itIfDocker(
    'keeps Git preparation private and retains modes when merging Git resources',
    async () => {
      rootDir = await mkdtemp(join(process.cwd(), '.docker-git-modes-'));
      const repo = join(rootDir, 'repo');
      const scratch = join(rootDir, 'scratch');
      await mkdir(join(repo, 'assets/child'), { recursive: true });
      await mkdir(scratch);
      await writeFile(join(repo, 'assets/child/value'), 'configured');
      for (const args of [
        ['init'],
        ['add', '.'],
        [
          '-c',
          'user.name=Test',
          '-c',
          'user.email=test@example.invalid',
          'commit',
          '-m',
          'source',
        ],
      ]) {
        expect(spawnSync('git', ['-C', repo, ...args]).status).toBe(0);
      }
      const ref = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
      }).stdout.trim();
      const session = await new DockerSandboxClient({
        image: DOCKER_TEST_IMAGE,
      }).create(
        new Manifest({
          entries: {
            scratch: {
              type: 'mount',
              source: scratch,
              mountPath: '/scratch',
              readOnly: false,
              mountStrategy: { type: 'local_bind' },
            },
          },
        }),
      );
      cleanupContainerIds.add(session.state.containerId);
      const originalTmp = process.env.TMPDIR;
      try {
        for (const variant of ['subpath', 'commit'] as const) {
          const destination = join(session.state.workspaceRootPath, variant);
          const child = join(
            destination,
            variant === 'subpath' ? 'child' : 'assets/child',
          );
          await mkdir(child, { recursive: true });
          await chmod(child, 0o700);
          await writeFile(join(child, 'value'), 'old', { mode: 0o600 });
          await session.materializeEntry({
            path: variant,
            entry: {
              type: 'git_repo',
              repo: `file://${repo}`,
              ...(variant === 'subpath' ? { subpath: 'assets' } : { ref }),
            },
          });
          expect((await stat(child)).mode & 0o777).toBe(0o700);
          expect((await stat(join(child, 'value'))).mode & 0o777).toBe(0o600);
          expect(await readFile(join(child, 'value'), 'utf8')).toBe(
            'configured',
          );
        }
        // A shared TMPDIR cannot own a trusted Git checkout, even for matching UIDs.
        process.env.TMPDIR = scratch;
        const manifest = session.state.manifest;
        await expect(
          session.materializeEntry({
            path: 'unsafe',
            entry: {
              type: 'dir',
              children: {
                repo: { type: 'git_repo', repo: `file://${repo}`, ref },
              },
            },
          }),
        ).rejects.toThrow('temporary directory outside the sandbox mounts');
        expect(await readdir(scratch)).toEqual([]);
        expect(session.state.manifest).toBe(manifest);
        // Inline resources need no private checkout and continue to work.
        await session.materializeEntry({
          path: 'inline',
          entry: { type: 'file', content: 'configured' },
        });
        expect(
          await readFile(
            join(session.state.workspaceRootPath, 'inline'),
            'utf8',
          ),
        ).toBe('configured');
      } finally {
        if (originalTmp === undefined) delete process.env.TMPDIR;
        else process.env.TMPDIR = originalTmp;
        await session.close();
        cleanupContainerIds.delete(session.state.containerId);
      }
    },
    DOCKER_TEST_TIMEOUT_MS,
  );

  it(
    'rejects custom command mount credential exposure before Docker side effects',
    async () => {
      rootDir = await mkdtemp(
        join(tmpdir(), 'agents-core-docker-sandbox-test-'),
      );
      const client = new DockerSandboxClient({
        workspaceBaseDir: rootDir,
        image: DOCKER_TEST_IMAGE,
      });
      await expect(
        client.create(
          new Manifest({
            entries: {
              mounted: {
                type: 'mount',
                source: 'memory://initial',
                mountStrategy: inContainerMountStrategy({
                  pattern: {
                    type: 'fuse',
                    command: 'custom-mount',
                  },
                }),
              },
            },
          }).withInContainerMountCredentialExposureAcknowledged('mounted'),
        ),
      ).rejects.toThrow(/SDK-supported strategy/u);
    },
    DOCKER_TEST_TIMEOUT_MS,
  );

  itIfDocker(
    'runs workspace commands, apply_patch, view_image, interactive stdin, and restore via snapshot',
    async () => {
      rootDir = await mkdtemp(
        join(tmpdir(), 'agents-core-docker-sandbox-test-'),
      );
      const client = new DockerSandboxClient({
        workspaceBaseDir: rootDir,
        image: DOCKER_TEST_IMAGE,
      });
      const session = await client.create(
        new Manifest({
          entries: {
            'notes.txt': {
              type: 'file',
              content: 'hello docker\n',
            },
            'pixel.png': {
              type: 'file',
              content: ONE_BY_ONE_PNG,
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
      cleanupContainerIds.add(session.state.containerId);

      const output = await session.execCommand({
        cmd: 'cat notes.txt',
      });

      expect(output).toContain('Process exited with code 0');
      expect(output).toContain('hello docker');

      await session.applyManifest(
        new Manifest({
          environment: {
            TOKEN: 'updated',
            EXTRA: 'present',
          },
        }),
      );
      const envOutput = await session.execCommand({
        cmd: 'printf "%s:%s\\n" "$TOKEN" "$EXTRA"',
      });
      expect(envOutput).toContain('updated:present');

      await session.createEditor().updateFile({
        type: 'update_file',
        path: 'notes.txt',
        diff: '@@\n-hello docker\n+after\n',
      });

      const patchedOutput = await session.execCommand({
        cmd: 'cat notes.txt',
      });
      const image = await session.viewImage({
        path: 'pixel.png',
      });

      expect(patchedOutput).toContain('after');
      expect(image).toMatchObject({
        type: 'image',
        image: {
          data: expect.any(Uint8Array),
          mediaType: 'image/png',
        },
      });

      const started = await session.execCommand({
        cmd: 'printf "ready\\n"; read value; printf "%s\\n" "$value"',
        tty: true,
        yieldTimeMs: 0,
      });
      const sessionId = Number(
        started.match(/Process running with session ID (\d+)/)?.[1],
      );
      await waitForOutputContaining(
        {
          writeStdin: (args) => session.writeStdin(args),
        },
        sessionId,
        'ready',
      );
      const finished = await writeUntilExit(
        {
          writeStdin: (args) => session.writeStdin(args),
        },
        sessionId,
        'hello stdin\n',
      );

      expect(started).toContain('Process running with session ID');
      expect(finished).toContain('Process exited with code 0');
      expect(finished).toContain('hello stdin');

      const serialized = await client.serializeSessionState(session.state);

      removeDockerContainer(session.state.containerId);
      cleanupContainerIds.delete(session.state.containerId);

      const reattached = await client.resume(
        await client.deserializeSessionState(serialized),
      );
      cleanupContainerIds.add(reattached.state.containerId);
      const resumedOutput = await reattached.execCommand({
        cmd: 'cat notes.txt',
      });

      expect(resumedOutput).toContain('after');

      const priorWorkspaceRoot = reattached.state.workspaceRootPath;
      removeDockerContainer(reattached.state.containerId);
      cleanupContainerIds.delete(reattached.state.containerId);
      await rm(priorWorkspaceRoot, { recursive: true, force: true });

      const restored = await client.resume(
        await client.deserializeSessionState(serialized),
      );
      cleanupContainerIds.add(restored.state.containerId);
      const restoredOutput = await restored.execCommand({
        cmd: 'cat notes.txt',
      });

      expect(restored.state.workspaceRootPath).not.toBe(priorWorkspaceRoot);
      expect(restored.state.snapshotSpec).toEqual({
        type: 'local',
        baseDir: rootDir,
      });
      expect(restoredOutput).toContain('after');
    },
    DOCKER_TEST_TIMEOUT_MS,
  );

  itIfDocker.each(['local', 'remote'] as const)(
    'reapplies manifest sticky intent during %s snapshot recovery',
    async (type) => {
      rootDir = await mkdtemp(
        join(tmpdir(), 'agents-core-docker-sticky-test-'),
      );
      const client = new DockerSandboxClient({
        workspaceBaseDir: rootDir,
        image: DOCKER_TEST_IMAGE,
        snapshot:
          type === 'local'
            ? { type, baseDir: rootDir }
            : { type, store: new InMemoryRemoteSnapshotStore() },
      });
      const session = await client.create(
        new Manifest({
          users: [{ name: 'sticky-user' }],
          entries: {
            '.': { type: 'dir', permissions: 'drwxrwxrwt' },
            shared: {
              type: 'dir',
              permissions: 'drwxrwxrwt',
              children: {
                'value.txt': { type: 'file', content: 'original' },
              },
            },
            deleted: { type: 'dir', permissions: 'drwxrwxrwt' },
            replaced: {
              type: 'dir',
              children: {
                nested: { type: 'dir', permissions: 'drwxrwxrwt' },
              },
            },
            ordinary: { type: 'dir', permissions: 0o777 },
          },
        }),
      );
      cleanupContainerIds.add(session.state.containerId);
      const workspace = session.state.workspaceRootPath;
      await chmod(join(workspace, 'shared'), 0o777);
      await writeFile(join(workspace, 'shared/value.txt'), 'snapshot contents');
      await rm(join(workspace, 'deleted'), { recursive: true });
      await rm(join(workspace, 'replaced'), { recursive: true });
      await writeFile(join(workspace, 'replaced'), 'now a file');
      const serialized = JSON.parse(
        JSON.stringify(await client.serializeSessionState(session.state)),
      );
      removeDockerContainer(session.state.containerId);
      cleanupContainerIds.delete(session.state.containerId);
      // Exercise both existing-workspace extraction and new-workspace extraction.
      for (const recovery of ['drifted', 'missing']) {
        if (recovery === 'drifted') {
          await writeFile(join(workspace, 'shared/value.txt'), 'drift');
        } else {
          await rm(workspace, { recursive: true, force: true });
        }
        const restored = await client.resume(
          await client.deserializeSessionState(serialized),
        );
        cleanupContainerIds.add(restored.state.containerId);
        const restoredRoot = restored.state.workspaceRootPath;
        expect((await stat(restoredRoot)).mode & 0o7777).toBe(0o1755);
        expect((await stat(join(restoredRoot, 'shared'))).mode & 0o7777).toBe(
          (0o777 & ~process.umask()) | 0o1000,
        );
        expect((await stat(join(restoredRoot, 'ordinary'))).mode & 0o7777).toBe(
          0o777 & ~process.umask(),
        );
        expect(
          await readFile(join(restoredRoot, 'shared/value.txt'), 'utf8'),
        ).toBe('snapshot contents');
        await expect(stat(join(restoredRoot, 'deleted'))).rejects.toMatchObject(
          { code: 'ENOENT' },
        );
        expect(await readFile(join(restoredRoot, 'replaced'), 'utf8')).toBe(
          'now a file',
        );
        expect(
          await restored.execCommand({ cmd: 'stat -c %a shared' }),
        ).toContain(((0o777 & ~process.umask()) | 0o1000).toString(8));
        removeDockerContainer(restored.state.containerId);
        cleanupContainerIds.delete(restored.state.containerId);
      }
    },
    DOCKER_TEST_TIMEOUT_MS,
  );

  itIfDocker(
    'keeps application environment separate from file helpers',
    async () => {
      rootDir = await mkdtemp(
        join(tmpdir(), 'agents-core-docker-environment-test-'),
      );
      const client = new DockerSandboxClient({
        workspaceBaseDir: rootDir,
        image: DOCKER_TEST_IMAGE,
      });
      const session = await client.create(
        new Manifest({
          environment: {
            PATH: '/application-only/bin',
            APP_MODE: 'application',
          },
          entries: { 'note.txt': { type: 'file', content: 'before\n' } },
        }),
      );
      cleanupContainerIds.add(session.state.containerId);
      try {
        expect(
          await session.execCommand({
            cmd: 'printf "%s:%s\\n" "$PATH" "$APP_MODE"',
            login: false,
          }),
        ).toContain('/application-only/bin:application');
        expect(
          Buffer.from(await session.readFile({ path: 'note.txt' })).toString(),
        ).toBe('before\n');
        await session.createEditor().updateFile({
          type: 'update_file',
          path: 'note.txt',
          moveTo: 'moved.txt',
          diff: '@@\n-before\n+after\n',
        });
        expect(await session.pathExists('note.txt')).toBe(false);
        expect(
          Buffer.from(await session.readFile({ path: 'moved.txt' })).toString(),
        ).toBe('after\n');
        await session.applyManifest(
          new Manifest({ environment: { APP_MODE: 'updated' } }),
        );
        expect(
          await session.runDockerMountCommand(
            '/usr/bin/printenv APP_MODE',
            'inspect mount environment',
          ),
        ).toBe('updated\n');
        await session
          .createEditor()
          .deleteFile({ type: 'delete_file', path: 'moved.txt' });
        expect(await session.listDir({ path: '.' })).toEqual([]);
      } finally {
        await session.close();
        cleanupContainerIds.delete(session.state.containerId);
      }
    },
    DOCKER_TEST_TIMEOUT_MS,
  );

  itIfDocker(
    'reuses a running container when bind mount authority is unchanged',
    async () => {
      rootDir = await mkdtemp(
        join(tmpdir(), 'agents-core-docker-sandbox-test-'),
      );
      const sharedPath = join(rootDir, 'shared');
      await mkdir(sharedPath);
      const client = new DockerSandboxClient({
        workspaceBaseDir: rootDir,
        image: DOCKER_TEST_IMAGE,
        snapshot: new NoopSnapshotSpec(),
      });
      const session = await client.create(
        new Manifest({
          extraPathGrants: [{ path: sharedPath, readOnly: true }],
        }),
      );
      cleanupContainerIds.add(session.state.containerId);
      await session.execCommand({
        cmd: 'printf retained > /tmp/container-only-state',
      });
      const serialized = await client.serializeSessionState(session.state);

      const resumed = await client.resume(
        await client.deserializeSessionState(
          JSON.parse(JSON.stringify(serialized)) as Record<string, unknown>,
        ),
      );

      expect(resumed.state.containerId).toBe(session.state.containerId);
      expect(
        await resumed.execCommand({
          cmd: 'cat /tmp/container-only-state',
        }),
      ).toContain('retained');
    },
    DOCKER_TEST_TIMEOUT_MS,
  );
});

function isDockerAvailable(): boolean {
  const result = spawnSync('docker', ['version'], {
    stdio: 'ignore',
    timeout: DOCKER_CLI_TIMEOUT_MS,
  });

  return result.status === 0;
}

function removeDockerContainer(containerId: string): void {
  spawnSync('docker', ['rm', '-f', containerId], {
    stdio: 'ignore',
    timeout: DOCKER_CLI_TIMEOUT_MS,
  });
}

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

async function waitForOutputContaining(
  session: {
    writeStdin(args: {
      sessionId: number;
      chars?: string;
      yieldTimeMs?: number;
    }): Promise<string>;
  },
  sessionId: number,
  expected: string,
): Promise<string> {
  let output = '';
  for (
    let attempt = 0;
    attempt < ACTIVE_PROCESS_MAX_POLLS && !output.includes(expected);
    attempt += 1
  ) {
    output += await session.writeStdin({
      sessionId,
      chars: '',
      yieldTimeMs: ACTIVE_PROCESS_POLL_MS,
    });
  }
  expect(output).toContain(expected);
  return output;
}
