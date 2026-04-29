import { mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DockerSandboxClient, Manifest } from '../../src/sandbox/local';

const ONE_BY_ONE_PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAE/wH+gZ6kWQAAAABJRU5ErkJggg==',
    'base64',
  ),
);

const DOCKER_TEST_IMAGE = 'busybox:1.36';
const DOCKER_CLI_TIMEOUT_MS = 30_000;
const DOCKER_TEST_TIMEOUT_MS = 180_000;
const dockerAvailable = isDockerAvailable();
const itIfDocker = dockerAvailable ? it : it.skip;

describe('DockerSandboxClient', () => {
  let rootDir: string;
  const cleanupContainerIds = new Set<string>();

  beforeAll(() => {
    if (!dockerAvailable) {
      console.warn(
        'Skipping Docker sandbox tests because Docker is unavailable.',
      );
    }
  });

  afterEach(async () => {
    for (const containerId of cleanupContainerIds) {
      removeDockerContainer(containerId);
    }
    cleanupContainerIds.clear();

    if (rootDir) {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  itIfDocker(
    'creates a container-backed workspace and runs commands in it',
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
          },
        }),
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
      const ttyInitialOutput = await session.execCommand({
        cmd: 'test -t 0 && printf "tty yes\\n" || printf "tty no\\n"',
        tty: true,
        yieldTimeMs: 500,
      });
      const ttySessionId = Number(
        ttyInitialOutput.match(/Process running with session ID (\d+)/)?.[1],
      );
      const ttyOutput = Number.isFinite(ttySessionId)
        ? ttyInitialOutput +
          (await writeUntilExit(
            {
              writeStdin: (args) => session.writeStdin(args),
            },
            ttySessionId,
            '',
          ))
        : ttyInitialOutput;

      expect(envOutput).toContain('updated:present');
      expect(ttyOutput).toContain('tty yes');
      expect(ttyOutput).not.toContain('tty no');
    },
    DOCKER_TEST_TIMEOUT_MS,
  );

  itIfDocker(
    'supports apply_patch, view_image, interactive stdin, and restore via snapshot',
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
              content: 'before\n',
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

      await session.createEditor().updateFile({
        type: 'update_file',
        path: 'notes.txt',
        diff: '@@\n-before\n+after\n',
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
    yieldTimeMs: 200,
  });
  let combinedOutput = output;

  for (
    let attempt = 0;
    attempt < 20 && !output.includes('Process exited with code');
    attempt += 1
  ) {
    output = await session.writeStdin({
      sessionId,
      chars: '',
      yieldTimeMs: 200,
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
    attempt < 10 && !output.includes(expected);
    attempt += 1
  ) {
    output += await session.writeStdin({
      sessionId,
      chars: '',
      yieldTimeMs: 200,
    });
  }
  expect(output).toContain(expected);
  return output;
}
