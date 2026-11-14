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
import { DockerSandboxClient } from '@openai/agents/sandbox/local';
import { Manifest, sandboxEnvironment } from '@openai/agents/sandbox';
import { Agent, NativeProvider } from '../../src';
import { call, message, ModelServer } from './fixtures/model-server';

const exec = promisify(execFile);
const socketPath = process.env.CODEX_DOCKER_TEST_SOCKET;
const fixture = process.env.CODEX_EXEC_SERVER_TEST_BINARY;

afterEach(async () => {
  await ModelServer.closeAll();
});

const noBwrapImage = process.env.CODEX_DOCKER_TEST_NO_BWRAP_IMAGE;
it.runIf(process.env.CODEX_DOCKER_TEST_NO_BWRAP === '1')(
  'finds native mapped files and refuses shell when the Docker executor lacks bubblewrap',
  async () => {
    expect(process.platform).toBe('linux');
    expect(process.arch).toBe('x64');
    expect(noBwrapImage).toMatch(/@sha256:[a-f0-9]{64}$/u);
    expect(socketPath).toBeTruthy();
    expect(fixture).toBeTruthy();

    // Reuse a cached, ABI-compatible image. An absent image must fail here.
    await exec(
      '/usr/bin/docker',
      ['--host', 'unix://' + socketPath!, 'image', 'inspect', noBwrapImage!],
      { env: { PATH: '/usr/bin:/bin' } },
    );

    const host = await mkdtemp(join(tmpdir(), 'sdk-docker-no-bwrap-'));
    try {
      const readonly = join(host, 'readonly');
      const writable = join(host, 'writable');
      await mkdir(readonly);
      await mkdir(writable);
      await writeFile(join(readonly, 'marker.txt'), 'trusted mapped input');
      await writeFile(
        join(readonly, 'launch'),
        [
          '#!/bin/sh',
          'set -eu',
          'export CODEX_HOME="$(mktemp -d /dev/shm/sdk-docker-exec.XXXXXXXX)"',
          'exec /tools/exec-server "$@"',
          '',
        ].join('\n'),
        { mode: 0o755 },
      );
      await copyFile(fixture!, join(readonly, 'exec-server'));
      await chmod(join(readonly, 'exec-server'), 0o755);

      const outputFor = (request: { input?: unknown }, callId: string) => {
        if (!Array.isArray(request.input))
          throw new Error('Missing native model input');
        const item = request.input.find((item) => item.call_id === callId);
        expect(typeof item?.output).toBe('string');
        return item?.output as string;
      };
      const server = new ModelServer([
        [
          call(
            'project_grep',
            { pattern: 'native fixture', glob: 'native-witness.txt' },
            { callId: 'no-bwrap-grep' },
          ),
        ],
        (request) => {
          expect(outputFor(request, 'no-bwrap-grep')).toContain(
            'native fixture',
          );
          return [
            call(
              'exec_command',
              {
                cmd: 'printf unexpected > native-output.txt; printf unsafe > /tools/native-denied.txt',
                workdir: '/data-write',
                shell: '/bin/bash',
                login: false,
                yield_time_ms: 1000,
              },
              { callId: 'no-bwrap-exec' },
            ),
          ];
        },
        (request) => {
          const output = outputFor(request, 'no-bwrap-exec');
          expect(output).toContain('Process exited with code 101');
          expect(output).toContain('bubblewrap is unavailable');
          expect(output).toContain('no system bwrap was found on PATH');
          expect(output).toContain('no bundled codex-resources/bwrap');
          return [message('Docker native shell refused')];
        },
      ]);
      const client = new DockerSandboxClient({
        image: noBwrapImage!,
        networkMode: 'none',
      });
      const create = client.create.bind(client);
      const acquired: Awaited<ReturnType<typeof create>>[] = [];
      vi.spyOn(client, 'create').mockImplementation(async (...args) => {
        const resource = await create(...args);
        acquired.push(resource);
        return resource;
      });
      const config = await server.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-docker-native',
        supportsWebsockets: false,
      });
      const session = await new Agent({
        provider,
        instructions: 'Find the witness, then run the command.',
      }).session({
        environment: sandboxEnvironment({
          client,
          manifest: new Manifest({
            root: '/workspace',
            entries: {
              'native-witness.txt': { type: 'file', content: 'native fixture' },
            },
            extraPathGrants: [
              { hostPath: readonly, path: '/tools', readOnly: true },
              { hostPath: writable, path: '/data-write' },
            ],
          }),
          capabilities: [],
          dockerGateway: {
            socketPath: socketPath!,
            execServerPath: '/tools/launch',
            tools: ['project_grep', 'exec_command'],
          },
        }),
      });
      try {
        const resource = acquired.at(-1);
        if (!resource) throw new Error('Docker resource was not acquired');
        const control = await resource.exec({
          cmd: [
            'set -eu',
            'test "$(pwd)" = /data-write',
            'test "$(cat /tools/marker.txt)" = "trusted mapped input"',
            'if command -v bwrap >/dev/null 2>&1; then exit 35; fi',
            'test ! -e /tools/codex-resources/bwrap',
            'printf provider-writable > provider-output.txt',
            'if (printf unsafe > /tools/provider-denied.txt) 2>/dev/null; then exit 33; fi',
          ].join('; '),
          workdir: '/data-write',
          shell: '/bin/bash',
          login: false,
          yieldTimeMs: 1000,
        });
        expect(control.exitCode).toBe(0);
        expect(
          (await (await session.submit('Begin.')).wait()).finalOutput,
        ).toBe('Docker native shell refused');
      } finally {
        await session.close();
      }
      expect(
        await readFile(join(writable, 'provider-output.txt'), 'utf8'),
      ).toBe('provider-writable');
      expect(await readFile(join(readonly, 'marker.txt'), 'utf8')).toBe(
        'trusted mapped input',
      );
      for (const path of [
        join(writable, 'native-output.txt'),
        join(readonly, 'native-denied.txt'),
        join(readonly, 'provider-denied.txt'),
      ]) {
        await expect(readFile(path, 'utf8')).rejects.toMatchObject({
          code: 'ENOENT',
        });
      }
      server.assertExhausted();
    } finally {
      await rm(host, { recursive: true, force: true });
    }
  },
  60_000,
);
