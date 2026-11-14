import { afterEach, describe, expect, it, vi } from 'vitest';
import { Manifest, type SandboxSessionLike } from '@openai/agents-core/sandbox';
import {
  CloudflareSandboxClient,
  type CloudflareSandboxClientOptions,
  type CloudflareSandboxSessionState,
} from '../../agents-extensions/src/sandbox/cloudflare/sandbox';
import { Environment, sandboxEnvironment } from '../src';
import { acquireEnvironment } from '../src/runtime/environment-source';

afterEach(() => vi.unstubAllEnvs());

function fixture() {
  const manifest = new Manifest({ root: '/workspace' });
  const state: CloudflareSandboxSessionState = {
    manifest,
    workerUrl: 'https://worker.invalid/service',
    sandboxId: 'synthetic',
    environment: {},
    configuredExposedPorts: [3000, 8080],
  };
  const resource: SandboxSessionLike<CloudflareSandboxSessionState> = {
    state,
    close: vi.fn(async () => {}),
  };
  return { manifest, state, resource };
}

describe('current Cloudflare worker and port authority', () => {
  for (const configuration of ['constructor', 'call'] as const) {
    for (const apiKey of [undefined, 'synthetic-secret']) {
      it.each(['matching', 'omitted', 'worker', 'revoked', 'ports'] as const)(
        `${configuration} ${apiKey ? 'key' : 'no-key'} borrowed: %s`,
        async (change) => {
          vi.stubEnv('CLOUDFLARE_SANDBOX_API_KEY', '');
          const { manifest, resource } = fixture();
          const options: CloudflareSandboxClientOptions = {
            workerUrl:
              change === 'worker'
                ? 'https://other-worker.invalid/service'
                : 'https://worker.invalid/service/',
            ...(apiKey === undefined ? {} : { apiKey }),
            ...(change === 'omitted'
              ? {}
              : {
                  exposedPorts:
                    change === 'revoked'
                      ? []
                      : change === 'ports'
                        ? [4000]
                        : [8080, 3000, 8080],
                }),
          };
          const client = new CloudflareSandboxClient(
            configuration === 'constructor' ? options : {},
          );
          const connect = vi.fn(async () =>
            Environment.lease(
              new Environment({
                url: 'wss://fixture.invalid',
                cwd: manifest.root,
              }),
              async () => {},
            ),
          );
          const source = sandboxEnvironment({
            client,
            manifest,
            session: resource,
            connect,
            ...(configuration === 'call' ? { options } : {}),
          });
          if (change === 'matching' || change === 'omitted') {
            const owner = await acquireEnvironment(source);
            await owner.dispose();
            expect(connect).toHaveBeenCalledOnce();
          } else {
            await expect(acquireEnvironment(source)).rejects.toThrow(
              /workerUrl|fresh sandbox/,
            );
            expect(connect).not.toHaveBeenCalled();
          }
          expect(resource.close).not.toHaveBeenCalled();
        },
      );
    }
  }

  it.each(['worker', 'ports'] as const)(
    'refuses no-key explicit resume drift before provider IO: %s',
    async (change) => {
      vi.stubEnv('CLOUDFLARE_SANDBOX_API_KEY', '');
      const { state } = fixture();
      const fetch = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('Unexpected IO'));
      try {
        await expect(
          new CloudflareSandboxClient({
            workerUrl:
              change === 'worker' ? 'https://other.invalid' : state.workerUrl,
            exposedPorts: change === 'ports' ? [] : [8080, 3000],
          }).resume(state),
        ).rejects.toThrow(/workerUrl|fresh sandbox/);
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        fetch.mockRestore();
      }
    },
  );

  it('preserves fresh-only portable resume without gateway or provider IO', async () => {
    const { manifest, state } = fixture();
    const client = new CloudflareSandboxClient({
      workerUrl: state.workerUrl,
      exposedPorts: [3000, 8080],
    });
    const connect = vi.fn();
    const resume = vi.spyOn(client, 'resume');
    await expect(
      acquireEnvironment(
        sandboxEnvironment({
          client,
          manifest,
          connect,
          authorizedResumeState: { backendId: 'cloudflare', state },
        }),
      ),
    ).rejects.toThrow(/fresh resource creation/);
    expect(connect).not.toHaveBeenCalled();
    expect(resume).not.toHaveBeenCalled();
  });

  it('keeps preserved owner reuse within the current worker and explicit ports', () => {
    const { state } = fixture();
    const client = new CloudflareSandboxClient({ workerUrl: state.workerUrl });
    expect(client.canReusePreservedOwnedSession(state)).toBe(true);
    expect(
      client.canReusePreservedOwnedSession(state, {
        clientOptions: { workerUrl: 'https://other.invalid' },
      }),
    ).toBe(false);
    expect(
      client.canReusePreservedOwnedSession(state, {
        clientOptions: { workerUrl: state.workerUrl, exposedPorts: [] },
      }),
    ).toBe(false);
  });
});
