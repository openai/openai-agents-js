import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DockerSandboxClient,
  inContainerMountStrategy,
  Manifest,
  NoopSnapshotSpec,
  ProcessEnvValue,
} from '../../src/sandbox/local';

const ONE_BY_ONE_PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAE/wH+gZ6kWQAAAABJRU5ErkJggg==',
    'base64',
  ),
);

const DOCKER_TEST_IMAGE = 'busybox:1.36';
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
    'delivers protected values to workloads without persisting them in the container environment',
    async () => {
      rootDir = await mkdtemp(
        join(tmpdir(), 'agents-core-docker-sandbox-test-'),
      );
      process.env.AGENTS_TEST_DOCKER_PROCESS_SOURCE =
        'docker-protected-environment-sentinel';
      process.env.AGENTS_TEST_DOCKER_LARGE_PROCESS_SOURCE = 'x'.repeat(8192);
      const client = new DockerSandboxClient({
        workspaceBaseDir: rootDir,
        image: DOCKER_TEST_IMAGE,
        processEnvironmentBindings: {
          SANDBOX_TOKEN: 'AGENTS_TEST_DOCKER_PROCESS_SOURCE',
          LARGE_TOKEN: 'AGENTS_TEST_DOCKER_LARGE_PROCESS_SOURCE',
        },
      });
      try {
        const session = await client.create(
          new Manifest({
            environment: {
              SANDBOX_TOKEN: new ProcessEnvValue({
                name: 'AGENTS_TEST_DOCKER_PROCESS_SOURCE',
              }),
              LARGE_TOKEN: new ProcessEnvValue({
                name: 'AGENTS_TEST_DOCKER_LARGE_PROCESS_SOURCE',
              }),
            },
          }),
        );
        cleanupContainerIds.add(session.state.containerId);

        const environment = await session.exec({ cmd: 'env' });
        const ttyEnvironment = await session.exec({
          cmd: 'printf %s "$SANDBOX_TOKEN"',
          tty: true,
        });
        const started = await session.execCommand({
          cmd: 'printf "%s:%s:ready\\n" "$SANDBOX_TOKEN" "${#LARGE_TOKEN}"; read value; printf "%s\\n" "$value"',
          tty: true,
          yieldTimeMs: 0,
        });
        const sessionId = Number(
          started.match(/Process running with session ID (\d+)/)?.[1],
        );
        const finished = await writeUntilExit(
          { writeStdin: (args) => session.writeStdin(args) },
          sessionId,
          'protected stdin remains available\n',
        );
        const controlStarted = await session.execCommand({
          cmd: 'while :; do sleep 1; done',
          tty: true,
          yieldTimeMs: 0,
        });
        const controlSessionId = Number(
          controlStarted.match(/Process running with session ID (\d+)/)?.[1],
        );
        const controlFinished = await writeUntilExit(
          { writeStdin: (args) => session.writeStdin(args) },
          controlSessionId,
          '\u0003',
        );
        const initEnvironment = await session.exec({
          cmd: "tr '\\000' '\\n' < /proc/1/environ",
        });
        expect(environment.stdout).toContain(
          'docker-protected-environment-sentinel',
        );
        expect(ttyEnvironment.stdout).toContain(
          'docker-protected-environment-sentinel',
        );
        expect(ttyEnvironment.stdout).not.toContain(
          Buffer.from(
            "export 'SANDBOX_TOKEN=docker-protected-environment-sentinel'",
          ).toString('base64'),
        );
        expect(finished).toContain('protected stdin remains available');
        expect(controlFinished).toContain('Process exited with code');
        expect(initEnvironment.stdout).not.toContain(
          'docker-protected-environment-sentinel',
        );
      } finally {
        delete process.env.AGENTS_TEST_DOCKER_PROCESS_SOURCE;
        delete process.env.AGENTS_TEST_DOCKER_LARGE_PROCESS_SOURCE;
      }
    },
    DOCKER_TEST_TIMEOUT_MS,
  );

  itIfDocker(
    'restores TTY state before starting a workload with a protected PATH',
    async () => {
      rootDir = await mkdtemp(
        join(tmpdir(), 'agents-core-docker-sandbox-test-'),
      );
      process.env.AGENTS_TEST_DOCKER_PATH_SOURCE = '/does-not-exist';
      process.env.AGENTS_TEST_DOCKER_STTY_COMMAND_SOURCE = 'command-value';
      process.env.AGENTS_TEST_DOCKER_STTY_STATE_SOURCE = 'state-value';
      const client = new DockerSandboxClient({
        workspaceBaseDir: rootDir,
        image: DOCKER_TEST_IMAGE,
        processEnvironmentBindings: {
          PATH: 'AGENTS_TEST_DOCKER_PATH_SOURCE',
          protected_stty_command: 'AGENTS_TEST_DOCKER_STTY_COMMAND_SOURCE',
          protected_stty_state: 'AGENTS_TEST_DOCKER_STTY_STATE_SOURCE',
        },
      });
      try {
        const session = await client.create(
          new Manifest({
            environment: {
              PATH: new ProcessEnvValue({
                name: 'AGENTS_TEST_DOCKER_PATH_SOURCE',
              }),
              protected_stty_command: new ProcessEnvValue({
                name: 'AGENTS_TEST_DOCKER_STTY_COMMAND_SOURCE',
              }),
              protected_stty_state: new ProcessEnvValue({
                name: 'AGENTS_TEST_DOCKER_STTY_STATE_SOURCE',
              }),
            },
          }),
        );
        cleanupContainerIds.add(session.state.containerId);

        const result = await session.exec({
          cmd: 'printf "%s:%s:%s" protected-path-workload-started "$protected_stty_command" "$protected_stty_state"',
          tty: true,
        });

        expect(result.stdout).toContain(
          'protected-path-workload-started:command-value:state-value',
        );
      } finally {
        delete process.env.AGENTS_TEST_DOCKER_PATH_SOURCE;
        delete process.env.AGENTS_TEST_DOCKER_STTY_COMMAND_SOURCE;
        delete process.env.AGENTS_TEST_DOCKER_STTY_STATE_SOURCE;
      }
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
