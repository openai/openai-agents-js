// Public native enforcement assertions check real native effects.
import { createServer } from 'node:http';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  Agent,
  Environment,
  NativeAgents,
  NativeProvider,
  parseSessionState,
} from '@openai/agents';
import { text, toolCall, withScriptedResponses } from '@openai/agents/testing';
import { startPublicExecutor } from './fixtures/public-executor';

const supported = ['linux', 'darwin'].includes(process.platform);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const command = (
  cmd: string,
  callId = 'command',
  extra: { sandbox_permissions?: string } = {},
) => ({
  items: [
    toolCall('exec_command', { cmd, login: false, ...extra }, { callId }),
  ],
});
const answer = (value: string) => ({ items: [text(value)] });
const folders: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const folder of folders.splice(0))
    await rm(folder, { recursive: true, force: true });
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'agents-read-only-'));
  folders.push(path);
  return realpath(path);
}
function output(request: Record<string, unknown>, callId = 'command') {
  const items = request.input as {
    type?: string;
    call_id?: string;
    output?: unknown;
  }[];
  const matches = items.filter(
    (item) => item.type === 'function_call_output' && item.call_id === callId,
  );
  expect(matches).toHaveLength(1);
  const value = matches[0]!.output;
  return typeof value === 'string'
    ? value
    : (value as { text?: string }[]).map((item) => item.text ?? '').join('');
}

it('rejects conflicting read-only declarations', () => {
  expect(
    new Environment({ url: 'wss://executor.invalid', cwd: '/workspace' })
      .readOnly,
  ).toBe(false);
  expect(
    () =>
      new Environment({
        url: 'wss://executor.invalid',
        cwd: '/workspace',
        writePolicy: 'legacy',
        readOnly: true,
      }),
  ).toThrow('strict');
  expect(
    () =>
      new Environment({
        url: 'wss://executor.invalid',
        cwd: '/workspace',
        writableRoots: ['/output'],
        readOnly: true,
      }),
  ).toThrow('writableRoots');
  expect(
    () =>
      new Environment({
        url: 'wss://executor.invalid',
        cwd: '/workspace',
        tools: ['apply_patch'],
        readOnly: true,
      }),
  ).toThrow('apply_patch');
  expect(
    () =>
      new Environment({
        url: 'wss://executor.invalid',
        cwd: '/workspace',
        readOnly: 'yes' as unknown as boolean,
      }),
  ).toThrow('boolean');
});

for (const transport of ['local', 'wss'] as const) {
  for (const operation of [
    'create',
    'append',
    'unlink',
    'rename',
    'absolute',
    'alias',
  ] as const) {
    it.skipIf(!supported)(
      `denies ${operation} through the real ${transport} executor`,
      async () => {
        const owned = await directory();
        const remote =
          transport === 'wss' ? await startPublicExecutor() : undefined;
        const cwd = remote?.cwd ?? join(owned, 'workspace');
        try {
          if (!remote) await mkdir(cwd);
          await writeFile(join(cwd, 'seed'), 'ORIGINAL\n');
          const alias = join(owned, 'alias');
          await symlink(cwd, alias);
          const mutations = {
            create: 'printf changed > new',
            append: 'printf changed >> seed',
            unlink: 'rm seed',
            rename: 'mv seed moved',
            absolute: `printf changed > ${quote(join(cwd, 'new'))}`,
            alias: `printf changed > ${quote(join(alias, 'new'))}`,
          };
          const probe = `printf READ:; cat seed; if (${mutations[operation]}) 2>/dev/null; then printf UNEXPECTED_WRITE; else printf DENIED; fi`;
          await withScriptedResponses(
            [command(probe), answer('done')],
            async (peer) => {
              const environment = remote
                ? new Environment({
                    url: remote.url,
                    cwd,
                    headers: remote.headers,
                    tools: ['exec_command'],
                    readOnly: true,
                    approval: () => true,
                  })
                : Environment.local({
                    cwd,
                    tools: ['exec_command'],
                    readOnly: true,
                    approval: () => true,
                  });
              const result = await new Agent({
                model: 'gpt-5.5',
                instructions: 'Use the selected command.',
                provider: peer.provider,
              }).run('Run.', { environment });
              expect(result.finalOutput).toBe('done');
              expect(peer.requests).toHaveLength(2);
              const actual = output(peer.requests[1]!);
              expect(actual).toContain('READ:ORIGINAL');
              expect(actual).toContain('DENIED');
              expect(actual).not.toContain('UNEXPECTED_WRITE');
            },
          );
          expect(await readFile(join(cwd, 'seed'), 'utf8')).toBe('ORIGINAL\n');
          expect(existsSync(join(cwd, 'new'))).toBe(false);
          expect(existsSync(join(cwd, 'moved'))).toBe(false);
          expect((await readdir(cwd)).sort()).toEqual(['seed']);
        } finally {
          await remote?.close();
        }
      },
      45_000,
    );
  }
}

