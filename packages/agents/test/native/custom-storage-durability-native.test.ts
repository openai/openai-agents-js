import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  NativeAgents,
  nativeGoals,
  checklist,
  fileThreadStore,
  reconcileThreadStore,
  tool,
  type CanonicalThreadStore,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

const directories: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) =>
        child.once('exit', () => resolve()),
      );
      child.kill('SIGKILL');
      await exited;
    }),
  );
  await ModelServer.closeAll();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'custom-storage-native-'));
  directories.push(path);
  return path;
}
async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-custom-storage',
    supportsWebsockets: false,
  });
}
async function history(session: Awaited<ReturnType<Agent['session']>>) {
  const items = [];
  for await (const item of session.items()) items.push(item);
  return items;
}
async function worker(server: ModelServer, config: Record<string, unknown>) {
  const provider = await providerFor(server);
  const child = fork(
    fileURLToPath(
      new URL('./fixtures/custom-storage-worker.ts', import.meta.url),
    ),
    [JSON.stringify({ ...config, url: provider.baseUrl })],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  children.push(child);
  await provider.close();
  const messages: Record<string, any>[] = [];
  let stderr = '';
  child.stderr?.on('data', (data) => {
    stderr += String(data);
  });
  child.on('message', (value) => messages.push(value as Record<string, any>));
  const exited = new Promise<void>((resolve) =>
    child.once('exit', () => resolve()),
  );
  const wait = async (type: string): Promise<Record<string, any>> => {
    const found = messages.find((value) => value.type === type);
    if (found) return found;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        child.off('message', receive);
        child.off('exit', fail);
      };
      const receive = (value: any) => {
        if (value.type === type) {
          cleanup();
          resolve(value);
        }
      };
      const fail = () => {
        cleanup();
        reject(
          new Error(
            `Worker exited before ${type}: ${stderr} ${JSON.stringify(messages)}`,
          ),
        );
      };
      child.on('message', receive);
      child.once('exit', fail);
      if (child.exitCode !== null || child.signalCode !== null) fail();
    });
  };
  return { child, wait, exited };
}

