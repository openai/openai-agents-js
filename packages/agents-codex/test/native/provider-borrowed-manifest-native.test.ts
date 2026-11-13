import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { Agent, Environment, NativeProvider } from '../../src';
import { Manifest, sandboxEnvironment } from '@openai/agents/sandbox';
import { UnixLocalSandboxClient } from '@openai/agents/sandbox/local';
import { ModelServer, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';
const nativeIt = it.skipIf(process.platform === 'win32');
let peer: Awaited<ReturnType<typeof startPublicExecutor>>;
beforeAll(async () => {
  peer = await startPublicExecutor();
});
afterAll(async () => {
  await peer?.close();
});
afterEach(() => ModelServer.closeAll());
async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic',
    supportsWebsockets: false,
  });
}
nativeIt(
  'has been adding borrowed files before native execution and retaining caller ownership',
  async () => {
    const client = new UnixLocalSandboxClient();
    const selected = await client.create({
      manifest: new Manifest({
        entries: { 'old.txt': { type: 'file', content: 'old' } },
      }),
    });
    const root = selected.state.workspaceRootPath as string;
    const server = new ModelServer([[message('done')]]);
    try {
      const target = new Manifest({
        root: selected.state.manifest.root,
        entries: {
          'old.txt': { type: 'file', content: 'old' },
          'added.txt': { type: 'file', content: 'addition' },
        },
      });
      const source = sandboxEnvironment({
        client,
        session: selected,
        manifest: target,
        connect: async (sandbox) => {
          expect(sandbox).toBe(selected);
          expect(await readFile(root + '/added.txt', 'utf8')).toBe('addition');
          return Environment.lease(
            new Environment({
              url: peer.url,
              headers: peer.headers,
              cwd: root,
              tools: [],
            }),
            () => {},
          );
        },
      });
      await using provider = await providerFor(server);
      const session = await new Agent({
        instructions: 'Use the workspace.',
        provider,
      }).session({ environment: source });
      try {
        expect((await (await session.submit('start')).wait()).finalOutput).toBe(
          'done',
        );
      } finally {
        await session.close();
      }
      expect(await readFile(root + '/old.txt', 'utf8')).toBe('old');
      expect(selected.state.manifest.entries['added.txt']).toEqual(
        target.entries['added.txt'],
      );
      server.assertExhausted();
    } finally {
      await selected.close();
    }
  },
);
nativeIt(
  'has been rejecting borrowed file replacement before gateway admission',
  async () => {
    const client = new UnixLocalSandboxClient();
    const selected = await client.create({
      manifest: new Manifest({
        entries: { 'old.txt': { type: 'file', content: 'old' } },
      }),
    });
    const root = selected.state.workspaceRootPath as string;
    const server = new ModelServer([]);
    const connect = vi.fn(async () => {
      throw new Error('Unexpected gateway');
    });
    try {
      const target = new Manifest({
        root: selected.state.manifest.root,
        entries: { 'old.txt': { type: 'file', content: 'replacement' } },
      });
      await using provider = await providerFor(server);
      await expect(
        new Agent({ instructions: 'Use the workspace.', provider }).session({
          environment: sandboxEnvironment({
            client,
            session: selected,
            manifest: target,
            connect,
          }),
        }),
      ).rejects.toThrow();
      expect(connect).not.toHaveBeenCalled();
      expect(await readFile(root + '/old.txt', 'utf8')).toBe('old');
      server.assertExhausted();
    } finally {
      await selected.close();
    }
  },
);
nativeIt(
  'has been retaining the original manifest after provider materialization failure',
  async () => {
    const client = new UnixLocalSandboxClient();
    const selected = await client.create({
      manifest: new Manifest({
        entries: { 'old.txt': { type: 'file', content: 'old' } },
      }),
    });
    const original = selected.state.manifest;
    const root = selected.state.workspaceRootPath as string;
    const server = new ModelServer([]);
    const connect = vi.fn(async () => {
      throw new Error('Unexpected gateway');
    });
    try {
      vi.spyOn(selected, 'applyManifest').mockRejectedValueOnce(
        new Error('Provider materialization failed'),
      );
      const target = new Manifest({
        root: original.root,
        entries: {
          'old.txt': { type: 'file', content: 'old' },
          'added.txt': { type: 'file', content: 'addition' },
        },
      });
      await using provider = await providerFor(server);
      await expect(
        new Agent({ instructions: 'Use the workspace.', provider }).session({
          environment: sandboxEnvironment({
            client,
            session: selected,
            manifest: target,
            connect,
          }),
        }),
      ).rejects.toThrow('Provider materialization failed');
      expect(connect).not.toHaveBeenCalled();
      expect(selected.state.manifest).toBe(original);
      expect(await readFile(root + '/old.txt', 'utf8')).toBe('old');
      server.assertExhausted();
    } finally {
      await selected.close();
    }
  },
);
