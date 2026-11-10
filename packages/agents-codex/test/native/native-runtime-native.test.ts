import { stat } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { Engine, _PlainRun } from '../../native/index.js';
import type { Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent, NativeError, NativeProvider, NativeRuntime } from '../../src';
import { binding, type JsonObject } from '../../src/runtime/binding';
import { NativeProviderRoutes } from '../../src/runtime/http-model';
import { ModelServer, message } from './fixtures/model-server';

function connections(model: ModelServer) {
  const server = (model as unknown as { server: Server }).server;
  server.keepAliveTimeout = 60_000;
  const ids = new WeakMap<Socket, number>();
  const requests: number[] = [];
  let accepted = 0;
  server.on('connection', (socket) => ids.set(socket, ++accepted));
  server.on('request', (request) => {
    const id = ids.get(request.socket);
    if (id === undefined) throw new Error('Unobserved fixture connection');
    requests.push(id);
  });
  return {
    requests,
    get accepted() {
      return accepted;
    },
  };
}

async function baseUrl(model: ModelServer) {
  const config = await model.config();
  return (config['model_providers.fixture'] as { base_url: string }).base_url;
}

function agentFor(provider: NativeProvider) {
  return new Agent({ provider, model: 'gpt-5', instructions: 'Answer.' });
}

function jsonResponse(text: string) {
  return {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'synthetic-buffered-response',
      object: 'response',
      model: 'gpt-5',
      status: 'completed',
      output: [message(text)],
    }),
  };
}