// Exercise the public native runner with a real durable adapter. Faults cross
// the application-owned storage boundary, never fabricated native events.
describe('public native custom storage durability', () => {
  it.each(['goals', 'children', 'checklist'] as const)(
    'rejects unsupported %s before acquiring storage or dispatching work',
    async (kind) => {
      const durable = fileThreadStore(await directory());
      const server = new ModelServer([]);
      const provider = await providerFor(server);
      let acquisitions = 0;
      let effects = 0;
      const storage: CanonicalThreadStore = {
        ...durable,
        acquire: async (...args) => {
          acquisitions++;
          return durable.acquire(...args);
        },
      };
      const agent = new Agent({
        instructions: 'Do work.',
        model: 'gpt-5.1-codex',
        provider,
        tools: [
          kind === 'goals'
            ? nativeGoals()
            : kind === 'children'
              ? new NativeAgents()
              : checklist(),
          tool({
            name: 'record',
            description: 'Record.',
            parameters: z.object({}),
            execute: () => {
              effects++;
              return 'recorded';
            },
          }),
        ],
      });
      await expect(agent.session({ storage })).rejects.toThrow(
        /Custom canonical storage does not support/,
      );
      expect(acquisitions).toBe(0);
      expect(effects).toBe(0);
      await provider.close();
      server.assertExhausted();
    },
  );

  it('cold resumes completed history in another process without repeating an effect', async () => {
    const path = await directory();
    const server = new ModelServer([
      [call('record', {}, { callId: 'durable-effect' })],
      [message('recorded once')],
    ]);
    const sourceKey = 'synthetic-source-credential';
    const currentKey = 'synthetic-current-credential';
    const destination = new ModelServer([
      (request) => {
        expect(JSON.stringify(request.input)).toContain('recorded once');
        return [call('record', {}, { callId: 'current-call' })];
      },
      [message('current callback complete')],
    ]);
    const first = await worker(server, {
      label: 'source',
      apiKey: sourceKey,
      directory: path,
      effects: join(path, 'effects'),
      mode: 'run',
    });
    const opened = await first.wait('opened');
    const result = await first.wait('result');
    await first.wait('done');
    await first.exited;
    const second = await worker(destination, {
      label: 'current',
      apiKey: currentKey,
      directory: path,
      effects: join(path, 'effects'),
      mode: 'run',
      resume: opened.id,
    });
    expect((await second.wait('opened')).history).toEqual(result.history);
    expect((await second.wait('result')).output).toBe(
      'current callback complete',
    );
    await second.wait('done');
    await second.exited;
    expect(await readFile(join(path, 'effects'), 'utf8')).toBe(
      'source\ncurrent\n',
    );
    expect(JSON.stringify(result.history)).toContain('recorded once');
    expect(result.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'function_call',
          callId: 'durable-effect',
        }),
        expect.objectContaining({
          type: 'function_call_output',
          callId: 'durable-effect',
        }),
      ]),
    );
    expect(
      server.requestHeaders.map((headers) => headers.authorization),
    ).toEqual([`Bearer ${sourceKey}`, `Bearer ${sourceKey}`]);
    expect(
      destination.requestHeaders.map((headers) => headers.authorization),
    ).toEqual([`Bearer ${currentKey}`, `Bearer ${currentKey}`]);
    destination.assertExhausted();
    server.assertExhausted();
  }, 45000);

  it('fences competing process writers and permits a new owner after joined close', async () => {
    const path = await directory();
    const server = new ModelServer([]);
    const owner = await worker(server, { directory: path, mode: 'hold-open' });
    const opened = await owner.wait('opened');
    const competitor = await worker(server, {
      directory: path,
      mode: 'hold-open',
      resume: opened.id,
    });
    expect((await competitor.wait('failure')).message).toMatch(
      /owner|writer|locked|lease|fenc|canonical storage operation failed/i,
    );
    await competitor.exited;
    owner.child.send('close');
    await owner.wait('done');
    await owner.exited;
    const successor = await worker(server, {
      directory: path,
      mode: 'hold-open',
      resume: opened.id,
    });
    expect((await successor.wait('opened')).id).toBe(opened.id);
    successor.child.send('close');
    await successor.wait('done');
    await successor.exited;
    server.assertExhausted();
  }, 45000);

  it('does not replay an effect after SIGKILL before its completion was persisted', async () => {
    const path = await directory();
    const effects = join(path, 'effects');
    const server = new ModelServer([
      [call('record', {}, { callId: 'ambiguous-effect' })],
    ]);
    const first = await worker(server, {
      directory: path,
      effects,
      mode: 'hold-effect',
    });
    const opened = await first.wait('opened');
    const submitted = await first.wait('submitted');
    await first.wait('effect');
    await expect(
      reconcileThreadStore(fileThreadStore(path), {
        threadId: opened.id,
        turnId: submitted.turnId,
        callId: 'ambiguous-effect',
        result: 'must not overwrite a live owner',
      }),
    ).rejects.toThrow(
      /owner|writer|locked|lease|fenc|canonical storage operation failed/i,
    );
    first.child.kill('SIGKILL');
    await first.exited;
    // The application must establish process death before removing a stale
    // reference-adapter lock. The adapter never steals a live owner's lease.
    await rm(join(path, `${opened.id}.lock`), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      const resumed = await worker(server, {
        directory: path,
        effects,
        mode: 'hold-open',
        resume: opened.id,
      });
      expect((await resumed.wait('failure')).message).toMatch(
        /unknown|unresolved|reconcil/i,
      );
      await resumed.exited;
    }
    expect(await readFile(effects, 'utf8')).toBe('effect\n');
    const reconciliation = {
      threadId: opened.id,
      turnId: submitted.turnId,
      callId: 'ambiguous-effect',
      result: 'external effect verified',
    };
    await reconcileThreadStore(fileThreadStore(path), reconciliation);
    await expect(
      reconcileThreadStore(fileThreadStore(path), reconciliation),
    ).rejects.toThrow(/pending|unresolved|already|intent/i);
    const currentServer = new ModelServer([
      (request) => {
        expect(JSON.stringify(request.input)).toContain(
          'external effect verified',
        );
        return [call('record', {}, { callId: 'current-effect' })];
      },
      [message('continued after reconciliation')],
    ]);
    const currentProvider = await providerFor(currentServer);
    const recovered = await new Agent({
      instructions: 'Use record when requested.',
      model: 'gpt-5',
      provider: currentProvider,
      tools: [
        tool({
          name: 'record',
          description: 'Record.',
          parameters: z.object({}),
          execute: async () => {
            await appendFile(effects, 'current binding\n');
            return 'current';
          },
        }),
      ],
    }).session({ storage: fileThreadStore(path), resume: opened.id });
    expect(recovered.id).toBe(opened.id);
    expect(
      (
        await (
          await recovered.submit('Continue after verified reconciliation.')
        ).wait()
      ).finalOutput,
    ).toBe('continued after reconciliation');
    const recoveredHistory = await history(recovered);
    expect(
      recoveredHistory.filter(
        (item) =>
          item.type === 'function_call_output' &&
          item.callId === 'ambiguous-effect',
      ),
    ).toHaveLength(1);
    await recovered.close();
    await currentProvider.close();
    expect(await readFile(effects, 'utf8')).toBe('effect\ncurrent binding\n');
    currentServer.assertExhausted();
    server.assertExhausted();
  }, 45000);

  it('does not treat canceled native cleanup as a committed callback result', async () => {
    const path = await directory();
    const effects = join(path, 'effects');
    const server = new ModelServer([
      [call('record', {}, { callId: 'canceled-effect' })],
    ]);
    const running = await worker(server, {
      directory: path,
      effects,
      mode: 'hold-abort',
    });
    const opened = await running.wait('opened');
    await running.wait('effect');
    running.child.send('close');
    expect((await running.wait('close-error')).message).toMatch(
      /cleanup|cancel|abort/i,
    );
    await running.exited;
    const reopened = await worker(server, {
      directory: path,
      effects,
      mode: 'hold-open',
      resume: opened.id,
    });
    expect((await reopened.wait('failure')).message).toMatch(
      /unknown|unresolved|reconcil/i,
    );
    await reopened.exited;
    expect(await readFile(effects, 'utf8')).toBe('effect\n');
    server.assertExhausted();
  }, 45000);

  it('fails opening before model dispatch when the store read is unavailable', async () => {
    const durable = fileThreadStore(await directory());
    const server = new ModelServer([]);
    const provider = await providerFor(server);
    let releases = 0;
    const storage: CanonicalThreadStore = {
      acquire: (...args) => durable.acquire(...args),
      commit: (...args) => durable.commit(...args),
      read: async () => {
        throw new Error('fixture read unavailable');
      },
      release: async (...args) => {
        releases++;
        await durable.release(...args);
      },
    };
    await expect(
      new Agent({ instructions: 'Answer.', model: 'gpt-5', provider }).session({
        storage,
      }),
    ).rejects.toThrow(/canonical storage operation failed/);
    expect(releases).toBe(1);
    await provider.close();
    server.assertExhausted();
  });

  it.each(['commit', 'flush'] as const)(
    'does not dispatch the callback when its intent %s fails',
    async (failurePoint) => {
      const durable = fileThreadStore(await directory());
      let armed = false;
      let effects = 0;
      const storage: CanonicalThreadStore = {
        acquire: (...args) => durable.acquire(...args),
        read: (...args) => durable.read(...args),
        release: (...args) => durable.release(...args),
        commit: async (...args) => {
          if (armed && failurePoint === 'commit')
            throw new Error('fixture intent durability unavailable');
          await durable.commit(...args);
        },
        flush: async () => {
          if (armed && failurePoint === 'flush')
            throw new Error('fixture intent durability unavailable');
        },
      };
      const server = new ModelServer(
        [[call('record', {}, { callId: 'blocked-effect' })]],
        [],
        () => {
          armed = true;
        },
      );
      const provider = await providerFor(server);
      const session = await new Agent({
        instructions: 'Record.',
        model: 'gpt-5',
        provider,
        tools: [
          tool({
            name: 'record',
            description: 'Record once.',
            parameters: z.object({}),
            execute: () => {
              effects++;
              return 'recorded';
            },
          }),
        ],
      }).session({ storage });
      await expect((await session.submit('Record.')).wait()).rejects.toThrow(
        /canonical storage operation failed/,
      );
      await expect(session.close()).rejects.toThrow(
        /canonical storage operation failed/,
      );
      await expect(session.close()).rejects.toThrow(
        /canonical storage operation failed/,
      );
      await provider.close();
      expect(effects).toBe(0);
      server.assertExhausted();
    },
  );

  it('reports a failed initial write before model or tool dispatch', async () => {
    const durable = fileThreadStore(await directory());
    const server = new ModelServer([]);
    const provider = await providerFor(server);
    const storage: CanonicalThreadStore = {
      acquire: (...args) => durable.acquire(...args),
      read: (...args) => durable.read(...args),
      release: (...args) => durable.release(...args),
      commit: async () => {
        throw new Error('fixture initial commit unavailable');
      },
    };
    const agent = new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
    });
    const failure = await agent.session({ storage }).catch((error) => error);
    expect(
      String(failure) +
        String(failure.cause) +
        JSON.stringify(failure.errors?.map(String)),
    ).toMatch(/canonical storage operation failed/);
    await provider.close();
    server.assertExhausted();
  });

  it.each(['before release', 'lost acknowledgment'] as const)(
    'reports %s and retries close without discarding committed history',
    async (failurePoint) => {
      const path = await directory();
      const durable = fileThreadStore(path);
      const server = new ModelServer([[message('durable answer')]]);
      const provider = await providerFor(server);
      let releases = 0;
      const storage: CanonicalThreadStore = {
        acquire: (...args) => durable.acquire(...args),
        read: (...args) => durable.read(...args),
        commit: (...args) => durable.commit(...args),
        release: async (...args) => {
          if (++releases === 1) {
            if (failurePoint === 'lost acknowledgment')
              await durable.release(...args);
            throw new Error('fixture release unavailable');
          }
          await durable.release(...args);
        },
      };
      const session = await new Agent({
        instructions: 'Answer.',
        model: 'gpt-5',
        provider,
      }).session({ storage });
      await (await session.submit('Answer.')).wait();
      const id = session.id;
      const expected = await history(session);
      await expect(session.close()).rejects.toThrow(
        /canonical storage operation failed/,
      );
      await session.close();
      expect(releases).toBe(2);
      await provider.close();
      const current = await providerFor(server);
      const reopened = await new Agent({
        instructions: 'Answer.',
        model: 'gpt-5',
        provider: current,
      }).session({ storage: fileThreadStore(path), resume: id });
      expect(await history(reopened)).toEqual(expected);
      await reopened.close();
      await current.close();
      server.assertExhausted();
    },
  );

  it.skipIf(process.platform !== 'linux').each(['intent', 'result'] as const)(
    'reports a real built-in local %s write failure and stops further dispatch',
    async (boundary) => {
      const path = await directory();
      const server = new ModelServer(
        [[call('record', {}, { callId: 'local-failed-effect' })]],
        [],
        () => {
          if (boundary === 'intent') {
            expect(child?.pid).toBeTypeOf('number');
            execFileSync(
              '/usr/bin/prlimit',
              ['--pid', String(child!.pid), '--fsize=0:unlimited'],
              { stdio: 'pipe' },
            );
          }
        },
      );
      const running = await worker(server, {
        directory: join(path, 'local'),
        effects: join(path, 'effects'),
        local: true,
        mode: `local-${boundary}-fail`,
      });
      const child = running.child;
      await running.wait('opened');
      expect((await running.wait('turn-error')).message).toMatch(
        /storage|persist|file|large|write/i,
      );
      expect((await running.wait('sticky-error')).message).toMatch(
        /storage|persist|file|large|write|failed/i,
      );
      expect((await running.wait('close-error')).message).toMatch(
        /storage|persist|file|large|write/i,
      );
      expect((await running.wait('repeated-close-error')).message).toMatch(
        /storage|persist|file|large|write/i,
      );
      await running.wait('failure');
      await running.exited;
      expect(running.child.exitCode).toBe(1);
      expect(running.child.signalCode).toBeNull();
      const effects = await readFile(join(path, 'effects'), 'utf8').catch(
        (error) => {
          if (error.code === 'ENOENT') return '';
          throw error;
        },
      );
      expect(effects).toBe(boundary === 'result' ? 'effect\n' : '');
      server.assertExhausted();
    },
    45000,
  );

  it('stops before an effect when a committed intent loses both write acknowledgments', async () => {
    const durable = fileThreadStore(await directory());
    let armed = false;
    let attempts = 0;
    let effects = 0;
    let original: Parameters<CanonicalThreadStore['commit']> | undefined;
    const storage: CanonicalThreadStore = {
      acquire: (...args) => durable.acquire(...args),
      read: (...args) => durable.read(...args),
      release: (...args) => durable.release(...args),
      commit: async (...args) => {
        if (!armed) return durable.commit(...args);
        attempts++;
        if (attempts === 1) {
          original = args;
          await durable.commit(...args);
        } else {
          expect(args).toEqual(original);
        }
        throw new Error('fixture lost write and confirmation acknowledgments');
      },
    };
    const server = new ModelServer(
      [[call('record', {}, { callId: 'unconfirmed-effect' })]],
      [],
      () => {
        armed = true;
      },
    );
    const provider = await providerFor(server);
    const session = await new Agent({
      instructions: 'Record.',
      model: 'gpt-5',
      provider,
      tools: [
        tool({
          name: 'record',
          description: 'Record.',
          parameters: z.object({}),
          execute: () => {
            effects++;
            return 'recorded';
          },
        }),
      ],
    }).session({ storage });
    await expect((await session.submit('Record.')).wait()).rejects.toThrow(
      /canonical storage operation failed/,
    );
    await expect(session.close()).rejects.toThrow(
      /canonical storage operation failed/,
    );
    await provider.close();
    expect(attempts).toBe(2);
    expect(effects).toBe(0);
    server.assertExhausted();
  });

  it.each(['lost acknowledgment', 'commit rejection'] as const)(
    'handles %s at the tool completion boundary without duplicate effects',
    async (fault) => {
      const path = await directory();
      const durable = fileThreadStore(path);
      let armed = false;
      let injected = 0;
      let effects = 0;
      const storage: CanonicalThreadStore = {
        acquire: (...args) => durable.acquire(...args),
        read: (...args) => durable.read(...args),
        release: (...args) => durable.release(...args),
        commit: async (...args) => {
          if (armed && injected++ === 0) {
            if (fault === 'lost acknowledgment') await durable.commit(...args);
            throw new Error(`fixture ${fault}`);
          }
          await durable.commit(...args);
        },
      };
      const server = new ModelServer([
        [call('record', {}, { callId: 'fault-effect' })],
        ...(fault === 'lost acknowledgment' ? [[message('finished')]] : []),
      ]);
      const provider = await providerFor(server);
      const agent = new Agent({
        instructions: 'Use record.',
        model: 'gpt-5',
        provider,
        tools: [
          tool({
            name: 'record',
            description: 'Record once.',
            parameters: z.object({}),
            execute: () => {
              effects++;
              armed = true;
              return 'recorded';
            },
          }),
        ],
      });
      const session = await agent.session({ storage });
      const id = session.id;
      if (fault === 'lost acknowledgment') {
        expect(
          (await (await session.submit('Record.')).wait()).finalOutput,
        ).toBe('finished');
        await session.close();
      } else {
        await expect((await session.submit('Record.')).wait()).rejects.toThrow(
          /canonical storage operation failed/,
        );
        await expect(session.close()).rejects.toThrow(
          /canonical storage operation failed/,
        );
      }
      await provider.close();
      expect(effects).toBe(1);
      expect(injected).toBeGreaterThan(0);
      const reopenedProvider = await providerFor(server);
      const opening = new Agent({
        instructions: 'Use record.',
        model: 'gpt-5',
        provider: reopenedProvider,
      }).session({ storage: fileThreadStore(path), resume: id });
      if (fault === 'commit rejection') {
        await expect(opening).rejects.toThrow(/unknown|unresolved|reconcil/i);
        await reopenedProvider.close();
        expect(effects).toBe(1);
        server.assertExhausted();
        return;
      }
      const reopened = await opening;
      const restored = await history(reopened);
      expect(restored).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'function_call',
            callId: 'fault-effect',
          }),
        ]),
      );
      if (fault === 'lost acknowledgment')
        expect(restored).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'function_call_output',
              callId: 'fault-effect',
            }),
          ]),
        );
      await reopened.close();
      await reopenedProvider.close();
      expect(effects).toBe(1);
      server.assertExhausted();
    },
    30000,
  );
});
