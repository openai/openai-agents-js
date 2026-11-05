import { fork, type ChildProcess } from 'node:child_process';
import { access, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Environment,
  NativeProvider,
  localStorage,
  manualTool,
} from '../../src';
import {
  binding,
  type Engine,
  type NativeThread,
} from '../../src/runtime/binding';
import * as nativeBinding from '../../src/runtime/binding';
import { NativeProviderRoutes } from '../../src/runtime/http-model';
import { Session as OwnedSession } from '../../src/runtime/session';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

const homes: string[] = [];
const workers: ChildProcess[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    workers.splice(0).map(async (child) => {
      if (child.exitCode === null && child.signalCode === null) {
        const exit = new Promise<void>((resolve) =>
          child.once('exit', () => resolve()),
        );
        child.kill('SIGKILL');
        await exit;
      }
    }),
  );
  await ModelServer.closeAll();
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});
async function profile() {
  const home = await mkdtemp(join(tmpdir(), 'native-storage-public-'));
  homes.push(home);
  return {
    home,
    storage: localStorage(join(home, 'profile')),
    effects: join(home, 'effects'),
  };
}
async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-public-storage',
    supportsWebsockets: false,
  });
}
async function worker(server: ModelServer, config: Record<string, unknown>) {
  const provider = await providerFor(server);
  const child = fork(
    fileURLToPath(
      new URL('./fixtures/local-storage-worker.ts', import.meta.url),
    ),
    [JSON.stringify({ ...config, url: provider.baseUrl })],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  await provider.close();
  workers.push(child);
  const messages: Array<Record<string, any>> = [];
  let stderr = '';
  child.stderr?.on('data', (data) => {
    stderr += String(data);
  });
  child.on('message', (msg) => messages.push(msg as Record<string, any>));
  const exited = new Promise<{ code: number | null; signal: string | null }>(
    (resolve) =>
      child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  async function wait(type: string): Promise<Record<string, any>> {
    const found = messages.find((x) => x.type === type);
    if (found) return found;
    return new Promise((resolve, reject) => {
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
      const cleanup = () => {
        child.off('message', receive);
        child.off('exit', fail);
      };
      child.on('message', receive);
      child.once('exit', fail);
      if (child.exitCode !== null || child.signalCode !== null) fail();
    });
  }
  return { child, wait, exited, messages };
}
const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

describe('public native local profiles', () => {
  it('captures a structural absolute profile before the binding await', async () => {
    const p = await profile();
    const server = new ModelServer([]);
    const provider = await providerFor(server);
    const addon = await binding();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    vi.spyOn(nativeBinding, 'binding').mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return addon;
    });
    const descriptor = { path: p.storage.path };
    const options = { storage: descriptor };
    const opening = new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
    }).session(options);
    await entered.promise;
    descriptor.path = join(p.home, 'other-profile');
    options.storage = { path: join(p.home, 'replaced-profile') };
    release.resolve();
    const session = await opening;
    await session.close();
    await provider.close();
    expect(await exists(p.storage.path)).toBe(true);
    expect(await exists(descriptor.path)).toBe(false);
    expect(await exists(options.storage.path)).toBe(false);
  });
  it('cold reopens with current credentials and callbacks while keeping credentials out of durable history and errors', async () => {
    const p = await profile();
    const server = new ModelServer([
      [call('record', {}, { callId: 'source-call' })],
      [message('source done')],
    ]);
    const destination = new ModelServer([
      (request) => {
        expect(JSON.stringify(request.input)).toContain('source');
        return [call('record', {}, { callId: 'destination-call' })];
      },
      [message('destination done')],
    ]);
    const sourceKey = `synthetic-private-source-${randomUUID()}`;
    const destinationKey = `synthetic-private-destination-${randomUUID()}`;
    const first = await worker(server, {
      apiKey: sourceKey,
      profile: p.storage.path,
      effects: p.effects,
      label: 'source',
      mode: 'run',
    });
    const opened = await first.wait('opened');
    const sourceResult = await first.wait('result');
    await first.wait('done');
    expect((await first.exited).code).toBe(0);
    const second = await worker(destination, {
      apiKey: destinationKey,
      profile: p.storage.path,
      effects: p.effects,
      label: 'destination',
      mode: 'run',
      resume: opened.id,
    });
    const destinationOpened = await second.wait('opened');
    expect(destinationOpened.id).toBe(opened.id);
    expect(destinationOpened.history).toEqual(sourceResult.history);
    expect(sourceResult.history.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'function_call',
          name: 'record',
          callId: 'source-call',
        }),
        expect.objectContaining({
          type: 'function_call_output',
          callId: 'source-call',
        }),
      ]),
    );
    expect(JSON.stringify(sourceResult.history.items)).toContain('source done');
    expect(sourceResult.history.turns).toHaveLength(1);
    expect(sourceResult.history.turns[0].createdAt).toBeTypeOf('number');
    await second.wait('done');
    expect((await second.exited).code).toBe(0);
    expect(await readFile(p.effects, 'utf8')).toBe('source\ndestination\n');
    expect(
      server.requestHeaders.map((headers) => headers.authorization),
    ).toEqual([`Bearer ${sourceKey}`, `Bearer ${sourceKey}`]);
    expect(
      destination.requestHeaders.map((headers) => headers.authorization),
    ).toEqual([`Bearer ${destinationKey}`, `Bearer ${destinationKey}`]);
    // Observe a real opening error, including its stack, cause and nested errors.
    const rejected = await worker(destination, {
      profile: p.storage.path,
      effects: p.effects,
      label: 'rejected',
      mode: 'hold-open',
      resume: randomUUID(),
      apiKey: destinationKey,
    });
    const failure = await rejected.wait('failure');
    expect(failure.details).toBeTypeOf('string');
    expect(failure.details.length).toBeGreaterThan(0);
    expect((await rejected.exited).code).toBe(1);
    // All three processes have joined cleanup before reading profile bytes.
    const entries = await readdir(p.storage.path, {
      recursive: true,
      withFileTypes: true,
    });
    expect(entries.some((entry) => entry.isSymbolicLink())).toBe(false);
    const regularFiles = entries.filter((entry) => entry.isFile());
    expect(regularFiles.length).toBeGreaterThan(0);
    for (const key of [sourceKey, destinationKey]) {
      expect(
        JSON.stringify([
          ...first.messages,
          ...second.messages,
          ...rejected.messages,
        ]),
      ).not.toContain(key);
      for (const entry of regularFiles) {
        const bytes = await readFile(join(entry.parentPath, entry.name));
        expect(bytes.includes(Buffer.from(key)), entry.name).toBe(false);
      }
    }
    server.assertExhausted();
    destination.assertExhausted();
  }, 45000);

  it('fences another process writer and releases it after joined close', async () => {
    const p = await profile();
    const server = new ModelServer([]);
    const owner = await worker(server, {
      profile: p.storage.path,
      effects: p.effects,
      label: 'owner',
      mode: 'hold-open',
    });
    const { id } = await owner.wait('opened');
    const provider = await providerFor(server);
    const agent = new Agent({
      instructions:
        'Use the current managed record tool. Preserve conversation history.',
      provider,
      model: 'gpt-5',
    });
    await expect(
      agent.session({ storage: p.storage, resume: id }),
    ).rejects.toThrow();
    owner.child.send('close');
    await owner.wait('done');
    await owner.exited;
    const next = await agent.session({ storage: p.storage, resume: id });
    expect(next.id).toBe(id);
    await next.close();
    await provider.close();
    expect(server.requests).toHaveLength(0);
  }, 45000);

  it('preserves a model-consumed receipt across kill without replaying the tool', async () => {
    const p = await profile();
    const consumed = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const server = new ModelServer([
      [call('record', {}, { callId: 'known-call' })],
      async (request) => {
        expect(JSON.stringify(request.input)).toContain('source');
        consumed.resolve();
        await release.promise;
        return [message('unpublished final')];
      },
      [message('new root')],
    ]);
    const first = await worker(server, {
      profile: p.storage.path,
      effects: p.effects,
      label: 'source',
      mode: 'run',
    });
    const { id } = await first.wait('opened');
    try {
      await consumed.promise;
      first.child.kill('SIGKILL');
      await first.exited;
    } finally {
      release.resolve();
    }
    const next = await worker(server, {
      profile: p.storage.path,
      effects: p.effects,
      label: 'destination',
      mode: 'run',
      resume: id,
    });
    await next.wait('done');
    expect((await next.exited).code).toBe(0);
    expect(await readFile(p.effects, 'utf8')).toBe('source\n');
    const history = JSON.stringify(server.requests[2].input);
    expect(history).toContain('source');
    expect(history).not.toContain('unpublished final');
    server.assertExhausted();
  }, 45000);

  it.each([
    ['hold-before', 'beforeEffect', 'not_applied'],
    ['hold-effect', 'effect', 'applied'],
  ])(
    'requires a verified result after process loss in %s',
    async (mode, milestone, outcome) => {
      const p = await profile();
      const server = new ModelServer([
        [call('record', {}, { callId: 'unknown-call' })],
        [message('Recovered the original conversation.')],
        [call('record', {}, { callId: 'unknown-call' })],
      ]);
      const first = await worker(server, {
        profile: p.storage.path,
        effects: p.effects,
        label: 'source',
        mode,
      });
      const { id } = await first.wait('opened');
      await first.wait(milestone);
      first.child.kill('SIGKILL');
      await first.exited;

      const reopen = (options: Record<string, unknown> = {}) =>
        worker(server, {
          profile: p.storage.path,
          effects: p.effects,
          label: 'destination',
          mode: 'run',
          resume: id,
          ...options,
        });
      const next = await reopen();
      const hold = await next.wait('failure');
      expect(hold.message).toContain('unknown tool effects');
      expect(hold.calls).toEqual([
        {
          threadId: id,
          turnId: expect.any(String),
          callId: 'unknown-call',
          name: 'record',
          namespace: null,
          arguments: '{}',
        },
      ]);
      const { threadId, turnId, callId } = hold.calls[0];
      expect(hold.turns).toContainEqual({ id: turnId, status: 'interrupted' });
      expect(hold.items).toContainEqual(
        expect.objectContaining({ type: 'function_call', turnId, callId }),
      );
      expect((await next.exited).code).toBe(1);
      expect(server.requests).toHaveLength(1);
      // The sole effects worker exited. This append-only fixture journal is
      // authoritative for whether this particular operation applied.
      const effect = (await exists(p.effects))
        ? await readFile(p.effects, 'utf8')
        : '';
      expect(effect).toBe(outcome === 'applied' ? 'source\n' : '');
      const receipt = {
        threadId,
        turnId,
        callId,
        outcome,
        result: `Verified by the application: ${outcome}`,
      };
      const foreign = await reopen({
        reconciledCalls: [{ ...receipt, threadId: randomUUID() }],
      });
      expect((await foreign.wait('failure')).message).toContain(
        'different thread',
      );
      expect((await foreign.exited).code).toBe(1);
      expect(server.requests).toHaveLength(1);

      const recovered = await reopen({ reconciledCalls: [receipt] });
      const opened = await recovered.wait('opened');
      expect(opened.id).toBe(id);
      expect(opened.history.turns).toContainEqual(
        expect.objectContaining({ id: receipt.turnId, status: 'cancelled' }),
      );
      expect(opened.history.items).toContainEqual(
        expect.objectContaining({
          type: 'function_call_output',
          callId: receipt.callId,
          turnId: receipt.turnId,
          output: receipt.result,
          reconciliation: outcome,
        }),
      );
      expect((await recovered.wait('result')).output).toBe(
        'Recovered the original conversation.',
      );
      expect((await recovered.exited).code).toBe(0);
      expect(server.requests[1].input).toContainEqual(
        expect.objectContaining({
          type: 'function_call_output',
          call_id: receipt.callId,
          output: receipt.result,
        }),
      );

      const conflict = await reopen({
        reconciledCalls: [{ ...receipt, result: 'changed' }],
      });
      expect((await conflict.wait('failure')).message).toContain(
        'retained result',
      );
      expect((await conflict.exited).code).toBe(1);
      expect(server.requests).toHaveLength(2);

      const repeated = await reopen({ reconciledCalls: [receipt] });
      const sameHistory = (await repeated.wait('opened')).history.items;
      expect(
        sameHistory.filter(
          (item: { reconciliation?: string }) => item.reconciliation,
        ),
      ).toHaveLength(1);
      expect((await repeated.wait('failure')).message).toContain(
        'Cannot reuse an original call identity during recovery',
      );
      expect((await repeated.exited).code).toBe(1);
      expect(
        (await exists(p.effects)) ? await readFile(p.effects, 'utf8') : '',
      ).toBe(effect);
      server.assertExhausted();
    },
    60000,
  );

  it('rejects portable operations before spending a live local manual grant', async () => {
    const p = await profile();
    const server = new ModelServer([
      [call('lookup', {}, { callId: 'manual-local' })],
      [message('answered')],
    ]);
    const provider = await providerFor(server);
    const lookup = manualTool({
      name: 'lookup',
      description: 'Read.',
      parameters: z.object({}),
      result: z.string(),
    });
    const agent = new Agent({
      instructions: 'Read.',
      model: 'gpt-5',
      provider,
      tools: [lookup],
    });
    const session = await agent.session({ storage: p.storage });
    const pending = (async () => {
      for await (const event of session.events()) {
        if (event.type === 'action_requested') {
          const found = lookup.match(event);
          if (found) return found;
        }
      }
      throw new Error('No manual action');
    })();
    const turn = await session.submit('Read.');
    const request = await pending;
    await expect(session.saveState()).rejects.toThrow('Local storage');
    await expect(session.suspend()).rejects.toThrow('Local storage');
    await expect(session.compact()).rejects.toThrow('settled open session');
    await session.submit(request.reply('known receipt'));
    expect((await turn.wait()).finalOutput).toBe('answered');
    await session.close();
    await provider.close();
    expect(await exists(p.storage.path)).toBe(true);
    server.assertExhausted();
  }, 30000);
});

