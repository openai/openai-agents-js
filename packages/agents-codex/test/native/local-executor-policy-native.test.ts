import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import {
  Agent,
  Environment,
  NativeAgents,
  NativeProvider,
  StdioMCP,
  checklist,
  localStorage,
  parseSessionState,
  type Session,
  type SessionState,
} from '@openai/agents';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
import { nativeDescendantModel } from './fixtures/native-descendant-model';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(async () => {
  vi.unstubAllEnvs();
  await ModelServer.closeAll();
});

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-local-worker',
    supportsWebsockets: false,
  });
}

const supported = process.platform === 'linux' || process.platform === 'darwin';
const packageRoot = join(import.meta.dirname, '..', '..');

it.skipIf(!supported)(
  'records the selected local proxy in child and grandchild receipts',
  async (context) => {
    const temporary = await mkdtemp(
      join(tmpdir(), 'agents-child-local-policy-'),
    );
    try {
      const directory = await realpath(temporary);
      const cwd = join(directory, 'work');
      const extra = join(directory, 'extra');
      const storage = join(directory, 'storage');
      await Promise.all([mkdir(cwd), mkdir(extra)]);
      const identities = new Map<string, string>();
      const respond = (request: JsonObject) => {
        const metadata = request.client_metadata as Record<string, string>;
        const { agent_name: name, thread_id: id } = JSON.parse(
          metadata['x-codex-turn-metadata']!,
        ) as { agent_name: string; thread_id: string };
        const first = !identities.has(name);
        identities.set(name, id);
        if (!first) {
          const input = JSON.stringify(request.input);
          if (name === '/root/alpha/grandchild') {
            expect(input).toContain('proxy active');
          } else {
            expect(input).toContain(
              name === '/root' ? '/root/alpha' : '/root/alpha/grandchild',
            );
          }
          return [message(name + ' finished')];
        }
        if (name === '/root/alpha/grandchild') {
          return [
            call(
              'exec_command',
              { cmd: 'test -n "$HTTP_PROXY" && printf "proxy active"' },
              { callId: 'probe-proxy' },
            ),
          ];
        }
        return [
          call(
            'spawn_agent',
            {
              task_name: name === '/root' ? 'alpha' : 'grandchild',
              message: 'Work.',
              fork_turns: 'none',
            },
            {
              namespace: 'collaboration',
              callId: name === '/root' ? 'spawn-alpha' : 'spawn-grandchild',
            },
          ),
        ];
      };
      const server = new ModelServer(Array.from({ length: 6 }, () => respond));
      await using provider = await providerFor(server);
      const agent = new Agent({
        provider,
        model: nativeDescendantModel,
        instructions: 'Delegate the work.',
        programmaticToolCalling: false,
        tools: [new NativeAgents({ maxChildren: 2, maxDepth: 2 })],
      });
      {
        const opened = await agent
          .session({
            environment: Environment.local({
              cwd,
              writableRoots: [extra],
              tools: ['exec_command', 'write_stdin', 'apply_patch'],
              network: {
                allowedDomains: ['allowed.example.invalid'],
                deniedDomains: ['blocked.example.invalid'],
                allowAllUnixSockets: true,
              },
            }),
            storage: localStorage(storage),
          })
          .catch((error: unknown) => {
            if (
              error instanceof Error &&
              /could not establish the platform sandbox/.test(error.message) &&
              process.env.OPENAI_AGENTS_REQUIRE_LOCAL_SANDBOX !== '1'
            ) {
              expect(server.requests).toHaveLength(0);
              context.skip('This host cannot launch a nested platform sandbox');
            }
            throw error;
          });
        await using session = opened;
        const turn = await session.submit('Delegate.');
        expect((await turn.wait()).finalOutput).toBe('/root finished');
        const children = await vi.waitFor(
          async () => {
            const children = await Array.fromAsync(session.subagents());
            expect(children).toHaveLength(2);
            expect(children.every((child) => child.turn)).toBe(true);
            return children;
          },
          { timeout: 25_000 },
        );
        await Promise.all(children.map((child) => child.turn!.wait()));
        expect(new Set(identities.keys())).toEqual(
          new Set(['/root', '/root/alpha', '/root/alpha/grandchild']),
        );
        for (const id of identities.values()) {
          const [recorded] = await Array.fromAsync(
            session.turns(id === session.id ? {} : { subagentId: id }),
          );
          const [executor] = recorded?.receipt?.executors ?? [];
          expect(executor).toMatchObject({
            transport: 'local',
            cwd: pathToFileURL(cwd).href,
            networkPolicy: {
              domains: {
                'allowed.example.invalid': 'allow',
                'blocked.example.invalid': 'deny',
              },
            },
          });
          expect(new Set(executor?.writableRoots)).toEqual(
            new Set([pathToFileURL(cwd).href, pathToFileURL(extra).href]),
          );
        }
      }
      const sessions = join(storage, 'sessions');
      const files = await readdir(sessions, { recursive: true });
      for (const id of identities.values()) {
        const file = files.find((name) => name.endsWith(`-${id}.jsonl`));
        expect(file).toBeDefined();
        const rows = (await readFile(join(sessions, file!), 'utf8'))
          .trimEnd()
          .split('\n')
          .map((line) => JSON.parse(line));
        const receipts = rows
          .filter((row) => row.type === 'turn_context')
          .map((row) => row.payload.sdk_receipt)
          .filter((receipt) => receipt?.thread_id === id);
        expect(receipts.length).toBeGreaterThan(0);
        expect(
          receipts.every((receipt) => receipt.strict_executor_writes),
        ).toBe(true);
      }
      server.assertExhausted();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
  75_000,
);

it.skipIf(!supported).for(['default', 'explicit'] as const)(
  'resumes an implicit remote workspace after relocation with %s networking',
  { timeout: 30_000 },
  async (networkMode) => {
    const executor = await startPublicExecutor();
    try {
      const next = join(executor.cwd, '..', 'relocated');
      await mkdir(next);
      const server = new ModelServer([
        [message('before')],
        [message('after')],
        [message('unattached')],
      ]);
      await using provider = await providerFor(server);
      const agent = new Agent({
        provider,
        model: 'gpt-5',
        instructions: 'Work.',
      });
      const connection = {
        url: executor.url,
        headers: executor.headers,
        writePolicy: 'legacy' as const,
      };
      const network = {
        allowAllUnixSockets: true,
        allowedDomains: ['example.invalid'],
      };
      const tools = ['exec_command'] as const;
      const policy =
        networkMode === 'explicit' ? { tools, network } : { tools };
      const storage = localStorage(join(executor.cwd, '..', 'storage'));
      let resume: string;
      {
        await using session = await agent.session({
          environment: new Environment({
            ...connection,
            cwd: executor.cwd,
            ...policy,
          }),
          storage,
        });
        resume = session.id;
        expect(
          (await (await session.submit('Begin.')).wait()).finalOutput,
        ).toBe('before');
      }
      await expect(
        agent.session({
          storage,
          resume,
          environment: new Environment({
            ...connection,
            cwd: next,
            ...policy,
            writePolicy: 'strict',
            writableRoots: [],
          }),
        }),
      ).rejects.toThrow(/recorded executor write and network policy/);
      await expect(
        agent.session({
          storage,
          resume,
          environment: new Environment({
            ...connection,
            cwd: next,
            tools,
            network: { ...network, allowedDomains: ['different.invalid'] },
          }),
        }),
      ).rejects.toThrow(/recorded executor write and network policy/);
      {
        await using session = await agent.session({
          storage,
          resume,
          environment: new Environment({ ...connection, cwd: next, ...policy }),
        });
        expect(
          (await (await session.submit('Continue.')).wait()).finalOutput,
        ).toBe('after');
      }
      await using unattached = await agent.session({ storage, resume });
      expect(
        (await (await unattached.submit('Continue without tools.')).wait())
          .finalOutput,
      ).toBe('unattached');
      const receipts = [];
      for await (const turn of unattached.turns()) receipts.push(turn.receipt);
      expect(receipts.at(-1)?.executors).toEqual([]);
      expect(server.requests.at(-1)?.tools ?? []).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'exec_command' }),
        ]),
      );
      server.assertExhausted();
    } finally {
      await executor.close();
    }
  },
);

