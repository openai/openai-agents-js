import { describe, expect, it, vi } from 'vitest';
import { Manifest, type SandboxSessionLike } from '@openai/agents-core/sandbox';
import {
  E2BSandboxClient,
  type E2BSandboxSessionState,
} from '../../agents-extensions/src/sandbox/e2b/sandbox';
import {
  VercelSandboxClient,
  type VercelSandboxSessionState,
} from '../../agents-extensions/src/sandbox/vercel/sandbox';
import { Environment, sandboxEnvironment } from '../src';
import { acquireEnvironment } from '../src/runtime/environment-source';

describe('current remote provider network authority', () => {
  for (const backend of ['e2b', 'vercel'] as const) {
    for (const lifecycle of ['borrowed', 'resume'] as const) {
      for (const configuration of ['constructor', 'call'] as const) {
        it.each(['matching', 'network', 'ports'] as const)(
          `${backend} ${lifecycle} ${configuration} policy: %s`,
          async (change) => {
            const root = backend === 'vercel' ? '/vercel/sandbox' : '/trusted';
            const manifest = new Manifest({ root });
            const policy = { allow: ['trusted.invalid'] };
            const configuredExposedPorts = change === 'ports' ? [3000] : [];
            const options =
              backend === 'e2b'
                ? { allowInternetAccess: false, exposedPorts: [] }
                : { networkPolicy: policy, exposedPorts: [] };
            const state =
              backend === 'e2b'
                ? ({
                    manifest,
                    sandboxId: 'synthetic',
                    sandboxType: 'e2b' as const,
                    pauseOnExit: false,
                    environment: {},
                    configuredExposedPorts,
                    allowInternetAccess: change === 'network',
                  } satisfies E2BSandboxSessionState)
                : ({
                    manifest,
                    sandboxId: 'synthetic',
                    workspacePersistence: 'tar' as const,
                    environment: {},
                    configuredExposedPorts,
                    networkPolicy: change === 'network' ? undefined : policy,
                  } satisfies VercelSandboxSessionState);
            const client =
              backend === 'e2b'
                ? new E2BSandboxClient(
                    configuration === 'constructor' ? options : {},
                  )
                : new VercelSandboxClient(
                    configuration === 'constructor' ? options : {},
                  );
            const resource: SandboxSessionLike = {
              state,
              close: vi.fn(async () => {}),
            };
            const resume = vi
              .spyOn(client, 'resume')
              .mockResolvedValue(resource as never);
            const create = vi
              .spyOn(client, 'create')
              .mockRejectedValue(new Error('Unexpected provider creation'));
            const connect = vi.fn(async () =>
              Environment.lease(
                new Environment({ url: 'wss://fixture.invalid', cwd: root }),
                async () => {},
              ),
            );
            const source = sandboxEnvironment({
              client: client as E2BSandboxClient,
              manifest,
              connect,
              ...(configuration === 'call' ? { options } : {}),
              ...(lifecycle === 'borrowed'
                ? {
                    session:
                      resource as SandboxSessionLike<E2BSandboxSessionState>,
                  }
                : {
                    authorizedResumeState: {
                      backendId: backend,
                      state: state as E2BSandboxSessionState,
                    },
                  }),
            });
            if (change === 'matching') {
              const owner = await acquireEnvironment(source);
              await owner.dispose();
              expect(connect).toHaveBeenCalledOnce();
              expect(resume).toHaveBeenCalledTimes(
                lifecycle === 'resume' ? 1 : 0,
              );
            } else {
              await expect(acquireEnvironment(source)).rejects.toThrow(
                'networking options',
              );
              expect(connect).not.toHaveBeenCalled();
              expect(resume).not.toHaveBeenCalled();
              expect(resource.close).not.toHaveBeenCalled();
            }
            expect(create).not.toHaveBeenCalled();
          },
        );
      }
    }
  }
});
