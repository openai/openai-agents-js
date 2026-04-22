import {
  Manifest,
  SandboxProviderError,
  SandboxUnsupportedFeatureError,
} from '@openai/agents-core/sandbox';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { CloudflareSandboxClient } from '../../src/sandbox/cloudflare';
import { CloudflareBucketMountStrategy } from '../../src/sandbox/cloudflare/mounts';
import { resolvedRemotePathFromValidationCommand } from './remotePathValidation';
import { makeTarArchive } from './tarFixture';

const originalFetch = global.fetch;
const originalWebSocket = globalThis.WebSocket;

function jsonResponse(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

function sseExecResponse(
  events: Array<{ event: string; data: string }>,
  options: { trailingDelimiter?: boolean; lineEnding?: '\n' | '\r\n' } = {},
): Response {
  const lineEnding = options.lineEnding ?? '\n';
  const delimiter = `${lineEnding}${lineEnding}`;
  let body = events
    .map(
      ({ event, data }) =>
        `event: ${event}${lineEnding}data: ${data}${delimiter}`,
    )
    .join('');
  if (options.trailingDelimiter === false) {
    body = body.endsWith(delimiter) ? body.slice(0, -delimiter.length) : body;
  }
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
    },
  });
}

test('Cloudflare workerd-facing source avoids static Node-only imports', async () => {
  const cloudflareSource = await readFile(
    new URL('../../src/sandbox/cloudflare/sandbox.ts', import.meta.url),
    'utf8',
  );
  const sharedIndexSource = await readFile(
    new URL('../../src/sandbox/shared/index.ts', import.meta.url),
    'utf8',
  );

  expect(cloudflareSource).not.toMatch(/from ['"]node:/u);
  expect(cloudflareSource).not.toMatch(/\bBuffer\b/u);
  expect(cloudflareSource).not.toMatch(/\bprocess\.env\b/u);
  expect(cloudflareSource).not.toMatch(
    /from ['"]\.\.\/shared\/localSources['"]/u,
  );
  expect(cloudflareSource).toMatch(
    /import\(['"]\.\.\/shared\/localSources['"]\)/u,
  );
  expect(sharedIndexSource).not.toMatch(/from ['"]node:/u);
  expect(sharedIndexSource).not.toMatch(/\bBuffer\b/u);
  expect(sharedIndexSource).not.toMatch(/\bprocess\.env\b/u);
  expect(sharedIndexSource).not.toContain('localSources');
});

describe('CloudflareSandboxClient', () => {
  beforeEach(() => {
    vi.doMock('ws', () => ({ WebSocket: TestWebSocket }));
    global.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url.endsWith('/v1/sandbox') && method === 'POST') {
        return jsonResponse({ id: 'cf_test' });
      }

      if (url.includes('/exec') && method === 'POST') {
        const payload = JSON.parse(String(init?.body)) as {
          argv?: string[];
        };
        const shellCommand = payload.argv?.[2] ?? '';
        const resolvedPath =
          resolvedRemotePathFromValidationCommand(shellCommand);

        if (resolvedPath) {
          return sseExecResponse([
            {
              event: 'stdout',
              data: Buffer.from(`${resolvedPath}\n`).toString('base64'),
            },
            { event: 'exit', data: JSON.stringify({ exit_code: 0 }) },
          ]);
        }

        if (shellCommand.includes('mkdir -p')) {
          return sseExecResponse([
            { event: 'exit', data: JSON.stringify({ exit_code: 0 }) },
          ]);
        }

        if (shellCommand.includes('ls')) {
          return sseExecResponse([
            {
              event: 'stdout',
              data: Buffer.from('README.md\n').toString('base64'),
            },
            { event: 'exit', data: JSON.stringify({ exit_code: 0 }) },
          ]);
        }

        if (shellCommand.includes('unterminated-failure')) {
          return sseExecResponse(
            [
              {
                event: 'stderr',
                data: Buffer.from('tail output\n').toString('base64'),
              },
              { event: 'exit', data: JSON.stringify({ exit_code: 7 }) },
            ],
            { trailingDelimiter: false },
          );
        }

        return sseExecResponse([
          { event: 'exit', data: JSON.stringify({ exit_code: 0 }) },
        ]);
      }

      if (url.includes('/file/workspace/README.md') && method === 'PUT') {
        return new Response(null, { status: 200 });
      }

      if (url.includes('/file/workspace/local.txt') && method === 'PUT') {
        return new Response(null, { status: 200 });
      }

      if (url.includes('/file/tmp/data/note.txt') && method === 'GET') {
        return new Response('old\n', { status: 200 });
      }

      if (url.includes('/file/tmp/data/note.txt') && method === 'PUT') {
        return new Response(null, { status: 200 });
      }

      if (url.includes('/file/workspace/README.md') && method === 'GET') {
        return new Response('# Hello\n', { status: 200 });
      }

      if (url.includes('/file/workspace/pixel.png') && method === 'GET') {
        return sseExecResponse([
          {
            event: 'metadata',
            data: JSON.stringify({ isBinary: true }),
          },
          {
            event: 'chunk',
            data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
          },
        ]);
      }

      if (url.includes('/file/workspace/commented.png') && method === 'GET') {
        return new Response(
          [
            ': keepalive',
            '',
            'event: metadata',
            `data: ${JSON.stringify({ isBinary: true })}`,
            '',
            'event: chunk',
            `data: ${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')}`,
            '',
          ].join('\n'),
          {
            status: 200,
            headers: {
              'Content-Type': 'text/event-stream',
            },
          },
        );
      }

      if (url.includes('/v1/sandbox/cf_test/persist') && method === 'POST') {
        return new Response(
          makeTarArchive([{ name: 'README.md', content: '# Hello\n' }]),
          { status: 200 },
        );
      }

      if (url.includes('/v1/sandbox/cf_test/hydrate') && method === 'POST') {
        return new Response(null, { status: 200 });
      }

      if (url.includes('/v1/sandbox/cf_test/mount') && method === 'POST') {
        return new Response(null, { status: 200 });
      }

      if (url.includes('/v1/sandbox/cf_test/unmount') && method === 'POST') {
        return new Response(null, { status: 200 });
      }

      if (url.includes('/v1/sandbox/cf_test/running') && method === 'GET') {
        return jsonResponse({ running: true });
      }

      if (url.includes('/v1/sandbox/cf_test') && method === 'GET') {
        return jsonResponse({ id: 'cf_test', status: 'running' });
      }

      if (url.includes('/v1/sandbox/cf_test') && method === 'DELETE') {
        return new Response(null, { status: 200 });
      }

      return new Response(null, { status: 404 });
    }) as typeof fetch;
  });

  afterEach(() => {
    vi.doUnmock('ws');
    global.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
    TestWebSocket.instances = [];
  });

  test('rejects unsupported core create options instead of ignoring them', async () => {
    const client = new CloudflareSandboxClient();

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
  });

  test('wraps Cloudflare create worker failures as provider errors', async () => {
    const client = new CloudflareSandboxClient();
    vi.mocked(global.fetch).mockRejectedValueOnce(
      new TypeError('network down'),
    );

    const createPromise = client.create(new Manifest(), {
      workerUrl: 'https://worker.example.com',
    });

    await expect(createPromise).rejects.toBeInstanceOf(SandboxProviderError);
    await expect(createPromise).rejects.toMatchObject({
      details: {
        provider: 'cloudflare',
        operation: 'create sandbox',
        workerUrl: 'https://worker.example.com',
        cause: 'network down',
      },
    });
  });

  test('creates a sandbox, materializes the manifest, and executes commands', async () => {
    const client = new CloudflareSandboxClient();
    const session = await client.create(
      new Manifest({
        entries: {
          'README.md': {
            type: 'file',
            content: '# Hello\n',
          },
        },
      }),
      {
        workerUrl: 'https://worker.example.com',
      },
    );

    const output = await session.execCommand({ cmd: 'ls' });

    expect(output).toContain('README.md');
    expect(session.state.sandboxId).toBe('cf_test');
    expect(global.fetch).toHaveBeenCalledWith(
      'https://worker.example.com/v1/sandbox',
      expect.objectContaining({
        method: 'POST',
      }),
    );
  });

  test('rejects invalid sandbox ids returned by create', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(
      jsonResponse({ id: '../cf_test' }),
    );
    const client = new CloudflareSandboxClient();

    await expect(
      client.create(new Manifest(), {
        workerUrl: 'https://worker.example.com',
      }),
    ).rejects.toThrow(SandboxProviderError);

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('rejects non-string sandbox ids returned by create', async () => {
    vi.mocked(global.fetch).mockResolvedValueOnce(jsonResponse({ id: 123 }));
    const client = new CloudflareSandboxClient();

    await expect(
      client.create(new Manifest(), {
        workerUrl: 'https://worker.example.com',
      }),
    ).rejects.toThrow(SandboxProviderError);

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('treats missing command exit events as failures', async () => {
    const client = new CloudflareSandboxClient();
    const session = await client.create(new Manifest(), {
      workerUrl: 'https://worker.example.com',
    });
    vi.mocked(global.fetch).mockResolvedValueOnce(
      sseExecResponse([
        {
          event: 'stdout',
          data: Buffer.from('lost exit\n').toString('base64'),
        },
      ]),
    );

    const output = await session.execCommand({ cmd: 'lost-exit' });

    expect(output).toContain('Process exited with code 1');
    expect(output).toContain('lost exit');
  });

  test('applies provider timeout bundles to Cloudflare requests', async () => {
    const client = new CloudflareSandboxClient({
      workerUrl: 'https://worker.example.com',
      timeouts: {
        execTimeoutMs: 101,
        createTimeoutMs: 202,
        requestTimeoutMs: 303,
      },
    });
    const session = await client.create(new Manifest());

    const createCall = vi
      .mocked(global.fetch)
      .mock.calls.find(([input]) => String(input).endsWith('/v1/sandbox'));
    const createInit = createCall?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(createInit?.body))).toMatchObject({
      timeoutMs: 101,
      createTimeoutMs: 202,
    });
    expect(createInit?.signal).toBeInstanceOf(AbortSignal);

    await session.execCommand({ cmd: 'ls' });
    const execCall = vi
      .mocked(global.fetch)
      .mock.calls.find(([input]) => String(input).includes('/exec'));
    const execInit = execCall?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(execInit?.body))).toMatchObject({
      timeoutMs: 101,
    });
    expect(execInit?.signal).toBeInstanceOf(AbortSignal);
  });

  test('materializes local file entries through the Node local source path', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'agents-cloudflare-test-'));
    const sourceFile = join(tempDir, 'local.txt');
    await writeFile(sourceFile, 'local source\n');
    try {
      const client = new CloudflareSandboxClient();
      await client.create(
        new Manifest({
          entries: {
            'local.txt': {
              type: 'local_file',
              src: sourceFile,
            },
          },
        }),
        {
          workerUrl: 'https://worker.example.com',
        },
      );

      expect(global.fetch).toHaveBeenCalledWith(
        'https://worker.example.com/v1/sandbox/cf_test/file/workspace/local.txt',
        expect.objectContaining({
          method: 'PUT',
          body: new TextEncoder().encode('local source\n').buffer,
        }),
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test('deletes the sandbox when manifest application fails during create', async () => {
    global.fetch = vi.fn(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url.endsWith('/v1/sandbox') && method === 'POST') {
        return jsonResponse({ id: 'cf_test' });
      }

      if (url.includes('/exec') && method === 'POST') {
        const payload = JSON.parse(String(init?.body)) as {
          argv?: string[];
        };
        const resolvedPath = resolvedRemotePathFromValidationCommand(
          payload.argv?.[2] ?? '',
        );
        if (resolvedPath) {
          return sseExecResponse([
            {
              event: 'stdout',
              data: Buffer.from(`${resolvedPath}\n`).toString('base64'),
            },
            { event: 'exit', data: JSON.stringify({ exit_code: 0 }) },
          ]);
        }
        return sseExecResponse([
          { event: 'exit', data: JSON.stringify({ exit_code: 0 }) },
        ]);
      }

      if (url.includes('/file/workspace/README.md') && method === 'PUT') {
        return new Response('write failed', { status: 500 });
      }

      if (url.includes('/v1/sandbox/cf_test') && method === 'DELETE') {
        return new Response(null, { status: 200 });
      }

      return new Response(null, { status: 404 });
    }) as typeof fetch;
    const client = new CloudflareSandboxClient();

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
        {
          workerUrl: 'https://worker.example.com',
        },
      ),
    ).rejects.toMatchObject({
      code: 'provider_error',
      details: {
        provider: 'cloudflare',
        operation: 'write file',
        status: 500,
        path: '/workspace/README.md',
      },
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'https://worker.example.com/v1/sandbox/cf_test',
      expect.objectContaining({
        method: 'DELETE',
      }),
    );
  });

  test('resolves environment before creating the remote sandbox', async () => {
    const client = new CloudflareSandboxClient({
      workerUrl: 'https://worker.example.com',
    });

    await expect(
      client.create(
        new Manifest({
          environment: {
            SECRET: {
              value: 'placeholder',
              resolve: async () => {
                throw new Error('env failed');
              },
            },
          },
        }),
      ),
    ).rejects.toThrow('env failed');

    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('wraps Cloudflare exec, read, and delete failures as provider errors', async () => {
    const client = new CloudflareSandboxClient({
      workerUrl: 'https://worker.example.com',
    });
    const session = await client.create(new Manifest());

    vi.mocked(global.fetch).mockResolvedValueOnce(
      new Response('unavailable', { status: 503 }),
    );
    await expect(session.execCommand({ cmd: 'ls' })).rejects.toMatchObject({
      code: 'provider_error',
      details: {
        provider: 'cloudflare',
        operation: 'execute command',
        status: 503,
        sandboxId: 'cf_test',
      },
    });

    vi.mocked(global.fetch)
      .mockResolvedValueOnce(
        sseExecResponse([
          {
            event: 'stdout',
            data: Buffer.from('/workspace/missing.png\n').toString('base64'),
          },
          { event: 'exit', data: JSON.stringify({ exit_code: 0 }) },
        ]),
      )
      .mockResolvedValueOnce(new Response('missing', { status: 404 }));
    await expect(
      session.viewImage({ path: 'missing.png' }),
    ).rejects.toMatchObject({
      code: 'workspace_read_not_found',
      details: {
        provider: 'cloudflare',
        status: 404,
        sandboxId: 'cf_test',
        path: '/workspace/missing.png',
      },
    });

    vi.mocked(global.fetch).mockResolvedValueOnce(
      new Response('delete failed', { status: 500 }),
    );
    await expect(session.delete()).rejects.toMatchObject({
      code: 'provider_error',
      details: {
        provider: 'cloudflare',
        operation: 'delete sandbox',
        status: 500,
        sandboxId: 'cf_test',
      },
    });
  });

  test('rejects non-workspace roots when applying manifests to sessions', async () => {
    const client = new CloudflareSandboxClient();
    const session = await client.create(new Manifest(), {
      workerUrl: 'https://worker.example.com',
    });
    vi.mocked(global.fetch).mockClear();

    await expect(
      session.applyManifest(
        new Manifest({
          root: '/tmp',
          entries: {
            'next.txt': {
              type: 'file',
              content: 'next\n',
            },
          },
        }),
      ),
    ).rejects.toThrow(
      'Cloudflare sandboxes currently require manifest.root="/workspace".',
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('fails fast when manifest directory creation exits non-zero', async () => {
    const client = new CloudflareSandboxClient({
      workerUrl: 'https://worker.example.com',
    });
    const session = await client.resume({
      manifest: new Manifest(),
      workerUrl: 'https://worker.example.com',
      sandboxId: 'cf_test',
      environment: {},
    });
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(
        sseExecResponse([
          {
            event: 'stdout',
            data: Buffer.from('/workspace/new-dir\n').toString('base64'),
          },
          { event: 'exit', data: JSON.stringify({ exit_code: 0 }) },
        ]),
      )
      .mockResolvedValueOnce(
        sseExecResponse([
          {
            event: 'stderr',
            data: Buffer.from('permission denied\n').toString('base64'),
          },
          { event: 'exit', data: JSON.stringify({ exit_code: 13 }) },
        ]),
      );

    await expect(
      session.applyManifest(
        new Manifest({
          entries: {
            'new-dir': {
              type: 'dir',
            },
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: 'provider_error',
      details: {
        provider: 'cloudflare',
        operation: 'create directory',
        path: '/workspace/new-dir',
        exitCode: 13,
        output: 'permission denied',
      },
    });
  });

  test('fails fast when file materialization parent mkdir exits non-zero', async () => {
    const client = new CloudflareSandboxClient({
      workerUrl: 'https://worker.example.com',
    });
    const session = await client.resume({
      manifest: new Manifest(),
      workerUrl: 'https://worker.example.com',
      sandboxId: 'cf_test',
      environment: {},
    });
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(
        sseExecResponse([
          {
            event: 'stdout',
            data: Buffer.from('/workspace/nested/file.txt\n').toString(
              'base64',
            ),
          },
          { event: 'exit', data: JSON.stringify({ exit_code: 0 }) },
        ]),
      )
      .mockResolvedValueOnce(
        sseExecResponse([
          {
            event: 'stderr',
            data: Buffer.from('read-only filesystem\n').toString('base64'),
          },
          { event: 'exit', data: JSON.stringify({ exit_code: 30 }) },
        ]),
      );

    await expect(
      session.applyManifest(
        new Manifest({
          entries: {
            'nested/file.txt': {
              type: 'file',
              content: 'hello\n',
            },
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: 'provider_error',
      details: {
        provider: 'cloudflare',
        operation: 'create parent directory',
        path: '/workspace/nested',
        exitCode: 30,
        output: 'read-only filesystem',
      },
    });
  });

  test('fails fast when editor mkdir exits non-zero', async () => {
    const client = new CloudflareSandboxClient({
      workerUrl: 'https://worker.example.com',
    });
    const session = await client.resume({
      manifest: new Manifest(),
      workerUrl: 'https://worker.example.com',
      sandboxId: 'cf_test',
      environment: {},
    });
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(
        sseExecResponse([
          {
            event: 'stdout',
            data: Buffer.from('/workspace/nested/file.txt\n').toString(
              'base64',
            ),
          },
          { event: 'exit', data: JSON.stringify({ exit_code: 0 }) },
        ]),
      )
      .mockResolvedValueOnce(
        sseExecResponse([
          {
            event: 'stdout',
            data: Buffer.from('/workspace/nested/file.txt\n').toString(
              'base64',
            ),
          },
          { event: 'exit', data: JSON.stringify({ exit_code: 0 }) },
        ]),
      )
      .mockResolvedValueOnce(
        sseExecResponse([
          { event: 'exit', data: JSON.stringify({ exit_code: 1 }) },
        ]),
      )
      .mockResolvedValueOnce(
        sseExecResponse([
          {
            event: 'stderr',
            data: Buffer.from('mkdir failed\n').toString('base64'),
          },
          { event: 'exit', data: JSON.stringify({ exit_code: 1 }) },
        ]),
      );

    await expect(
      session.createEditor().createFile({
        type: 'create_file',
        path: 'nested/file.txt',
        diff: '+hello\n',
      }),
    ).rejects.toMatchObject({
      code: 'provider_error',
      details: {
        provider: 'cloudflare',
        operation: 'create directory',
        path: '/workspace/nested',
        exitCode: 1,
        output: 'mkdir failed',
      },
    });
  });

  test('parses the trailing SSE frame before returning exec output', async () => {
    const client = new CloudflareSandboxClient({
      workerUrl: 'https://worker.example.com',
    });
    const session = await client.resume({
      manifest: new Manifest(),
      workerUrl: 'https://worker.example.com',
      sandboxId: 'cf_test',
      environment: {},
    });

    const output = await session.execCommand({ cmd: 'unterminated-failure' });

    expect(output).toContain('tail output');
    expect(output).toContain('Process exited with code 7');
  });

  test('parses CRLF-delimited SSE command output', async () => {
    const client = new CloudflareSandboxClient({
      workerUrl: 'https://worker.example.com',
    });
    const session = await client.resume({
      manifest: new Manifest(),
      workerUrl: 'https://worker.example.com',
      sandboxId: 'cf_test',
      environment: {},
    });
    vi.mocked(global.fetch).mockResolvedValueOnce(
      sseExecResponse(
        [
          {
            event: 'stdout',
            data: Buffer.from('crlf output\n').toString('base64'),
          },
          { event: 'exit', data: JSON.stringify({ exit_code: 0 }) },
        ],
        { lineEnding: '\r\n' },
      ),
    );

    const output = await session.execCommand({ cmd: 'crlf-output' });

    expect(output).toContain('crlf output');
    expect(output).not.toContain('Process exited with code 1');
  });

  test('decodes binary file SSE that starts with a metadata event', async () => {
    const client = new CloudflareSandboxClient({
      workerUrl: 'https://worker.example.com',
    });
    const session = await client.resume({
      manifest: new Manifest(),
      workerUrl: 'https://worker.example.com',
      sandboxId: 'cf_test',
      environment: {},
    });

    const image = await session.viewImage({ path: 'pixel.png' });
    const payload = image.image as { data: Uint8Array; mediaType?: string };

    expect(payload.mediaType).toBe('image/png');
    expect([...payload.data.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  test('decodes multiline base64 SSE binary payloads', async () => {
    const client = new CloudflareSandboxClient({
      workerUrl: 'https://worker.example.com',
    });
    const session = await client.resume({
      manifest: new Manifest(),
      workerUrl: 'https://worker.example.com',
      sandboxId: 'cf_test',
      environment: {},
    });
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(
        sseExecResponse([
          {
            event: 'stdout',
            data: Buffer.from('/workspace/multiline.png\n').toString('base64'),
          },
          { event: 'exit', data: JSON.stringify({ exit_code: 0 }) },
        ]),
      )
      .mockResolvedValueOnce(
        new Response(
          [
            'event: metadata',
            `data: ${JSON.stringify({ isBinary: true })}`,
            '',
            'event: chunk',
            'data: iVBO',
            'data: Rw==',
            '',
          ].join('\n'),
          {
            status: 200,
            headers: {
              'Content-Type': 'text/event-stream',
            },
          },
        ),
      );

    const image = await session.viewImage({ path: 'multiline.png' });
    const payload = image.image as { data: Uint8Array; mediaType?: string };

    expect(payload.mediaType).toBe('image/png');
    expect([...payload.data.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  test('returns raw SSE-like file payloads without binary metadata', async () => {
    const client = new CloudflareSandboxClient({
      workerUrl: 'https://worker.example.com',
    });
    const session = await client.resume({
      manifest: new Manifest(),
      workerUrl: 'https://worker.example.com',
      sandboxId: 'cf_test',
      environment: {},
    });
    const rawText = ['event: chunk', 'data: not base64', ''].join('\n');
    vi.mocked(global.fetch).mockResolvedValueOnce(
      new Response(rawText, {
        status: 200,
        headers: {
          'Content-Type': 'text/plain',
        },
      }),
    );
    const readFileBytes = (
      session as unknown as {
        readFileBytes(path: string): Promise<Uint8Array>;
      }
    ).readFileBytes.bind(session);

    const bytes = await readFileBytes('/workspace/sse-like.txt');

    expect(new TextDecoder().decode(bytes)).toBe(rawText);
  });

  test('decodes binary file SSE that starts with a comment frame', async () => {
    const client = new CloudflareSandboxClient({
      workerUrl: 'https://worker.example.com',
    });
    const session = await client.resume({
      manifest: new Manifest(),
      workerUrl: 'https://worker.example.com',
      sandboxId: 'cf_test',
      environment: {},
    });

    const image = await session.viewImage({ path: 'commented.png' });
    const payload = image.image as { data: Uint8Array; mediaType?: string };

    expect(payload.mediaType).toBe('image/png');
    expect([...payload.data.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  test('decodes CRLF-delimited binary file SSE', async () => {
    const client = new CloudflareSandboxClient({
      workerUrl: 'https://worker.example.com',
    });
    const session = await client.resume({
      manifest: new Manifest(),
      workerUrl: 'https://worker.example.com',
      sandboxId: 'cf_test',
      environment: {},
    });
    vi.mocked(global.fetch)
      .mockResolvedValueOnce(
        sseExecResponse([
          {
            event: 'stdout',
            data: Buffer.from('/workspace/crlf.png\n').toString('base64'),
          },
          { event: 'exit', data: JSON.stringify({ exit_code: 0 }) },
        ]),
      )
      .mockResolvedValueOnce(
        sseExecResponse(
          [
            {
              event: 'metadata',
              data: JSON.stringify({ isBinary: true }),
            },
            {
              event: 'chunk',
              data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
            },
          ],
          { lineEnding: '\r\n' },
        ),
      );

    const image = await session.viewImage({ path: 'crlf.png' });
    const payload = image.image as { data: Uint8Array; mediaType?: string };

    expect(payload.mediaType).toBe('image/png');
    expect([...payload.data.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  test('rejects unsafe environment names before building shell commands', async () => {
    const client = new CloudflareSandboxClient();
    const session = await client.create(
      new Manifest({
        environment: {
          'X; touch /tmp/pwned; #': 'bad',
        },
      }),
      {
        workerUrl: 'https://worker.example.com',
      },
    );

    await expect(session.execCommand({ cmd: 'ls' })).rejects.toThrow(
      'Invalid environment variable name',
    );
  });

  test('closes PTY sockets when command building fails before registration', async () => {
    globalThis.WebSocket =
      TestWebSocket as unknown as typeof globalThis.WebSocket;
    const client = new CloudflareSandboxClient();
    const session = await client.create(
      new Manifest({
        environment: {
          'X; touch /tmp/pwned; #': 'bad',
        },
      }),
      {
        workerUrl: 'https://worker.example.com',
      },
    );

    const startedPromise = session.execCommand({
      cmd: 'ls',
      tty: true,
      yieldTimeMs: 250,
    });
    const socket = await TestWebSocket.nextInstance();
    socket.open();
    socket.message(JSON.stringify({ type: 'ready' }));

    await expect(startedPromise).rejects.toThrow(
      'Invalid environment variable name',
    );
    expect(socket.readyState).toBe(3);
    expect(socket.sent).toHaveLength(0);
  });

  test('closes PTY sockets when initial command send fails before registration', async () => {
    globalThis.WebSocket =
      TestWebSocket as unknown as typeof globalThis.WebSocket;
    const client = new CloudflareSandboxClient({ apiKey: '' });
    const session = await client.create(new Manifest(), {
      workerUrl: 'https://worker.example.com',
    });

    const startedPromise = session.execCommand({
      cmd: 'echo ready',
      tty: true,
      yieldTimeMs: 250,
    });
    const socket = await TestWebSocket.nextInstance();
    socket.send = vi.fn(() => {
      throw new Error('send failed');
    });
    socket.open();
    socket.message(JSON.stringify({ type: 'ready' }));

    await expect(startedPromise).rejects.toThrow('send failed');
    expect(socket.readyState).toBe(3);
  });

  test('supports PTY execution and stdin through the worker websocket', async () => {
    globalThis.WebSocket =
      TestWebSocket as unknown as typeof globalThis.WebSocket;
    const client = new CloudflareSandboxClient({ apiKey: '' });
    const session = await client.create(new Manifest(), {
      workerUrl: 'https://worker.example.com',
    });

    const startedPromise = session.execCommand({
      cmd: 'echo ready',
      tty: true,
      yieldTimeMs: 250,
    });
    const socket = await TestWebSocket.nextInstance();
    const firstSend = socket.nextSend();
    socket.open();
    socket.message(JSON.stringify({ type: 'ready' }));
    await firstSend;
    socket.message(new TextEncoder().encode('ready\n'));
    const started = await startedPromise;
    const sessionId = Number(
      started.match(/Process running with session ID (\d+)/)?.[1],
    );

    const secondSend = socket.nextSend();
    const writePromise = session.writeStdin({
      sessionId,
      chars: 'echo next\n',
      yieldTimeMs: 250,
    });
    await secondSend;
    socket.message(new TextEncoder().encode('next\n'));
    socket.message(JSON.stringify({ type: 'exit', code: 0 }));
    const next = await writePromise;

    expect(socket.url).toBe(
      'wss://worker.example.com/v1/sandbox/cf_test/pty?cols=80&rows=24',
    );
    expect(new TextDecoder().decode(socket.sent[0] as Uint8Array)).toBe(
      "/bin/sh -c 'cd '\\''/workspace'\\'' && echo ready'\n",
    );
    expect(new TextDecoder().decode(socket.sent[1] as Uint8Array)).toBe(
      'echo next\n',
    );
    expect(started).toContain('ready');
    expect(next).toContain('next');
    expect(next).toContain('Process exited with code 0');
  });

  test('preserves plain-text PTY websocket frames as output', async () => {
    globalThis.WebSocket =
      TestWebSocket as unknown as typeof globalThis.WebSocket;
    const client = new CloudflareSandboxClient({ apiKey: '' });
    const session = await client.create(new Manifest(), {
      workerUrl: 'https://worker.example.com',
    });

    const startedPromise = session.execCommand({
      cmd: 'echo ready',
      tty: true,
      yieldTimeMs: 250,
    });
    const socket = await TestWebSocket.nextInstance();
    const firstSend = socket.nextSend();
    socket.open();
    socket.message(JSON.stringify({ type: 'ready' }));
    await firstSend;
    socket.message('plain text output\n');
    const started = await startedPromise;

    expect(started).toContain('plain text output');
    expect(started).toContain('Process running with session ID');
  });

  test('rejects PTY error control frames before ready', async () => {
    globalThis.WebSocket =
      TestWebSocket as unknown as typeof globalThis.WebSocket;
    const client = new CloudflareSandboxClient({ apiKey: '' });
    const session = await client.create(new Manifest(), {
      workerUrl: 'https://worker.example.com',
    });

    const startedPromise = session.execCommand({
      cmd: 'echo ready',
      tty: true,
      yieldTimeMs: 250,
    });
    const socket = await TestWebSocket.nextInstance();
    socket.open();
    socket.message(JSON.stringify({ type: 'error', message: 'pty disabled' }));

    await expect(startedPromise).rejects.toThrow(
      'CloudflareSandboxClient PTY failed before ready: pty disabled',
    );
    expect(socket.sent).toHaveLength(0);
  });

  test('captures binary PTY frames before the ready handshake completes', async () => {
    globalThis.WebSocket =
      TestWebSocket as unknown as typeof globalThis.WebSocket;
    const client = new CloudflareSandboxClient({ apiKey: '' });
    const session = await client.create(new Manifest(), {
      workerUrl: 'https://worker.example.com',
    });

    const startedPromise = session.execCommand({
      cmd: 'echo ready',
      tty: true,
      yieldTimeMs: 250,
    });
    const socket = await TestWebSocket.nextInstance();
    const firstSend = socket.nextSend();
    socket.open();
    socket.message(new TextEncoder().encode('boot output\n'));
    socket.message(JSON.stringify({ type: 'ready' }));
    await firstSend;
    const started = await startedPromise;

    expect(started).toContain('boot output');
    expect(started).toContain('Process running with session ID');
  });

  test('parses PTY control messages delivered as binary websocket frames', async () => {
    globalThis.WebSocket =
      TestWebSocket as unknown as typeof globalThis.WebSocket;
    const client = new CloudflareSandboxClient({ apiKey: '' });
    const session = await client.create(new Manifest(), {
      workerUrl: 'https://worker.example.com',
    });

    const startedPromise = session.execCommand({
      cmd: 'exit 7',
      tty: true,
      yieldTimeMs: 250,
    });
    const socket = await TestWebSocket.nextInstance();
    const firstSend = socket.nextSend();
    socket.open();
    socket.message(JSON.stringify({ type: 'ready' }));
    await firstSend;
    socket.message(Buffer.from(JSON.stringify({ type: 'exit', code: 7 })));
    const started = await startedPromise;

    expect(started).toContain('Process exited with code 7');
  });

  test('passes PTY auth through WebSocket headers for native runtimes', async () => {
    globalThis.WebSocket =
      TestWebSocket as unknown as typeof globalThis.WebSocket;
    const client = new CloudflareSandboxClient({ apiKey: 'secret-token' });
    const session = await client.create(new Manifest(), {
      workerUrl: 'https://worker.example.com',
    });

    const startedPromise = session.execCommand({
      cmd: 'echo ready',
      tty: true,
      yieldTimeMs: 250,
    });
    const socket = await TestWebSocket.nextInstance();
    const firstSend = socket.nextSend();
    socket.open();
    socket.message(JSON.stringify({ type: 'ready' }));
    await firstSend;
    socket.message(JSON.stringify({ type: 'exit', code: 0 }));
    const started = await startedPromise;
    const socketUrl = new URL(socket.url);

    expect(socketUrl.searchParams.has('authorization')).toBe(false);
    expect(socketUrl.searchParams.get('cols')).toBe('80');
    expect(socketUrl.searchParams.get('rows')).toBe('24');
    expect(socket.options?.headers).toEqual({
      Authorization: 'Bearer secret-token',
    });
    expect(started).toContain('Process exited with code 0');
  });

  test('preserves PTY exit codes after the worker websocket closes', async () => {
    globalThis.WebSocket =
      TestWebSocket as unknown as typeof globalThis.WebSocket;
    const client = new CloudflareSandboxClient({ apiKey: '' });
    const session = await client.create(new Manifest(), {
      workerUrl: 'https://worker.example.com',
    });

    const startedPromise = session.execCommand({
      cmd: 'echo ready',
      tty: true,
      yieldTimeMs: 250,
    });
    const socket = await TestWebSocket.nextInstance();
    const firstSend = socket.nextSend();
    socket.open();
    socket.message(JSON.stringify({ type: 'ready' }));
    await firstSend;
    socket.message(JSON.stringify({ type: 'exit', code: 0 }));
    socket.close();
    const started = await startedPromise;

    expect(started).toContain('Process exited with code 0');
    expect(started).not.toContain('Process exited with code 1');
  });

  test('does not clobber PTY exit codes on websocket errors after exit', async () => {
    globalThis.WebSocket =
      TestWebSocket as unknown as typeof globalThis.WebSocket;
    const client = new CloudflareSandboxClient({ apiKey: '' });
    const session = await client.create(new Manifest(), {
      workerUrl: 'https://worker.example.com',
    });

    const startedPromise = session.execCommand({
      cmd: 'echo ready',
      tty: true,
      yieldTimeMs: 250,
    });
    const socket = await TestWebSocket.nextInstance();
    const firstSend = socket.nextSend();
    socket.open();
    socket.message(JSON.stringify({ type: 'ready' }));
    await firstSend;
    socket.message(JSON.stringify({ type: 'exit', code: 0 }));
    socket.error();
    const started = await startedPromise;

    expect(started).toContain('Process exited with code 0');
    expect(started).not.toContain('Process exited with code 1');
  });

  test('honors workdir and environment for PTY execution', async () => {
    globalThis.WebSocket =
      TestWebSocket as unknown as typeof globalThis.WebSocket;
    const client = new CloudflareSandboxClient({ apiKey: '' });
    const session = await client.create(
      new Manifest({
        environment: {
          NODE_ENV: 'test',
        },
      }),
      {
        workerUrl: 'https://worker.example.com',
      },
    );

    const startedPromise = session.execCommand({
      cmd: 'npm test',
      workdir: 'app',
      tty: true,
      yieldTimeMs: 250,
    });
    const socket = await TestWebSocket.nextInstance();
    const firstSend = socket.nextSend();
    socket.open();
    socket.message(JSON.stringify({ type: 'ready' }));
    await firstSend;
    socket.message(JSON.stringify({ type: 'exit', code: 0 }));
    await startedPromise;

    expect(new TextDecoder().decode(socket.sent[0] as Uint8Array)).toBe(
      "/bin/sh -c 'cd '\\''/workspace/app'\\'' && export NODE_ENV='\\''test'\\'' && npm test'\n",
    );
  });

  test('resumes from serialized state and deletes on close', async () => {
    const client = new CloudflareSandboxClient({
      workerUrl: 'https://worker.example.com',
    });
    const session = await client.resume({
      manifest: new Manifest(),
      workerUrl: 'https://worker.example.com',
      sandboxId: 'cf_test',
      environment: {},
    });

    await session.close();

    expect(global.fetch).toHaveBeenCalledWith(
      'https://worker.example.com/v1/sandbox/cf_test',
      expect.objectContaining({
        method: 'DELETE',
      }),
    );
  });

  test('requires a sandbox id when resuming from serialized state', async () => {
    const client = new CloudflareSandboxClient({
      workerUrl: 'https://worker.example.com',
    });

    await expect(
      client.resume({
        manifest: new Manifest(),
        workerUrl: 'https://worker.example.com',
        sandboxId: '',
        environment: {},
      }),
    ).rejects.toThrow(
      'Cloudflare sandbox resume requires a persisted sandboxId.',
    );
  });

  test('requires a safe sandbox id when resuming from serialized state', async () => {
    const client = new CloudflareSandboxClient({
      workerUrl: 'https://worker.example.com',
    });

    await expect(
      client.resume({
        manifest: new Manifest(),
        workerUrl: 'https://worker.example.com',
        sandboxId: '../cf_test',
        environment: {},
      }),
    ).rejects.toThrow(
      'Cloudflare sandbox persisted sandboxId must be a safe path segment.',
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('requires a string sandbox id when resuming from serialized state', async () => {
    const client = new CloudflareSandboxClient({
      workerUrl: 'https://worker.example.com',
    });

    await expect(
      client.resume({
        manifest: new Manifest(),
        workerUrl: 'https://worker.example.com',
        sandboxId: 123 as unknown as string,
        environment: {},
      }),
    ).rejects.toThrow(
      'Cloudflare sandbox persisted sandboxId must be a safe path segment.',
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('requires an absolute worker URL when resuming serialized state', async () => {
    const client = new CloudflareSandboxClient({
      workerUrl: 'https://worker.example.com',
    });

    await expect(
      client.resume({
        manifest: new Manifest(),
        workerUrl: '/relative-worker',
        sandboxId: 'cf_test',
        environment: {},
      }),
    ).rejects.toThrow(
      'Cloudflare sandbox persisted workerUrl must be an absolute http(s) URL.',
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('rejects invalid manifests when resuming serialized state', async () => {
    const client = new CloudflareSandboxClient({
      workerUrl: 'https://worker.example.com',
    });

    await expect(
      client.resume({
        manifest: new Manifest({ root: '/tmp' }),
        workerUrl: 'https://worker.example.com',
        sandboxId: 'cf_test',
        environment: {},
      }),
    ).rejects.toThrow(
      'Cloudflare sandboxes currently require manifest.root="/workspace".',
    );
    expect(global.fetch).not.toHaveBeenCalled();

    await expect(
      client.resume({
        manifest: new Manifest({
          entries: {
            data: {
              type: 's3_mount',
              bucket: 'logs',
              region: 'us-east-1',
              accessKeyId: 'access-key',
              secretAccessKey: 'secret-key',
            },
          },
        }),
        workerUrl: 'https://worker.example.com',
        sandboxId: 'cf_test',
        environment: {},
      }),
    ).rejects.toBeInstanceOf(SandboxUnsupportedFeatureError);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('rejects stale sandboxes during resume before commands run', async () => {
    const client = new CloudflareSandboxClient({
      workerUrl: 'https://worker.example.com',
    });

    await expect(
      client.resume({
        manifest: new Manifest(),
        workerUrl: 'https://worker.example.com',
        sandboxId: 'cf_stale',
        environment: {},
      }),
    ).rejects.toThrow('Cloudflare sandbox cf_stale is no longer running.');

    expect(global.fetch).toHaveBeenCalledWith(
      'https://worker.example.com/v1/sandbox/cf_stale/running',
      expect.objectContaining({
        method: 'GET',
      }),
    );
    expect(global.fetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/v1/sandbox/cf_stale/exec'),
      expect.anything(),
    );
  });

  test('wraps Cloudflare running lookup failures during resume as provider errors', async () => {
    const client = new CloudflareSandboxClient({
      workerUrl: 'https://worker.example.com',
    });
    vi.mocked(global.fetch).mockResolvedValueOnce(
      new Response(null, { status: 503 }),
    );

    const resumePromise = client.resume({
      manifest: new Manifest(),
      workerUrl: 'https://worker.example.com',
      sandboxId: 'cf_test',
      environment: {},
    });

    await expect(resumePromise).rejects.toBeInstanceOf(SandboxProviderError);
    await expect(resumePromise).rejects.toMatchObject({
      details: {
        provider: 'cloudflare',
        operation: 'check running state',
        sandboxId: 'cf_test',
        status: 503,
      },
    });
  });

  test('checks running state through the worker status endpoint', async () => {
    const client = new CloudflareSandboxClient({
      workerUrl: 'https://worker.example.com',
    });
    const session = await client.resume({
      manifest: new Manifest(),
      workerUrl: 'https://worker.example.com',
      sandboxId: 'cf_test',
      environment: {},
    });

    await expect(session.running()).resolves.toBe(true);

    expect(global.fetch).toHaveBeenCalledWith(
      'https://worker.example.com/v1/sandbox/cf_test/running',
      expect.objectContaining({
        method: 'GET',
      }),
    );
  });

  test('persists and hydrates workspaces through worker archive endpoints', async () => {
    const client = new CloudflareSandboxClient({
      workerUrl: 'https://worker.example.com',
    });
    const session = await client.resume({
      manifest: new Manifest({
        entries: {
          'tmp.txt': {
            type: 'file',
            content: 'tmp',
            ephemeral: true,
          },
        },
      }),
      workerUrl: 'https://worker.example.com',
      sandboxId: 'cf_test',
      environment: {},
    });

    const archive = await session.persistWorkspace();
    await session.hydrateWorkspace(archive);

    expect(global.fetch).toHaveBeenCalledWith(
      'https://worker.example.com/v1/sandbox/cf_test/persist?excludes=tmp.txt',
      expect.objectContaining({
        method: 'POST',
      }),
    );
    expect(global.fetch).toHaveBeenCalledWith(
      'https://worker.example.com/v1/sandbox/cf_test/hydrate',
      expect.objectContaining({
        method: 'POST',
        body: expect.any(ArrayBuffer),
      }),
    );
  });

  test('rejects unsupported manifest metadata during resume', async () => {
    const client = new CloudflareSandboxClient({
      workerUrl: 'https://worker.example.com',
    });

    await expect(
      client.resume({
        manifest: new Manifest({
          extraPathGrants: [{ path: '/tmp/data' }],
        }),
        workerUrl: 'https://worker.example.com',
        sandboxId: 'cf_test',
        environment: {},
      }),
    ).rejects.toBeInstanceOf(SandboxUnsupportedFeatureError);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('reports configured exposed ports as unsupported until worker resolution exists', async () => {
    const client = new CloudflareSandboxClient();
    const session = await client.create(new Manifest(), {
      workerUrl: 'https://worker.example.com',
      exposedPorts: [3000],
    });

    await expect(session.resolveExposedPort(3000)).rejects.toBeInstanceOf(
      SandboxUnsupportedFeatureError,
    );
    expect(global.fetch).toHaveBeenCalledWith(
      'https://worker.example.com/v1/sandbox',
      expect.objectContaining({
        body: JSON.stringify({ exposedPorts: [3000] }),
      }),
    );
  });

  test('mounts Cloudflare bucket entries through worker endpoints', async () => {
    const client = new CloudflareSandboxClient({
      workerUrl: 'https://worker.example.com',
    });
    await client.create(
      new Manifest({
        entries: {
          data: {
            type: 's3_mount',
            bucket: 'logs',
            prefix: '2026/04',
            region: 'us-east-1',
            accessKeyId: 'access-key',
            secretAccessKey: 'secret-key',
            mountPath: 'mounted/logs',
            mountStrategy: new CloudflareBucketMountStrategy(),
          },
        },
      }),
    );

    expect(global.fetch).toHaveBeenCalledWith(
      'https://worker.example.com/v1/sandbox/cf_test/mount',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          bucket: 'logs',
          mountPath: '/workspace/mounted/logs',
          options: {
            endpoint: 'https://s3.us-east-1.amazonaws.com',
            provider: 's3',
            readOnly: true,
            prefix: '/2026/04/',
            credentials: {
              accessKeyId: 'access-key',
              secretAccessKey: 'secret-key',
            },
          },
        }),
      }),
    );
  });

  test('forwards Cloudflare bucket provider hints for R2 custom domains', async () => {
    const client = new CloudflareSandboxClient({
      workerUrl: 'https://worker.example.com',
    });
    await client.create(
      new Manifest({
        entries: {
          data: {
            type: 'r2_mount',
            bucket: 'logs',
            customDomain: 'https://logs.example.com',
            mountPath: 'mounted/logs',
            mountStrategy: new CloudflareBucketMountStrategy(),
          },
        },
      }),
    );

    expect(global.fetch).toHaveBeenCalledWith(
      'https://worker.example.com/v1/sandbox/cf_test/mount',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          bucket: 'logs',
          mountPath: '/workspace/mounted/logs',
          options: {
            endpoint: 'https://logs.example.com',
            provider: 'r2',
            readOnly: true,
          },
        }),
      }),
    );
  });
});

class TestWebSocket {
  static instances: TestWebSocket[] = [];
  private static instanceWaiters: Array<(socket: TestWebSocket) => void> = [];
  readonly sent: Array<string | Uint8Array | ArrayBuffer> = [];
  readyState = 0;
  binaryType = '';
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  private sendWaiters: Array<
    (data: string | Uint8Array | ArrayBuffer) => void
  > = [];

  constructor(
    readonly url: string,
    readonly options?: { headers?: Record<string, string> },
  ) {
    TestWebSocket.instances.push(this);
    const waiter = TestWebSocket.instanceWaiters.shift();
    waiter?.(this);
  }

  static async nextInstance(): Promise<TestWebSocket> {
    const existing = TestWebSocket.instances.at(-1);
    if (existing) {
      return existing;
    }
    return await new Promise((resolve) => {
      TestWebSocket.instanceWaiters.push(resolve);
    });
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string | Uint8Array | ArrayBuffer): void {
    this.sent.push(data);
    const waiter = this.sendWaiters.shift();
    waiter?.(data);
  }

  close(): void {
    if (this.readyState === 3) {
      return;
    }
    this.readyState = 3;
    this.dispatch('close', {});
  }

  error(): void {
    this.dispatch('error', {});
  }

  open(): void {
    this.readyState = 1;
    this.dispatch('open', {});
  }

  message(data: unknown): void {
    this.dispatch('message', { data });
  }

  async nextSend(): Promise<string | Uint8Array | ArrayBuffer> {
    return await new Promise((resolve) => {
      this.sendWaiters.push(resolve);
    });
  }

  private dispatch(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}
