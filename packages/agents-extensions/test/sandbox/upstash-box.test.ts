import {
  Manifest,
  SandboxProviderError,
  SandboxUnsupportedFeatureError,
} from '@openai/agents-core/sandbox';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { UpstashBoxSandboxClient } from '../../src/sandbox/upstash-box';
import { resolvedRemotePathFromValidationCommand } from './remotePathValidation';

const createMock = vi.fn();
const getMock = vi.fn();
const fromSnapshotMock = vi.fn();
const execCommandMock = vi.fn();
const filesReadMock = vi.fn();
const filesWriteMock = vi.fn();
const getPublicURLMock = vi.fn();
const pauseMock = vi.fn();
const resumeMock = vi.fn();
const deleteMock = vi.fn();
const boxConstructorMock = vi.fn();

vi.mock('@upstash/box', () => ({
  Box: class Box {
    static create = createMock;
    static get = getMock;
    static fromSnapshot = fromSnapshotMock;
    constructor(options?: Record<string, unknown>) {
      boxConstructorMock(options);
    }
  },
}));

function makeBox() {
  return {
    id: 'box-test',
    exec: { command: execCommandMock },
    files: { read: filesReadMock, write: filesWriteMock },
    getPublicURL: getPublicURLMock,
    pause: pauseMock,
    resume: resumeMock,
    delete: deleteMock,
  };
}