afterEach(async () => {
  try {
    await ModelServer.closeAll();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'shared native HTTP Responses clients',
  () => {
    it('reuses a real connection across plain runs and full Sessions without sharing credentials, routing or history', async () => {
      const model = new ModelServer([
        [message('plain answer')],
        [message('session answer')],
        [message('session continues')],
      ]);
      const observed = connections(model);
      const paths: string[] = [];
      model.onRecord = (phase, detail) => {
        if (phase === 'MODEL_REQUEST')
          paths.push((detail as { path: string }).path);
      };
      const url = await baseUrl(model);
      await using owner = new NativeRuntime();
      vi.stubEnv('OPENAI_API_KEY', 'synthetic-constructor-key');
      await using first = new NativeProvider({
        runtime: owner,
        baseUrl: url,
        headers: { 'X-Route': 'first-route' },
        queryParams: { route: 'first' },
      });
      await using second = new NativeProvider({
        runtime: owner,
        baseUrl: url,
        apiKey: 'synthetic-second-key',
        headers: { 'X-Route': 'second-route' },
        queryParams: { route: 'second' },
      });
      vi.stubEnv('OPENAI_API_KEY', 'synthetic-opening-key');
      expect(
        (await agentFor(first).run('plain isolated marker')).finalOutput,
      ).toBe('plain answer');
      await using session = await agentFor(second).session();
      expect(
        (await (await session.submit('session isolated marker')).wait())
          .finalOutput,
      ).toBe('session answer');
      await first.close();
      await expect(owner.close()).rejects.toThrow('borrowing Providers');
      expect(
        (await (await session.submit('continue session')).wait()).finalOutput,
      ).toBe('session continues');
      expect(observed.requests).toHaveLength(3);
      expect(new Set(observed.requests).size).toBe(1);
      expect(observed.accepted).toBe(1);
      expect(
        model.requestHeaders.map((headers) => [
          headers.authorization,
          headers['x-route'],
        ]),
      ).toEqual([
        ['Bearer synthetic-opening-key', 'first-route'],
        ['Bearer synthetic-second-key', 'second-route'],
        ['Bearer synthetic-second-key', 'second-route'],
      ]);
      expect(
        paths.map((path) => new URL(path, url).searchParams.get('route')),
      ).toEqual(['first', 'second', 'second']);
      expect(JSON.stringify(model.requests[1].input)).not.toContain(
        'plain isolated marker',
      );
      expect(JSON.stringify(model.requests[2].input)).toContain(
        'session isolated marker',
      );
      await session.close();
      await second.close();
      await owner.close();
      model.assertExhausted();
    }, 30_000);

    it('reuses the connection across buffered Providers and a full Session', async () => {
      const model = new ModelServer([
        jsonResponse('buffered plain'),
        jsonResponse('buffered session'),
      ]);
      const observed = connections(model);
      const url = await baseUrl(model);
      await using owner = new NativeRuntime();
      await using first = new NativeProvider({
        runtime: owner,
        baseUrl: url,
        apiKey: 'synthetic-first',
        responseMode: 'buffered',
      });
      await using second = new NativeProvider({
        runtime: owner,
        baseUrl: url,
        apiKey: 'synthetic-second',
        responseMode: 'buffered',
      });
      expect(
        (await agentFor(first).run('buffered plain marker')).finalOutput,
      ).toBe('buffered plain');
      await first.close();
      await using session = await agentFor(second).session();
      expect(
        (await (await session.submit('buffered session marker')).wait())
          .finalOutput,
      ).toBe('buffered session');
      expect(model.requests.map((request) => request.stream)).toEqual([
        false,
        false,
      ]);
      expect(
        model.requestHeaders.map((headers) => headers.authorization),
      ).toEqual(['Bearer synthetic-first', 'Bearer synthetic-second']);
      expect(observed.requests).toHaveLength(2);
      expect(observed.requests[1]).toBe(observed.requests[0]);
      expect(observed.accepted).toBe(1);
      model.assertExhausted();
    }, 30_000);

    it('keeps redirect policy isolated after an unrouted Provider has populated the shared cache', async () => {
      const foreign = new ModelServer([]);
      const location = (await baseUrl(foreign)) + '/redirected';
      const source = new ModelServer([
        [message('unrouted warmup')],
        { status: 307, body: 'synthetic redirect', headers: { location } },
        [message('original route retry')],
      ]);
      const paths: string[] = [];
      source.onRecord = (phase, detail) => {
        if (phase === 'MODEL_REQUEST')
          paths.push((detail as { path: string }).path);
      };
      const url = await baseUrl(source);
      await using owner = new NativeRuntime();
      await using first = new NativeProvider({
        runtime: owner,
        baseUrl: url,
        apiKey: 'synthetic-unrouted',
      });
      await using routed = new NativeProvider({
        runtime: owner,
        baseUrl: url,
        apiKey: 'synthetic-routed',
        headers: { 'X-Route': 'private-route' },
      });
      expect(
        (await agentFor(first).run('warm default redirect policy')).finalOutput,
      ).toBe('unrouted warmup');
      expect(
        (await agentFor(routed).run('preserve routed redirect policy'))
          .finalOutput,
      ).toBe('original route retry');
      expect(paths).toEqual([
        '/v1/responses',
        '/v1/responses',
        '/v1/responses',
      ]);
      expect(foreign.requests).toHaveLength(0);
      expect(
        source.requestHeaders.slice(1).map((headers) => headers['x-route']),
      ).toEqual(['private-route', 'private-route']);
      source.assertExhausted();
      foreign.assertExhausted();
    }, 30_000);

    it('cancels one Provider session while another Provider continues using the owner', async () => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const completed = Promise.withResolvers<void>();
      const model = new ModelServer([
        async () => {
          entered.resolve();
          await release.promise;
          return [message('discarded')];
        },
        [message('sibling survives')],
        [message('sibling continues')],
      ]);
      model.onRecord = (phase, detail) => {
        if (
          phase === 'MODEL_COMPLETED_FRAME' &&
          (detail as { requestIndex: number }).requestIndex === 0
        )
          completed.resolve();
      };
      const url = await baseUrl(model);
      await using owner = new NativeRuntime();
      await using first = new NativeProvider({
        runtime: owner,
        baseUrl: url,
        apiKey: 'synthetic-cancelled',
      });
      await using second = new NativeProvider({
        runtime: owner,
        baseUrl: url,
        apiKey: 'synthetic-survivor',
      });
      await using cancelled = await agentFor(first).session();
      await using survivor = await agentFor(second).session();
      try {
        const turn = await cancelled.submit('cancelled isolated marker');
        const outcome = turn.wait().catch((error: unknown) => error);
        await Promise.race([
          entered.promise,
          outcome.then(() => {
            throw new Error('cancelled turn settled before request');
          }),
        ]);
        expect(
          (await (await survivor.submit('survivor isolated marker')).wait())
            .finalOutput,
        ).toBe('sibling survives');
        await turn.cancel();
        expect(await outcome).toBeInstanceOf(NativeError);
        await cancelled.close();
        await first.close();
        await expect(owner.close()).rejects.toThrow('borrowing Providers');
        expect(
          (await (await survivor.submit('continue survivor')).wait())
            .finalOutput,
        ).toBe('sibling continues');
        expect(JSON.stringify(model.requests[2].input)).not.toContain(
          'cancelled isolated marker',
        );
        expect(
          model.requestHeaders.map((headers) => headers.authorization),
        ).toEqual([
          'Bearer synthetic-cancelled',
          'Bearer synthetic-survivor',
          'Bearer synthetic-survivor',
        ]);
      } finally {
        release.resolve();
        if (model.requests.length > 0) await completed.promise;
      }
      model.assertExhausted();
    }, 30_000);

    it('retains the owner through failed native opening and retryable Engine cleanup', async () => {
      const native = await binding();
      const model = new ModelServer([[message('surviving Provider')]]);
      await using owner = new NativeRuntime();
      const url = await baseUrl(model);
      await using failing = new NativeProvider({
        runtime: owner,
        baseUrl: url,
        apiKey: 'synthetic-failing',
      });
      await using sibling = new NativeProvider({
        runtime: owner,
        baseUrl: url,
        apiKey: 'synthetic-sibling',
      });
      vi.spyOn(
        native.Engine.prototype,
        'start_replaceable_thread',
      ).mockRejectedValueOnce(new Error('injected opening failure'));
      const closeEngine = vi
        .spyOn(native.Engine.prototype, '_close_report')
        .mockRejectedValueOnce(new Error('injected cleanup failure'))
        .mockRejectedValueOnce(new Error('injected cleanup retry failure'));
      await expect(agentFor(failing).session()).rejects.toBeInstanceOf(
        AggregateError,
      );
      await expect(failing.close()).rejects.toThrow(
        'NativeProvider cleanup failed',
      );
      await expect(owner.close()).rejects.toThrow('borrowing Providers');
      await failing.close();
      expect(closeEngine).toHaveBeenCalledTimes(3);
      expect(
        (await agentFor(sibling).run('sibling after failed opening'))
          .finalOutput,
      ).toBe('surviving Provider');
      await sibling.close();
      await owner.close();
      model.assertExhausted();
    }, 30_000);
  },
);

async function runtimeStarts() {
  const native = await binding();
  const calls: {
    kind: 'plain' | 'session';
    engine: Engine;
    promise: Promise<unknown>;
  }[] = [];
  const plain = native.Engine.prototype._plain_run;
  const session = native.Engine.prototype.start_replaceable_thread;
  vi.spyOn(native.Engine.prototype, '_plain_run').mockImplementation(function (
    this: Engine,
    ...args
  ) {
    const promise = Reflect.apply(plain, this, args);
    calls.push({ kind: 'plain', engine: this, promise });
    return promise;
  });
  vi.spyOn(
    native.Engine.prototype,
    'start_replaceable_thread',
  ).mockImplementation(function (this: Engine, ...args) {
    const promise = Reflect.apply(session, this, args);
    calls.push({ kind: 'session', engine: this, promise });
    return promise;
  });
  return calls;
}

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'NativeRuntime private plain Engines',
  () => {
    it('reuses one real Engine across two closed Providers and a macrotask, with detached old controls', async () => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const model = new ModelServer([
        [message('first answer')],
        async () => {
          entered.resolve();
          await release.promise;
          return [message('second answer')];
        },
      ]);
      await using owner = new NativeRuntime();
      const url = await baseUrl(model);
      const options = {
        runtime: owner,
        baseUrl: url,
        apiKey: 'synthetic-runtime',
      };
      const calls = await runtimeStarts();
      const carriers: {
        carrier: NativeProviderRoutes;
        home: string | undefined;
      }[] = [];
      const start = NativeProviderRoutes.prototype.start;
      vi.spyOn(NativeProviderRoutes.prototype, 'start').mockImplementation(
        function (this: NativeProviderRoutes, ...args) {
          carriers.push({
            carrier: this,
            home: args[1].codex_home ?? undefined,
          });
          return Reflect.apply(start, this, args);
        },
      );
      await using first = new NativeProvider(options);
      const a = await agentFor(first).run('first isolated runtime marker');
      const replay = await Array.fromAsync(a.turn.events());
      await first.close();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await using second = new NativeProvider(options);
      const next = agentFor(second).run('second isolated runtime marker');
      try {
        await Promise.race([
          entered.promise,
          next.then(() => {
            throw new Error('second run settled before request');
          }),
        ]);
        expect(calls.map((c) => c.kind)).toEqual(['plain', 'plain']);
        expect(calls[1].engine).toBe(calls[0].engine);
        await first.close();
        await a.turn.cancel();
        await expect(a.turn.steer('stale marker')).rejects.toThrow(
          'no longer active',
        );
        await expect(owner.close()).rejects.toThrow('borrowing Providers');
      } finally {
        release.resolve();
        await next.catch(() => {});
      }
      const b = await next;
      expect([a.finalOutput, b.finalOutput]).toEqual([
        'first answer',
        'second answer',
      ]);
      expect(a.turn.turnId).not.toBe(b.turn.turnId);
      expect(a.turn.sessionId).not.toBe(b.turn.sessionId);
      expect(await Array.fromAsync(a.turn.events())).toEqual(replay);
      expect(JSON.stringify(model.requests[1].input)).toContain(
        'second isolated runtime marker',
      );
      expect(JSON.stringify(model.requests[1].input)).not.toContain(
        'first isolated runtime marker',
      );
      await second.close();
      expect(carriers).toHaveLength(1);
      const { carrier, home } = carriers[0];
      expect(typeof home).toBe('string');
      const server = (carrier as unknown as { server: Server }).server;
      expect(server.listening).toBe(true);
      expect((await stat(home!)).isDirectory()).toBe(true);
      const closed = Promise.withResolvers<void>();
      server.once('close', () => closed.resolve());
      await owner.close();
      await closed.promise;
      expect(server.listening).toBe(false);
      expect(carrier.reuseBinding(calls[0].engine)).toBeUndefined();
      await expect(stat(home!)).rejects.toMatchObject({ code: 'ENOENT' });
      model.assertExhausted();
    }, 30_000);

    it.each(['apiKey', 'headers'] as const)(
      'rejects a different %s before cached execution and uses fresh ordinary resources',
      async (field) => {
        const model = new ModelServer([
          [message('first')],
          [message('changed')],
        ]);
        const url = await baseUrl(model);
        await using owner = new NativeRuntime();
        const calls = await runtimeStarts();
        await using first = new NativeProvider({
          runtime: owner,
          baseUrl: url,
          apiKey: 'synthetic-first',
        });
        expect((await agentFor(first).run('first marker')).finalOutput).toBe(
          'first',
        );
        await first.close();
        await using second = new NativeProvider({
          runtime: owner,
          baseUrl: url,
          apiKey: field === 'apiKey' ? 'synthetic-second' : 'synthetic-first',
          ...(field === 'headers' ? { headers: { 'X-Changed': 'yes' } } : {}),
        });
        expect((await agentFor(second).run('changed marker')).finalOutput).toBe(
          'changed',
        );
        expect(calls.map((c) => c.kind)).toEqual(['plain', 'session']);
        expect(calls[1].engine).not.toBe(calls[0].engine);
        expect(model.requestHeaders[1].authorization).toBe(
          field === 'apiKey'
            ? 'Bearer synthetic-second'
            : 'Bearer synthetic-first',
        );
        if (field === 'headers')
          expect(model.requestHeaders[1]['x-changed']).toBe('yes');
        model.assertExhausted();
      },
      30_000,
    );

    it('shares an admitted Engine with an overlapping matching call', async () => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const model = new ModelServer([
        async () => {
          entered.resolve();
          await release.promise;
          return [message('first')];
        },
        [message('matching overlap')],
        [message('reused')],
      ]);
      const url = await baseUrl(model);
      await using owner = new NativeRuntime();
      const calls = await runtimeStarts();
      const options = {
        runtime: owner,
        baseUrl: url,
        apiKey: 'synthetic-runtime',
      };
      await using first = new NativeProvider(options);
      await using second = new NativeProvider(options);
      const pending = agentFor(first).run('held first marker');
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error('first run settled before request');
          }),
        ]);
        expect(
          (await agentFor(second).run('overlapping marker')).finalOutput,
        ).toBe('matching overlap');
        expect(calls[1].engine).toBe(calls[0].engine);
        await second.close();
        await expect(owner.close()).rejects.toThrow('borrowing Providers');
      } finally {
        release.resolve();
        await pending.catch(() => {});
      }
      expect((await pending).finalOutput).toBe('first');
      await first.close();
      await using third = new NativeProvider(options);
      expect((await agentFor(third).run('third marker')).finalOutput).toBe(
        'reused',
      );
      expect(calls[2].engine).toBe(calls[0].engine);
      await third.close();
      model.assertExhausted();
    }, 30_000);

    it('never returns a cancelled plain Engine to the owner', async () => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const model = new ModelServer([
        async () => {
          entered.resolve();
          await release.promise;
          return [message('discarded')];
        },
        [message('after cancel')],
      ]);
      const url = await baseUrl(model);
      await using owner = new NativeRuntime();
      const calls = await runtimeStarts();
      const options = {
        runtime: owner,
        baseUrl: url,
        apiKey: 'synthetic-runtime',
      };
      await using first = new NativeProvider(options);
      const controller = new AbortController();
      const result = agentFor(first)
        .run('cancelled marker', { signal: controller.signal })
        .catch((e: unknown) => e);
      try {
        await Promise.race([
          entered.promise,
          result.then(() => {
            throw new Error('run settled before request');
          }),
        ]);
        controller.abort(new Error('requested abort'));
      } finally {
        release.resolve();
        await result;
      }
      expect(await result).toBeInstanceOf(Error);
      await first.close();
      await using second = new NativeProvider(options);
      expect((await agentFor(second).run('next marker')).finalOutput).toBe(
        'after cancel',
      );
      expect(calls[1].engine).not.toBe(calls[0].engine);
      model.assertExhausted();
    }, 30_000);

    it('discards a failed plain attempt and keeps full Sessions out of the cache', async () => {
      const model = new ModelServer([
        { status: 503, body: 'synthetic failure' },
        [message('full session')],
        [message('good plain')],
      ]);
      const url = await baseUrl(model);
      await using owner = new NativeRuntime();
      const calls = await runtimeStarts();
      const options = {
        runtime: owner,
        baseUrl: url,
        apiKey: 'synthetic-runtime',
        requestMaxRetries: 0,
        streamMaxRetries: 0,
      };
      await using first = new NativeProvider(options);
      await expect(agentFor(first).run('failed marker')).rejects.toBeInstanceOf(
        Error,
      );
      await first.close();
      await using second = new NativeProvider(options);
      await using session = await agentFor(second).session();
      expect(
        (await (await session.submit('full marker')).wait()).finalOutput,
      ).toBe('full session');
      await session.close();
      await second.close();
      await using third = new NativeProvider(options);
      expect((await agentFor(third).run('good marker')).finalOutput).toBe(
        'good plain',
      );
      expect(calls.map((c) => c.kind)).toEqual(['plain', 'session', 'plain']);
      expect(new Set(calls.map((c) => c.engine)).size).toBe(3);
      model.assertExhausted();
    }, 30_000);
    it('does not park an Engine when joined native result projection fails late', async () => {
      const model = new ModelServer([
        [message('corrupted projection')],
        [message('valid projection')],
      ]);
      const url = await baseUrl(model);
      await using owner = new NativeRuntime();
      const calls = await runtimeStarts();
      const native = await binding();
      const startSpy = vi.mocked(native.Engine.prototype._plain_run);
      // Capture the installed observer implementation, never the spy itself.
      const observingStart = startSpy.getMockImplementation()!;
      startSpy.mockImplementationOnce(function (
        this: Engine,
        ...args: Parameters<Engine['_plain_run']>
      ) {
        return Reflect.apply(observingStart, this, args).then(
          (handle: _PlainRun) => {
            const wait = handle.wait;
            // Fault injection follows genuine handle settlement; no production export.
            vi.spyOn(handle, 'wait').mockImplementationOnce(function (
              this: _PlainRun,
              ...waitArgs: Parameters<_PlainRun['wait']>
            ) {
              return Reflect.apply(wait, this, waitArgs).then((raw: string) => {
                const dto = JSON.parse(raw);
                dto.finalOutput = 17;
                return JSON.stringify(dto);
              });
            });
            return handle;
          },
        );
      });
      const options = {
        runtime: owner,
        baseUrl: url,
        apiKey: 'synthetic-runtime',
      };
      await using first = new NativeProvider(options);
      await expect(agentFor(first).run('fault marker')).rejects.toBeInstanceOf(
        Error,
      );
      await first.close();
      await using second = new NativeProvider(options);
      expect((await agentFor(second).run('valid marker')).finalOutput).toBe(
        'valid projection',
      );
      expect(calls[1].engine).not.toBe(calls[0].engine);
      model.assertExhausted();
    }, 30_000);
  },
);

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'NativeRuntime concurrent plain leases',
  () => {
    it('keeps four matching runs on one Engine while mismatches and full Sessions stay independent', async () => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let arrivals = 0;
      const held = async (request: JsonObject) => {
        if (++arrivals === 4) entered.resolve();
        await release.promise;
        const marker = JSON.stringify(request.input).match(
          /concurrency-lane-[0-3]/,
        )?.[0];
        if (!marker) throw new Error('Missing unique lane marker');
        return [message(marker)];
      };
      const model = new ModelServer([
        [message('prime')],
        held,
        held,
        held,
        held,
        [message('different key')],
        [message('different config')],
        [message('ordinary session')],
        [message('still shared')],
      ]);
      await using owner = new NativeRuntime();
      const options = {
        runtime: owner,
        baseUrl: await baseUrl(model),
        apiKey: 'concurrent-key',
      };
      const calls = await runtimeStarts();
      await using prime = new NativeProvider(options);
      await agentFor(prime).run('prime');
      await prime.close();
      const providers = Array.from(
        { length: 4 },
        () => new NativeProvider(options),
      );
      const controllers = providers.map(() => new AbortController());
      const runs = providers.map((p, i) =>
        agentFor(p).run(`concurrency-lane-${i}`, {
          signal: controllers[i].signal,
        }),
      );
      const settled = Promise.allSettled(runs);
      const timeout = Promise.withResolvers<never>();
      const timeoutError = new Error('concurrent witness exceeded 10 seconds');
      let expired = false;
      let checked = false;
      const timer = setTimeout(() => {
        expired = true;
        release.resolve();
        for (const controller of controllers) controller.abort(timeoutError);
        timeout.reject(timeoutError);
      }, 10_000);
      let closed: PromiseSettledResult<void>[] = [];
      try {
        await Promise.race([
          entered.promise,
          timeout.promise,
          ...runs.map((run) =>
            run.then(() => {
              throw new Error('run settled before all requests');
            }),
          ),
        ]);
        expect(calls).toHaveLength(5);
        expect(
          calls.every(
            (c) => c.kind === 'plain' && c.engine === calls[0].engine,
          ),
        ).toBe(true);
        await using changedKey = new NativeProvider({
          ...options,
          apiKey: 'different-key',
        });
        expect(
          (await agentFor(changedKey).run('key mismatch')).finalOutput,
        ).toBe('different key');
        expect(model.requestHeaders[5].authorization).toBe(
          'Bearer different-key',
        );
        await changedKey.close();
        await using changedConfig = new NativeProvider({
          ...options,
          headers: { 'X-Concurrency': 'different' },
        });
        expect(
          (await agentFor(changedConfig).run('config mismatch')).finalOutput,
        ).toBe('different config');
        expect(model.requestHeaders[6]['x-concurrency']).toBe('different');
        await changedConfig.close();
        await using ordinary = new NativeProvider(options);
        await using session = await agentFor(ordinary).session();
        expect(
          (await (await session.submit('ordinary marker')).wait()).finalOutput,
        ).toBe('ordinary session');
        await session.close();
        await ordinary.close();
        expect(calls.slice(5).every((c) => c.engine !== calls[0].engine)).toBe(
          true,
        );
        await expect(owner.close()).rejects.toThrow('borrowing');
        checked = true;
      } finally {
        try {
          release.resolve();
          if (!checked)
            for (const controller of controllers)
              controller.abort(new Error('witness failed'));
          await settled;
          closed = await Promise.allSettled(providers.map((p) => p.close()));
          if (!checked || expired) await owner.close();
        } finally {
          clearTimeout(timer);
        }
      }
      for (const result of closed)
        if (result.status === 'rejected') throw result.reason;
      if (expired) throw timeoutError;
      const results = await Promise.all(runs);
      expect(results.map((r) => r.finalOutput)).toEqual(
        [0, 1, 2, 3].map((i) => `concurrency-lane-${i}`),
      );
      expect(new Set(results.map((r) => r.turn.sessionId)).size).toBe(4);
      expect(new Set(results.map((r) => r.turn.turnId)).size).toBe(4);
      await using last = new NativeProvider(options);
      expect((await agentFor(last).run('after mismatches')).finalOutput).toBe(
        'still shared',
      );
      expect(calls.at(-1)!.engine).toBe(calls[0].engine);
      await last.close();
      await owner.close();
      model.assertExhausted();
    }, 30_000);

    it.each(['fresh', 'retained'] as const)(
      'isolates cancellation and defers retirement with %s Providers',
      async (lifetime) => {
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let arrivals = 0;
        const held = async (request: JsonObject) => {
          if (++arrivals === 4) entered.resolve();
          await release.promise;
          const marker = JSON.stringify(request.input).match(
            /survivor-lane-[0-3]/,
          )?.[0];
          if (!marker) throw new Error('Missing unique survivor marker');
          return [message(marker)];
        };
        const model = new ModelServer([
          [message('prime')],
          held,
          held,
          held,
          held,
          [message('replacement')],
        ]);
        await using owner = new NativeRuntime();
        const options = {
          runtime: owner,
          baseUrl: await baseUrl(model),
          apiKey: 'concurrent-key',
        };
        const calls = await runtimeStarts();
        const carriers: {
          carrier: NativeProviderRoutes;
          home: string | undefined;
        }[] = [];
        const start = NativeProviderRoutes.prototype.start;
        vi.spyOn(NativeProviderRoutes.prototype, 'start').mockImplementation(
          function (this: NativeProviderRoutes, ...args) {
            carriers.push({
              carrier: this,
              home: args[1].codex_home ?? undefined,
            });
            return Reflect.apply(start, this, args);
          },
        );
        const warm = new NativeProvider(options);
        await agentFor(warm).run('prime');
        if (lifetime === 'fresh') await warm.close();
        const providers =
          lifetime === 'fresh'
            ? Array.from({ length: 4 }, () => new NativeProvider(options))
            : [warm, warm, warm, warm];
        const first = providers[0];
        const controllers = providers.map(() => new AbortController());
        const reason = new Error('cancel one lane');
        const runs = providers.map((p, i) =>
          agentFor(p).run(`survivor-lane-${i}`, {
            signal: controllers[i].signal,
          }),
        );
        const settled = Promise.allSettled(runs);
        const timeout = Promise.withResolvers<never>();
        const timeoutError = new Error(
          'concurrent witness exceeded 10 seconds',
        );
        let expired = false;
        let checked = false;
        const timer = setTimeout(() => {
          expired = true;
          release.resolve();
          for (const controller of controllers) controller.abort(timeoutError);
          timeout.reject(timeoutError);
        }, 10_000);
        const original = carriers[0];
        const server = (original.carrier as unknown as { server: Server })
          .server;
        let closed: PromiseSettledResult<void>[] = [];
        try {
          await Promise.race([
            entered.promise,
            timeout.promise,
            ...runs.map((run) =>
              run.then(() => {
                throw new Error('run settled before all requests');
              }),
            ),
          ]);
          expect(calls).toHaveLength(5);
          expect(calls.every((c) => c.engine === calls[0].engine)).toBe(true);
          controllers[0].abort(reason);
          await expect(runs[0]).rejects.toBe(reason);
          if (lifetime === 'fresh') await first.close();
          else await expect(first.close()).rejects.toThrow('open or opening');
          expect(server.listening).toBe(true);
          expect((await stat(original.home!)).isDirectory()).toBe(true);
          await using replacement = new NativeProvider(options);
          expect(
            (await agentFor(replacement).run('replacement marker')).finalOutput,
          ).toBe('replacement');
          expect(calls.at(-1)!.engine).not.toBe(calls[0].engine);
          await replacement.close();
          await expect(owner.close()).rejects.toThrow('borrowing');
          if (lifetime === 'fresh') await first.close();
          checked = true;
        } finally {
          try {
            release.resolve();
            if (!checked)
              for (const controller of controllers)
                controller.abort(new Error('witness failed'));
            await settled;
            closed = await Promise.allSettled(
              [...new Set(providers)].map((p) => p.close()),
            );
            if (!checked || expired) await owner.close();
          } finally {
            clearTimeout(timer);
          }
        }
        for (const result of closed)
          if (result.status === 'rejected') throw result.reason;
        if (expired) throw timeoutError;
        const survivors = await Promise.all(runs.slice(1));
        expect(survivors.map((r) => r.finalOutput)).toEqual(
          [1, 2, 3].map((i) => `survivor-lane-${i}`),
        );
        expect(new Set(survivors.map((r) => r.turn.sessionId)).size).toBe(3);
        await owner.close();
        expect(server.listening).toBe(false);
        await expect(stat(original.home!)).rejects.toMatchObject({
          code: 'ENOENT',
        });
        expect(original.carrier.reuseBinding(calls[0].engine)).toBeUndefined();
        model.assertExhausted();
      },
      30_000,
    );
  },
);