for (const readOnly of [false, true]) {
  it.skipIf(!supported)(
    `keeps readOnly=${readOnly} through updates, restore and compaction`,
    async () => {
      const owned = await directory(),
        cwd = join(owned, 'workspace'),
        extra = join(owned, 'extra'),
        outside = join(owned, 'outside');
      await mkdir(cwd);
      await mkdir(extra);
      await mkdir(join(cwd, '.git'));
      await writeFile(join(cwd, 'seed'), 'ORIGINAL\n');
      await writeFile(outside, 'PRIVATE_OUTSIDE_SENTINEL');
      const metadata = '[core]\n\trepositoryformatversion = 0\n';
      await writeFile(join(cwd, '.git', 'config'), metadata);
      const probe = (name: string) =>
        `cat seed; if (printf changed > ${name}) 2>/dev/null; then printf WROTE; else printf DENIED; fi; (cat ${quote(outside)}) 2>/dev/null; (printf bad > .git/config) 2>/dev/null; (printf bad > ${quote(outside)}) 2>/dev/null; (printf bad > ${quote(join(extra, name))}) 2>/dev/null; true`;
      await withScriptedResponses(
        [
          command(
            readOnly
              ? 'cat seed'
              : `cat seed; printf allowed > ${quote(join(extra, 'initial'))}`,
            'initial',
          ),
          answer('initial'),
          command(probe('after-empty'), 'empty'),
          answer('empty'),
          command(probe('after-compact'), 'compact'),
          answer('compact'),
        ],
        async (peer) => {
          const agent = new Agent({
            model: 'gpt-5.5',
            instructions: 'Use the selected command.',
            provider: peer.provider,
          });
          let state;
          {
            await using session = await agent.session({
              environment: Environment.local({
                cwd,
                tools: ['exec_command'],
                readOnly,
              }),
            });
            if (readOnly)
              await expect(
                session.submit('Do not expand.', { writableRoots: [extra] }),
              ).rejects.toThrow('Read-only');
            expect(peer.requests).toHaveLength(0);
            expect(
              (
                await (
                  await session.submit(
                    'Read.',
                    readOnly ? {} : { writableRoots: [extra] },
                  )
                ).wait()
              ).finalOutput,
            ).toBe('initial');
            state = await session.saveState();
          }
          expect(existsSync(join(extra, 'initial'))).toBe(!readOnly);
          expect(state.executor_read_only ?? false).toBe(readOnly);
          expect(Object.hasOwn(state, 'executor_read_only')).toBe(readOnly);
          const opposite = Environment.local({
            cwd,
            tools: ['exec_command'],
            readOnly: !readOnly,
          });
          const acquire = vi
            .spyOn(NativeProvider.prototype, '_acquire')
            .mockImplementation(() => {
              throw new Error('Mode mismatch reached provider acquisition');
            });
          try {
            await expect(
              agent.session({ state, environment: opposite }),
            ).rejects.toThrow('read-only execution');
            expect(acquire).not.toHaveBeenCalled();
          } finally {
            acquire.mockRestore();
          }
          const forged = parseSessionState(
            JSON.stringify({ ...state, executor_read_only: !readOnly }),
          );
          await expect(
            agent.session({ state: forged, environment: opposite }),
          ).rejects.toThrow('recorded executor write and network policy');
          expect(peer.requests).toHaveLength(2);
          const selected = Environment.local({
            cwd,
            tools: ['exec_command'],
            readOnly,
            writableRoots: readOnly ? [] : [extra],
          });
          {
            await using restored = await agent.session({
              state,
              environment: selected,
            });
            expect(
              (
                await (
                  await restored.submit('Replace with empty roots.', {
                    writableRoots: [],
                  })
                ).wait()
              ).finalOutput,
            ).toBe('empty');
            await restored.compact({
              summary: 'Keep the supplied seed and command boundary.',
            });
            expect(
              (await (await restored.submit('After compaction.')).wait())
                .finalOutput,
            ).toBe('compact');
            expect(
              (await restored.saveState()).executor_read_only ?? false,
            ).toBe(readOnly);
          }
          expect(output(peer.requests[3]!, 'empty')).toContain(
            readOnly ? 'DENIED' : 'WROTE',
          );
          expect(output(peer.requests[5]!, 'compact')).toContain(
            readOnly ? 'DENIED' : 'WROTE',
          );
          expect(output(peer.requests[3]!, 'empty')).not.toContain(
            'PRIVATE_OUTSIDE_SENTINEL',
          );
          expect(output(peer.requests[5]!, 'compact')).not.toContain(
            'PRIVATE_OUTSIDE_SENTINEL',
          );
          for (const name of ['after-empty', 'after-compact']) {
            expect(existsSync(join(cwd, name))).toBe(!readOnly);
            expect(existsSync(join(extra, name))).toBe(false);
          }
          expect(await readFile(outside, 'utf8')).toBe(
            'PRIVATE_OUTSIDE_SENTINEL',
          );
          expect(await readFile(join(cwd, '.git', 'config'), 'utf8')).toBe(
            metadata,
          );
        },
      );
    },
    45_000,
  );
}

