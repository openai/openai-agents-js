import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  chmod,
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
import { createServer as createUnixServer } from 'node:net';
import { homedir, tmpdir, userInfo } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import {
  Agent,
  ChatCompletionsModel,
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
import { text, toolCall, withScriptedResponses } from '@openai/agents/testing';
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

const isLinux = process.platform === 'linux';
const supported = isLinux || process.platform === 'darwin';
const packageRoot = join(import.meta.dirname, '..', '..');

const shellQuote = (arg: string) => `'${arg.replaceAll("'", "'\\''")}'`;

it.skipIf(!supported)(
  'scopes trusted local workspace writes, private authentication and command temp',
  async (context) => {
    const temporary = await mkdtemp(join(tmpdir(), 'agents-trusted-local-'));
    try {
      const base = await realpath(temporary);
      const cwd = join(base, 'workspace');
      const extra = join(base, 'extra');
      const replacement = join(base, 'replacement');
      const sibling = join(base, 'sibling');
      const homes = join(base, 'runtime-homes');
      const login = join(base, 'codex-home');
      const tools = join(base, 'toolchain');
      await Promise.all(
        [cwd, extra, replacement, sibling, homes, login, tools].map((p) =>
          mkdir(p),
        ),
      );
      const outside = join(base, 'outside');
      const readAlias = join(cwd, 'host-capability');
      const auth = join(base, 'private-login-target');
      const authAlias = join(cwd, 'private-alias');
      const oauth = join(login, '.credentials.json');
      const fakeHelper = join(base, 'fake-bwrap-ran');
      const nativeAuthPath = join(cwd, 'native-auth-path');
      await Promise.all([
        writeFile(outside, 'outside'),
        writeFile(auth, 'synthetic-login'),
        writeFile(oauth, 'synthetic-oauth'),
        symlink(outside, readAlias),
        symlink(auth, authAlias),
        symlink(auth, join(login, 'auth.json')),
        writeFile(
          join(tools, 'sdk-fixture-tool'),
          '#!/bin/sh\nprintf inherited',
          { mode: 0o755 },
        ),
        writeFile(
          join(tools, 'bwrap'),
          `#!/bin/sh\nprintf unsafe > ${shellQuote(fakeHelper)}\nexit 71\n`,
          {
            mode: 0o755,
          },
        ),
      ]);
      vi.stubEnv('CODEX_HOME', login);
      vi.stubEnv('TMPDIR', homes);
      vi.stubEnv('PATH', [tools, process.env.PATH].join(delimiter));
      vi.stubEnv('OPENAI_API_KEY', 'synthetic-ambient-key');
      vi.stubEnv('BASH_ENV', join(tools, 'bwrap'));
      vi.stubEnv('HTTP_PROXY', 'http://ambient-proxy.invalid:9');
      vi.stubEnv('NO_PROXY', '127.0.0.1');
      const command = [
        'set -eu',
        'test "$(sdk-fixture-tool)" = inherited',
        'test -z "${OPENAI_API_KEY+x}${BASH_ENV+x}${CODEX_HOME+x}${OPENAI_AGENTS_SDK_COMMAND_PATH+x}"',
        'test -n "${HTTP_PROXY:-${http_proxy:-}}"',
        'test "${HTTP_PROXY:-${http_proxy:-}}" != http://ambient-proxy.invalid:9',
        `test "$(cat ${shellQuote(readAlias)})" = outside`,
        ...[authAlias, auth, join(login, 'auth.json'), oauth].map(
          (file) =>
            `if ( : < ${shellQuote(file)} ) 2>/dev/null; then exit 12; fi`,
        ),
        `native_auth="$(cat ${shellQuote(nativeAuthPath)})"`,
        'test -n "$native_auth"',
        'if ( : < "$native_auth" ) 2>/dev/null; then exit 16; fi',
        `if (printf denied > ${shellQuote(outside)}) 2>/dev/null; then exit 13; fi`,
        `if (printf denied > ${shellQuote(join(homes, 'ambient-write'))}) 2>/dev/null; then exit 14; fi`,
        'printf scoped > "$TMPDIR/fixture"',
        'printf "%s" "$TMPDIR" > command-temp',
        `printf granted > ${shellQuote(join(extra, 'marker'))}`,
      ].join('; ');
      const server = new ModelServer([
        [call('exec_command', { cmd: command }, { callId: 'trusted-scope' })],
        [message('trusted')],
        [
          call(
            'exec_command',
            {
              cmd: [
                'set -eu',
                `other="$(cat ${shellQuote(join(cwd, 'command-temp'))})"`,
                'test "$other" != "$TMPDIR"',
                'if (printf denied > "$other/fixture") 2>/dev/null; then exit 15; fi',
                `if (printf denied > ${shellQuote(join(extra, 'marker'))}) 2>/dev/null; then exit 16; fi`,
                'printf sibling > "$TMPDIR/fixture"',
                'printf "%s" "$TMPDIR" > command-temp',
              ].join('; '),
            },
            { callId: 'trusted-sibling' },
          ),
        ],
        [message('sibling')],
        [
          call(
            'exec_command',
            {
              cmd: [
                'set -eu',
                `if (printf denied > ${shellQuote(join(extra, 'marker'))}) 2>/dev/null; then exit 17; fi`,
                `printf replaced > ${shellQuote(join(replacement, 'marker'))}`,
                'printf compacted > "$TMPDIR/fixture"',
                'printf "%s" "$TMPDIR" > command-temp',
              ].join('; '),
            },
            { callId: 'trusted-compacted' },
          ),
        ],
        [message('Continue')],
      ]);
      await using provider = await providerFor(server);
      const agent = new Agent({
        provider,
        model: 'gpt-5',
        instructions: 'Work.',
      });
      const environment = (cwd: string, writableRoots: string[] = []) =>
        Environment.local({
          cwd,
          writableRoots,
          writePolicy: 'trusted_workspace_write',
          tools: ['exec_command'],
          network: {
            allowedDomains: ['sdk-fixture.invalid'],
            deniedDomains: ['denied.invalid'],
            allowAllUnixSockets: isLinux,
          },
        });
      const opened = await agent
        .session({ environment: environment(cwd, [extra]) })
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
      const [runtimeHome] = (await readdir(homes)).filter((name) =>
        name.startsWith('agents-session-'),
      );
      expect(runtimeHome).toBeDefined();
      const seededAuth = join(homes, runtimeHome!, 'auth.json');
      await writeFile(seededAuth, 'synthetic-native-auth');
      expect(await readFile(seededAuth, 'utf8')).toBe('synthetic-native-auth');
      await writeFile(nativeAuthPath, seededAuth);
      await using other = await agent.session({
        environment: environment(sibling),
      });
      const run = async (
        session: Session,
        stage: string,
        callId: string,
        writableRoots?: string[],
      ) => {
        const turn = await session.submit(stage, { writableRoots });
        expect((await turn.wait()).finalOutput).toBe(stage);
        expect(await Array.fromAsync(session.items())).toContainEqual(
          expect.objectContaining({
            type: 'command_execution',
            callId,
            exitCode: 0,
            status: 'completed',
          }),
        );
      };
      await run(session, 'trusted', 'trusted-scope');
      await run(other, 'sibling', 'trusted-sibling');
      const temp = await readFile(join(cwd, 'command-temp'), 'utf8');
      const otherTemp = await readFile(join(sibling, 'command-temp'), 'utf8');
      expect(temp).not.toBe(otherTemp);
      expect(await readFile(join(temp, 'fixture'), 'utf8')).toBe('scoped');
      expect(await readFile(join(otherTemp, 'fixture'), 'utf8')).toBe(
        'sibling',
      );
      expect(await readFile(outside, 'utf8')).toBe('outside');
      expect(await readFile(auth, 'utf8')).toBe('synthetic-login');
      expect(await readFile(join(extra, 'marker'), 'utf8')).toBe('granted');
      expect(existsSync(fakeHelper)).toBe(false);
      expect(existsSync(join(homes, 'ambient-write'))).toBe(false);
      const receipt = (await Array.fromAsync(session.turns())).at(-1)?.receipt
        ?.executors?.[0];
      expect(receipt?.networkPolicy?.domains).toEqual({
        'sdk-fixture.invalid': 'allow',
        'denied.invalid': 'deny',
      });
      await session.compact({ summary: 'Supplied summary.' });
      expect(existsSync(temp)).toBe(false);
      await run(session, 'Continue', 'trusted-compacted', [replacement]);
      const compactedTemp = await readFile(join(cwd, 'command-temp'), 'utf8');
      expect(compactedTemp).not.toBe(temp);
      expect(compactedTemp).not.toBe(otherTemp);
      expect(await readFile(join(compactedTemp, 'fixture'), 'utf8')).toBe(
        'compacted',
      );
      expect(await readFile(join(extra, 'marker'), 'utf8')).toBe('granted');
      expect(await readFile(join(replacement, 'marker'), 'utf8')).toBe(
        'replaced',
      );
      await session.close();
      expect(existsSync(compactedTemp)).toBe(false);
      expect(await readFile(join(otherTemp, 'fixture'), 'utf8')).toBe(
        'sibling',
      );
      server.assertExhausted();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
  45_000,
);

it.skipIf(!supported)(
  'scopes Git and SSH settings for local commands',
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'sdk-git-'));
    try {
      const base = await realpath(temporary);
      const home = join(base, 'home');
      const cwd = join(base, 'work');
      const globalConfig = join(base, 'git-config');
      const socketPath = join(base, 'agent.sock');
      await Promise.all([mkdir(home), mkdir(cwd)]);
      await Promise.all([
        writeFile(join(home, '.gitconfig'), '[sdkfixture]\n\tcontext = home\n'),
        writeFile(globalConfig, '[sdkfixture]\n\tcontext = override\n'),
      ]);

      const markers: string[] = [];
      await using listener = createUnixServer((socket) => {
        let marker = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk) => (marker += chunk));
        socket.on('end', () => markers.push(marker));
      });
      await new Promise<void>((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(socketPath, resolve);
      });

      const hostGit = (...args: string[]) =>
        execFileSync('/usr/bin/git', ['config', ...args], {
          cwd,
          encoding: 'utf8',
        }).trim();
      vi.stubEnv('HOME', home);
      vi.stubEnv('GIT_CONFIG_GLOBAL', undefined);
      expect(hostGit('--global', '--get', 'sdkfixture.context')).toBe('home');

      vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
      vi.stubEnv('GIT_CONFIG_COUNT', '1');
      vi.stubEnv('GIT_CONFIG_KEY_0', 'sdkfixture.command');
      vi.stubEnv('GIT_CONFIG_VALUE_0', 'synthetic-git-value');
      vi.stubEnv('SSH_AUTH_SOCK', socketPath);
      vi.stubEnv('OPENAI_API_KEY', 'synthetic-ambient-key');
      vi.stubEnv('GH_TOKEN', 'synthetic-git-token');
      vi.stubEnv('LD_LIBRARY_PATH', home);
      vi.stubEnv('DYLD_LIBRARY_PATH', home);
      vi.stubEnv('NO_PROXY', '127.0.0.1');
      expect(hostGit('--global', '--get', 'sdkfixture.context')).toBe(
        'override',
      );
      expect(hostGit('--get', 'sdkfixture.command')).toBe(
        'synthetic-git-value',
      );

      const connect = [
        'const socket = require("node:net").createConnection(process.argv[1]);',
        'socket.setTimeout(2000, () => socket.destroy(new Error("timeout")));',
        'socket.on("connect", () => socket.end(process.argv[2]));',
        'socket.on("end", () => console.log("ipc=connected"));',
        'socket.on("error", (error) => console.log("ipc=" + error.code));',
      ].join('\n');
      const control = await promisify(execFile)(process.execPath, [
        '-e',
        connect,
        socketPath,
        'driver',
      ]);
      expect(control.stdout.trim()).toBe('ipc=connected');
      expect(markers).toEqual(['driver']);

      const modes = [
        { name: 'strict-default', trusted: false, allowSockets: false },
        { name: 'trusted-default', trusted: true, allowSockets: false },
        { name: 'trusted-explicit-unix', trusted: true, allowSockets: true },
      ];
      const server = new ModelServer(
        modes.flatMap(({ name, trusted, allowSockets }) => {
          const command = [
            'set -eu',
            'printf "git-global=%s\\n" "$(/usr/bin/git config --global --get sdkfixture.context 2>/dev/null || true)"',
            'printf "git-value=%s\\n" "$(/usr/bin/git config --get sdkfixture.command || true)"',
            'printf "ssh-setting=%s\\n" "${SSH_AUTH_SOCK-}"',
            'test -z "${GIT_CONFIG_COUNT+x}${GIT_CONFIG_KEY_0+x}${GIT_CONFIG_VALUE_0+x}${OPENAI_API_KEY+x}${GH_TOKEN+x}${LD_LIBRARY_PATH+x}${DYLD_LIBRARY_PATH+x}"',
          ];
          if (trusted) {
            const socket = allowSockets
              ? '"$SSH_AUTH_SOCK"'
              : shellQuote(socketPath);
            command.push(
              `test -S ${socket}`,
              `${shellQuote(process.execPath)} -e ${shellQuote(connect)} ${socket} ${shellQuote(name)}`,
            );
          } else {
            command.push('test -z "${GIT_CONFIG_GLOBAL+x}"');
          }
          if (!allowSockets) {
            command.push('test -z "${SSH_AUTH_SOCK+x}"');
          }
          return [
            [
              call(
                'exec_command',
                { cmd: command.join('; '), yield_time_ms: 10_000 },
                { callId: name },
              ),
            ],
            [message(name)],
          ];
        }),
      );
      await using provider = await providerFor(server);
      const agent = new Agent({
        provider,
        model: 'gpt-5',
        instructions: 'Work.',
      });
      if (isLinux) {
        await expect(
          agent.session({
            environment: Environment.local({
              cwd,
              writePolicy: 'trusted_workspace_write',
              tools: ['exec_command'],
              network: { allowedDomains: ['sdk-fixture.invalid'] },
            }),
          }),
        ).rejects.toThrow('Linux requires explicit access to all Unix sockets');
        expect(server.requests).toHaveLength(0);
      }
      for (const { name, trusted, allowSockets } of modes) {
        await using session = await agent.session({
          environment: Environment.local({
            cwd,
            tools: ['exec_command'],
            writePolicy: trusted ? 'trusted_workspace_write' : undefined,
            network: allowSockets ? { allowAllUnixSockets: true } : undefined,
          }),
        });
        expect((await (await session.submit(name)).wait()).finalOutput).toBe(
          name,
        );
        const item = (await Array.fromAsync(session.items())).find(
          (item) => item.type === 'command_execution' && item.callId === name,
        );
        expect(item).toMatchObject({ exitCode: 0, status: 'completed' });
        if (item?.type !== 'command_execution')
          throw new Error(`Missing command for ${name}`);
        expect(item.output).toMatch(
          trusted ? /^git-global=override$/m : /^git-global=$/m,
        );
        expect(item.output).toMatch(/^git-value=$/m);
        expect(item.output?.split('\n')).toContain(
          `ssh-setting=${allowSockets ? socketPath : ''}`,
        );
        if (trusted) {
          expect(item.output).toMatch(
            allowSockets ? /^ipc=connected$/m : /^ipc=(EPERM|EACCES)$/m,
          );
        }
        expect(markers).toEqual(allowSockets ? ['driver', name] : ['driver']);
      }
      server.assertExhausted();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
  120_000,
);