describe('UpstashBoxSandboxClient', () => {
  beforeEach(() => {
    createMock.mockReset();
    getMock.mockReset();
    fromSnapshotMock.mockReset();
    execCommandMock.mockReset();
    filesReadMock.mockReset();
    filesWriteMock.mockReset();
    getPublicURLMock.mockReset();
    pauseMock.mockReset();
    resumeMock.mockReset();
    deleteMock.mockReset();
    boxConstructorMock.mockReset();

    const box = makeBox();
    createMock.mockResolvedValue(box);
    getMock.mockResolvedValue(box);
    fromSnapshotMock.mockResolvedValue(box);
    execCommandMock.mockImplementation(async (command: string) => {
      const resolvedPath = resolvedRemotePathFromValidationCommand(command);
      const output = resolvedPath ? `${resolvedPath}\n` : 'README.md\n';
      return { result: output, exitCode: 0 };
    });
    filesReadMock.mockResolvedValue('# Hello\n');
    filesWriteMock.mockResolvedValue(undefined);
    getPublicURLMock.mockResolvedValue({
      url: 'https://3000-box.example.test/?token=abc',
      port: 3000,
    });
    pauseMock.mockResolvedValue(undefined);
    resumeMock.mockResolvedValue(undefined);
    deleteMock.mockResolvedValue(undefined);
  });

  test('rejects unsupported core create options instead of ignoring them', async () => {
    const client = new UpstashBoxSandboxClient();

    await expect(
      client.create({
        manifest: new Manifest(),
        snapshot: { type: 'remote' },
      }),
    ).rejects.toBeInstanceOf(SandboxUnsupportedFeatureError);
    expect(createMock).not.toHaveBeenCalled();
  });

  test('creates a box, remaps the default root, and materializes files', async () => {
    const client = new UpstashBoxSandboxClient();
    const session = await client.create(
      new Manifest({
        entries: {
          'README.md': { type: 'file', content: '# Hello\n' },
        },
      }),
    );
    const output = await session.execCommand({ cmd: 'ls' });

    expect(session.state.manifest.root).toBe('/workspace/home');
    expect(execCommandMock).toHaveBeenCalledWith(
      "mkdir -p -- '/workspace/home'",
    );
    expect(execCommandMock).toHaveBeenCalledWith("cd '/workspace/home' && ls");
    const writeCall = filesWriteMock.mock.calls.find(
      ([opts]) => opts.path === '/workspace/home/README.md',
    );
    expect(writeCall).toBeDefined();
    expect(Buffer.from(writeCall![0].content, 'base64').toString('utf8')).toBe(
      '# Hello\n',
    );
    expect(output).toContain('README.md');
  });

  test('passes UPSTASH_BOX env config through to box creation', async () => {
    const client = new UpstashBoxSandboxClient({
      apiKey: 'box-key',
      size: 'medium',
      env: { CLIENT_ENV: 'client' },
    });

    await client.create(
      new Manifest({
        environment: { SAFE: 'manifest' },
      }),
    );

    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'box-key',
        size: 'medium',
        env: { CLIENT_ENV: 'client', SAFE: 'manifest' },
      }),
    );
  });

  test('cleans up when workspace root preparation fails', async () => {
    execCommandMock.mockResolvedValueOnce({
      result: 'mkdir failed',
      exitCode: 1,
    });
    const client = new UpstashBoxSandboxClient();

    await expect(client.create(new Manifest())).rejects.toThrow(
      /failed to prepare the workspace root/,
    );
    expect(deleteMock).toHaveBeenCalledOnce();
  });

  test('rejects unsupported manifest metadata after remapping the default root', async () => {
    const client = new UpstashBoxSandboxClient();

    await expect(
      client.create(new Manifest({ extraPathGrants: [{ path: '/tmp/data' }] })),
    ).rejects.toThrow();
    expect(createMock).not.toHaveBeenCalled();
  });

  test('remaps default manifest roots when applying manifests to sessions', async () => {
    const client = new UpstashBoxSandboxClient();
    const session = await client.create(new Manifest());
    filesWriteMock.mockClear();

    await session.applyManifest(
      new Manifest({
        entries: { 'next.txt': { type: 'file', content: 'next\n' } },
      }),
    );

    const writeCall = filesWriteMock.mock.calls.find(
      ([opts]) => opts.path === '/workspace/home/next.txt',
    );
    expect(writeCall).toBeDefined();
    expect(session.state.manifest.root).toBe('/workspace/home');
  });

  test('rejects applyManifest roots that differ from the session root', async () => {
    const client = new UpstashBoxSandboxClient();
    const session = await client.create(new Manifest());
    filesWriteMock.mockClear();

    await expect(
      session.applyManifest(
        new Manifest({
          root: '/tmp',
          entries: { 'outside.txt': { type: 'file', content: 'outside\n' } },
        }),
      ),
    ).rejects.toThrow(/different root than the active session/);
    expect(filesWriteMock).not.toHaveBeenCalled();
  });

  test('uses box file APIs for editor reads and writes', async () => {
    const client = new UpstashBoxSandboxClient();
    const session = await client.create(new Manifest());
    filesReadMock.mockClear();
    filesWriteMock.mockClear();
    filesReadMock.mockResolvedValue('# Hello\n');

    await session.createEditor().updateFile({
      type: 'update_file',
      path: 'link.txt',
      diff: '-# Hello\n+# Safe\n',
    });

    expect(filesReadMock).toHaveBeenCalled();
    const writeCall = filesWriteMock.mock.calls.at(-1);
    expect(writeCall).toBeDefined();
    expect(
      Buffer.from(writeCall![0].content, 'base64').toString('utf8'),
    ).toContain('# Safe');
  });

  test('reads images through the base64 box file API', async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const client = new UpstashBoxSandboxClient();
    const session = await client.create(new Manifest());
    filesReadMock.mockReset();
    filesReadMock.mockImplementation(
      async (_path: string, options?: { encoding?: 'base64' }) =>
        options?.encoding === 'base64'
          ? pngBytes.toString('base64')
          : pngBytes.toString('binary'),
    );

    const image = await session.viewImage({ path: 'image.png' });

    expect(filesReadMock).toHaveBeenCalledWith('/workspace/home/image.png', {
      encoding: 'base64',
    });
    if (
      !image.image ||
      typeof image.image !== 'object' ||
      !('mediaType' in image.image)
    ) {
      throw new Error('Expected viewImage to return inline image data.');
    }
    expect(image.image.mediaType).toBe('image/png');
  });

  test('serializes runtime env overrides for session resume', async () => {
    const client = new UpstashBoxSandboxClient({
      env: { API_KEY: 'client-secret' },
    });
    const session = await client.create(
      new Manifest({ environment: { SAFE: 'manifest' } }),
    );

    const serialized = await client.serializeSessionState(session.state);
    const restored = await client.deserializeSessionState(serialized);

    expect(serialized.environment).toEqual({
      API_KEY: 'client-secret',
      SAFE: 'manifest',
    });
    expect(restored.environment).toEqual({
      SAFE: 'manifest',
      API_KEY: 'client-secret',
    });
    expect(serialized.boxId).toBe('box-test');
  });

  test('pauses on close when pauseOnExit is enabled and resumes by id', async () => {
    const client = new UpstashBoxSandboxClient();
    const session = await client.create(new Manifest(), { pauseOnExit: true });

    await session.close();
    await client.resume(session.state);

    expect(pauseMock).toHaveBeenCalledOnce();
    expect(getMock).toHaveBeenCalledWith('box-test', expect.anything());
    expect(resumeMock).toHaveBeenCalledOnce();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  test('delete terminates even when pauseOnExit is enabled', async () => {
    const client = new UpstashBoxSandboxClient();
    const session = await client.create(new Manifest(), { pauseOnExit: true });

    await session.delete();

    expect(pauseMock).not.toHaveBeenCalled();
    expect(deleteMock).toHaveBeenCalledOnce();
  });

  test('does not delete twice across shutdown and delete lifecycle hooks', async () => {
    const client = new UpstashBoxSandboxClient();
    const session = await client.create(new Manifest());

    await session.shutdown();
    await session.delete();

    expect(deleteMock).toHaveBeenCalledOnce();
  });

  test('preserves the box on managed cleanup when preserveOwnedSessions is set', async () => {
    const client = new UpstashBoxSandboxClient();
    const session = await client.create(new Manifest(), { pauseOnExit: true });

    const cleanupOptions = { reason: 'cleanup', preserveOwnedSessions: true };
    await session.shutdown(cleanupOptions);
    await session.delete(cleanupOptions);

    expect(pauseMock).toHaveBeenCalledOnce();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  test('tears the box down on managed cleanup without preservation', async () => {
    const client = new UpstashBoxSandboxClient();
    const session = await client.create(new Manifest(), { pauseOnExit: true });

    const cleanupOptions = { reason: 'cleanup' };
    await session.shutdown(cleanupOptions);
    await session.delete(cleanupOptions);

    expect(deleteMock).toHaveBeenCalledOnce();
    expect(pauseMock).not.toHaveBeenCalled();
  });

  test('leaves keep-alive boxes running during managed cleanup', async () => {
    const client = new UpstashBoxSandboxClient();
    const session = await client.create(new Manifest(), { keepAlive: true });

    const cleanupOptions = { reason: 'cleanup' };
    await session.shutdown(cleanupOptions);
    await session.delete(cleanupOptions);

    expect(pauseMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  test('leaves keep-alive boxes running on close', async () => {
    const client = new UpstashBoxSandboxClient();
    const session = await client.create(new Manifest(), { keepAlive: true });

    await session.close();

    expect(pauseMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  test('resolves exposed ports through public URLs', async () => {
    const client = new UpstashBoxSandboxClient();
    const session = await client.create(new Manifest(), {
      exposedPorts: [3000],
    });

    const endpoint = await session.resolveExposedPort(3000);

    expect(getPublicURLMock).toHaveBeenCalledWith(3000);
    expect(endpoint).toMatchObject({
      host: '3000-box.example.test',
      port: 443,
      tls: true,
      query: 'token=abc',
    });
  });

  test('recreates the box when resume lookup reports a missing box', async () => {
    const client = new UpstashBoxSandboxClient();
    const session = await client.create(new Manifest(), { pauseOnExit: true });
    createMock.mockClear();
    getMock.mockRejectedValueOnce(
      Object.assign(new Error('box not found'), { statusCode: 404 }),
    );

    const recreated = await client.resume(session.state);

    expect(getMock).toHaveBeenCalledWith('box-test', expect.anything());
    expect(createMock).toHaveBeenCalledOnce();
    expect(recreated.state.boxId).toBe('box-test');
  });

  test('fails fast when resume lookup fails with a provider error', async () => {
    const client = new UpstashBoxSandboxClient();
    const session = await client.create(new Manifest(), { pauseOnExit: true });
    createMock.mockClear();
    getMock.mockRejectedValueOnce(new Error('request timeout'));

    await expect(client.resume(session.state)).rejects.toBeInstanceOf(
      SandboxProviderError,
    );
    expect(createMock).not.toHaveBeenCalled();
  });

  test('creates from a snapshot when snapshotId is provided', async () => {
    const client = new UpstashBoxSandboxClient({ snapshotId: 'snap-1' });

    await client.create(new Manifest());

    expect(fromSnapshotMock).toHaveBeenCalledWith('snap-1', expect.any(Object));
    expect(createMock).not.toHaveBeenCalled();
  });
});
