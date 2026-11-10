import { describe, expect, it, vi } from 'vitest';
import { Manifest, type SandboxSessionLike } from '@openai/agents-core/sandbox';
import {
  DaytonaSandboxClient,
  type DaytonaSandboxSessionState,
} from '../../agents-extensions/src/sandbox/daytona/sandbox';
import {
  ModalSandboxClient,
  type ModalSandboxSessionState,
} from '../../agents-extensions/src/sandbox/modal/sandbox';
import { Environment, sandboxEnvironment } from '../src';
import { acquireEnvironment } from '../src/runtime/environment-source';

describe('current Daytona and Modal port authority', () => {
  for (const backend of ['daytona', 'modal'] as const) {
    for (const lifecycle of (backend === 'modal'
      ? ['borrowed']
      : ['borrowed', 'resume']) as ('borrowed' | 'resume')[]) {
      for (const configuration of ['constructor', 'call'] as const) {
        it.each(['matching', 'revoked', 'changed'] as const)(
          `${backend} ${lifecycle} ${configuration}: %s`,
          async (change) => {
            const root =
              backend === 'daytona' ? '/home/daytona/workspace' : '/workspace';
            const manifest = new Manifest({ root });
            const options = {
              exposedPorts:
                change === 'matching'
                  ? [8080, 3000]
                  : change === 'revoked'
                    ? []
                    : [4000],
            };
            const state =
              backend === 'daytona'
                ? ({
                    manifest,
                    sandboxId: 'synthetic',
                    environment: {},
                    pauseOnExit: false,
                    configuredExposedPorts:
                      change === 'matching' ? [3000, 8080] : [3000],
                  } satisfies DaytonaSandboxSessionState)
                : ({
                    manifest,
                    sandboxId: 'synthetic',
                    appName: 'synthetic',
                    imageTag: 'synthetic',
                    workspacePersistence: 'tar',
                    environment: {},
                    useSleepCmd: false,
                    configuredExposedPorts:
                      change === 'matching' ? [3000, 8080] : [3000],
                  } satisfies ModalSandboxSessionState);
            const client =
              backend === 'daytona'
                ? new DaytonaSandboxClient(
                    configuration === 'constructor' ? options : {},
                  )
                : new ModalSandboxClient(
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
              client: client as DaytonaSandboxClient,
              manifest,
              connect,
              ...(configuration === 'call' ? { options } : {}),
              ...(lifecycle === 'borrowed'
                ? {
                    session:
                      resource as SandboxSessionLike<DaytonaSandboxSessionState>,
                  }
                : {
                    authorizedResumeState: {
                      backendId: backend,
                      state: state as DaytonaSandboxSessionState,
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
