import { ModalSandboxClient } from '../../agents-extensions/src/sandbox/modal';
import { expect, it, vi } from 'vitest';
import { Manifest, type SandboxClient } from '@openai/agents-core/sandbox';
import { DockerSandboxClient } from '@openai/agents/sandbox/local';
import { E2BSandboxClient } from '../../agents-extensions/src/sandbox/e2b';
import { DaytonaSandboxClient } from '../../agents-extensions/src/sandbox/daytona';
import { BlaxelSandboxClient } from '../../agents-extensions/src/sandbox/blaxel';
import { sandboxEnvironment } from '../src/runtime/sandbox-environment';
import { acquireEnvironment } from '../src/runtime/environment-source';

it.each([
  ['e2b', () => new E2BSandboxClient()],
  ['daytona', () => new DaytonaSandboxClient()],
  ['blaxel', () => new BlaxelSandboxClient()],
] as const)(
  'adapter reaches real %s preflight and rejects unsupported strategies before gateway effects',
  async (_name, client) => {
    const connect = vi.fn();
    const source = sandboxEnvironment({
      client: client() as SandboxClient,
      connect,
      manifest: {
        entries: {
          data: {
            type: 's3_mount',
            bucket: 'synthetic',
            mountStrategy: { type: 'docker_volume' },
          },
        },
      },
    });
    await expect(acquireEnvironment(source)).rejects.toThrow(/supports/);
    expect(connect).not.toHaveBeenCalled();
  },
);

it('rejects an unsafe readonly host bind plus privileged mount before Docker effects', async () => {
  const connect = vi.fn();
  const manifest = new Manifest({
    extraPathGrants: [{ path: '/data', hostPath: '/tmp', readOnly: true }],
    entries: {
      data: {
        type: 's3_files_mount',
        fileSystemId: 'fs-synthetic',
        mountStrategy: { type: 'in_container', pattern: { type: 's3files' } },
      },
    },
  }).withInContainerMountBroadCredentialExposureAcknowledged('data');
  await expect(
    acquireEnvironment(
      sandboxEnvironment({
        client: new DockerSandboxClient(),
        manifest,
        connect,
      }),
    ),
  ).rejects.toThrow(/read-only host binds cannot be combined/);
  expect(connect).not.toHaveBeenCalled();
});

it('keeps invalid mount errors and their serializable details free of credential values', async () => {
  const secret = 'synthetic-private-secret-sentinel';
  const manifest = new Manifest({
    entries: {
      data: {
        type: 'r2_mount',
        bucket: 'synthetic',
        accountId: '',
        accessKeyId: 'synthetic-id',
        secretAccessKey: secret,
        mountStrategy: { type: 'modal_cloud_bucket' },
      },
    },
  });
  delete (manifest.entries.data as { accountId?: string }).accountId;
  const connect = vi.fn();
  const error = await acquireEnvironment(
    sandboxEnvironment({
      client: new ModalSandboxClient({ appName: 'synthetic' }),
      manifest,
      connect,
    }),
  ).catch((error) => error);
  expect(error).toBeInstanceOf(Error);
  expect(error.message).toMatch(/accountId/);
  const serialized = JSON.stringify(
    Object.fromEntries(
      Object.getOwnPropertyNames(error).map((key) => [key, error[key]]),
    ),
  );
  expect(serialized).not.toContain(secret);
  expect(serialized).not.toContain('synthetic-id');
  expect(connect).not.toHaveBeenCalled();
});