it.skipIf(process.platform !== 'darwin')(
  'keeps telemetry configurable after rejecting trusted writes for a remote environment',
  () => {
    const env = { ...process.env };
    delete env.CODEX_HOME;
    delete env.OPENAI_API_KEY;
    delete env.NODE_PATH;
    const fixture = join(
      import.meta.dirname,
      'fixtures',
      'darwin-telemetry.mjs',
    );
    for (const mode of ['clean', 'unsupported', 'late']) {
      const stdout = execFileSync(
        process.execPath,
        [fixture, packageRoot, mode],
        {
          encoding: 'utf8',
          env,
          timeout: 45_000,
          maxBuffer: 1024 * 1024,
        },
      );
      expect(stdout.trim()).toBe(`PASS ${mode}`);
    }
  },
  150_000,
);

it.skipIf(process.platform !== 'darwin')(
  'allows trusted local workspace commands to use macOS identity, toolchains and TLS within write grants',
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'agents-trusted-darwin-'));
    try {
      const base = await realpath(temporary);
      const cwd = join(base, 'workspace');
      const extra = join(base, 'granted');
      const outside = join(base, 'outside');
      await Promise.all([
        mkdir(cwd),
        mkdir(extra),
        writeFile(outside, 'outside'),
      ]);
      vi.stubEnv(
        'PATH',
        [dirname(process.execPath), process.env.PATH].join(delimiter),
      );
      const host = userInfo();
      expect(
        execFileSync('/usr/bin/id', ['-un'], {
          encoding: 'utf8',
          timeout: 5_000,
        }).trim(),
      ).toBe(host.username);
      const sshArgs = ['-G', '-T', '-F', '/dev/null', 'sdk-fixture.invalid'];
      const sshUser = `user ${host.username}`;
      const hostSsh = execFileSync('/usr/bin/ssh', sshArgs, {
        encoding: 'utf8',
        timeout: 5_000,
      });
      expect(hostSsh.split('\n')).toContain(sshUser);
      const tlsArgs = [
        '-u',
        'CURL_CA_BUNDLE',
        '-u',
        'SSL_CERT_FILE',
        '-u',
        'SSL_CERT_DIR',
        '-u',
        'CURL_SSL_BACKEND',
        '/usr/bin/curl',
        '--disable',
        '--fail',
        '--silent',
        '--show-error',
        '--max-time',
        '20',
        '--proto',
        '=https',
        '--write-out',
        '%{ssl_verify_result}',
        'https://github.com/robots.txt',
      ];
      const hostBody = join(base, 'host-robots.txt');
      const hostTls = await promisify(execFile)(
        '/usr/bin/env',
        [...tlsArgs, '-o', hostBody],
        { timeout: 22_000 },
      );
      expect(hostTls.stdout).toBe('0');
      expect((await readFile(hostBody)).length).toBeGreaterThan(0);
      const curl = ['/usr/bin/env', ...tlsArgs].map(shellQuote).join(' ');
      const command = [
        'set -eu',
        `test "$(/usr/bin/id -u)" = ${host.uid} || exit 11`,
        `test "$(/usr/bin/id -un)" = ${shellQuote(host.username)} || exit 12`,
        `/usr/bin/ssh ${sshArgs.map(shellQuote).join(' ')} > "$TMPDIR/ssh-config"`,
        '/usr/bin/grep -qx "hostname sdk-fixture.invalid" "$TMPDIR/ssh-config"',
        `/usr/bin/grep -Fqx ${shellQuote(sshUser)} "$TMPDIR/ssh-config"`,
        `test "$(node --version)" = ${shellQuote(process.version)} || exit 13`,
        `verify=$(${curl} -o "$TMPDIR/robots.txt")`,
        'test "$verify" = 0 || exit 14',
        'test -s "$TMPDIR/robots.txt"',
        `test "$(cat ${shellQuote(outside)})" = outside`,
        `if (printf denied > ${shellQuote(outside)}) 2>/dev/null; then exit 15; fi`,
        'printf workspace > result',
        `printf grant > ${shellQuote(join(extra, 'result'))}`,
      ].join('; ');
      const server = new ModelServer([
        [
          call(
            'exec_command',
            { cmd: command, yield_time_ms: 25_000 },
            { callId: 'trusted-macos' },
          ),
        ],
        [message('done')],
      ]);
      await using provider = await providerFor(server);
      const agent = new Agent({
        provider,
        model: 'gpt-5',
        instructions: 'Work.',
      });
      await using session = await agent.session({
        environment: Environment.local({
          cwd,
          writableRoots: [extra],
          writePolicy: 'trusted_workspace_write',
          tools: ['exec_command'],
          network: { allowedDomains: ['github.com'] },
        }),
      });
      expect(
        (await (await session.submit('Run the fixture.')).wait()).finalOutput,
      ).toBe('done');
      expect(await Array.fromAsync(session.items())).toContainEqual(
        expect.objectContaining({
          type: 'command_execution',
          callId: 'trusted-macos',
          exitCode: 0,
          status: 'completed',
        }),
      );
      expect(await readFile(join(cwd, 'result'), 'utf8')).toBe('workspace');
      expect(await readFile(join(extra, 'result'), 'utf8')).toBe('grant');
      expect(await readFile(outside, 'utf8')).toBe('outside');
      server.assertExhausted();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
  75_000,
);