it.skipIf(process.platform !== 'linux')(
  'ignores sandbox helper candidates on the controller PATH',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agents-local-helper-'));
    try {
      const cwd = join(directory, 'workspace');
      const marker = join(directory, 'helper-ran');
      await mkdir(cwd);
      await writeFile(
        join(directory, 'bwrap'),
        `#!/bin/sh\nprintf unsafe > "${marker}"\nexit 71\n`,
        { mode: 0o755 },
      );
      vi.stubEnv('PATH', [directory, process.env.PATH].join(delimiter));
      const server = new ModelServer([]);
      await using provider = await providerFor(server);
      const agent = new Agent({
        provider,
        model: 'gpt-5',
        instructions: 'Work.',
      });
      try {
        await using _session = await agent.session({
          environment: Environment.local({ cwd }),
        });
      } catch (error) {
        if (!(
          error instanceof Error &&
          /could not establish the platform sandbox/.test(error.message)
        ))
          throw error;
      }
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(server.requests).toHaveLength(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  20_000,
);

it.skipIf(!supported)(
  'isolates local command reads and environment from the host',
  async (context) => {
    const directory = await mkdtemp(join(tmpdir(), 'agents-local-host-data-'));
    try {
      const cwd = join(directory, 'workspace');
      const extra = join(directory, 'granted');
      await Promise.all([mkdir(cwd), mkdir(extra)]);
      const outside = join(directory, 'outside');
      const alias = join(cwd, 'link');
      const granted = join(extra, 'allowed');
      const roster = join(directory, 'roster.json');
      const calls = join(directory, 'calls.jsonl');
      await Promise.all([
        writeFile(outside, 'synthetic-outside'),
        symlink(outside, alias),
        writeFile(granted, 'synthetic-grant'),
        writeFile(
          roster,
          JSON.stringify({
            tools: [
              {
                name: 'lookup',
                annotations: { readOnlyHint: true, destructiveHint: false },
                inputSchema: { type: 'object' },
              },
            ],
            result: {
              content: [{ type: 'text', text: 'host grant available' }],
            },
          }),
        ),
      ]);
      vi.stubEnv('SDK_TEST_AMBIENT_PASSWORD', 'synthetic-ambient-password');
      vi.stubEnv('OPENAI_API_KEY', 'synthetic-explicit-host-key');
      const host = new StdioMCP({
        name: 'host',
        tools: ['lookup'],
        location: 'host',
        envVars: ['OPENAI_API_KEY'],
        command: '/bin/sh',
        args: [
          '-c',
          'test "$OPENAI_API_KEY" = synthetic-explicit-host-key && exec "$@"',
          'fixture',
          process.execPath,
          join(import.meta.dirname, 'mcp-peer.mjs'),
          roster,
          calls,
        ],
      });
      const command = [
        'test -z "${SDK_TEST_AMBIENT_PASSWORD+x}${OPENAI_API_KEY+x}" || exit 11',
        `if cat "${outside}" >/dev/null 2>&1; then exit 12; fi`,
        `if cat "${alias}" >/dev/null 2>&1; then exit 13; fi`,
        `test "$(cat "${granted}")" = synthetic-grant`,
      ].join('; ');
      const server = new ModelServer([
        [call('exec_command', { cmd: command }, { callId: 'isolation' })],
        [call('lookup', {}, { namespace: 'mcp__host', callId: 'host-grant' })],
        [message('done')],
      ]);
      await using provider = await providerFor(server);
      const agent = new Agent({
        provider,
        model: 'gpt-5',
        instructions: 'Work.',
        tools: [host],
      });
      const environment = Environment.local({
        cwd,
        writableRoots: [extra],
        tools: ['exec_command'],
      });
      const opened = await agent
        .session({ environment })
        .catch((error: unknown) => {
          if (
            error instanceof Error &&
            /could not establish the platform sandbox/.test(error.message) &&
            process.env.OPENAI_AGENTS_REQUIRE_LOCAL_SANDBOX !== '1'
          ) {
            expect(server.requests).toHaveLength(0);
            context.skip('This host cannot launch a nested platform sandbox');
          }
          throw error;
        });
      await using session = opened;
      expect(
        (await (await session.submit('Check both grants.')).wait()).finalOutput,
      ).toBe('done');
      const executions = [];
      for await (const item of session.items()) {
        if (item.type === 'command_execution') executions.push(item);
      }
      expect(executions).toEqual([
        expect.objectContaining({
          callId: 'isolation',
          exitCode: 0,
          status: 'completed',
        }),
      ]);
      expect(await readFile(calls, 'utf8')).toContain('lookup');
      server.assertExhausted();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

it.skipIf(!supported)(
  'joins an interrupted local command and preserves a returned background handle',
  async (context) => {
    const temporary = await mkdtemp(join(tmpdir(), 'agents-local-cancel-'));
    try {
      const directory = await realpath(temporary);
      const cwd = join(directory, 'workspace');
      const sibling = join(directory, 'sibling');
      await Promise.all([mkdir(cwd), mkdir(sibling)]);
      const heartbeat = join(cwd, 'heartbeat');
      let processId = 0;
      const server = new ModelServer([
        [
          call(
            'exec_command',
            {
              cmd: 'read -r value; printf "preserved:%s\\n" "$value"',
              tty: true,
              yield_time_ms: 1000,
            },
            { callId: 'start-background' },
          ),
        ],
        (request) => {
          const handle = /Process running with session ID (\d+)/.exec(
            JSON.stringify(request.input),
          );
          expect(handle).not.toBeNull();
          processId = Number(handle![1]);
          return [message('background started')];
        },
        [
          call(
            'exec_command',
            {
              cmd: 'i=0; while [ "$i" -lt 120 ]; do printf x >> heartbeat; sleep 0.1; i=$((i + 1)); done',
              yield_time_ms: 10_000,
            },
            { callId: 'interrupted-command' },
          ),
        ],
        () => [
          call(
            'write_stdin',
            { session_id: processId, chars: 'done\n', yield_time_ms: 1000 },
            { callId: 'finish-background' },
          ),
        ],
        (request) => {
          expect(JSON.stringify(request.input)).toContain('preserved:done');
          return [message('background finished')];
        },
      ]);
      await using provider = await providerFor(server);
      const agent = new Agent({
        provider,
        model: 'gpt-5',
        instructions: 'Use the local commands.',
      });
      const opened = await agent
        .session({
          environment: Environment.local({
            cwd,
            tools: ['exec_command', 'write_stdin'],
          }),
        })
        .catch((error: unknown) => {
          if (
            error instanceof Error &&
            /could not establish the platform sandbox/.test(error.message) &&
            process.env.OPENAI_AGENTS_REQUIRE_LOCAL_SANDBOX !== '1'
          ) {
            expect(server.requests).toHaveLength(0);
            context.skip('This host cannot launch a nested platform sandbox');
          }
          throw error;
        });
      await using session = opened;
      expect(
        (await (await session.submit('Start a background process.')).wait())
          .finalOutput,
      ).toBe('background started');

      await expect(
        session.submit('Change grants while the returned handle is live.', {
          writableRoots: [sibling],
        }),
      ).rejects.toThrow(
        /Cannot change writable roots while earlier executor work or descendants are retained/,
      );
      expect(server.requests).toHaveLength(2);

      const interrupted = await session.submit('Start the heartbeat.');
      const outcome = interrupted.wait().catch((error: unknown) => error);
      await vi.waitFor(
        async () => expect(await readFile(heartbeat, 'utf8')).toContain('xxx'),
        { timeout: 5000 },
      );
      expect(server.requests).toHaveLength(3);
      await interrupted.cancel();
      expect(await outcome).toMatchObject({ name: 'TurnAborted' });
      const stoppedAt = await readFile(heartbeat, 'utf8');

      expect(
        (await (await session.submit('Finish the background process.')).wait())
          .finalOutput,
      ).toBe('background finished');
      await delay(600);
      expect(await readFile(heartbeat, 'utf8')).toBe(stoppedAt);
      server.assertExhausted();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
  30_000,
);

it.skipIf(!supported)(
  'joins a yielded local process when its result policy is cancelled',
  async (context) => {
    const cwd = await mkdtemp(join(tmpdir(), 'agents-local-result-cancel-'));
    const release = Promise.withResolvers<void>();
    try {
      let acceptedId = 0;
      let withheldId = 0;
      let acceptedOutput = '';
      let withheldOutput = '';
      let probeOutput = '';
      let finishedOutput = '';
      const outputFor = (request: JsonObject, id: string) =>
        JSON.stringify(
          (request.input as JsonObject[]).find(
            (item) =>
              item.type === 'function_call_output' && item.call_id === id,
          )?.output ?? null,
        );
      const server = new ModelServer([
        [
          call(
            'exec_command',
            {
              cmd: 'read -r value; printf "preserved:%s\\n" "$value"',
              tty: true,
              yield_time_ms: 1000,
            },
            { callId: 'accepted-background' },
          ),
        ],
        (request) => {
          acceptedOutput = outputFor(request, 'accepted-background');
          return [message('Accepted process started.')];
        },
        [
          call(
            'exec_command',
            { cmd: 'exec /bin/sleep 120', tty: true, yield_time_ms: 1000 },
            { callId: 'withheld-background' },
          ),
        ],
        (request) => {
          withheldOutput = outputFor(request, 'withheld-background');
          return [
            call(
              'write_stdin',
              { session_id: withheldId, chars: '', yield_time_ms: 1000 },
              { callId: 'poll-withheld' },
            ),
          ];
        },
        (request) => {
          probeOutput = outputFor(request, 'poll-withheld');
          return [
            call(
              'write_stdin',
              { session_id: acceptedId, chars: 'done\n', yield_time_ms: 1000 },
              { callId: 'finish-accepted' },
            ),
          ];
        },
        (request) => {
          finishedOutput = outputFor(request, 'finish-accepted');
          return [message('Process checks finished.')];
        },
      ]);
      await using provider = await providerFor(server);
      const agent = new Agent({
        provider,
        model: nativeDescendantModel,
        instructions: 'Run the fixture commands.',
      });
      const environment = Environment.local({
        cwd,
        tools: ['exec_command', 'write_stdin'],
        async transformResult(info, value) {
          if (info.toolName !== 'exec_command') return value;
          if (
            !value ||
            typeof value !== 'object' ||
            Array.isArray(value) ||
            typeof value.session_id !== 'number'
          )
            throw new Error('Expected a live terminal result');
          if (info.callId === 'accepted-background') {
            acceptedId = value.session_id;
            return { ...value, output: 'accepted result transform' };
          }
          expect(info.callId).toBe('withheld-background');
          withheldId = value.session_id;
          await release.promise;
          return { ...value, output: 'withheld result transform' };
        },
      });
      const opened = await agent
        .session({ environment })
        .catch((error: unknown) => {
          if (
            error instanceof Error &&
            /could not establish the platform sandbox/.test(error.message) &&
            process.env.OPENAI_AGENTS_REQUIRE_LOCAL_SANDBOX !== '1'
          ) {
            expect(server.requests).toHaveLength(0);
            context.skip('This host cannot launch a nested platform sandbox');
          }
          throw error;
        });
      await using session = opened;
      let cancellation: Promise<void> | undefined;
      try {
        const accepted = await session.submit('Start the accepted process.');
        expect((await accepted.wait()).finalOutput).toBe(
          'Accepted process started.',
        );
        expect(acceptedId).toBeGreaterThan(0);
        expect(acceptedOutput).toContain('accepted result transform');
        expect(acceptedOutput).toMatch(
          new RegExp('session_id[^0-9]*' + acceptedId + '(?!\\d)'),
        );

        const withheld = await session.submit('Start the withheld process.');
        const outcome = withheld.wait().catch((error: unknown) => error);
        await vi.waitFor(() => expect(withheldId).toBeGreaterThan(0), {
          timeout: 5000,
        });
        expect(server.requests).toHaveLength(3);
        let cancelled = false;
        cancellation = withheld.cancel().then(() => {
          cancelled = true;
        });
        await delay(50);
        expect(cancelled).toBe(false);
        release.resolve();
        await cancellation;
        expect(await outcome).toMatchObject({ name: 'TurnAborted' });

        const check = await session.submit('Check the two processes.');
        expect((await check.wait()).finalOutput).toBe(
          'Process checks finished.',
        );
        expect(withheldOutput).not.toContain('session_id');
        expect(withheldOutput).not.toContain('withheld result transform');
        expect(probeOutput).not.toBe('null');
        expect(probeOutput).not.toMatch(
          /session_id|Process running with session ID/,
        );
        expect(finishedOutput).toContain('preserved:done');
        await vi.waitFor(
          async () => {
            const items = await Array.fromAsync(session.items());
            expect(items).toContainEqual(
              expect.objectContaining({
                type: 'command_execution',
                callId: 'withheld-background',
                exitCode: expect.any(Number),
              }),
            );
          },
          { timeout: 5000 },
        );
        server.assertExhausted();
      } finally {
        release.resolve();
        await cancellation;
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  60_000,
);

it.skipIf(!supported)(
  'rejects a missing write root before local worker model work',
  async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'agents-local-worker-'));
    try {
      const server = new ModelServer([]);
      await using provider = await providerFor(server);
      const agent = new Agent({
        provider,
        model: 'gpt-5',
        instructions: 'Work.',
      });
      const environment = Environment.local({
        cwd: workspace,
        writableRoots: [join(workspace, 'missing')],
      });
      await expect(agent.session({ environment })).rejects.toThrow(
        /executor write root/,
      );
      expect(server.requests).toHaveLength(0);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  },
  20_000,
);

it.skipIf(!supported)(
  'rejects an alias to the installed helpers as a local write root',
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'agents-helper-overlap-'));
    try {
      const alias = join(cwd, 'package');
      await symlink(packageRoot, alias);
      const server = new ModelServer([]);
      await using provider = await providerFor(server);
      const agent = new Agent({
        provider,
        model: 'gpt-5',
        instructions: 'Work.',
      });
      await expect(
        agent.session({
          environment: Environment.local({ cwd, writableRoots: [alias] }),
        }),
      ).rejects.toThrow(
        /local executor write roots must not contain installed sandbox helpers/,
      );
      expect(server.requests).toHaveLength(0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  20_000,
);

const localStorageOverlap =
  /Keep local session storage outside the executor cwd and writable roots/;
const runtimeHomeOverlap =
  /Keep the native runtime home outside the executor cwd and writable roots/;

it.skipIf(!supported).for(['canonical', 'unicode'] as const)(
  'keeps relocated checklist state outside local grants (%s)',
  { timeout: 45_000 },
  async (spelling, context) => {
    const temporary = await mkdtemp(join(tmpdir(), 'agents-checklist-alias-'));
    try {
      const base = await realpath(temporary);
      const cwd = join(base, 'workspace');
      const extra = join(base, 'extra');
      const storage = localStorage(join(base, 'profile'));
      await Promise.all([mkdir(cwd), mkdir(extra)]);
      const plan = [{ step: 'Inspect the workspace', status: 'completed' }];
      const server = new ModelServer([
        [call('update_plan', { plan }, { callId: 'seed-checklist' })],
        [message('Saved the checklist.')],
        [message('Used a disjoint grant.')],
      ]);
      await using provider = await providerFor(server);
      const agent = new Agent({
        provider,
        model: 'gpt-5',
        instructions: 'Maintain the checklist.',
        tools: [checklist()],
      });
      const environment = Environment.local({ cwd, tools: ['exec_command'] });
      let threadId: string;
      {
        await using seed = await agent
          .session({ environment, storage })
          .catch((error: unknown) => {
            if (
              error instanceof Error &&
              /could not establish the platform sandbox/.test(error.message) &&
              process.env.OPENAI_AGENTS_REQUIRE_LOCAL_SANDBOX !== '1'
            ) {
              context.skip('This host cannot launch a nested platform sandbox');
            }
            throw error;
          });
        threadId = seed.id;
        const turn = await seed.submit('Save the checklist.');
        expect((await turn.wait()).finalOutput).toBe('Saved the checklist.');
        expect(await seed.checklist()).toMatchObject({ plan });
      }
      const directory = join(storage.path, 'sdk-checklists');
      const relocated = join(base, 'relocated-checklists');
      await rename(directory, relocated);
      await symlink(relocated, directory);
      await symlink(extra, join(storage.path, 'application-scratch'));
      const logical = join(relocated, `${threadId}.json`);
      const backing =
        spelling === 'unicode'
          ? join(relocated, `${threadId.toUpperCase()}.j\u017fon`)
          : logical;
      if (backing !== logical) {
        const intermediate = join(relocated, 'checklist-rename');
        await rename(logical, intermediate);
        await rename(intermediate, backing);
      }
      const selectedByStore = existsSync(logical);
      const alias = join(extra, 'linked-checklist');
      await link(backing, alias);
      const open = (writableRoots: string[] = []) =>
        agent.session({
          environment: Environment.local({
            cwd,
            tools: ['exec_command'],
            writableRoots,
          }),
          storage,
          resume: threadId,
        });
      await expect(async () => {
        await using _session = await open([extra]);
      }).rejects.toThrow(localStorageOverlap);
      await expect(async () => {
        await using _session = await open([relocated]);
      }).rejects.toThrow(localStorageOverlap);
      expect(server.requests).toHaveLength(2);
      await using resumed = await open();
      const expectedPlan = selectedByStore ? plan : undefined;
      expect((await resumed.checklist())?.plan).toEqual(expectedPlan);
      await expect(
        resumed.submit('Do not grant the linked checklist.', {
          writableRoots: [extra],
        }),
      ).rejects.toThrow(localStorageOverlap);
      const disjoint = join(base, 'disjoint-checklist-link');
      if (spelling === 'canonical') {
        await rm(backing);
        await symlink(alias, backing);
        await expect(
          resumed.submit('Do not grant the checklist target.', {
            writableRoots: [extra],
          }),
        ).rejects.toThrow(localStorageOverlap);
        await rm(backing);
        await symlink(disjoint, backing);
      }
      expect(server.requests).toHaveLength(2);
      await rename(alias, disjoint);
      const turn = await resumed.submit('Use the disjoint grant.', {
        writableRoots: [extra],
      });
      expect((await turn.wait()).finalOutput).toBe('Used a disjoint grant.');
      expect((await resumed.checklist())?.plan).toEqual(expectedPlan);
      server.assertExhausted();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
);

it.skipIf(!supported)(
  'rejects unverifiable directory aliases in the private native runtime home',
  { timeout: 25_000 },
  async (context) => {
    const temporary = await mkdtemp(join(tmpdir(), 'agents-runtime-alias-'));
    try {
      const base = await realpath(temporary);
      const homes = join(base, 'runtime-homes');
      const cwd = join(base, 'workspace');
      await Promise.all([mkdir(homes), mkdir(cwd)]);
      vi.stubEnv('TMPDIR', homes);
      const server = new ModelServer([[message('Used a private runtime.')]]);
      await using provider = await providerFor(server);
      const agent = new Agent({
        provider,
        model: 'gpt-5',
        instructions: 'Work.',
      });
      const environment = Environment.local({ cwd, tools: ['exec_command'] });
      await using session = await agent
        .session({ environment })
        .catch((error: unknown) => {
          if (
            error instanceof Error &&
            /could not establish the platform sandbox/.test(error.message) &&
            process.env.OPENAI_AGENTS_REQUIRE_LOCAL_SANDBOX !== '1'
          ) {
            context.skip('This host cannot launch a nested platform sandbox');
          }
          throw error;
        });
      const home = (await readdir(homes)).find((name) =>
        name.startsWith('agents-session-'),
      );
      if (!home) throw new Error('The session has no private runtime home.');
      const alias = join(homes, home, 'directory-alias');
      for (const target of [base, alias]) {
        await symlink(target, alias);
        await expect(
          session.submit('Keep the native runtime private.', {
            writableRoots: [],
          }),
        ).rejects.toThrow(
          'symbolic links inside the private native runtime home are unsupported',
        );
        await rm(alias);
      }
      expect(server.requests).toHaveLength(0);
      const turn = await session.submit('Use the private runtime.');
      expect((await turn.wait()).finalOutput).toBe('Used a private runtime.');
      server.assertExhausted();
    } finally {
      vi.unstubAllEnvs();
      await rm(temporary, { recursive: true, force: true });
    }
  },
);

it.skipIf(!supported).for(['sessions', 'dated sessions', 'archives'] as const)(
  'keeps relocated %s outside local grants on open and replacement',
  { timeout: 35_000 },
  async (placement, context) => {
    const temporary = await mkdtemp(join(tmpdir(), 'agents-rollout-root-'));
    try {
      const base = await realpath(temporary);
      const cwd = join(base, 'workspace');
      const extra = join(base, 'extra');
      const storage = localStorage(join(base, 'profile'));
      await Promise.all([mkdir(cwd), mkdir(extra), mkdir(storage.path)]);
      const sessions = join(storage.path, 'sessions');
      let alias = sessions;
      if (placement === 'dated sessions') {
        const [year, month, day] = new Date()
          .toISOString()
          .slice(0, 10)
          .split('-');
        const dated = join(sessions, year!, month!);
        await mkdir(dated, { recursive: true });
        alias = join(dated, day!);
      } else if (placement === 'archives') {
        alias = join(storage.path, 'archived_sessions');
      }
      // Unrelated application symlinks are outside Core's rollout layout.
      await symlink(cwd, join(storage.path, 'unrelated'));
      await symlink(cwd, alias);
      const server = new ModelServer([[message('Persisted safely.')]]);
      await using provider = await providerFor(server);
      const agent = new Agent({
        provider,
        model: 'gpt-5',
        instructions: 'Work.',
      });
      const environment = Environment.local({ cwd });
      const open = () => agent.session({ environment, storage });
      await expect(async () => {
        await using _session = await open();
      }).rejects.toThrow(localStorageOverlap);
      expect(server.requests).toHaveLength(0);

      await rm(alias);
      await symlink(extra, alias);
      await using session = await open().catch((error: unknown) => {
        if (
          error instanceof Error &&
          /could not establish the platform sandbox/.test(error.message) &&
          process.env.OPENAI_AGENTS_REQUIRE_LOCAL_SANDBOX !== '1'
        ) {
          context.skip('This host cannot launch a nested platform sandbox');
        }
        throw error;
      });
      await expect(
        session.submit('Do not grant this directory.', {
          writableRoots: [extra],
        }),
      ).rejects.toThrow(localStorageOverlap);
      expect(server.requests).toHaveLength(0);
      const turn = await session.submit('Persist with a disjoint grant.');
      expect((await turn.wait()).finalOutput).toBe('Persisted safely.');
      server.assertExhausted();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
);

it.skipIf(!supported)(
  'keeps relocated dated sessions outside local grants on open and replacement (alternate spelling)',
  { timeout: 45_000 },
  async (context) => {
    const temporary = await mkdtemp(join(tmpdir(), 'agents-rollout-spelling-'));
    try {
      const base = await realpath(temporary);
      const cwd = join(base, 'workspace');
      const storage = localStorage(join(base, 'profile'));
      const relocated = join(base, 'relocated-sessions');
      const alternate = join(base, 'RELOCATED-SESSIONS');
      const [year, month] = new Date().toISOString().slice(0, 7).split('-');
      const grant = join(relocated, year!, month!);
      await Promise.all([
        mkdir(cwd),
        mkdir(storage.path),
        mkdir(grant, { recursive: true }),
      ]);
      // On a case-insensitive volume the alias uses another spelling of
      // the same directory. Exercise ordinary containment on other volumes.
      await symlink(
        existsSync(alternate) ? alternate : relocated,
        join(storage.path, 'sessions'),
      );
      const server = new ModelServer([[message('Persisted safely.')]]);
      await using provider = await providerFor(server);
      const agent = new Agent({
        provider,
        model: 'gpt-5',
        instructions: 'Work.',
      });
      const open = (writableRoots: string[] = []) =>
        agent.session({
          environment: Environment.local({ cwd, writableRoots }),
          storage,
        });
      await expect(async () => {
        await using _session = await open([grant]);
      }).rejects.toThrow(localStorageOverlap);
      expect(await readdir(grant)).toEqual([]);
      await using session = await open().catch((error: unknown) => {
        if (
          error instanceof Error &&
          /could not establish the platform sandbox/.test(error.message) &&
          process.env.OPENAI_AGENTS_REQUIRE_LOCAL_SANDBOX !== '1'
        ) {
          context.skip('This host cannot launch a nested platform sandbox');
        }
        throw error;
      });
      const beforeReplacement = await readdir(grant);
      await expect(
        session.submit('Do not grant the directory for new rollouts.', {
          writableRoots: [grant],
        }),
      ).rejects.toThrow(localStorageOverlap);
      expect(server.requests).toHaveLength(0);
      expect(await readdir(grant)).toEqual(beforeReplacement);
      const turn = await session.submit('Persist with the disjoint grant.');
      expect((await turn.wait()).finalOutput).toBe('Persisted safely.');
      server.assertExhausted();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
);

it.skipIf(!supported).for(['file alias', 'recorded path'] as const)(
  'keeps a selected local rollout outside grants on resume and replacement (%s)',
  { timeout: 50_000 },
  async (placement, context) => {
    const temporary = await mkdtemp(join(tmpdir(), 'agents-rollout-file-'));
    try {
      const base = await realpath(temporary);
      const cwd = join(base, 'workspace');
      const extra = join(base, 'extra');
      const storage = localStorage(join(base, 'profile'));
      const sessions = join(storage.path, 'sessions');
      await Promise.all([mkdir(cwd), mkdir(extra), mkdir(storage.path)]);
      if (placement === 'recorded path') await symlink(extra, sessions);
      const server = new ModelServer([
        [message('Seeded the history.')],
        [message('Resumed with a disjoint grant.')],
      ]);
      await using provider = await providerFor(server);
      const agent = new Agent({
        provider,
        model: 'gpt-5',
        instructions: 'Work.',
      });
      const environment = Environment.local({ cwd });
      let threadId: string;
      {
        await using seed = await agent
          .session({ environment, storage })
          .catch((error: unknown) => {
            if (
              error instanceof Error &&
              /could not establish the platform sandbox/.test(error.message) &&
              process.env.OPENAI_AGENTS_REQUIRE_LOCAL_SANDBOX !== '1'
            ) {
              context.skip('This host cannot launch a nested platform sandbox');
            }
            throw error;
          });
        threadId = seed.id;
        const turn = await seed.submit('Seed the history.');
        expect((await turn.wait()).finalOutput).toBe('Seeded the history.');
      }
      const open = (writableRoots: string[] = []) =>
        agent.session({
          environment: Environment.local({ cwd, writableRoots }),
          storage,
          resume: threadId,
        });
      if (placement === 'recorded path') {
        // Resume records the canonical path selected by Core in SQLite.
        {
          await using anchored = await open();
          expect(anchored.id).toBe(threadId);
        }
        await rm(sessions);
      } else {
        const files = await readdir(sessions, {
          recursive: true,
          withFileTypes: true,
        });
        const rollout = files.find((entry) =>
          entry.name.endsWith(`${threadId}.jsonl`),
        );
        if (!rollout) throw new Error('The local profile has no rollout.');
        const original = join(rollout.parentPath, rollout.name);
        const relocated = join(extra, rollout.name);
        await rename(original, relocated);
        await symlink(relocated, original);
      }
      await expect(async () => {
        await using _session = await open([extra]);
      }).rejects.toThrow(localStorageOverlap);
      expect(server.requests).toHaveLength(1);
      await using resumed = await open();
      await expect(
        resumed.submit('Do not grant the selected rollout.', {
          writableRoots: [extra],
        }),
      ).rejects.toThrow(localStorageOverlap);
      expect(server.requests).toHaveLength(1);
      const turn = await resumed.submit('Resume with a disjoint grant.');
      expect((await turn.wait()).finalOutput).toBe(
        'Resumed with a disjoint grant.',
      );
      server.assertExhausted();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
);

it.skipIf(!supported).for([
  ['open', 'direct'],
  ['open', 'relocated'],
  ['replacement', 'direct'],
  ['replacement', 'relocated'],
] as const)(
  'rejects a profile database hard link in a local grant on %s (%s)',
  { timeout: 35_000 },
  async ([stage, placement], context) => {
    const temporary = await mkdtemp(join(tmpdir(), 'agents-storage-hardlink-'));
    try {
      const base = await realpath(temporary);
      const cwd = join(base, 'workspace');
      const extra = join(base, 'extra');
      const profile = join(base, 'profile');
      await Promise.all([mkdir(cwd), mkdir(extra)]);
      const server = new ModelServer([
        [message('Seeded the profile.')],
        [message('Used a disjoint grant.')],
      ]);
      await using provider = await providerFor(server);
      const agent = new Agent({
        provider,
        model: 'gpt-5',
        instructions: 'Work.',
      });
      const environment = Environment.local({ cwd, tools: ['exec_command'] });
      const storage = localStorage(profile);
      let threadId: string;
      {
        await using seed = await agent
          .session({ environment, storage })
          .catch((error: unknown) => {
            if (
              error instanceof Error &&
              /could not establish the platform sandbox/.test(error.message) &&
              process.env.OPENAI_AGENTS_REQUIRE_LOCAL_SANDBOX !== '1'
            ) {
              expect(server.requests).toHaveLength(0);
              context.skip('This host cannot launch a nested platform sandbox');
            }
            throw error;
          });
        threadId = seed.id;
        expect(
          (await (await seed.submit('Seed the profile.')).wait()).finalOutput,
        ).toBe('Seeded the profile.');
      }
      const database = (await readdir(profile)).find((name) =>
        /^state_\d+\.sqlite$/.test(name),
      );
      if (!database)
        throw new Error('The local profile has no state database.');
      const original = join(profile, database);
      const backing =
        placement === 'direct' ? original : join(base, 'relocated', database);
      if (placement === 'relocated') {
        await mkdir(join(base, 'relocated'));
        await rename(original, backing);
        await symlink(backing, original);
      }
      const alias = join(stage === 'open' ? cwd : extra, 'linked-storage');
      const disjoint = join(base, 'linked-storage');
      await link(backing, alias);
      const open = () =>
        agent.session({ environment, storage, resume: threadId });
      if (stage === 'open') {
        await expect(async () => {
          await using _session = await open();
        }).rejects.toThrow(localStorageOverlap);
        expect(server.requests).toHaveLength(1);
        await rename(alias, disjoint);
      }
      await using resumed = await open();
      if (stage === 'replacement') {
        await expect(
          resumed.submit('Reject the linked grant.', {
            writableRoots: [extra],
          }),
        ).rejects.toThrow(localStorageOverlap);
        expect(server.requests).toHaveLength(1);
        await rename(alias, disjoint);
      }
      expect(resumed.id).toBe(threadId);
      const turn = await resumed.submit('Use the disjoint grant.', {
        writableRoots: [extra],
      });
      expect((await turn.wait()).finalOutput).toBe('Used a disjoint grant.');
      server.assertExhausted();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
);

it.skipIf(!supported).for(['cwd', 'aliased writable root'] as const)(
  'rejects a local executor grant to the runtime home through %s',
  { timeout: 20_000 },
  async (kind) => {
    const temporary = await mkdtemp(join(tmpdir(), 'agents-runtime-overlap-'));
    try {
      const base = await realpath(temporary);
      const homes = join(base, 'runtime-homes');
      const workspace = join(base, 'workspace');
      const alias = join(base, 'homes-alias');
      await Promise.all([mkdir(homes), mkdir(workspace)]);
      await symlink(homes, alias);
      vi.stubEnv('TMPDIR', homes);
      const server = new ModelServer([]);
      await using provider = await providerFor(server);
      const agent = new Agent({
        provider,
        model: 'gpt-5',
        instructions: 'Work.',
      });
      await expect(async () => {
        await using _session = await agent.session({
          environment: Environment.local({
            cwd: kind === 'cwd' ? homes : workspace,
            tools: ['exec_command'],
            writableRoots: kind === 'cwd' ? [] : [alias],
          }),
        });
      }).rejects.toThrow(runtimeHomeOverlap);
      expect(await readdir(homes)).toEqual([]);
      expect(server.requests).toHaveLength(0);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
);

it
  .skipIf(!supported)
  .for([
    'cwd',
    'aliased writable root',
    'aliased profile',
    'profile link under cwd',
    'root below profile',
  ] as const)(
  'rejects local storage overlap through %s before opening the profile',
  { timeout: 20_000 },
  async (kind) => {
    const temporary = await mkdtemp(join(tmpdir(), 'agents-storage-overlap-'));
    try {
      const base = await realpath(temporary);
      const cwd = join(base, 'workspace');
      const profile = join(base, 'profile');
      const nested = join(profile, 'nested');
      const extra = join(base, 'extra');
      const writableAlias = join(base, 'extra-alias');
      const profileAlias = join(base, 'profile-alias');
      const writableProfileLink = join(cwd, 'profile-link');
      await Promise.all([
        mkdir(cwd),
        mkdir(nested, { recursive: true }),
        mkdir(extra),
      ]);
      await Promise.all([
        symlink(extra, writableAlias),
        symlink(cwd, profileAlias),
        symlink(profile, writableProfileLink),
      ]);

      const configurations = {
        cwd: { path: join(cwd, 'new', 'profile'), roots: [] },
        'aliased writable root': {
          path: join(extra, 'new', 'profile'),
          roots: [writableAlias],
        },
        'aliased profile': { path: join(profileAlias, 'profile'), roots: [] },
        'profile link under cwd': { path: writableProfileLink, roots: [] },
        'root below profile': { path: profile, roots: [nested] },
      };
      const { path, roots } = configurations[kind];
      const server = new ModelServer([]);
      await using provider = await providerFor(server);
      const agent = new Agent({
        provider,
        model: 'gpt-5',
        instructions: 'Work.',
      });
      await expect(async () => {
        await using _session = await agent.session({
          environment: Environment.local({
            cwd,
            tools: ['exec_command'],
            writableRoots: roots,
          }),
          storage: localStorage(path),
        });
      }).rejects.toThrow(localStorageOverlap);
      expect(await readdir(profile)).toEqual(['nested']);
      expect(await readdir(cwd)).toEqual(['profile-link']);
      expect(await readdir(extra)).toEqual([]);
      expect(server.requests).toHaveLength(0);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
);

it.skipIf(!supported)(
  'rejects a portable goal store inside the local executor cwd',
  async (context) => {
    const temporary = await mkdtemp(join(tmpdir(), 'agents-goal-overlap-'));
    try {
      const cwd = await realpath(temporary);
      const server = new ModelServer([[message('Remembered')]]);
      await using provider = await providerFor(server);
      const agent = new Agent({
        provider,
        model: 'gpt-5',
        instructions: 'Work.',
      });
      const environment = Environment.local({ cwd, tools: ['exec_command'] });
      const state = await (async () => {
        const opened = await agent
          .session({ environment })
          .catch((error: unknown) => {
            if (
              error instanceof Error &&
              /could not establish the platform sandbox/.test(error.message) &&
              process.env.OPENAI_AGENTS_REQUIRE_LOCAL_SANDBOX !== '1'
            ) {
              expect(server.requests).toHaveLength(0);
              context.skip('This host cannot launch a nested platform sandbox');
            }
            throw error;
          });
        await using source = opened;
        await (await source.submit('Record the context.')).wait();
        return source.saveState();
      })();
      state.root_goal = {
        thread_id: state.source_session_id,
        objective: 'Retain the objective',
        status: 'paused',
        token_budget: 100,
        tokens_used: 0,
        time_used_seconds: 0,
      };
      // The provider opens portable goal storage inside its temporary home.
      vi.stubEnv('TMPDIR', cwd);
      await expect(async () => {
        await using _session = await agent.session({
          environment,
          state,
        });
      }).rejects.toThrow(localStorageOverlap);
      expect(await readdir(cwd)).toEqual([]);
      server.assertExhausted();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
  20_000,
);

it.skipIf(process.platform !== 'linux').for(['portable', 'local'] as const)(
  'keeps a strict remote Session reusable and validates %s restore',
  { timeout: 30_000 },
  async (kind) => {
    const executor = await startPublicExecutor();
    try {
      const previous = join(executor.cwd, '..', 'previous');
      const next = join(await realpath(executor.cwd), '..', 'next');
      await Promise.all([mkdir(previous), mkdir(next)]);
      const server = new ModelServer([
        [message('new policy')],
        [message('resumed')],
      ]);
      await using provider = await providerFor(server);
      const agent = new Agent({
        provider,
        model: 'gpt-5',
        instructions: 'Work.',
      });
      const connection = {
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
      };
      const original = new Environment({
        ...connection,
        writableRoots: [previous],
      });
      const current = new Environment({ ...connection, writableRoots: [next] });
      const storage =
        kind === 'local'
          ? localStorage(join(executor.cwd, '..', 'local-storage'))
          : undefined;
      let state: SessionState | undefined;
      let sessionId: string;
      {
        await using session = await agent.session({
          environment: original,
          storage,
        });
        sessionId = session.id;
        await expect(
          session.submit('Invalid policy.', {
            writableRoots: [join(next, 'missing')],
          }),
        ).rejects.toThrow(/executor write root/);
        expect(server.requests).toHaveLength(0);
        const turn = await session.submit('Change write roots.', {
          writableRoots: [next],
        });
        expect((await turn.wait()).finalOutput).toBe('new policy');
        for await (const recorded of session.turns()) {
          expect(recorded.receipt?.executors?.[0]).toMatchObject({
            transport: 'remote',
            writableRoots: expect.arrayContaining([
              expect.stringContaining('/next'),
            ]),
          });
        }
        if (!storage) {
          await session.compact({ summary: 'The write roots changed.' });
          state = await session.saveState();
        }
      }
      const restore = storage ? { storage, resume: sessionId } : { state };
      if (state) {
        expect(state.executor_policy_digest).toMatch(/^[a-f0-9]{64}$/);
        const incomplete = { ...state };
        delete incomplete.executor_policy_digest;
        const parsed = parseSessionState(JSON.stringify(incomplete));
        const before = executor.requests.length;
        await expect(
          agent.session({ environment: original, state: parsed }),
        ).rejects.toThrow(/recorded executor write and network policy/);
        expect(executor.requests).toHaveLength(before);
      }
      if (storage) {
        await expect(agent.session(restore)).rejects.toThrow(
          /recorded executor write and network policy/,
        );
      }
      await expect(
        agent.session({ ...restore, environment: original }),
      ).rejects.toThrow(/recorded executor write and network policy/);
      expect(server.requests).toHaveLength(1);
      await using resumed = await agent.session({
        ...restore,
        environment: current,
      });
      expect(
        (await (await resumed.submit('Continue.')).wait()).finalOutput,
      ).toBe('resumed');
      server.assertExhausted();
    } finally {
      await executor.close();
    }
  },
);

it
  .skipIf(process.platform !== 'linux')
  .each(['opening alias', 'turn alias', 'canonical path'] as const)(
  'keeps a reused writable-root path pinned to its %s grant',
  async (source) => {
    const executor = await startPublicExecutor();
    try {
      const cwd = await realpath(executor.cwd);
      const original = join(cwd, '..', 'original-root');
      const replacement = join(cwd, '..', 'replacement-root');
      const grant = source === 'canonical path' ? original : join(cwd, 'alias');
      const declaration = grant + '/';
      await Promise.all([mkdir(original), mkdir(replacement)]);
      if (grant !== original) await symlink(original, grant);
      const server = new ModelServer([
        [message('initial grant')],
        [message('stable alias')],
        [message('explicit grant')],
        [message('reuse after revocation')],
      ]);
      await using provider = await providerFor(server);
      const agent = new Agent({ provider, instructions: 'Work.' });
      await using session = await agent.session({
        environment: new Environment({
          url: executor.url,
          cwd,
          headers: executor.headers,
          writableRoots: source === 'turn alias' ? [] : [declaration],
        }),
      });
      const runWithRoots = async (input: string, writableRoots?: string[]) => {
        const turn = await session.submit(input, { writableRoots });
        await turn.wait();
        const turns = await Array.fromAsync(session.turns());
        return turns.find(({ id }) => id === turn.turnId)?.receipt
          ?.executors?.[0]?.writableRoots;
      };
      await runWithRoots(
        'Establish the grant.',
        source === 'turn alias' ? [original] : undefined,
      );
      expect(
        new Set(await runWithRoots('Reuse the stable path.', [declaration])),
      ).toEqual(
        new Set([pathToFileURL(cwd).href, pathToFileURL(original).href]),
      );
      if (source === 'turn alias') {
        await session.compact({ summary: 'The write grant stays active.' });
      }
      await rm(grant, { recursive: true });
      await symlink(replacement, grant);
      const rebound = await runWithRoots('Reuse the same application grant.', [
        grant,
      ]).catch((error: unknown) => error);
      expect(rebound, JSON.stringify(rebound)).toBeInstanceOf(Error);
      expect(String(rebound)).toMatch(/executor write root.*changed/i);
      expect(server.requests).toHaveLength(2);

      expect(
        new Set(
          await runWithRoots('Grant the new directory explicitly.', [
            replacement,
          ]),
        ),
      ).toEqual(
        new Set([pathToFileURL(cwd).href, pathToFileURL(replacement).href]),
      );
      expect(
        new Set(
          await runWithRoots('Grant the previously removed path.', [grant]),
        ),
      ).toEqual(
        new Set([pathToFileURL(cwd).href, pathToFileURL(replacement).href]),
      );
      server.assertExhausted();
    } finally {
      await executor.close();
    }
  },
  30_000,
);

it.skipIf(process.platform !== 'linux').each(['regranted', 'new'] as const)(
  'requires a canonical target for a %s alias outside the active roots',
  async (kind) => {
    const executor = await startPublicExecutor();
    try {
      const cwd = await realpath(executor.cwd);
      const original = join(cwd, '..', 'original-root');
      const target = join(cwd, '..', 'new-root');
      const alias = join(cwd, 'alias');
      await Promise.all([mkdir(original), mkdir(target)]);
      if (kind === 'regranted') await symlink(original, alias);
      const server = new ModelServer([
        [message('Workspace only')],
        [message('Target granted')],
      ]);
      await using provider = await providerFor(server);
      const agent = new Agent({ provider, instructions: 'Work.' });
      await using session = await agent.session({
        environment: new Environment({
          url: executor.url,
          cwd,
          headers: executor.headers,
          writableRoots: kind === 'regranted' ? [alias] : [],
        }),
      });
      const runWithRoots = async (input: string, writableRoots?: string[]) => {
        const turn = await session.submit(input, { writableRoots });
        await turn.wait();
        const turns = await Array.fromAsync(session.turns());
        return turns.find(({ id }) => id === turn.turnId)?.receipt
          ?.executors?.[0]?.writableRoots;
      };
      expect(
        await runWithRoots(
          'Use just the workspace.',
          kind === 'regranted' ? [] : undefined,
        ),
      ).toEqual([pathToFileURL(cwd).href]);
      if (kind === 'regranted') await rm(alias);
      await symlink(target, alias);
      const grant = await runWithRoots('Grant the alias.', [alias]).catch(
        (error: unknown) => error,
      );
      expect(grant, JSON.stringify(grant)).toBeInstanceOf(Error);
      expect(String(grant)).toMatch(/new executor write roots.*canonical/i);
      expect(server.requests).toHaveLength(1);

      expect(
        new Set(await runWithRoots('Grant the target explicitly.', [target])),
      ).toEqual(new Set([pathToFileURL(cwd).href, pathToFileURL(target).href]));
      server.assertExhausted();
    } finally {
      await executor.close();
    }
  },
  30_000,
);

it.skipIf(!supported)(
  'rejects an executor workspace symlink pivot before replacing additional write roots',
  async () => {
    const executor = await startPublicExecutor();
    try {
      const original = join(executor.cwd, 'original');
      const external = join(executor.cwd, '..', 'outside');
      const alias = join(executor.cwd, 'alias');
      await Promise.all([mkdir(original), mkdir(external)]);
      await symlink(original, alias);
      const server = new ModelServer([[message('before')], [message('after')]]);
      await using provider = await providerFor(server);
      const agent = new Agent({
        provider,
        model: 'gpt-5',
        instructions: 'Work.',
      });
      await using session = await agent.session({
        environment: new Environment({
          url: executor.url,
          cwd: alias,
          headers: executor.headers,
          writableRoots: [executor.cwd],
        }),
      });
      expect((await (await session.submit('Begin.')).wait()).finalOutput).toBe(
        'before',
      );
      await rm(alias);
      await symlink(external, alias);
      await expect(
        session.submit('Narrow the write grant.', { writableRoots: [] }),
      ).rejects.toThrow(/executor workspace changed/);
      expect(server.requests).toHaveLength(1);
      await rm(alias);
      await symlink(original, alias);
      const turn = await session.submit('Keep the write grant.', {
        writableRoots: [executor.cwd],
      });
      expect((await turn.wait()).finalOutput).toBe('after');
      server.assertExhausted();
    } finally {
      await executor.close();
    }
  },
  30_000,
);

it.skipIf(!supported).for(['portable', 'local'] as const)(
  'applies a per-turn write policy and requires the current policy on %s restore',
  { timeout: 45_000 },
  async (kind, context) => {
    const temporary = await mkdtemp(join(tmpdir(), 'agents-local-policy-'));
    try {
      const workspace = await realpath(temporary);
      const cwd = join(workspace, 'cwd');
      const previous = join(workspace, 'previous');
      const next = join(workspace, 'next');
      const homes = join(workspace, 'runtime-homes');
      await Promise.all(
        [cwd, previous, next, homes].map((path) => mkdir(path)),
      );
      vi.stubEnv('TMPDIR', homes);
      const previousFile = join(previous, 'marker');
      const nextFile = join(next, 'marker');
      await writeFile(previousFile, 'previous');
      const command =
        `if (printf denied > "${previousFile}") 2>/dev/null; then exit 11; fi; ` +
        `printf expanded > "${nextFile}"`;
      const server = new ModelServer([
        [
          call(
            'exec_command',
            { cmd: `printf added > "${nextFile}"` },
            { callId: 'local-root-expansion' },
          ),
        ],
        [message('expanded policy')],
        [message('replaced policy')],
        [
          call(
            'exec_command',
            { cmd: command },
            { callId: 'local-root-receipt' },
          ),
        ],
        [message('resumed')],
      ]);
      await using provider = await providerFor(server);
      const agent = new Agent({
        provider,
        model: 'gpt-5',
        instructions: 'Work.',
      });
      const original = Environment.local({
        cwd,
        tools: ['exec_command'],
        writableRoots: [previous],
      });
      const current = Environment.local({
        cwd,
        tools: ['exec_command'],
        writableRoots: [next],
      });
      const storage =
        kind === 'local' ? localStorage(join(workspace, 'storage')) : undefined;
      let state: SessionState | undefined;
      let sessionId: string;
      {
        const opened = await agent
          .session({ environment: original, storage })
          .catch((error: unknown) => {
            if (
              error instanceof Error &&
              /could not establish the platform sandbox/.test(error.message) &&
              process.env.OPENAI_AGENTS_REQUIRE_LOCAL_SANDBOX !== '1'
            ) {
              expect(server.requests).toHaveLength(0);
              context.skip('This host cannot launch a nested platform sandbox');
            }
            throw error;
          });
        await using session = opened;
        sessionId = session.id;
        await expect(
          session.submit('Reject helper overlap.', {
            writableRoots: [await realpath(packageRoot)],
          }),
        ).rejects.toThrow(
          /local executor write roots must not contain installed sandbox helpers/,
        );
        await expect(
          session.submit('Reject runtime home overlap.', {
            writableRoots: [homes],
          }),
        ).rejects.toThrow(runtimeHomeOverlap);
        if (storage) {
          await expect(
            session.submit('Reject profile overlap.', {
              writableRoots: [await realpath(workspace)],
            }),
          ).rejects.toThrow(localStorageOverlap);
        }
        expect(server.requests).toHaveLength(0);
        const expanded = await session.submit('Add the sibling write root.', {
          writableRoots: [previous, next],
        });
        expect((await expanded.wait()).finalOutput).toBe('expanded policy');
        expect(await readFile(nextFile, 'utf8')).toBe('added');
        const expandedReceipt = (await Array.fromAsync(session.turns())).at(-1)
          ?.receipt?.executors?.[0];
        expect(expandedReceipt).toMatchObject({
          transport: 'local',
          writableRoots: expect.arrayContaining([
            expect.stringContaining('/previous'),
            expect.stringContaining('/next'),
          ]),
        });
        const turn = await session.submit('Remove the old write root.', {
          writableRoots: [next],
        });
        expect((await turn.wait()).finalOutput).toBe('replaced policy');
        const replacedReceipt = (await Array.fromAsync(session.turns())).at(-1)
          ?.receipt?.executors?.[0];
        expect(replacedReceipt).toMatchObject({
          transport: 'local',
          writableRoots: expect.arrayContaining([
            expect.stringContaining('/next'),
          ]),
        });
        expect(replacedReceipt?.writableRoots).not.toEqual(
          expect.arrayContaining([expect.stringContaining('/previous')]),
        );
        if (!storage) state = await session.saveState();
      }
      const restore = storage ? { storage, resume: sessionId } : { state };
      if (storage) {
        await expect(
          agent.session({
            ...restore,
            environment: Environment.local({
              cwd: workspace,
              tools: ['exec_command'],
            }),
          }),
        ).rejects.toThrow(localStorageOverlap);
      }
      await expect(
        agent.session({ ...restore, environment: original }),
      ).rejects.toThrow(
        /recorded executor write and network policy|applied executor policy/,
      );
      expect(server.requests).toHaveLength(3);
      {
        await using resumed = await agent.session({
          ...restore,
          environment: current,
        });
        const turn = await resumed.submit('Write in the new root.');
        expect((await turn.wait()).finalOutput).toBe('resumed');
        const receipts = [];
        for await (const item of resumed.items()) {
          if (
            item.type === 'command_execution' &&
            item.callId === 'local-root-receipt'
          )
            receipts.push(item);
        }
        expect(receipts).toEqual([
          expect.objectContaining({
            callId: 'local-root-receipt',
            exitCode: 0,
            status: 'completed',
          }),
        ]);
      }
      expect(await readFile(previousFile, 'utf8')).toBe('previous');
      expect(await readFile(nextFile, 'utf8')).toBe('expanded');
      server.assertExhausted();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
);

it.skipIf(!supported)(
  'keeps the opening write policy on a WSS executor that reports macOS',
  async () => {
    const executor = await startPublicExecutor({
      environmentInfoOverride: { platformOs: 'macos' },
    });
    try {
      const cwd = await realpath(executor.cwd);
      const original = join(cwd, '..', 'original');
      const retained = join(cwd, '..', 'retained');
      const next = join(cwd, '..', 'next');
      await Promise.all([mkdir(original), mkdir(retained), mkdir(next)]);
      const server = new ModelServer([[message('Same grant')]]);
      await using provider = await providerFor(server);
      const agent = new Agent({ provider, instructions: 'Work.' });
      await using session = await agent.session({
        environment: new Environment({
          url: executor.url,
          headers: executor.headers,
          cwd,
          writableRoots: [original, retained],
        }),
      });
      for (const writableRoots of [
        [],
        [next, retained],
        [original, retained, next],
      ]) {
        await expect(
          session.submit('Change the grant.', { writableRoots }),
        ).rejects.toThrow(/Cannot change writable roots on a macOS executor/);
      }
      expect(server.requests).toHaveLength(0);
      const turn = await session.submit('Keep the same grant.', {
        writableRoots: [retained, original + '/'],
      });
      expect((await turn.wait()).finalOutput).toBe('Same grant');
      server.assertExhausted();
    } finally {
      await executor.close();
    }
  },
  30_000,
);

function compileDetachedChild(cwd: string) {
  // Capture compiler stderr so execFileSync does not write it to the test process.
  execFileSync(
    '/usr/bin/cc',
    [
      join(import.meta.dirname, 'fixtures', 'detached-child.c'),
      '-o',
      join(cwd, 'detach'),
    ],
    { stdio: 'pipe' },
  );
}

it
  .skipIf(process.platform !== 'darwin')
  .for(['terminal completion', 'Session disposal'] as const)(
  'joins a detached local child at %s',
  { timeout: 45_000 },
  async (boundary) => {
    const directory = await mkdtemp(join(tmpdir(), 'agents-detached-close-'));
    const cwd = join(directory, 'workspace');
    const original = join(directory, 'original');
    const tag = basename(directory);
    const pidFile = join(cwd, tag);
    const readPid = async () => Number(await readFile(pidFile, 'utf8'));
    const isTaggedChild = (pid: number) => {
      const probe = spawnSync(
        '/bin/ps',
        ['-ww', '-p', String(pid), '-o', 'command='],
        {
          encoding: 'utf8',
        },
      );
      if (probe.error) throw probe.error;
      expect(probe.status === 0 || (probe.status === 1 && !probe.stderr)).toBe(
        true,
      );
      return probe.stdout.trimEnd().endsWith(' ' + tag);
    };
    const releaseChild = async (pid: number) => {
      await writeFile(join(cwd, 'release'), '');
      await vi.waitFor(() => expect(isTaggedChild(pid)).toBe(false), {
        timeout: 5_000,
      });
    };
    const checkStopped = async (pid: number) => {
      const childSurvived = isTaggedChild(pid);
      await releaseChild(pid);
      await expect(readFile(join(original, 'marker'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(childSurvived).toBe(false);
    };
    try {
      await Promise.all([mkdir(cwd), mkdir(original)]);
      compileDetachedChild(cwd);
      const callId = 'detach-local-child-before-close';
      let childSurvivedCommand: boolean | undefined;
      const server = new ModelServer([
        [
          call(
            'exec_command',
            { cmd: 'exec ./detach ' + tag + ' </dev/null >/dev/null 2>&1' },
            { callId },
          ),
        ],
        async () => {
          if (boundary === 'terminal completion') {
            childSurvivedCommand = isTaggedChild(await readPid());
          }
          return [message('Terminal exited')];
        },
      ]);
      await using provider = await providerFor(server);
      const agent = new Agent({ provider, instructions: 'Work.' });
      let childPid: number;
      {
        await using session = await agent.session({
          environment: Environment.local({
            cwd: await realpath(cwd),
            tools: ['exec_command'],
            writableRoots: [await realpath(original)],
          }),
        });
        const turn = await session.submit('Detach a child.');
        expect((await turn.wait()).finalOutput).toBe('Terminal exited');
        childPid = await readPid();
        expect(Number.isSafeInteger(childPid) && childPid > 1).toBe(true);
        const command = (await Array.fromAsync(session.items()))
          .filter((item) => item.type === 'command_execution')
          .find((item) => item.callId === callId);
        const exitCode = command?.exitCode;
        // Exit 3 means the sandbox ended the child before it signaled readiness.
        expect([0, 3]).toContain(exitCode);
        expect(command?.status).toBe(exitCode === 0 ? 'completed' : 'failed');
        if (exitCode === 3) expect(isTaggedChild(childPid)).toBe(false);
        server.assertExhausted();
        if (boundary === 'terminal completion') {
          await checkStopped(childPid);
          expect(childSurvivedCommand).toBe(false);
        }
      }
      if (boundary === 'Session disposal') await checkStopped(childPid);
    } finally {
      try {
        const childPid = await readPid().catch(() => NaN);
        if (
          Number.isSafeInteger(childPid) &&
          childPid > 1 &&
          isTaggedChild(childPid)
        ) {
          await releaseChild(childPid);
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  },
);

it.skipIf(process.platform !== 'darwin')(
  'confirms Session close with a stopped macOS command wrapper',
  async () => {
    const directory = await realpath(
      await mkdtemp(join(tmpdir(), 'agents-paused-wrapper-')),
    );
    const marker = join(directory, 'heartbeat');
    const quotedMarker = "'" + marker.replaceAll("'", "'\\''") + "'";
    const heartbeat = () => readFile(marker, 'utf8');
    const details = (pid: number) => {
      const result = spawnSync(
        '/bin/ps',
        ['-ww', '-p', String(pid), '-o', 'stat=,lstart=,command='],
        { encoding: 'utf8' },
      );
      if (result.error) throw result.error;
      if (result.status === 1 && !result.stderr) return null;
      expect(result.status, result.stderr).toBe(0);
      const match = /^(\S+)\s+(.+)$/.exec(result.stdout.trim());
      expect(match).not.toBeNull();
      return { stopped: match![1]!.startsWith('T'), identity: match![2]! };
    };
    const signal = (pid: number, action: 'SIGSTOP' | 'SIGCONT') => {
      try {
        process.kill(pid, action);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    };
    try {
      const helper = await realpath(
        join(packageRoot, 'bin', 'codex-sdk-runtime'),
      );
      const wrapperCommand = helper + ' --codex-sdk-darwin-command ';
      const server = new ModelServer([
        [
          call(
            'exec_command',
            {
              cmd:
                'printf "%s\\n" "$$" > ' +
                quotedMarker +
                '; i=0; while [ "$i" -lt 180 ]; do printf x >> ' +
                quotedMarker +
                '; /bin/sleep 0.25; i=$((i + 1)); done',
              yield_time_ms: 1000,
            },
            { callId: 'paused-wrapper-heartbeat' },
          ),
        ],
        (request) => {
          expect(JSON.stringify(request.input)).toMatch(
            /Process running with session ID \d+/,
          );
          return [message('Heartbeat running.')];
        },
      ]);
      await using provider = await providerFor(server);
      const agent = new Agent({
        provider,
        instructions: 'Use the local command.',
      });
      const session = await agent.session({
        environment: Environment.local({
          cwd: directory,
          tools: ['exec_command'],
        }),
      });
      let pausedWrapper: { pid: number; identity: string } | undefined;
      try {
        const turn = await session.submit('Start the heartbeat.');
        expect((await turn.wait()).finalOutput).toBe('Heartbeat running.');
        const wrappers = execFileSync(
          '/bin/ps',
          ['-axww', '-o', 'pid=,ppid=,command='],
          { encoding: 'utf8' },
        )
          .split('\n')
          .map((row) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(row))
          .filter(
            (row) =>
              Number(row?.[2]) === process.pid &&
              row?.[3]?.startsWith(wrapperCommand),
          );
        expect(wrappers).toHaveLength(1);
        const wrapperPid = Number(wrappers[0]![1]);
        const wrapper = details(wrapperPid);
        expect(wrapper?.identity).toContain(wrapperCommand);
        const payloadPid = Number((await heartbeat()).split('\n')[0]);
        expect(Number.isSafeInteger(payloadPid) && payloadPid > 1).toBe(true);
        const payload = details(payloadPid);
        expect(payload?.identity).toContain(marker);

        signal(wrapperPid, 'SIGSTOP');
        pausedWrapper = { pid: wrapperPid, identity: wrapper!.identity };
        await vi.waitFor(
          () =>
            expect(details(wrapperPid)).toEqual({
              stopped: true,
              identity: wrapper!.identity,
            }),
          { timeout: 2_000 },
        );
        const beforeClose = await heartbeat();
        await vi.waitFor(async () =>
          expect((await heartbeat()).length).toBeGreaterThan(
            beforeClose.length,
          ),
        );

        await session.close();
        expect(details(wrapperPid)?.identity).not.toBe(wrapper!.identity);
        expect(details(payloadPid)?.identity).not.toBe(payload!.identity);
        const atClose = await heartbeat();
        await delay(600);
        expect(await heartbeat()).toBe(atClose);
        server.assertExhausted();
      } finally {
        if (pausedWrapper) {
          const current = details(pausedWrapper.pid);
          if (current?.stopped && current.identity === pausedWrapper.identity) {
            signal(pausedWrapper.pid, 'SIGCONT');
          }
        }
        await session.close().catch(() => {});
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  45_000,
);

it.skipIf(process.platform !== 'darwin')(
  'blocks delegation from a local command to launchd',
  async () => {
    const launchctl = (...args: string[]) => {
      const result = spawnSync('/bin/launchctl', args, {
        encoding: 'utf8',
        timeout: 5_000,
      });
      if (result.error) throw result.error;
      return result;
    };
    const uid = process.getuid!();
    const gui = `gui/${uid}`;
    const domain = launchctl('print', gui).status === 0 ? gui : `user/${uid}`;
    const label = `org.openai.agents.sdk-test.${randomUUID()}`;
    const service = `${domain}/${label}`;
    const runCount = () => {
      const result = launchctl('print', service);
      expect(result.status, result.stderr).toBe(0);
      const count = /^\s*runs = (\d+)/m.exec(result.stdout)?.[1];
      expect(count, result.stdout).toBeDefined();
      return Number(count);
    };
    const quote = (arg: string) => `'${arg.replaceAll("'", "'\\''")}'`;

    const directory = await mkdtemp(join(tmpdir(), 'agents-launchd-'));
    try {
      const root = await realpath(directory);
      const cwd = join(root, 'workspace');
      const marker = join(root, 'launchd-marker');
      const plist = join(cwd, `${label}.plist`);
      await mkdir(cwd);
      const xmlMarker = marker
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
      const sessionType = domain.startsWith('user/')
        ? '<key>LimitLoadToSessionType</key><string>Background</string>'
        : '';
      await writeFile(
        plist,
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>/usr/bin/touch</string><string>${xmlMarker}</string></array>
  <key>RunAtLoad</key><false/>
  <key>KeepAlive</key><false/>
  <key>ExitTimeOut</key><integer>2</integer>
  <key>ThrottleInterval</key><integer>1</integer>
  ${sessionType}
</dict>
</plist>
`,
      );

      const attempts = [
        ['bootstrap', [domain, plist]],
        ['kickstart', [service]],
      ] as const;
      const server = new ModelServer(
        attempts.flatMap(([operation, args]) => {
          const command = ['/bin/launchctl', operation, ...args]
            .map(quote)
            .join(' ');
          return [
            [
              call(
                'exec_command',
                {
                  cmd: `rc=0; ${command} || rc=$?; printf '${operation} exit %s\\n' "$rc"`,
                  yield_time_ms: 10_000,
                },
                { callId: operation },
              ),
            ],
            [message('checked')],
          ];
        }),
      );
      await using provider = await providerFor(server);
      const agent = new Agent({ provider, instructions: 'Work.' });

      expect(launchctl('print', service).status).not.toBe(0);
      expect(existsSync(marker)).toBe(false);
      {
        await using session = await agent.session({
          environment: Environment.local({ cwd, tools: ['exec_command'] }),
        });
        const tryDelegation = async (operation: 'bootstrap' | 'kickstart') => {
          const turn = await session.submit(`Try launchctl ${operation}.`);
          expect((await turn.wait()).finalOutput).toBe('checked');
          const command = (await Array.fromAsync(session.items()))
            .filter((item) => item.type === 'command_execution')
            .find((item) => item.callId === operation);
          expect(command?.output).toMatch(
            new RegExp(`^${operation} exit [1-9]\\d*$`, 'm'),
          );
        };
        await tryDelegation('bootstrap');
        expect(launchctl('print', service).status).not.toBe(0);
        expect(existsSync(marker)).toBe(false);

        const bootstrapped = launchctl('bootstrap', domain, plist);
        expect(bootstrapped.status, bootstrapped.stderr).toBe(0);
        expect(runCount()).toBe(0);

        await tryDelegation('kickstart');
        expect(runCount()).toBe(0);
        expect(existsSync(marker)).toBe(false);
      }

      const kicked = launchctl('kickstart', service);
      expect(kicked.status, kicked.stderr).toBe(0);
      await vi.waitFor(() => expect(existsSync(marker)).toBe(true), {
        timeout: 5_000,
      });
      expect(runCount()).toBe(1);
      server.assertExhausted();
    } finally {
      try {
        const stopped = launchctl('bootout', service);
        if (stopped.status !== 0) {
          expect(launchctl('print', service).status, stopped.stderr).not.toBe(
            0,
          );
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  },
  45_000,
);

// Honor the host restriction unless native sandbox execution is required.
it
  .skipIf(
    !supported ||
      (process.env.GITHUB_ACTIONS !== 'true' &&
        process.env.OPENAI_AGENTS_TEST_IN_CODEX_SANDBOX === '1' &&
        process.env.OPENAI_AGENTS_REQUIRE_LOCAL_SANDBOX !== '1'),
  )
  .for(['portable', 'local'] as const)(
  'applies a per-turn write policy to linked Git worktrees and fixed network on %s restore',
  { timeout: 120_000 },
  async (route) => {
    const base = await realpath(
      await mkdtemp(join(tmpdir(), 'agents-linked-policy-')),
    );
    const origin = join(base, 'origin');
    const linked = join(base, 'linked');
    const sibling = join(base, 'sibling');
    const cache = join(base, 'cache');
    const locks = join(base, 'locks');
    const outside = join(base, 'outside');
    const peer = createServer((request, response) => {
      hits.push(request.url!);
      response.end(`boundary-peer ${request.url}`);
    });
    const hits: string[] = [];
    try {
      await Promise.all([mkdir(origin), mkdir(cache), mkdir(locks)]);
      // Hosted runners can install Node outside the executor's filesystem view.
      const nodeBinary = join(cache, 'node');
      await copyFile(process.execPath, nodeBinary);
      // The plain HTTP probe does not need a host OpenSSL configuration.
      const opensslConfig = join(cache, 'openssl.cnf');
      await writeFile(opensslConfig, '');
      // Apple's /usr/bin/git is an xcrun shim. Execute the real Git binary in
      // the sandbox without granting an Xcode installation write access.
      const gitBinary =
        process.platform === 'darwin' ? join(cache, 'git') : '/usr/bin/git';
      if (process.platform === 'darwin') {
        await copyFile(
          execFileSync('/usr/bin/xcrun', ['--find', 'git'], {
            encoding: 'utf8',
          }).trim(),
          gitBinary,
        );
      }
      const git = (cwd: string, ...args: string[]) =>
        execFileSync(gitBinary, ['-C', cwd, ...args], {
          encoding: 'utf8',
          env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_NOSYSTEM: '1',
          },
        }).trim();
      git(origin, 'init', '-q');
      git(
        origin,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'initial',
      );
      git(origin, 'worktree', 'add', '-q', '-b', 'linked', linked);
      git(origin, 'worktree', 'add', '-q', '-b', 'sibling', sibling);
      const first = [
        git(linked, 'rev-parse', '--absolute-git-dir'),
        join(origin, '.git'),
        cache,
      ];
      // A common-dir grant alone does not grant another worktree's private gitdir.
      const expanded = [
        ...first,
        sibling,
        git(sibling, 'rev-parse', '--absolute-git-dir'),
        locks,
      ];
      const linkedHead = git(linked, 'rev-parse', 'HEAD');
      const siblingHead = git(sibling, 'rev-parse', 'HEAD');
      await writeFile(outside, 'protected');
      await writeFile(join(sibling, 'sentinel'), 'ungranted');
      await writeFile(join(locks, 'sentinel'), 'ungranted');
      await new Promise<void>((resolve, reject) => {
        peer.once('error', reject);
        peer.listen(0, '127.0.0.1', resolve);
      });
      const address = peer.address();
      if (!address || typeof address === 'string')
        throw new Error('Missing HTTP fixture address');
      const network = {
        allowedDomains: ['127.0.0.1'],
        deniedDomains: ['localhost'],
        allowAllUnixSockets: process.platform === 'linux',
        allowLocalBinding: true,
      };
      const quote = (arg: string) => `'${arg.replaceAll("'", "'\\''")}'`;
      // Force both names for the same peer through the managed proxy. A fresh
      // Agent avoids Node's automatic environment proxy applying a second time.
      const request = (host: string, stage: string) =>
        `${quote(nodeBinary)} --openssl-config=${quote(opensslConfig)} -e ${quote(`
        const http = require('node:http');
        const target = 'http://${host}:${address.port}/${stage}';
        const proxy = new URL(process.env.HTTP_PROXY || process.env.http_proxy);
        const req = http.get(proxy, {path: target, headers: {host: new URL(target).host}, agent: new http.Agent()}, response => {
          let body = '';
          response.on('data', chunk => body += chunk);
          response.on('end', () => {console.log(response.statusCode + ' ' + body); if (response.statusCode !== 200) process.exitCode = 42;});
        });
        req.setTimeout(5000, () => req.destroy(new Error('HTTP probe timed out')));
        req.on('error', error => {console.error(error.message); process.exitCode = 43;});
      `)}`;
      const commit = `export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1; ${quote(gitBinary)} add result.txt; ${quote(gitBinary)} -c user.name=Fixture -c user.email=fixture@example.invalid -c gc.auto=0 commit -qm boundary`;
      const commands = [
        `set -e; printf initial > result.txt; printf initial > ${quote(join(cache, 'marker'))}; (printf denied > ${quote(outside)}) 2>/dev/null || true; (printf denied > ${quote(join(sibling, 'sentinel'))}) 2>/dev/null || true; (printf denied > ${quote(join(locks, 'sentinel'))}) 2>/dev/null || true; ${commit}`,
        `set -e; printf expanded > ${quote(join(sibling, 'result.txt'))}; printf expanded > ${quote(join(locks, 'request.lock'))}; printf expanded >> ${quote(join(cache, 'marker'))}; (printf denied > ${quote(outside)}) 2>/dev/null || true; cd ${quote(sibling)}; ${commit}`,
        `set -e; printf resumed >> result.txt; printf resumed >> ${quote(join(sibling, 'result.txt'))}; printf resumed >> ${quote(join(locks, 'request.lock'))}; printf resumed >> ${quote(join(cache, 'marker'))}; (printf denied > ${quote(outside)}) 2>/dev/null || true`,
      ];
      const stages = ['initial', 'expanded', 'resumed'];
      const server = new ModelServer(
        stages.flatMap((stage, index) => [
          [
            call(
              'exec_command',
              { cmd: commands[index] },
              { callId: `${stage}-files` },
            ),
          ],
          [
            call(
              'exec_command',
              { cmd: request('127.0.0.1', stage) },
              { callId: `${stage}-allow` },
            ),
          ],
          [
            call(
              'exec_command',
              { cmd: request('localhost', stage) },
              { callId: `${stage}-deny` },
            ),
          ],
          [message(stage)],
        ]),
      );
      await using provider = await providerFor(server);
      const agent = new Agent({
        provider,
        model: 'gpt-5',
        instructions: 'Work.',
      });
      const storage =
        route === 'local' ? localStorage(join(base, 'storage')) : undefined;
      const environment = (roots: string[]) =>
        Environment.local({
          cwd: linked,
          writableRoots: roots,
          tools: ['exec_command'],
          network,
        });
      const run = async (session: Session, stage: string, roots?: string[]) => {
        expect(
          (
            await (
              await session.submit(stage, roots ? { writableRoots: roots } : {})
            ).wait()
          ).finalOutput,
        ).toBe(stage);
        const items = await Array.fromAsync(session.items());
        expect(items).toContainEqual(
          expect.objectContaining({
            type: 'command_execution',
            callId: `${stage}-files`,
            exitCode: 0,
            status: 'completed',
          }),
        );
        expect(items).toContainEqual(
          expect.objectContaining({
            type: 'command_execution',
            callId: `${stage}-allow`,
            exitCode: 0,
            status: 'completed',
            output: expect.stringContaining(`200 boundary-peer /${stage}`),
          }),
        );
        const denied = items
          .filter((item) => 'callId' in item && item.callId === `${stage}-deny`)
          .map((item) => ('output' in item ? item.output : ''))
          .join('\n');
        expect(denied).toMatch(/blocked|denied|403/i);
        expect(await readFile(outside, 'utf8')).toBe('protected');
        const receipt = (await Array.fromAsync(session.turns())).at(-1)?.receipt
          ?.executors?.[0];
        expect(receipt?.networkPolicy?.domains).toEqual({
          '127.0.0.1': 'allow',
          localhost: 'deny',
        });
        return receipt;
      };
      await using session = await agent.session({
        environment: environment(first),
        ...(storage ? { storage } : {}),
      });
      const initial = await run(session, 'initial');
      expect(await readFile(join(sibling, 'sentinel'), 'utf8')).toBe(
        'ungranted',
      );
      expect(await readFile(join(locks, 'sentinel'), 'utf8')).toBe('ungranted');
      const updated = await run(session, 'expanded', expanded);
      const restore = storage
        ? { storage, resume: session.id }
        : { state: await session.saveState() };
      await session.close();
      const count = server.requests.length;
      await expect(
        agent.session({ ...restore, environment: environment(first) }),
      ).rejects.toThrow(
        /recorded executor write and network policy|applied executor policy/,
      );
      await expect(
        agent.session({
          ...restore,
          environment: Environment.local({
            cwd: linked,
            writableRoots: expanded,
            tools: ['exec_command'],
            network: { ...network, allowedDomains: ['different.invalid'] },
          }),
        }),
      ).rejects.toThrow(
        /recorded executor write and network policy|applied executor policy|network policy/,
      );
      expect(server.requests).toHaveLength(count);
      await using resumed = await agent.session({
        ...restore,
        environment: environment(expanded),
      });
      const reopened = await run(resumed, 'resumed');
      expect(new Set(initial?.writableRoots)).toEqual(
        new Set([linked, ...first].map((path) => pathToFileURL(path).href)),
      );
      expect(new Set(updated?.writableRoots)).toEqual(
        new Set([linked, ...expanded].map((path) => pathToFileURL(path).href)),
      );
      expect(reopened).toEqual(updated);
      expect(hits).toEqual(['/initial', '/expanded', '/resumed']);
      expect(git(linked, 'rev-parse', 'HEAD')).not.toBe(linkedHead);
      expect(git(sibling, 'rev-parse', 'HEAD')).not.toBe(siblingHead);
      expect(git(sibling, 'show', 'HEAD:result.txt')).toBe('expanded');
      expect(await readFile(join(sibling, 'result.txt'), 'utf8')).toBe(
        'expandedresumed',
      );
      expect(await readFile(join(locks, 'request.lock'), 'utf8')).toBe(
        'expandedresumed',
      );
      expect(await readFile(join(cache, 'marker'), 'utf8')).toBe(
        'initialexpandedresumed',
      );
      server.assertExhausted();
    } finally {
      peer.closeAllConnections();
      if (peer.listening)
        await new Promise<void>((resolve, reject) =>
          peer.close((error) => (error ? reject(error) : resolve())),
        );
      await rm(base, { recursive: true, force: true });
    }
  },
);
