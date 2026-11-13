import { execFile } from 'node:child_process';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { DockerSandboxClient } from '@openai/agents/sandbox/local';
import { createWorkspaceFileNoFollow } from '@openai/agents-core/sandbox/internal';
import {
  Manifest,
  sandboxEnvironment,
  type SandboxCapability,
  type SandboxSessionLike,
} from '@openai/agents/sandbox';
import { Agent, NativeProvider, tool } from '../../src';
import { call, message, ModelServer } from './fixtures/model-server';

const exec = promisify(execFile);
const image = process.env.CODEX_DOCKER_TEST_IMAGE;
const socketPath = process.env.CODEX_DOCKER_TEST_SOCKET;
const fixture = process.env.CODEX_EXEC_SERVER_TEST_BINARY;
afterEach(async () => {
  vi.unstubAllEnvs();
  await ModelServer.closeAll();
});

class RawSandboxCapability implements SandboxCapability {
  readonly type = 'raw-sandbox-test';
  private resource?: SandboxSessionLike;

  clone() {
    return new RawSandboxCapability();
  }

  prepareManifest(manifest: Manifest) {
    return manifest;
  }

  bind(resource: SandboxSessionLike) {
    this.resource = resource;
  }

  instructions() {
    return null;
  }

  tools() {
    return [
      tool({
        name: 'check_mapped_workspace',
        description: 'Read and write the fixture grants.',
        parameters: z.object({}),
        execute: async () => {
          const resource = this.resource!;
          await createWorkspaceFileNoFollow(resource, {
            path: '/workspace/exclusive.txt',
            entry: { type: 'file', content: 'first content' },
          });
          await createWorkspaceFileNoFollow(resource, {
            path: '/workspace/generated/nested/config.txt',
            entry: { type: 'file', content: 'nested content' },
          });
          const prepared = await resource.exec!({
            cmd: 'mkdir /workspace/other; ln -s /workspace/other /workspace/link; mkfifo /workspace/existing-fifo; ln -s /workspace/other/missing /workspace/existing-link',
            login: false,
          });
          expect(prepared.exitCode).toBe(0);
          for (const path of [
            '/workspace/exclusive.txt',
            '/workspace/link/nested/unexpected',
            '/workspace/existing-fifo',
            '/workspace/existing-link',
          ]) {
            await expect(
              createWorkspaceFileNoFollow(resource, {
                path,
                entry: { type: 'file', content: 'unexpected write' },
              }),
            ).rejects.toThrow('exclusively');
          }
          const result = await resource.exec!({
            cmd: 'set -e; test "$(cat /workspace/exclusive.txt)" = "first content"; test "$(cat /workspace/generated/nested/config.txt)" = "nested content"; test ! -e /workspace/other/nested; test ! -e /workspace/other/missing; cat /tools/marker.txt; pwd; printf retained > /data-write/output.txt; if (printf unsafe > /tools/denied.txt) 2>/dev/null; then exit 33; fi; printf "protected read-only mount"',
            login: false,
          });
          if (result.exitCode !== 0) throw new Error(result.output);
          return result.output;
        },
      }),
    ];
  }
}