it.skipIf(!supported)(
  'does not let argument transforms or approvals grant writes',
  async () => {
    const cwd = await directory();
    await writeFile(join(cwd, 'seed'), 'ORIGINAL\n');
    const calls: unknown[] = [];
    await withScriptedResponses(
      [command('printf harmless'), answer('done')],
      async (peer) => {
        const result = await new Agent({
          model: 'gpt-5.5',
          instructions: 'Use the selected command.',
          provider: peer.provider,
        }).run('Run.', {
          environment: Environment.local({
            cwd,
            tools: ['exec_command'],
            readOnly: true,
            approval: () => true,
            transformArguments: (_context, value) => {
              calls.push(value);
              return {
                ...(value as object),
                cmd: 'cat seed; if (printf bad > transformed) 2>/dev/null; then printf UNEXPECTED_WRITE; else printf DENIED; fi',
              };
            },
          }),
        });
        expect(result.finalOutput).toBe('done');
        expect(calls).toHaveLength(1);
        const actual = output(peer.requests[1]!);
        expect(actual).toContain('ORIGINAL');
        expect(actual).toContain('DENIED');
        expect(actual).not.toContain('UNEXPECTED_WRITE');
      },
    );
    expect(existsSync(join(cwd, 'transformed'))).toBe(false);
  },
  30_000,
);

it.skipIf(!supported)(
  'does not let require_escalated grant writes',
  async () => {
    const cwd = await directory();
    await writeFile(join(cwd, 'seed'), 'ORIGINAL');
    await withScriptedResponses(
      [
        command('cat seed', 'read'),
        command('printf bad > elevated', 'elevated', {
          sandbox_permissions: 'require_escalated',
        }),
        answer('done'),
      ],
      async (peer) => {
        const result = await new Agent({
          model: 'gpt-5.5',
          instructions: 'Use the selected commands.',
          provider: peer.provider,
        }).run('Run.', {
          environment: Environment.local({
            cwd,
            tools: ['exec_command'],
            readOnly: true,
          }),
        });
        expect(result.finalOutput).toBe('done');
        expect(output(peer.requests[1]!, 'read')).toContain('ORIGINAL');
        expect(output(peer.requests[2]!, 'elevated')).toMatch(/failed|error/i);
        expect(existsSync(join(cwd, 'elevated'))).toBe(false);
      },
    );
  },
  30_000,
);

for (const readOnly of [false, true]) {
  it.skipIf(!supported)(
    `keeps explicit network scope with readOnly=${readOnly}`,
    async () => {
      const cwd = await directory(),
        hits: string[] = [];
      const server = createServer((request, response) => {
        hits.push(request.url!);
        response.end('LOOPBACK_ALLOWED');
      });
      await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
      try {
        const address = server.address();
        if (!address || typeof address === 'string')
          throw new Error('Missing HTTP address');
        const curl =
          'curl --silent --show-error --fail --max-time 3 --proxy "$HTTP_PROXY" --noproxy \'\'';
        await withScriptedResponses(
          [
            command(
              `${curl} http://127.0.0.1:${address.port}/allowed`,
              'allow',
            ),
            command(`${curl} http://localhost:${address.port}/allowed`, 'deny'),
            answer('done'),
          ],
          async (peer) => {
            const environment = Environment.local({
              cwd,
              tools: ['exec_command'],
              readOnly,
              network: {
                allowedDomains: ['127.0.0.1'],
                deniedDomains: ['localhost'],
                allowAllUnixSockets: process.platform === 'linux',
                allowLocalBinding: true,
              },
            });
            const result = await new Agent({
              model: 'gpt-5.5',
              instructions: 'Use the selected commands.',
              provider: peer.provider,
            }).run('Run.', { environment });
            expect(result.finalOutput).toBe('done');
            expect(output(peer.requests[1]!, 'allow')).toContain(
              'LOOPBACK_ALLOWED',
            );
            expect(output(peer.requests[2]!, 'deny')).toMatch(/blocked/i);
          },
        );
        expect(hits).toEqual(['/allowed']);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((ok, bad) =>
          server.close((error) => (error ? bad(error) : ok())),
        );
      }
    },
    30_000,
  );
}

it('rejects read-only NativeAgents before provider acquisition', async () => {
  await withScriptedResponses([], async (peer) => {
    const agent = new Agent({
      model: 'gpt-5.5',
      instructions: 'Work.',
      provider: peer.provider,
      tools: [new NativeAgents({ maxChildren: 1, maxDepth: 1 })],
    });
    const acquire = vi
      .spyOn(NativeProvider.prototype, '_acquire')
      .mockImplementation(() => {
        throw new Error(
          'Unsupported NativeAgents reached provider acquisition',
        );
      });
    try {
      await expect(
        agent.session({
          environment: new Environment({
            url: 'wss://executor.invalid',
            cwd: '/workspace',
            readOnly: true,
          }),
        }),
      ).rejects.toThrow('NativeAgents');
      expect(acquire).not.toHaveBeenCalled();
      expect(peer.requests).toHaveLength(0);
    } finally {
      acquire.mockRestore();
    }
  });
});
