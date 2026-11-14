import { execFile } from 'node:child_process';
import {
  chmod,
  copyFile,
  cp,
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
import { DockerSandboxClient } from '@openai/agents/sandbox/local';
import { Manifest, sandboxEnvironment } from '@openai/agents/sandbox';
import { Agent, NativeProvider } from '../../src';
import { call, message, ModelServer } from './fixtures/model-server';

const exec = promisify(execFile);
const image = process.env.CODEX_DOCKER_TEST_IMAGE;
const socketPath = process.env.CODEX_DOCKER_TEST_SOCKET;
const fixture = process.env.CODEX_EXEC_SERVER_TEST_BINARY;
afterEach(async () => {
  vi.unstubAllEnvs();
  await ModelServer.closeAll();
});

it.runIf(
  process.platform === 'linux' &&
    process.arch === 'x64' &&
    !!image &&
    !!socketPath &&
    !!fixture,
)(
  'runs mapped native commands and restores with current Docker grants',
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
        [
          call(
            'exec_command',
            {
              cmd: 'set -e; test "$(pwd)" = /data-write; cat /tools/marker.txt; printf native-retained > native-output.txt; if (printf unsafe > /tools/native-denied.txt) 2>/dev/null; then exit 33; fi; printf native-mapped-ro-denied',
              workdir: '/data-write',
              shell: '/bin/sh',
              login: false,
              yield_time_ms: 1000,
              max_output_tokens: 2048,
            },
            { callId: 'native-mapped-exec' },
          ),
        ],
        [message('Docker native execution complete')],
        [
          call(
            'exec_command',
            {
              cmd: 'set -e; test "$(pwd)" = /data-write; test "$(cat /tools/marker.txt)" = "current restored input"; printf restored-retained > native-output.txt; if (printf unsafe > /tools/native-denied.txt) 2>/dev/null; then exit 34; fi; printf native-restored-ro-denied',
              workdir: '/data-write',
              shell: '/bin/sh',
              login: false,
              yield_time_ms: 1000,
              max_output_tokens: 2048,
            },
            { callId: 'native-restored-exec' },
          ),
        ],
        [message('Docker native restore complete')],
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
      const sourceFor = (
        readOnlyHost: string,
        writableHost: string,
        writeGrantReadOnly = false,
      ) =>
        sandboxEnvironment({
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
              { hostPath: readOnlyHost, path: '/tools', readOnly: true },
              {
                hostPath: writableHost,
                path: '/data-write',
                readOnly: writeGrantReadOnly,
              },
            ],
          }),
          capabilities: [],
          dockerGateway: {
            socketPath: socketPath!,
            execServerPath: '/tools/launch',
            tools: ['project_glob', 'exec_command'],
          },
        });
      const agent = new Agent({ provider, instructions: 'Read the marker.' });
      const session = await agent.session({
        environment: sourceFor(readonly, writable),
      });
      let state: Awaited<ReturnType<typeof session.saveState>>;
      let originalTurnId: string;
      try {
        expect(await active()).toHaveLength(1);
        const original = await session.submit('Read the marker.');
        originalTurnId = original.turnId;
        expect((await original.wait()).finalOutput).toBe(
          'Docker native execution complete',
        );
        state = await session.saveState();
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
      expect(output).toContain('native-mapped-ro-denied');
      expect(output).toContain('trusted mapped input');
      expect(await readFile(join(writable, 'native-output.txt'), 'utf8')).toBe(
        'native-retained',
      );
      await expect(
        readFile(join(readonly, 'native-denied.txt'), 'utf8'),
      ).rejects.toMatchObject({
        code: 'ENOENT',
      });
      // The old resource has closed. Recreate the same container targets from
      // current trusted host grants, rather than reviving serialized mounts.
      const currentReadonly = join(host, 'current-readonly');
      const currentWritable = join(host, 'current-writable');
      await cp(readonly, currentReadonly, { recursive: true });
      await mkdir(currentWritable);
      await writeFile(
        join(currentReadonly, 'marker.txt'),
        'current restored input',
      );
      // Current host paths are explicit authority, but changing a recorded
      // target's write policy must still fail before another model request.
      expect(server.requests).toHaveLength(3);
      await expect(
        agent
          .session({
            state,
            environment: sourceFor(currentReadonly, currentWritable, true),
          })
          .then(async (unexpected) => {
            await unexpected.close();
            return unexpected;
          }),
      ).rejects.toThrow(
        /recorded executor write and network policy|recorded Agent environment grants/,
      );
      expect(server.requests).toHaveLength(3);
      expect(await active()).toEqual([]);
      const restored = await agent.session({
        state,
        environment: sourceFor(currentReadonly, currentWritable),
      });
      try {
        expect(await active()).toHaveLength(1);
        const history = await Array.fromAsync(restored.turns());
        expect(history).toHaveLength(1);
        expect(history[0]?.id).toBe(originalTurnId);
        expect(
          (await (await restored.submit('Use current restored grants.')).wait())
            .finalOutput,
        ).toBe('Docker native restore complete');
      } finally {
        await restored.close();
      }
      expect(await active()).toEqual([]);
      const restoredOutput = (
        server.requests[4]?.input as { call_id?: string; output?: unknown }[]
      ).find(
        (item) =>
          item.call_id === 'native-restored-exec' && item.output !== undefined,
      )?.output;
      expect(JSON.stringify(restoredOutput)).toContain(
        'native-restored-ro-denied',
      );
      expect(
        await readFile(join(currentWritable, 'native-output.txt'), 'utf8'),
      ).toBe('restored-retained');
      expect(await readFile(join(writable, 'native-output.txt'), 'utf8')).toBe(
        'native-retained',
      );
      expect(await readFile(join(readonly, 'marker.txt'), 'utf8')).toBe(
        'trusted mapped input',
      );
      expect(await readFile(join(currentReadonly, 'marker.txt'), 'utf8')).toBe(
        'current restored input',
      );
      await expect(
        readFile(join(currentReadonly, 'native-denied.txt'), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      server.assertExhausted();
    } finally {
      await rm(host, { recursive: true, force: true });
    }
  },
  60_000,
);
