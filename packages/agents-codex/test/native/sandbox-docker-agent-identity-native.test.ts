import { execFile } from 'node:child_process';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';
import { DockerSandboxClient } from '@openai/agents/sandbox/local';
import { Manifest, sandboxEnvironment } from '@openai/agents/sandbox';
import { Agent, NativeProvider, type SessionState } from '../../src';
import { call, message, ModelServer } from './fixtures/model-server';

const exec = promisify(execFile);
const image = process.env.CODEX_DOCKER_TEST_IMAGE;
const socketPath = process.env.CODEX_DOCKER_TEST_SOCKET;
const fixture = process.env.CODEX_EXEC_SERVER_TEST_BINARY;
afterEach(() => ModelServer.closeAll());

function result(request: { input?: unknown }, callId: string) {
  if (!Array.isArray(request.input)) throw new Error('Missing model input');
  const item = request.input.find(
    (value) => value?.call_id === callId && typeof value.output === 'string',
  );
  if (!item) throw new Error('Missing native project_grep output: ' + callId);
  return JSON.parse(item.output) as {
    errors: unknown[];
    matches: { line: string }[];
  };
}

function readable(
  request: { input?: unknown },
  callId: string,
  marker: string,
) {
  const found = result(request, callId);
  expect(found.errors).toEqual([]);
  expect(found.matches.map((match) => match.line)).toEqual([marker]);
}

function denied(request: { input?: unknown }, callId: string) {
  const found = result(request, callId);
  expect(found.matches).toEqual([]);
  expect(JSON.stringify(found.errors)).toMatch(/permission denied|EACCES/i);
  expect(JSON.stringify(found)).not.toContain('sdk-child-private');
}

