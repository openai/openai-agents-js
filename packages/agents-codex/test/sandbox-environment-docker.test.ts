import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DockerSandboxClient,
  DockerSandboxSession,
  Manifest,
} from '@openai/agents-core/sandbox/local';
import { Environment, sandboxEnvironment } from '../src/index';
import { acquireEnvironment } from '../src/runtime/environment-source';

const transport = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../../agents-core/src/sandbox/sandboxes/shared/runProcess', () => ({
  runSandboxProcess: transport.run,
  formatSandboxProcessError: () => 'synthetic Docker transport failure',
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: ((...args: unknown[]) => {
      if (args[0] === 'docker')
        throw new Error(
          'Unexpected Docker transport outside the synthetic provider',
        );
      return Reflect.apply(actual.spawn, undefined, args);
    }) as typeof actual.spawn,
  };
});

afterEach(() => vi.restoreAllMocks());

describe('borrowed Docker native authority', () => {
  it.each(['unchanged', 'removed', 'source', 'readOnly'] as const)(
    'checks actual current host binds before connecting: %s',
    async (change) => {
      const root = await mkdtemp(join(tmpdir(), 'native-docker-authority-'));
      const host = join(root, 'host');
      const other = join(root, 'other');
      await mkdir(host);
      await mkdir(other);
      let labels: Record<string, string> = {};
      let networkMode = 'bridge';
      let mounts: {
        Type: string;
        Source: string;
        Destination: string;
        RW: boolean;
      }[] = [];
      const result = (stdout = '') => ({
        status: 0,
        signal: null,
        stdout,
        stderr: '',
        timedOut: false,
      });
      transport.run.mockImplementation(
        async (command: string, args: string[]) => {
          if (command !== 'docker')
            throw new Error('Unexpected provider transport');
          if (args[0] === 'run') {
            const networkIndex = args.indexOf('--network');
            networkMode = networkIndex < 0 ? 'bridge' : args[networkIndex + 1]!;
            labels = Object.fromEntries(
              args.flatMap((arg, i) =>
                arg === '--label'
                  ? [args[i + 1]!.split(/=(.*)/s).slice(0, 2)]
                  : [],
              ),
            );
            mounts = args.flatMap((arg, i) => {
              if (arg === '--volume' || arg === '-v') {
                const [source, target, mode] = args[i + 1]!.split(':');
                return [
                  {
                    Type: 'bind',
                    Source: source!,
                    Destination: target!,
                    RW: mode !== 'ro',
                  },
                ];
              }
              if (arg !== '--mount') return [];
              const options = Object.fromEntries(
                args[i + 1]!.split(',').map((part) =>
                  part.includes('=')
                    ? part.split(/=(.*)/s).slice(0, 2)
                    : [part, true],
                ),
              );
              return options.type === 'bind'
                ? [
                    {
                      Type: 'bind',
                      Source: String(options.source),
                      Destination: String(options.target),
                      RW: options.readonly !== true,
                    },
                  ]
                : [];
            });
            return result('native-borrowed-container');
          }
          if (args[0] === 'inspect') {
            if (args[4] === '{{json .Config.Labels}}')
              return result(JSON.stringify(labels));
            if (args[4] === '{{json .Mounts}}')
              return result(JSON.stringify(mounts));
            if (
              args[4] ===
              '{{json .HostConfig.NetworkMode}}\n{{json .NetworkSettings.Networks}}'
            )
              return result(
                JSON.stringify(networkMode) +
                  '\n' +
                  JSON.stringify(
                    networkMode === 'none' ? {} : { [networkMode]: {} },
                  ) +
                  '\n',
              );
            return result('true');
          }
          return result();
        },
      );
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
      const client = new DockerSandboxClient({ image: 'synthetic:image' });
      const original = {
        path: '/mnt/trusted',
        hostPath: host,
        readOnly: false,
      };
      const session = await client.create({
        manifest: new Manifest({ extraPathGrants: [original] }),
      });
      try {
        const manifest = new Manifest({
          extraPathGrants:
            change === 'removed'
              ? []
              : [
                  {
                    ...original,
                    ...(change === 'source' ? { hostPath: other } : {}),
                    ...(change === 'readOnly' ? { readOnly: true } : {}),
                  },
                ],
        });
        const connect = vi.fn(async () =>
          Environment.lease(
            new Environment({
              url: 'wss://fixture.invalid',
              cwd: '/workspace',
            }),
            async () => {},
          ),
        );
        const deleted = vi.spyOn(session, 'close');
        const source = sandboxEnvironment({
          client,
          manifest,
          session,
          connect,
        });
        if (change === 'unchanged') {
          const owner = await acquireEnvironment(source);
          await owner.dispose();
          expect(connect).toHaveBeenCalledOnce();
        } else {
          await expect(acquireEnvironment(source)).rejects.toThrow(
            'Borrowed Docker filesystem authority',
          );
          expect(connect).not.toHaveBeenCalled();
        }
        expect(deleted).not.toHaveBeenCalled();
      } finally {
        await session.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