function captureTemporaryHome(provider: NativeProvider) {
  let home: string | undefined;
  const acquire = provider._acquire.bind(provider);
  vi.spyOn(provider, '_acquire').mockImplementation(() => {
    const lease = acquire();
    const open = lease.open.bind(lease);
    lease.open = async () => {
      const result = await open();
      home = result.codex_home;
      return result;
    };
    return lease;
  });
  return () => {
    if (!home) throw new Error('No temporary home captured');
    return home;
  };
}

describe('public completed and incomplete local cleanup', () => {
  it('rethrows the original opening error after clean joined cleanup', async () => {
    const p = await profile();
    const server = new ModelServer([]);
    const provider = await providerFor(server);
    const home = captureTemporaryHome(provider);
    const original = new Error('setup rejected without cleanup failure');
    vi.spyOn(OwnedSession.prototype, '_start').mockRejectedValueOnce(original);
    await expect(
      new Agent({ instructions: 'Answer.', provider }).session({
        storage: p.storage,
      }),
    ).rejects.toBe(original);
    expect(await exists(home())).toBe(false);
    expect(await exists(p.storage.path)).toBe(true);
    await provider.close();
  });
  it.each(['before Session', 'after Session'] as const)(
    'keeps the opening error while releasing completed sticky owners %s',
    async (point) => {
      const p = await profile();
      const server = new ModelServer([]);
      const provider = await providerFor(server);
      const home = captureTemporaryHome(provider);
      const addon = await binding();
      const openingError = new Error('original setup failure');
      if (point === 'before Session') {
        vi.spyOn(
          NativeProviderRoutes.prototype,
          'bindEngine',
        ).mockRejectedValueOnce(openingError);
        const report = addon.Engine.prototype._close_report;
        vi.spyOn(
          addon.Engine.prototype,
          '_close_report',
        ).mockImplementationOnce(async function (this: Engine) {
          await report.call(this);
          return 'completed setup persistence diagnostic';
        });
      } else {
        vi.spyOn(OwnedSession.prototype, '_start').mockRejectedValueOnce(
          openingError,
        );
        const report = addon.NativeThread.prototype._close_report;
        vi.spyOn(
          addon.NativeThread.prototype,
          '_close_report',
        ).mockImplementationOnce(async function (this: NativeThread) {
          await report.call(this);
          return 'completed setup persistence diagnostic';
        });
      }
      const failure = await new Agent({ instructions: 'Answer.', provider })
        .session({ storage: p.storage })
        .catch((error) => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure.errors[0]).toBe(openingError);
      expect(failure.cause).toBe(openingError);
      expect(String(failure.errors[1])).toContain(
        'completed setup persistence diagnostic',
      );
      expect(await exists(home())).toBe(false);
      expect(await exists(p.storage.path)).toBe(true);
      await provider.close();
    },
  );

  it('preserves one selected-environment acknowledgment attempt across an incomplete engine retry', async () => {
    const executor = await startPublicExecutor();
    const server = new ModelServer([]);
    const provider = await providerFor(server);
    const home = captureTemporaryHome(provider);
    const addon = await binding();
    const original = addon.NativeThread.prototype._close_selected_environment;
    const selected = vi
      .spyOn(addon.NativeThread.prototype, '_close_selected_environment')
      .mockImplementationOnce(async function (this: NativeThread) {
        await original.call(this);
        return 'selected acknowledgment failed after shutdown';
      });
    const engine = vi
      .spyOn(addon.Engine.prototype, '_close_report')
      .mockRejectedValueOnce(new Error('incomplete engine'));
    const session = await new Agent({
      instructions: 'Answer.',
      provider,
    }).session({
      environment: new Environment({
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
        tools: ['exec_command'],
      }),
    });
    try {
      const first = await session.close().catch((error) => error);
      expect(first).toBeInstanceOf(AggregateError);
      expect(await exists(home())).toBe(true);
      const warning = first.errors.find((error: Error) =>
        error.message.includes('selected acknowledgment'),
      );
      expect(warning).toBeDefined();
      await expect(session.close()).rejects.toBe(warning);
      expect(selected).toHaveBeenCalledTimes(1);
      expect(engine).toHaveBeenCalledTimes(2);
      expect(await exists(home())).toBe(false);
      await provider.close();
    } finally {
      await session.close();
      await provider.close();
      await executor.close();
    }
  });
  it.each(['before Session', 'after Session'] as const)(
    'retains failed-opening owners %s until provider.close retries physical shutdown',
    async (point) => {
      const p = await profile();
      const server = new ModelServer([]);
      const provider = await providerFor(server);
      const home = captureTemporaryHome(provider);
      const addon = await binding();
      const original = new Error('original opening failure');
      if (point === 'before Session') {
        vi.spyOn(
          NativeProviderRoutes.prototype,
          'bindEngine',
        ).mockImplementationOnce(() => {
          throw original;
        });
        vi.spyOn(addon.Engine.prototype, '_close_report').mockRejectedValueOnce(
          new Error('held engine shutdown'),
        );
      } else {
        vi.spyOn(OwnedSession.prototype, '_start').mockRejectedValueOnce(
          original,
        );
        vi.spyOn(
          addon.NativeThread.prototype,
          '_close_report',
        ).mockRejectedValueOnce(new Error('held thread shutdown'));
      }
      const agent = new Agent({
        instructions: 'Answer.',
        model: 'gpt-5',
        provider,
      });
      const failure = await agent
        .session({ storage: p.storage })
        .catch((error) => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure.cause).toBe(original);
      expect(failure.errors[0]).toBe(original);
      expect(await exists(home())).toBe(true);
      expect(await exists(p.storage.path)).toBe(true);
      await provider.close();
      expect(await exists(home())).toBe(false);
      expect(await exists(p.storage.path)).toBe(true);
      expect(server.requests).toHaveLength(0);
    },
    30000,
  );

  it.each(['idle', 'active'] as const)(
    'releases physical owners and provider files while rejecting a completed %s diagnostic',
    async (mode) => {
      const p = await profile();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const server = new ModelServer(
        mode === 'active'
          ? [
              async () => {
                entered.resolve();
                await release.promise;
                return [message('never published')];
              },
            ]
          : [],
      );
      const provider = await providerFor(server);
      const home = captureTemporaryHome(provider);
      const addon = await binding();
      const originalReport = addon.NativeThread.prototype._close_report;
      vi.spyOn(
        addon.NativeThread.prototype,
        '_close_report',
      ).mockImplementationOnce(async function (this: NativeThread) {
        await originalReport.call(this);
        return 'retained persistence diagnostic';
      });
      const session = await new Agent({
        instructions: 'Answer.',
        model: 'gpt-5',
        provider,
      }).session({ storage: p.storage });
      let result: Promise<unknown> | undefined;
      try {
        if (mode === 'active') {
          const turn = await session.submit('Held provider request');
          result = turn.wait().catch((error) => error);
          await entered.promise;
        }
        await expect(session.close()).rejects.toThrow(
          'retained persistence diagnostic',
        );
        await provider.close();
        expect(await exists(home())).toBe(false);
        expect(await exists(p.storage.path)).toBe(true);
      } finally {
        release.resolve();
        await result;
      }
    },
    30000,
  );

  it('retains the first completed diagnostic across incomplete engine retry without repeating thread close', async () => {
    const p = await profile();
    const server = new ModelServer([]);
    const provider = await providerFor(server);
    const home = captureTemporaryHome(provider);
    const addon = await binding();
    const originalReport = addon.NativeThread.prototype._close_report;
    const threadReport = vi
      .spyOn(addon.NativeThread.prototype, '_close_report')
      .mockImplementationOnce(async function (this: NativeThread) {
        await originalReport.call(this);
        return 'first persistence error';
      });
    const engineReport = vi
      .spyOn(addon.Engine.prototype, '_close_report')
      .mockRejectedValueOnce(new Error('incomplete engine drain'));
    const session = await new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
    }).session({ storage: p.storage });
    const first = await session.close().catch((error) => error);
    expect(first).toBeInstanceOf(AggregateError);
    const retained = first.errors.find(
      (error: Error) => error.message === 'first persistence error',
    );
    expect(retained).toBeDefined();
    expect(await exists(home())).toBe(true);
    await expect(provider.close()).rejects.toThrow('open or opening');
    await expect(session.close()).rejects.toBe(retained);
    expect(threadReport).toHaveBeenCalledTimes(1);
    expect(engineReport).toHaveBeenCalledTimes(2);
    await provider.close();
    expect(await exists(home())).toBe(false);
  }, 30000);

  it('retries only provider release after its removal seam fails', async () => {
    const p = await profile();
    const server = new ModelServer([]);
    const provider = await providerFor(server);
    let home = '';
    let calls = 0;
    const acquire = provider._acquire.bind(provider);
    vi.spyOn(provider, '_acquire').mockImplementation(() => {
      const lease = acquire();
      const open = lease.open;
      const release = lease.release;
      lease.open = async () => {
        const value = await open();
        home = value.codex_home;
        return value;
      };
      lease.release = async () => {
        if (++calls === 1) throw new Error('temporary removal blocked');
        await release();
      };
      return lease;
    });
    const addon = await binding();
    const threadReport = vi.spyOn(
      addon.NativeThread.prototype,
      '_close_report',
    );
    const engineReport = vi.spyOn(addon.Engine.prototype, '_close_report');
    const session = await new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
    }).session({ storage: p.storage });
    await expect(session.close()).rejects.toThrow('temporary removal blocked');
    expect(await exists(home)).toBe(true);
    await session.close();
    await provider.close();
    expect(calls).toBe(2);
    expect(threadReport).toHaveBeenCalledTimes(1);
    expect(engineReport).toHaveBeenCalledTimes(1);
    expect(await exists(home)).toBe(false);
    expect(await exists(p.storage.path)).toBe(true);
  }, 30000);
});