it.runIf(
  process.platform === 'linux' &&
    process.arch === 'x64' &&
    !!image &&
    !!socketPath &&
    !!fixture,
)(
  'runs the native executor on the exact fresh Docker resource and retires it',
  async () => {
    const host = await mkdtemp(join(tmpdir(), 'sdk-docker-native-grant-'));
    try {
      const readonly = join(host, 'readonly');
      const writable = join(host, 'writable');
      await mkdir(readonly);
      await mkdir(writable);
      const label = { 'agents-sdk-docker-native-test': host.split('/').pop()! };
      const docker = (args: string[]) =>
        exec('/usr/bin/docker', ['--host', 'unix://' + socketPath!, ...args], {
          env: { PATH: '/usr/bin:/bin' },
        });
      const active = async () =>
        (
          await docker([
            'ps',
            '-aq',
            '--filter',
            'label=' + Object.entries(label)[0]!.join('='),
          ])
        ).stdout
          .trim()
          .split('\n')
          .filter(Boolean);
      await writeFile(join(readonly, 'marker.txt'), 'trusted mapped input');
      const launcher = join(readonly, 'launch');
      await writeFile(
        launcher,
        '#!/bin/sh\nexec /tools/loader --library-path /tools/libs /tools/exec-server "$@"\n',
        { mode: 0o755 },
      );
      await mkdir(join(readonly, 'libs'));
      await copyFile('/lib64/ld-linux-x86-64.so.2', join(readonly, 'loader'));
      await copyFile(fixture!, join(readonly, 'exec-server'));
      await chmod(join(readonly, 'loader'), 0o755);
      await chmod(join(readonly, 'exec-server'), 0o755);
      for (const name of [
        'libssl.so.3',
        'libcrypto.so.3',
        'libgcc_s.so.1',
        'libm.so.6',
        'libc.so.6',
      ])
        await copyFile(
          '/lib/x86_64-linux-gnu/' + name,
          join(readonly, 'libs', name),
        );
      const server = new ModelServer([
        [
          call(
            'project_glob',
            { pattern: '**/native-witness.txt' },
            { callId: 'native-glob' },
          ),
        ],
        [call('check_mapped_workspace', {}, { callId: 'resource-callback' })],
        [message('Docker native execution complete')],
      ]);
      vi.stubEnv('DOCKER_HOST', 'unix:///unselected-synthetic-socket');
      vi.stubEnv('DOCKER_CONTEXT', 'unselected-synthetic-context');
      vi.stubEnv('DOCKER_CUSTOM_HEADERS', 'X-Unselected=synthetic');
      const config = await server.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-docker-native',
        supportsWebsockets: false,
      });
      const source = sandboxEnvironment({
        client: new DockerSandboxClient({
          image: image!,
          networkMode: 'none',
          labels: label,
        }),
        manifest: new Manifest({
          root: '/workspace',
          entries: {
            'native-witness.txt': { type: 'file', content: 'native fixture' },
          },
          extraPathGrants: [
            { hostPath: readonly, path: '/tools', readOnly: true },
            { hostPath: writable, path: '/data-write', readOnly: false },
          ],
        }),
        capabilities: [new RawSandboxCapability()],
        dockerGateway: {
          socketPath: socketPath!,
          execServerPath: '/tools/launch',
          tools: ['project_glob'],
        },
      });
      const agent = new Agent({ provider, instructions: 'Read the marker.' });
      const session = await agent.session({ environment: source });
      try {
        expect(await active()).toHaveLength(1);
        expect(
          (await (await session.submit('Read the marker.')).wait()).finalOutput,
        ).toBe('Docker native execution complete');
      } finally {
        await session.close();
      }
      expect(await active()).toEqual([]);
      expect(await readFile(join(readonly, 'marker.txt'), 'utf8')).toBe(
        'trusted mapped input',
      );
      const nativeOutput = (
        server.requests[1]?.input as { call_id?: string; output?: unknown }[]
      ).find(
        (item) => item.call_id === 'native-glob' && item.output !== undefined,
      )?.output;
      expect(JSON.stringify(nativeOutput)).toContain('native-witness.txt');
      const output = JSON.stringify(server.requests[2]?.input);
      expect(output).toContain('trusted mapped input');
      expect(output).toContain('protected read-only mount');
      expect(await readFile(join(writable, 'output.txt'), 'utf8')).toBe(
        'retained',
      );
      await expect(
        readFile(join(readonly, 'denied.txt'), 'utf8'),
      ).rejects.toMatchObject({
        code: 'ENOENT',
      });
      server.assertExhausted();
    } finally {
      await rm(host, { recursive: true, force: true });
    }
  },
  60_000,
);