it.runIf(
  process.platform === 'linux' &&
    process.arch === 'x64' &&
    !!image &&
    !!socketPath &&
    !!fixture,
)(
  'keeps selected Docker user authority per Agent across cold native restore',
  async () => {
    const host = await mkdtemp(join(tmpdir(), 'sdk-docker-profile-identity-'));
    try {
      const tools = join(host, 'tools');
      await mkdir(tools);
      await mkdir(join(tools, 'libs'));
      await writeFile(
        join(tools, 'launch'),
        '#!/bin/sh\nexec /tools/loader --library-path /tools/libs /tools/exec-server "$@"\n',
        { mode: 0o755 },
      );
      await copyFile('/lib64/ld-linux-x86-64.so.2', join(tools, 'loader'));
      await copyFile(fixture!, join(tools, 'exec-server'));
      await chmod(join(tools, 'loader'), 0o755);
      await chmod(join(tools, 'exec-server'), 0o755);
      for (const name of [
        'libssl.so.3',
        'libcrypto.so.3',
        'libgcc_s.so.1',
        'libm.so.6',
        'libc.so.6',
      ])
        await copyFile(
          '/lib/x86_64-linux-gnu/' + name,
          join(tools, 'libs', name),
        );
      const label = { 'agents-sdk-profile-identity': host.split('/').pop()! };
      const active = async () =>
        (
          await exec(
            '/usr/bin/docker',
            [
              '--host',
              'unix://' + socketPath!,
              'ps',
              '-aq',
              '--filter',
              'label=' + Object.entries(label)[0]!.join('='),
            ],
            { env: { PATH: '/usr/bin:/bin' } },
          )
        ).stdout
          .trim()
          .split('\n')
          .filter(Boolean);
      const grep = (path: string, callId: string) =>
        call('project_grep', { pattern: 'sdk-', path }, { callId });
      const model = new ModelServer([
        [grep('private.txt', 'root-private-before')],
        (request) => {
          readable(request, 'root-private-before', 'sdk-root-private');
          return [call('transfer_to_child', {}, { callId: 'to-child' })];
        },
        [
          grep('public.txt', 'child-public-before'),
          grep('private.txt', 'child-private-before'),
        ],
        (request) => {
          readable(request, 'child-public-before', 'sdk-child-public');
          denied(request, 'child-private-before');
          return [message('Child identity retained.')];
        },
        [
          grep('public.txt', 'child-public-after'),
          grep('private.txt', 'child-private-after'),
        ],
        (request) => {
          readable(request, 'child-public-after', 'sdk-child-public');
          denied(request, 'child-private-after');
          return [call('transfer_to_root', {}, { callId: 'to-root' })];
        },
        [grep('private.txt', 'root-private-after')],
        (request) => {
          readable(request, 'root-private-after', 'sdk-root-private');
          return [message('Independent current identities restored.')];
        },
      ]);
      const config = await model.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-profile-identity',
        supportsWebsockets: false,
        requestMaxRetries: 0,
        streamMaxRetries: 0,
      });
      const source = (role: 'root' | 'child', runAs: string) =>
        sandboxEnvironment({
          client: new DockerSandboxClient({
            image: image!,
            networkMode: 'none',
            labels: { ...label, 'agents-sdk-profile-role': role },
          }),
          manifest: new Manifest({
            root: '/workspace',
            entries: {
              'public.txt': {
                type: 'file',
                content: 'sdk-' + role + '-public',
                permissions: 0o444,
              },
              'private.txt': {
                type: 'file',
                content: 'sdk-' + role + '-private',
                permissions: 0o400,
              },
            },
            extraPathGrants: [
              { hostPath: tools, path: '/tools', readOnly: true },
            ],
          }),
          capabilities: [],
          dockerGateway: {
            socketPath: socketPath!,
            execServerPath: '/tools/launch',
            tools: ['project_grep'],
            runAs,
          },
        });
      const graph = (childUser = '65534:65534') => {
        const child = new Agent({
          name: 'child',
          model: 'gpt-5.5',
          instructions: 'Read the child resource.',
          environment: source('child', childUser),
          handoffs: [() => root],
        });
        const root: Agent = new Agent({
          name: 'root',
          model: 'gpt-5.5',
          instructions: 'Read the root resource.',
          provider,
          environment: source('root', '0:0'),
          handoffs: [child],
        });
        return { root, child };
      };
      const initial = graph();
      const session = await initial.root.session();
      let state: SessionState;
      let turnId: string;
      try {
        expect(await active()).not.toHaveLength(0);
        const turn = await session.submit(
          'Check root, then transfer to child.',
        );
        turnId = turn.turnId;
        expect((await turn.wait()).finalOutput).toBe(
          'Child identity retained.',
        );
        expect(await session.getActiveAgent()).toBe(initial.child);
        expect(await active()).toHaveLength(2);
        state = await session.saveState();
      } finally {
        await session.close();
      }
      expect(await active()).toEqual([]);
      expect(model.requests).toHaveLength(4);

      // Only the child's selected user changes. Same names, instructions,
      // target paths, tools and parent user cannot authorize that identity.
      const changed = graph('0:0');
      await expect(
        changed.root.session({ state }).then(async (unexpected) => {
          await unexpected.close();
          return unexpected;
        }),
      ).rejects.toThrow(/recorded Agent environment grants/);
      expect(model.requests).toHaveLength(4);
      expect(await active()).toEqual([]);

      const current = graph();
      const restored = await current.root.session({ state });
      try {
        expect(await active()).not.toHaveLength(0);
        expect(await restored.getActiveAgent()).toBe(current.child);
        const history = await Array.fromAsync(restored.turns());
        expect(history).toHaveLength(1);
        expect(history[0]?.id).toBe(turnId);
        const turn = await restored.submit('Check child, then return to root.');
        expect((await turn.wait()).finalOutput).toBe(
          'Independent current identities restored.',
        );
        expect(await restored.getActiveAgent()).toBe(current.root);
        expect(await active()).toHaveLength(2);
      } finally {
        await restored.close();
      }
      expect(await active()).toEqual([]);
      expect(model.requests).toHaveLength(8);
      model.assertExhausted();
    } finally {
      await rm(host, { recursive: true, force: true });
    }
  },
  90_000,
);
