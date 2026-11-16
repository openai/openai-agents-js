import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { Manifest, type SandboxSessionLike } from '@openai/agents-core/sandbox';
import {
  CloudflareSandboxClient,
  type CloudflareSandboxSessionState,
} from '../../../agents-extensions/src/sandbox/cloudflare/sandbox';
import {
  Agent,
  Environment,
  NativeProvider,
  sandboxEnvironment,
} from '../../src';
import { ModelServer, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

let peer: Awaited<ReturnType<typeof startPublicExecutor>>;
beforeAll(async () => {
  peer = await startPublicExecutor();
});
afterAll(async () => {
  await peer?.close();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await ModelServer.closeAll();
});

it.each(['matching', 'worker', 'ports'] as const)(
  'checks no-key Cloudflare authority before native Session gateway admission: %s',
  async (change) => {
    vi.stubEnv('CLOUDFLARE_SANDBOX_API_KEY', '');
    const manifest = new Manifest({ root: peer.cwd });
    const resource: SandboxSessionLike<CloudflareSandboxSessionState> = {
      state: {
        manifest,
        sandboxId: 'synthetic',
        environment: {},
        workerUrl: 'https://worker.invalid/service',
        configuredExposedPorts: [3000],
      },
      close: vi.fn(async () => {}),
    };
    const client = new CloudflareSandboxClient({
      workerUrl:
        change === 'worker'
          ? 'https://other.invalid'
          : 'https://worker.invalid/service/',
      exposedPorts: change === 'ports' ? [] : [3000],
    });
    const connect = vi.fn(async () =>
      Environment.lease(
        new Environment({
          url: peer.url,
          headers: peer.headers,
          cwd: peer.cwd,
          tools: [],
        }),
        async () => {},
      ),
    );
    const server = new ModelServer(
      change === 'matching' ? [[message('done')]] : [],
    );
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic',
      supportsWebsockets: false,
    });
    const opening = new Agent({
      provider,
      instructions: 'Reply done.',
    }).session({
      environment: sandboxEnvironment({
        client,
        manifest,
        session: resource,
        connect,
      }),
    });
    if (change === 'matching') {
      const session = await opening;
      try {
        expect((await (await session.submit('start')).wait()).finalOutput).toBe(
          'done',
        );
      } finally {
        await session.close();
      }
      expect(connect).toHaveBeenCalledOnce();
    } else {
      await expect(opening).rejects.toThrow(/workerUrl|fresh sandbox/);
      expect(connect).not.toHaveBeenCalled();
    }
    expect(resource.close).not.toHaveBeenCalled();
    server.assertExhausted();
  },
);
