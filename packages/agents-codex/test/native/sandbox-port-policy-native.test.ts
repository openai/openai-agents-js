import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import {
  Manifest,
  sandboxEnvironment,
  type SandboxClient,
  type SandboxClientOptions,
  type SandboxSessionLike,
  type SandboxSessionState,
} from '@openai/agents/sandbox';
import { BlaxelSandboxClient } from '../../../agents-extensions/src/sandbox/blaxel';
import { ModalSandboxClient } from '../../../agents-extensions/src/sandbox/modal';
import { Agent, Environment, NativeProvider } from '../../src';
import { startPublicExecutor } from './fixtures/public-executor';

let peer: Awaited<ReturnType<typeof startPublicExecutor>>;
beforeAll(async () => {
  peer = await startPublicExecutor();
});
afterAll(async () => {
  await peer.close();
});

function fixture(
  provider: 'blaxel' | 'modal',
  optionSource: 'constructor' | 'per-call',
  changedPolicy: boolean,
) {
  const options: SandboxClientOptions =
    provider === 'blaxel'
      ? { exposedPortPublic: false }
      : { appName: 'synthetic-app', exposedPorts: [] };
  const client: SandboxClient =
    provider === 'blaxel'
      ? new BlaxelSandboxClient(optionSource === 'constructor' ? options : {})
      : new ModalSandboxClient(optionSource === 'constructor' ? options : {});
  const state: SandboxSessionState = {
    manifest: new Manifest({ root: process.cwd() }),
    environment: {},
    ownsSandbox: false,
    ...(provider === 'blaxel'
      ? {
          sandboxName: 'synthetic-sandbox',
          pauseOnExit: false,
          exposedPortPublic: changedPolicy,
        }
      : {
          sandboxId: 'synthetic-sandbox',
          appName: 'synthetic-app',
          imageTag: 'synthetic-image',
          workspacePersistence: 'tar',
          configuredExposedPorts: changedPolicy ? [3000] : [],
        }),
  };
  const resource: SandboxSessionLike = { state, close: vi.fn() };
  const resume = vi.fn(async () => resource);
  // Keep provider I/O observable without contacting either cloud provider.
  client.resume = resume;
  client.delete = vi.fn();
  return {
    client,
    state,
    resource,
    resume,
    options: optionSource === 'per-call' ? options : undefined,
  };
}

for (const provider of ['blaxel', 'modal'] as const) {
  for (const reuse of ['resume', 'borrowed'] as const) {
    it.each(['constructor', 'per-call'] as const)(
      `rejects changed ${provider} port policy before native ${reuse} effects (%s)`,
      async (optionSource) => {
        const f = fixture(provider, optionSource, true);
        const connect = vi.fn(async () => {
          throw new Error('Connection was admitted before current port policy');
        });
        await using model = new NativeProvider({
          apiKey: 'synthetic-port-policy',
          baseUrl: 'http://127.0.0.1:1/v1',
          supportsWebsockets: false,
        });
        const agent = new Agent({
          provider: model,
          instructions: 'Reply briefly.',
        });
        const opening = agent.session({
          environment: sandboxEnvironment({
            client: f.client,
            options: f.options,
            manifest: new Manifest({ root: process.cwd() }),
            ...(reuse === 'resume'
              ? {
                  authorizedResumeState: {
                    backendId: provider,
                    state: f.state,
                  },
                }
              : { session: f.resource }),
            connect,
          }),
        });
        await expect(opening).rejects.toThrow(
          'require a fresh sandbox session',
        );
        expect(f.resume).not.toHaveBeenCalled();
        expect(connect).not.toHaveBeenCalled();
        expect(f.resource.close).not.toHaveBeenCalled();
        expect(f.client.delete).not.toHaveBeenCalled();
        expect(f.state.exposedPortPublic).toBe(
          provider === 'blaxel' ? true : undefined,
        );
        expect(f.state.configuredExposedPorts).toEqual(
          provider === 'modal' ? [3000] : undefined,
        );
      },
    );

    it(`keeps unchanged ${provider} policy usable through native ${reuse}`, async () => {
      const f = fixture(provider, 'constructor', false);
      const connect = vi.fn(async () => {
        return Environment.lease(
          new Environment({
            url: peer.url,
            headers: peer.headers,
            cwd: process.cwd(),
            tools: [],
          }),
          async () => {},
        );
      });
      await using model = new NativeProvider({
        apiKey: 'synthetic-port-policy',
        baseUrl: 'http://127.0.0.1:1/v1',
        supportsWebsockets: false,
      });
      const agent = new Agent({
        provider: model,
        instructions: 'Reply briefly.',
      });
      const session = await agent.session({
        environment: sandboxEnvironment({
          client: f.client,
          manifest: new Manifest({ root: process.cwd() }),
          ...(reuse === 'resume'
            ? { authorizedResumeState: { backendId: provider, state: f.state } }
            : { session: f.resource }),
          connect,
        }),
      });
      await session.close();
      expect(connect).toHaveBeenCalledOnce();
      expect(f.resume).toHaveBeenCalledTimes(reuse === 'resume' ? 1 : 0);
      expect(f.resource.close).toHaveBeenCalledTimes(
        reuse === 'resume' ? 1 : 0,
      );
      expect(f.client.delete).toHaveBeenCalledTimes(reuse === 'resume' ? 1 : 0);
    });
  }
}
