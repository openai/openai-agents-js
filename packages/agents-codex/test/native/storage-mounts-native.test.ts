import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import {
  Agent,
  Environment,
  NativeProvider,
  NativeAgents,
  localStorage,
} from '@openai/agents';
import { ModelServer, call, message } from './fixtures/model-server';
import { nativeDescendantModel } from './fixtures/native-descendant-model';
import type { JsonObject } from '../../src/runtime/binding';

const quote = (path: string) => `'${path.replaceAll("'", "'\\''")}'`;
afterEach(() => ModelServer.closeAll());

async function directories() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'agents-storage-native-')),
  );
  const cwd = join(root, 'work');
  const source = join(root, 'storage');
  await Promise.all([mkdir(cwd), mkdir(source)]);
  await writeFile(join(source, 'marker'), 'caller-owned');
  return { root, cwd, source };
}

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-storage-test',
    supportsWebsockets: false,
  });
}

it.skipIf(process.platform !== 'linux')(
  'mounts a real read-only view and preserves it across restore',
  async (context) => {
    const { root, cwd, source } = await directories();
    const marker = join(source, 'marker');
    const originalMode = (await stat(marker)).mode;
    const environment = Environment.local({
      cwd,
      tools: ['exec_command', 'write_stdin', 'apply_patch'],
      mounts: [{ source, destination: source, strategy: 'local_bind' }],
    });
    const command = [
      `test "$(cat ${quote(marker)})" = caller-owned || exit 10`,
      `awk -v p=${quote(source)} '$5 == p && $6 ~ /^ro(,|$)/ {found=1} END {exit !found}' /proc/self/mountinfo || exit 11`,
      `if (printf forbidden > ${quote(marker)}) 2>/dev/null; then exit 12; fi`,
      `if mkdir ${quote(join(source, 'new'))} 2>/dev/null; then exit 13; fi`,
      `if mv ${quote(marker)} ${quote(join(source, 'renamed'))} 2>/dev/null; then exit 14; fi`,
      `if rm ${quote(marker)} 2>/dev/null; then exit 15; fi`,
      `if chmod 777 ${quote(marker)} 2>/dev/null; then exit 16; fi`,
      'printf mount-proof > proof',
    ].join('; ');
    const server = new ModelServer([
      [call('exec_command', { cmd: command }, { callId: 'mount-proof' })],
      [
        {
          type: 'custom_tool_call',
          name: 'apply_patch',
          call_id: 'patch-proof',
          input: `*** Begin Patch\n*** Update File: ${marker}\n@@\n-caller-owned\n+forbidden\n*** End Patch`,
        },
      ],
      [message('verified')],
      [
        call(
          'exec_command',
          {
            cmd: command.replace(
              'printf mount-proof > proof',
              'printf restored-mount-proof > restored-proof',
            ),
          },
          { callId: 'restore-proof' },
        ),
      ],
      [message('restored')],
    ]);
    try {
      await using provider = await providerFor(server);
      const agent = new Agent({
        model: 'gpt-5',
        provider,
        instructions: 'Check mounted storage.',
      });
      const session = await agent
        .session({ environment })
        .catch((error: unknown) => {
          if (
            typeof error === 'object' &&
            error !== null &&
            'message' in error &&
            error.message ===
              'local executor could not establish the platform sandbox' &&
            process.env.GITHUB_ACTIONS !== 'true' &&
            process.env.OPENAI_AGENTS_TEST_IN_CODEX_SANDBOX === '1' &&
            process.env.OPENAI_AGENTS_REQUIRE_LOCAL_SANDBOX !== '1'
          ) {
            expect(server.requests).toHaveLength(0);
            context.skip('This host cannot launch a nested platform sandbox');
          }
          throw error;
        });
      let state;
      try {
        await expect(
          session.submit('No root replacement.', { writableRoots: [] }),
        ).rejects.toThrow('storage mounts');
        await expect(
          session.enqueue('No queued replacement.', undefined, {
            writableRoots: [],
          }),
        ).rejects.toThrow('storage mounts');
        expect(
          (await (await session.submit('Verify the mounted view.')).wait())
            .finalOutput,
        ).toBe('verified');
        expect(await readFile(join(cwd, 'proof'), 'utf8')).toBe('mount-proof');
        expect(await readFile(marker, 'utf8')).toBe('caller-owned');
        state = await session.saveState();
      } finally {
        await session.close();
      }
      expect((await stat(marker)).mode).toBe(originalMode);
      await expect(
        agent.session({
          state,
          environment: Environment.local({ cwd, tools: environment.tools }),
        }),
      ).rejects.toThrow(/policy/i);
      expect(server.requests).toHaveLength(3);
      await using restored = await agent.session({ state, environment });
      expect(
        (await (await restored.submit('Verify restored mounts.')).wait())
          .finalOutput,
      ).toBe('restored');
      expect(await readFile(marker, 'utf8')).toBe('caller-owned');
      expect((await stat(marker)).mode).toBe(originalMode);
      expect(await readFile(join(cwd, 'restored-proof'), 'utf8')).toBe(
        'restored-mount-proof',
      );
      server.assertExhausted();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform !== 'linux')(
  'rejects read grants over private session storage before model requests',
  async () => {
    const { root, cwd, source } = await directories();
    const server = new ModelServer([]);
    try {
      await using provider = await providerFor(server);
      const agent = new Agent({
        model: 'gpt-5',
        provider,
        instructions: 'Do not start.',
      });
      await expect(
        agent.session({
          environment: Environment.local({
            cwd,
            mounts: [{ source, destination: source, strategy: 'local_bind' }],
          }),
          storage: localStorage(join(source, 'private-session')),
        }),
      ).rejects.toThrow(/Storage mounts must not expose private SDK state/);
      expect(server.requests).toHaveLength(0);
      expect(await readFile(join(source, 'marker'), 'utf8')).toBe(
        'caller-owned',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform !== 'linux').each(['cwd', 'writableRoots'] as const)(
  'rejects a writable hard-link alias in %s before startup',
  async (location) => {
    const { root, cwd, source } = await directories();
    const extra = join(root, 'extra');
    const marker = join(source, 'marker');
    const originalMode = (await stat(marker)).mode;
    const sourceMode = (await stat(source)).mode;
    const server = new ModelServer([]);
    try {
      await mkdir(extra);
      const alias = join(location === 'cwd' ? cwd : extra, 'writable-alias');
      await link(marker, alias);
      await using provider = await providerFor(server);
      const agent = new Agent({
        model: 'gpt-5',
        provider,
        instructions: 'Do not start.',
      });
      await expect(
        agent
          .session({
            environment: Environment.local({
              cwd,
              writableRoots: [extra],
              mounts: [{ source, destination: source, strategy: 'local_bind' }],
            }),
          })
          .then(async (session) => {
            await session.close();
            throw new Error('Unexpectedly admitted a writable hard-link alias');
          }),
      ).rejects.toThrow(/Storage mounts must not share hard-linked files/);
      expect(server.requests).toHaveLength(0);
      expect(await readFile(marker, 'utf8')).toBe('caller-owned');
      expect(await readFile(alias, 'utf8')).toBe('caller-owned');
      expect((await stat(marker)).mode).toBe(originalMode);
      expect((await stat(source)).mode).toBe(sourceMode);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform !== 'linux')(
  'joins cancellation without changing caller storage',
  async (context) => {
    const { root, cwd, source } = await directories();
    const heartbeat = join(cwd, 'heartbeat');
    const originalMode = (await stat(join(source, 'marker'))).mode;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const server = new ModelServer([
      [
        call(
          'exec_command',
          {
            cmd: 'i=0; while [ "$i" -lt 120 ]; do printf x >> heartbeat; sleep 0.1; i=$((i + 1)); done',
            yield_time_ms: 50,
          },
          { callId: 'retained-process' },
        ),
      ],
    ]);
    try {
      await using provider = await providerFor(server);
      const agent = new Agent({
        model: 'gpt-5',
        provider,
        instructions: 'Start the command.',
      });
      const session = await agent
        .session({
          environment: Environment.local({
            cwd,
            tools: ['exec_command', 'write_stdin'],
            mounts: [{ source, destination: source, strategy: 'local_bind' }],
            async transformResult(_context, value) {
              entered.resolve();
              await release.promise;
              return value;
            },
          }),
        })
        .catch((error: unknown) => {
          if (
            typeof error === 'object' &&
            error !== null &&
            'message' in error &&
            error.message ===
              'local executor could not establish the platform sandbox' &&
            process.env.GITHUB_ACTIONS !== 'true' &&
            process.env.OPENAI_AGENTS_TEST_IN_CODEX_SANDBOX === '1' &&
            process.env.OPENAI_AGENTS_REQUIRE_LOCAL_SANDBOX !== '1'
          ) {
            expect(server.requests).toHaveLength(0);
            context.skip('This host cannot launch a nested platform sandbox');
          }
          throw error;
        });
      try {
        const turn = await session.submit('Start a retained command.');
        const completed = turn.wait().catch(() => undefined);
        await entered.promise;
        const running = await readFile(heartbeat, 'utf8');
        expect(running.length).toBeGreaterThan(0);
        await expect
          .poll(() => readFile(heartbeat, 'utf8'), {
            timeout: 2_000,
            interval: 50,
          })
          .not.toBe(running);
        const closing = session.close();
        release.resolve();
        await closing;
        await completed;
        const stoppedAt = await readFile(heartbeat, 'utf8');
        await delay(600);
        expect(await readFile(heartbeat, 'utf8')).toBe(stoppedAt);
        expect((await stat(join(source, 'marker'))).mode).toBe(originalMode);
        expect(await readFile(join(source, 'marker'), 'utf8')).toBe(
          'caller-owned',
        );
      } finally {
        release.resolve();
        await session.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform !== 'linux')(
  'keeps mounts read-only in a child and continued process',
  async (context) => {
    const { root, cwd, source } = await directories();
    const marker = join(source, 'marker');
    let processId: number | undefined;
    let spawnResult: JsonObject | undefined;
    const steps = new Map<string, number>();
    const respond = (request: JsonObject) => {
      const metadata = request.client_metadata as Record<string, string>;
      const { agent_name: name } = JSON.parse(
        metadata['x-codex-turn-metadata']!,
      ) as { agent_name: string };
      const step = steps.get(name) ?? 0;
      steps.set(name, step + 1);
      if (name === '/root') {
        if (step === 0)
          return [
            call(
              'spawn_agent',
              {
                task_name: 'storage_reader',
                message: 'Verify the storage mount.',
                fork_turns: 'none',
              },
              { namespace: 'collaboration', callId: 'spawn-storage-reader' },
            ),
          ];
        spawnResult = (request.input as JsonObject[]).find(
          (item) =>
            item.type === 'function_call_output' &&
            item.call_id === 'spawn-storage-reader',
        );
        return [message('delegated')];
      }
      if (step === 0)
        return [
          call(
            'exec_command',
            {
              cmd: `IFS= read -r line; test "$line" = verify || exit 10; test "$(cat ${quote(marker)})" = caller-owned || exit 11; if (printf forbidden > ${quote(marker)}) 2>/dev/null; then exit 12; fi; printf child-proof > child-proof`,
              yield_time_ms: 50,
              tty: true,
            },
            { callId: 'child-start' },
          ),
        ];
      if (step === 1) {
        expect(processId).toBeTypeOf('number');
        return [
          call(
            'write_stdin',
            { session_id: processId!, chars: 'verify\n', yield_time_ms: 1000 },
            { callId: 'child-continue' },
          ),
        ];
      }
      return [message('child verified')];
    };
    const server = new ModelServer(Array.from({ length: 5 }, () => respond));
    try {
      await using provider = await providerFor(server);
      const agent = new Agent({
        model: nativeDescendantModel,
        provider,
        instructions: 'Delegate storage verification.',
        programmaticToolCalling: false,
        tools: [new NativeAgents({ maxChildren: 1, maxDepth: 1 })],
      });
      const session = await agent
        .session({
          environment: Environment.local({
            cwd,
            tools: ['exec_command', 'write_stdin', 'apply_patch'],
            mounts: [{ source, destination: source, strategy: 'local_bind' }],
            transformResult(info, value) {
              if (
                info.callId === 'child-start' &&
                value &&
                typeof value === 'object' &&
                !Array.isArray(value) &&
                typeof value.session_id === 'number'
              )
                processId = value.session_id;
              return value;
            },
          }),
        })
        .catch((error: unknown) => {
          if (
            typeof error === 'object' &&
            error !== null &&
            'message' in error &&
            error.message ===
              'local executor could not establish the platform sandbox' &&
            process.env.GITHUB_ACTIONS !== 'true' &&
            process.env.OPENAI_AGENTS_TEST_IN_CODEX_SANDBOX === '1' &&
            process.env.OPENAI_AGENTS_REQUIRE_LOCAL_SANDBOX !== '1'
          ) {
            expect(server.requests).toHaveLength(0);
            context.skip('This host cannot launch a nested platform sandbox');
          }
          throw error;
        });
      await using _owned = session;
      await (await session.submit('Delegate storage verification.')).wait();
      expect(spawnResult?.output, 'spawn_agent tool result').toMatch(/^\{/);
      expect(JSON.parse(spawnResult!.output as string)).toMatchObject({
        task_name: '/root/storage_reader',
      });
      const children = await vi.waitFor(
        async () => {
          const children = await Array.fromAsync(session.subagents());
          expect(children).toHaveLength(1);
          expect(children[0].turn).toBeTruthy();
          return children;
        },
        { timeout: 25_000 },
      );
      expect((await children[0].turn!.wait()).finalOutput).toBe(
        'child verified',
      );
      expect(await readFile(join(cwd, 'child-proof'), 'utf8')).toBe(
        'child-proof',
      );
      expect(await readFile(marker, 'utf8')).toBe('caller-owned');
      server.assertExhausted();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
