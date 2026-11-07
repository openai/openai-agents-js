import { Manifest, type Entry } from '@openai/agents-core/sandbox';
import {
  DockerSandboxClient,
  DockerSandboxSession,
} from '@openai/agents/sandbox/local';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SandboxProcessResult } from '../../agents-core/src/sandbox/sandboxes/shared/runProcess';
import { Environment } from '../src/runtime/environment';
import { acquireEnvironment } from '../src/runtime/environment-source';
import { sandboxEnvironment } from '../src/runtime/sandbox-environment';

const processMocks = vi.hoisted(() => ({ runSandboxProcess: vi.fn() }));
const childProcessMocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('../../agents-core/src/sandbox/sandboxes/shared/runProcess', () => ({
  runSandboxProcess: processMocks.runSandboxProcess,
  formatSandboxProcessError: (result: SandboxProcessResult) =>
    result.stderr || result.stdout || result.error?.message || 'process failed',
}));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    // Preserve the real pipes used by inherited host file workers.
    spawn: ((command, args, options) =>
      args?.includes('-I') && args?.includes('-S')
        ? actual.spawn(command, args, options ?? {})
        : childProcessMocks.spawn(
            command,
            args,
            options,
          )) as typeof actual.spawn,
  };
});
const success = (stdout = ''): SandboxProcessResult => ({
  status: 0,
  signal: null,
  stdout,
  stderr: '',
  timedOut: false,
});
const failure = (stderr: string): SandboxProcessResult => ({
  status: 1,
  signal: null,
  stdout: '',
  stderr,
  timedOut: false,
});
function completedChild() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    kill: vi.fn(() => true),
  });
  queueMicrotask(() => {
    child.stdout.end();
    child.stderr.end();
    child.emit('close', 0, null);
  });
  return child;
}

describe('native adapter with Docker provider preparation', () => {
  let rootDir: string;
  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'agents-codex-docker-test-'));
    processMocks.runSandboxProcess.mockReset();
    childProcessMocks.spawn.mockReset();
    vi.spyOn(
      DockerSandboxSession.prototype,
      'validateContainerFilesystemPath',
    ).mockImplementation(async function (
      this: DockerSandboxSession,
      path,
      options,
    ) {
      return this.resolveContainerFilesystemPath(path, options);
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(rootDir, { recursive: true, force: true });
  });
  it.each([
    { type: 's3_mount', bucket: 'synthetic' },
    { type: 'gcs_mount', bucket: 'synthetic' },
    { type: 'r2_mount', bucket: 'synthetic', accountId: 'synthetic' },
    {
      type: 'azure_blob_mount',
      container: 'synthetic',
      account: 'synthetic',
      accountKey: 'synthetic-key',
    },
    { type: 'box_mount', path: '/', accessToken: 'synthetic-token' },
    { type: 's3_files_mount', fileSystemId: 'fs-synthetic' },
  ])(
    'native adapter uses real Docker preparation for $type (controlled Docker effects)',
    async (entry) => {
      processMocks.runSandboxProcess.mockImplementation(
        async (_command, args: string[]) => {
          if (args[0] === 'version') return success('Docker version test');
          if (args[0] === 'run') return success('container-123\n');
          if (args[0] === 'rm' || args[0] === 'volume') return success();
          return failure('unexpected Docker command');
        },
      );
      childProcessMocks.spawn.mockImplementation(() => completedChild());
      const mount = {
        ...entry,
        mountStrategy:
          entry.type === 's3_files_mount'
            ? { type: 'in_container', pattern: { type: 's3files' } }
            : { type: 'docker_volume', driver: 'rclone' },
      } as Entry;
      let manifest = new Manifest({ entries: { data: mount } });
      if (entry.type === 's3_files_mount')
        manifest =
          manifest.withInContainerMountBroadCredentialExposureAcknowledged(
            'data',
          );
      let gatewayClosed = false;
      const source = sandboxEnvironment({
        client: new DockerSandboxClient({ workspaceBaseDir: rootDir }),
        manifest,
        connect: async (sandbox) => {
          expect(sandbox.state.manifest.entries.data).toMatchObject({
            type: entry.type,
            readOnly: true,
          });
          expect(
            processMocks.runSandboxProcess.mock.calls.some(
              ([, args]) => args[0] === 'run',
            ),
          ).toBe(true);
          if (entry.type !== 's3_files_mount')
            expect(
              processMocks.runSandboxProcess.mock.calls.some(
                ([, args]) =>
                  args[0] === 'run' &&
                  args.some((arg: string) =>
                    arg.includes('volume-driver=rclone'),
                  ),
              ),
            ).toBe(true);
          return Environment.lease(
            new Environment({
              url: 'wss://controlled.invalid',
              cwd: '/workspace',
            }),
            () => {
              gatewayClosed = true;
            },
          );
        },
      });
      const owner = await acquireEnvironment(source);
      await owner.dispose();
      expect(gatewayClosed).toBe(true);
      expect(
        processMocks.runSandboxProcess.mock.calls.some(
          ([, args]) => args[0] === 'rm',
        ),
      ).toBe(true);
    },
  );
});