it.skipIf(!supported).for(['strict', 'trusted_workspace_write'] as const)(
  'records the selected local proxy in child and grandchild receipts with %s',
  { timeout: 75_000 },
  async (writePolicy, context) => {
    const temporary = await mkdtemp(
      join(tmpdir(), 'agents-child-local-policy-'),
    );
    try {
      const directory = await realpath(temporary);
      const cwd = join(directory, 'work');
      const extra = join(directory, 'extra');
      const storage = join(directory, 'storage');
      await Promise.all([mkdir(cwd), mkdir(extra)]);
      const capability = join(directory, 'host-capability');
      await writeFile(capability, 'delegated-read');
      const read =
        writePolicy === 'trusted_workspace_write'
          ? `test "$(cat ${shellQuote(capability)})" = delegated-read`
          : `! cat ${shellQuote(capability)} >/dev/null 2>&1`;
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
              {
                cmd: `test -n "$HTTP_PROXY" && ${read} && printf "proxy active"`,
              },
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
              writePolicy,
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
        let expectedRoots: Set<string> | undefined;
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
          const roots = new Set(executor?.writableRoots);
          expect(roots.size).toBe(writePolicy === 'strict' ? 2 : 3);
          expect(roots.has(pathToFileURL(cwd).href)).toBe(true);
          expect(roots.has(pathToFileURL(extra).href)).toBe(true);
          expectedRoots ??= roots;
          expect(roots).toEqual(expectedRoots);
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
);

it.skipIf(!supported)(
  'applies a native workspace patch through Chat Completions',
  { timeout: 30_000 },
  async () => {
    const patch =
      '*** Begin Patch\n*** Add File: first.txt\n+first\n' +
      '*** Add File: second.txt\n+second\n*** End Patch';
    const approvals: unknown[] = [];
    const requests: Record<string, any>[] = [];
    const client = {
      chat: {
        completions: {
          async create(body: Record<string, any>) {
            requests.push(body);
            const first = requests.length === 1;
            if (first) {
              expect(body.tools).toMatchObject([
                { type: 'function', function: { name: 'apply_patch' } },
              ]);
            } else {
              const assistant = body.messages.find(
                (item: Record<string, unknown>) => item.tool_calls,
              );
              const [call] = assistant.tool_calls;
              expect(call.id).toBe('call_patch');
              expect(JSON.parse(call.function.arguments)).toEqual({ patch });
              const result = body.messages.find(
                (item: Record<string, unknown>) =>
                  item.tool_call_id === 'call_patch',
              );
              expect(result.role).toBe('tool');
              expect(typeof result.content).toBe('string');
              expect(result.content.length).toBeGreaterThan(0);
            }
            return {
              id: `chat_patch_${requests.length}`,
              choices: [
                {
                  finish_reason: first ? 'tool_calls' : 'stop',
                  message: first
                    ? {
                        content: null,
                        tool_calls: [
                          {
                            id: 'call_patch',
                            type: 'function',
                            function: {
                              name: 'apply_patch',
                              arguments: JSON.stringify({ patch }),
                            },
                          },
                        ],
                      }
                    : { content: 'patched' },
                },
              ],
            };
          },
        },
      },
    };
    const executor = await startPublicExecutor();
    try {
      await using provider = new NativeProvider({
        baseUrl: 'https://example.invalid/v1',
        apiKey: 'synthetic',
        modelBackend: new ChatCompletionsModel(client),
      });
      await using session = await new Agent({
        instructions: 'Edit the requested files.',
        provider,
      }).session({
        environment: new Environment({
          url: executor.url,
          cwd: executor.cwd,
          headers: executor.headers,
          tools: ['apply_patch'],
          approval(_context, args) {
            approvals.push(args);
            return true;
          },
        }),
      });
      expect(
        (await (await session.submit('Apply the patch.')).wait()).finalOutput,
      ).toBe('patched');
      expect(approvals).toEqual([patch]);
      expect(await readFile(join(executor.cwd, 'first.txt'), 'utf8')).toBe(
        'first\n',
      );
      expect(await readFile(join(executor.cwd, 'second.txt'), 'utf8')).toBe(
        'second\n',
      );
      expect(requests).toHaveLength(2);
    } finally {
      await executor.close();
    }
  },
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

it.skipIf(!supported).for(['portable', 'local', 'trusted portable'] as const)(
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
      const writePolicy =
        kind === 'trusted portable' ? 'trusted_workspace_write' : 'strict';
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
        writePolicy,
      });
      const current = Environment.local({
        cwd,
        tools: ['exec_command'],
        writableRoots: [next],
        writePolicy,
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
      if (writePolicy === 'trusted_workspace_write') {
        await expect(
          agent.session({
            ...restore,
            environment: Environment.local({
              cwd,
              tools: ['exec_command'],
              writableRoots: [next],
            }),
          }),
        ).rejects.toThrow(
          /recorded executor write and network policy|applied executor policy/,
        );
      }
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

it
  .skipIf(process.platform !== 'darwin')
  .for(['strict', 'trusted_workspace_write'] as const)(
  'blocks delegation from a local command to launchd with %s',
  { timeout: 45_000 },
  async (writePolicy) => {
    const launchctlPath = '/bin/launchctl';
    const launchctl = (...args: string[]) => {
      const result = spawnSync(launchctlPath, args, {
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
    const submitLabel = `org.openai.agents.sdk-submit-test.${randomUUID()}`;
    const submitService = `${domain}/${submitLabel}`;
    const bootout = (target: string) => {
      const stopped = launchctl('bootout', target);
      if (stopped.status !== 0) {
        expect(launchctl('print', target).status, stopped.stderr).not.toBe(0);
      }
    };
    const runCount = () => {
      const result = launchctl('print', service);
      expect(result.status, result.stderr).toBe(0);
      const count = /^\s*runs = (\d+)/m.exec(result.stdout)?.[1];
      expect(count, result.stdout).toBeDefined();
      return Number(count);
    };
    const quote = (arg: string) => `'${arg.replaceAll("'", "'\\''")}'`;

    const directory = await mkdtemp(join(tmpdir(), 'agents-launchd-'));
    let stage = 'fixture setup';
    try {
      const root = await realpath(directory);
      const cwd = join(root, 'workspace');
      const marker = join(root, 'launchd-marker');
      const submitMarker = join(root, 'launchd-submit-marker');
      const plist = join(cwd, `${label}.plist`);
      const copiedLaunchctl = join(cwd, 'launchctl-copy');
      const linkedLaunchctl = join(cwd, 'launchctl-link');
      await mkdir(cwd);
      await copyFile(launchctlPath, copiedLaunchctl);
      await chmod(copiedLaunchctl, 0o755);
      await symlink(launchctlPath, linkedLaunchctl);
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

      const submitArgs = [
        '-l',
        submitLabel,
        '--',
        '/usr/bin/touch',
        submitMarker,
      ];
      const attempts = [
        ['bootstrap', [launchctlPath, 'bootstrap', domain, plist]],
        ['kickstart', [launchctlPath, 'kickstart', service]],
        ['kickstart-copy', [copiedLaunchctl, 'kickstart', service]],
        ['kickstart-link', [linkedLaunchctl, 'kickstart', service]],
        ['submit', [launchctlPath, 'submit', ...submitArgs]],
      ] as const;
      const server = new ModelServer(
        attempts.flatMap(([operation, args]) => {
          const command = args.map(quote).join(' ');
          const checkWrite =
            operation === 'bootstrap'
              ? `if /usr/bin/touch ${quote(marker)} 2>/dev/null; then exit 20; fi; `
              : '';
          return [
            [
              call(
                'exec_command',
                {
                  cmd: `${checkWrite}rc=0; ${command} || rc=$?; printf '${operation} exit %s\\n' "$rc"`,
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
        stage = 'session startup';
        await using session = await agent.session({
          environment: Environment.local({
            cwd,
            tools: ['exec_command'],
            writePolicy,
          }),
        });
        const tryDelegation = async (
          operation: (typeof attempts)[number][0],
        ) => {
          stage = operation;
          const turn = await session.submit(`Try launchctl ${operation}.`);
          expect((await turn.wait()).finalOutput).toBe('checked');
          const items = await Array.fromAsync(session.items());
          const command = items
            .filter((item) => item.type === 'command_execution')
            .find((item) => item.callId === operation);
          const response = items.find(
            (item) =>
              item.type === 'function_call_output' && item.callId === operation,
          );
          expect(
            command?.output,
            response?.type === 'function_call_output'
              ? JSON.stringify(response.output)
              : undefined,
          ).toMatch(new RegExp(`^${operation} exit [1-9]\\d*$`, 'm'));
        };
        await tryDelegation('bootstrap');
        expect(launchctl('print', service).status).not.toBe(0);
        expect(existsSync(marker)).toBe(false);

        stage = 'host bootstrap';
        const bootstrapped = launchctl('bootstrap', domain, plist);
        expect(bootstrapped.status, bootstrapped.stderr).toBe(0);
        expect(runCount()).toBe(0);

        for (const operation of [
          'kickstart',
          'kickstart-copy',
          'kickstart-link',
        ] as const) {
          await tryDelegation(operation);
          expect(runCount()).toBe(0);
          expect(existsSync(marker)).toBe(false);
        }

        await tryDelegation('submit');
        expect(launchctl('list', submitLabel).status).not.toBe(0);
        expect(launchctl('print', submitService).status).not.toBe(0);
        expect(existsSync(submitMarker)).toBe(false);
        stage = 'session shutdown after all delegation checks';
      }

      stage = 'host kickstart';
      const kicked = launchctl('kickstart', service);
      expect(kicked.status, kicked.stderr).toBe(0);
      await vi.waitFor(() => expect(existsSync(marker)).toBe(true), {
        timeout: 5_000,
      });
      expect(runCount()).toBe(1);
      stage = 'host submit';
      const submitted = launchctl('submit', ...submitArgs);
      expect(submitted.status, submitted.stderr).toBe(0);
      await vi.waitFor(() => expect(existsSync(submitMarker)).toBe(true), {
        timeout: 5_000,
      });
      server.assertExhausted();
    } catch (cause) {
      throw new Error(`Launchd ${writePolicy} failed during ${stage}`, {
        cause,
      });
    } finally {
      try {
        try {
          const removed = launchctl('remove', submitLabel);
          if (removed.status !== 0) {
            expect(
              launchctl('list', submitLabel).status,
              removed.stderr,
            ).not.toBe(0);
          }
        } finally {
          // Legacy submit uses the caller's bootstrap context. The managed
          // worker and test host can be in different launchd domains.
          try {
            bootout(submitService);
          } finally {
            bootout(service);
          }
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  },
);

// Honor the host restriction unless native sandbox execution is required.
it
  .skipIf(
    !supported ||
      (process.env.GITHUB_ACTIONS !== 'true' &&
        process.env.OPENAI_AGENTS_TEST_IN_CODEX_SANDBOX === '1' &&
        process.env.OPENAI_AGENTS_REQUIRE_LOCAL_SANDBOX !== '1'),
  )
  .for(['portable', 'local', 'trusted local'] as const)(
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
        route === 'portable' ? undefined : localStorage(join(base, 'storage'));
      const writePolicy =
        route === 'trusted local' ? 'trusted_workspace_write' : 'strict';
      const environment = (roots: string[]) =>
        Environment.local({
          cwd: linked,
          writableRoots: roots,
          writePolicy,
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
            writePolicy,
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
      const checkRoots = (
        actual: readonly string[] | undefined,
        paths: string[],
      ) => {
        const granted = new Set(paths.map((path) => pathToFileURL(path).href));
        const temp = actual?.filter((path) => !granted.has(path)) ?? [];
        expect(new Set(actual?.filter((path) => !temp.includes(path)))).toEqual(
          granted,
        );
        expect(temp).toHaveLength(writePolicy === 'strict' ? 0 : 1);
        return temp[0];
      };
      const initialTemp = checkRoots(initial?.writableRoots, [
        linked,
        ...first,
      ]);
      const updatedTemp = checkRoots(updated?.writableRoots, [
        linked,
        ...expanded,
      ]);
      const reopenedTemp = checkRoots(reopened?.writableRoots, [
        linked,
        ...expanded,
      ]);
      expect(updatedTemp).toBe(initialTemp);
      if (writePolicy === 'trusted_workspace_write') {
        expect(reopenedTemp).not.toBe(updatedTemp);
        expect(reopened?.networkPolicy).toEqual(updated?.networkPolicy);
      } else {
        expect(reopened).toEqual(updated);
      }
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

it.skipIf(process.platform !== 'darwin')(
  'applies a per-turn write policy with macOS read-only roots and restores a named linked skill',
  async () => {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    // Seatbelt already grants access to the system scratch directories.
    const temporary = await mkdtemp(
      join(homedir(), '.agents-macos-read-roots-'),
    );
    try {
      const base = await realpath(temporary);
      const cwd = join(base, 'workspace');
      const granted = join(base, 'granted');
      const harmless = join(base, 'harmless');
      const other = join(base, 'other');
      const homes = join(base, 'runtime-homes');
      const skill = join(cwd, '.agents', 'skills', 'nov9_read_only_probe');
      await Promise.all([
        mkdir(join(cwd, '.agents', 'skills'), { recursive: true }),
        mkdir(join(cwd, '.git'), { recursive: true }),
        mkdir(granted),
        mkdir(harmless),
        mkdir(other),
        mkdir(homes),
      ]);
      const skillBody =
        '---\nname: nov9_read_only_probe\ndescription: NAMED_SKILL_CATALOG\n---\nRead marker.txt when this skill is requested.\n';
      const marker = join(granted, 'marker.txt');
      const linkedMarker = join(granted, 'linked-marker');
      const linkedAlias = join(granted, 'linked-marker-alias');
      const workspaceAlias = join(cwd, 'read-only-hard-link');
      const outside = join(other, 'ungranted.txt');
      const metadata = '[core]\n\trepositoryformatversion = 0\n';
      await Promise.all([
        writeFile(join(granted, 'SKILL.md'), skillBody),
        writeFile(marker, 'GRANTED_SKILL_MARKER\n'),
        writeFile(linkedMarker, 'GRANTED_HARD_LINK_MARKER\n'),
        writeFile(outside, 'UNGRANTED_PRIVATE_SENTINEL\n'),
        writeFile(join(cwd, '.git', 'config'), metadata),
        symlink(granted, skill),
        symlink(outside, join(cwd, 'ungranted-link')),
        symlink(outside, join(granted, 'ungranted-link')),
      ]);
      await link(linkedMarker, linkedAlias);
      await link(marker, workspaceAlias);
      await rm(workspaceAlias);
      vi.stubEnv('TMPDIR', homes);
      let privateMarker = '';
      const denyRead = (path: string) =>
        `if cat ${quote(path)} >/dev/null 2>&1; then exit 11; fi`;
      const denyWrite = (path: string) =>
        `if (printf changed >> ${quote(path)}) 2>/dev/null; then exit 12; fi`;
      const probe = (name: string, allowed: boolean) =>
        [
          'set -eu',
          ...(allowed
            ? [
                `cat ${quote(join(skill, 'SKILL.md'))}`,
                `cat ${quote(join(skill, 'marker.txt'))}`,
                `cat ${quote(marker)}`,
                `cat ${quote(linkedMarker)} ${quote(linkedAlias)}`,
                denyWrite(linkedAlias),
                `if link_error=$(LC_ALL=C /bin/ln ${quote(marker)} ${quote(workspaceAlias)} 2>&1); then printf READ_ONLY_LINK_CREATED; exit 13; fi`,
                'case "$link_error" in *"Operation not permitted"|*"Permission denied") printf READ_ONLY_LINK_DENIED;; *) printf "%s" "$link_error" >&2; exit 14;; esac',
              ]
            : [denyRead(marker), denyRead(join(skill, 'marker.txt'))]),
          denyRead(outside),
          denyRead(join(cwd, 'ungranted-link')),
          denyRead(join(granted, 'ungranted-link')),
          denyRead(privateMarker),
          denyWrite(marker),
          denyWrite(join(skill, 'marker.txt')),
          denyWrite(join(granted, 'new.txt')),
          denyWrite(join(cwd, '.git', 'config')),
          `printf workspace-ok > ${quote(join(cwd, name))}`,
          'printf POLICY_OK',
        ].join('; ');
      const command = (name: string, allowed: boolean) => ({
        items: [
          toolCall(
            'exec_command',
            { cmd: probe(name, allowed) },
            { callId: name },
          ),
        ],
      });
      const answer = () => ({ items: [text('done')] });
      const readOnlyRoots: readonly string[] = [granted, harmless];
      const options = { cwd, tools: ['exec_command'] as const };
      await withScriptedResponses(
        [
          () => command('strict-default', false),
          answer(),
          () => command('initial', true),
          answer(),
          () => command('restored', true),
          answer(),
        ],
        async (peer) => {
          const agent = new Agent({
            provider: peer.provider,
            model: 'gpt-5.5',
            instructions: 'Use the named skill and run the selected command.',
          });
          const setPrivateMarker = async (previous: string[]) => {
            const created = (await readdir(homes)).filter(
              (name) =>
                name.startsWith('agents-session-') && !previous.includes(name),
            );
            expect(created).toHaveLength(1);
            privateMarker = join(homes, created[0], 'private-sentinel');
            await writeFile(privateMarker, 'NATIVE_PRIVATE_SENTINEL\n');
          };
          {
            const environment = Environment.local(options);
            expect(environment.writePolicy).toBe('strict');
            const previous = await readdir(homes);
            await using session = await agent.session({ environment });
            await setPrivateMarker(previous);
            expect(
              (await (await session.submit('Check the default policy.')).wait())
                .finalOutput,
            ).toBe('done');
          }
          const sharedMarker = join(harmless, 'shared-marker');
          await link(outside, sharedMarker);
          await expect(
            agent.session({
              environment: Environment.local({ ...options, readOnlyRoots }),
            }),
          ).rejects.toThrow(/hard.link/i);
          await rm(sharedMarker);
          expect(peer.requests).toHaveLength(2);
          let state: SessionState;
          {
            const environment = Environment.local({
              ...options,
              capabilityDirectories: [join(cwd, '.agents')],
              readOnlyRoots,
            });
            expect(environment.writePolicy).toBe('strict');
            const previous = await readdir(homes);
            await using session = await agent.session({ environment });
            await setPrivateMarker(previous);
            await expect(
              session.submit('Do not make the linked skill writable.', {
                writableRoots: [skill],
              }),
            ).rejects.toThrow(/read.only|overlap|writ/i);
            expect(peer.requests).toHaveLength(2);
            expect(
              (
                await (
                  await session.submit(
                    'Use $nov9_read_only_probe and read its marker.txt.',
                    { writableRoots: [] },
                  )
                ).wait()
              ).finalOutput,
            ).toBe('done');
            state = parseSessionState(
              JSON.stringify(await session.saveState()),
            );
          }
          for (const roots of [undefined, [other]] as const) {
            await expect(
              agent.session({
                state,
                environment: Environment.local({
                  ...options,
                  readOnlyRoots: roots,
                }),
              }),
            ).rejects.toThrow(
              /recorded executor write and network policy|read.only roots/i,
            );
          }
          expect(peer.requests).toHaveLength(4);
          {
            const previous = await readdir(homes);
            await using session = await agent.session({
              state,
              environment: Environment.local({
                ...options,
                capabilityDirectories: [join(cwd, '.agents')],
                readOnlyRoots: [harmless, granted],
              }),
            });
            await setPrivateMarker(previous);
            expect(
              (
                await (
                  await session.submit('Use $nov9_read_only_probe again.')
                ).wait()
              ).finalOutput,
            ).toBe('done');
          }
          expect(JSON.stringify(peer.requests[2])).toContain(
            'NAMED_SKILL_CATALOG',
          );
          expect(peer.requests).toHaveLength(6);
          peer.assertExhausted();
          for (const phase of ['strict-default', 'initial', 'restored']) {
            const output = peer.toolOutput(phase);
            expect(output).toContain('POLICY_OK');
            expect(output).not.toContain('UNGRANTED_PRIVATE_SENTINEL');
            expect(output).not.toContain('NATIVE_PRIVATE_SENTINEL');
            if (phase !== 'strict-default') {
              expect(output).toContain('GRANTED_SKILL_MARKER');
              expect(output).toContain('READ_ONLY_LINK_DENIED');
              expect(output).toContain(
                'GRANTED_HARD_LINK_MARKER\nGRANTED_HARD_LINK_MARKER',
              );
            }
          }
        },
      );
      for (const name of ['strict-default', 'initial', 'restored'])
        expect(await readFile(join(cwd, name), 'utf8')).toBe('workspace-ok');
      expect(await readFile(marker, 'utf8')).toBe('GRANTED_SKILL_MARKER\n');
      expect(await readFile(join(granted, 'SKILL.md'), 'utf8')).toBe(skillBody);
      expect(await readFile(outside, 'utf8')).toBe(
        'UNGRANTED_PRIVATE_SENTINEL\n',
      );
      expect(await readFile(join(cwd, '.git', 'config'), 'utf8')).toBe(
        metadata,
      );
      expect(existsSync(join(granted, 'new.txt'))).toBe(false);
      expect(existsSync(workspaceAlias)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      await rm(temporary, { recursive: true, force: true });
    }
  },
  60_000,
);
