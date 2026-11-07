import type { Server } from 'node:http';
import type { Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent, NativeError, NativeProvider } from '../../src';
import { binding } from '../../src/runtime/binding';
import { ModelServer, message } from './fixtures/model-server';

// Reuse the observation seam in direct-transport-native.test.ts. Do not replace
// the endpoint, transport, or response path to manufacture connection reuse.
function connections(model: ModelServer) {
  const server = (model as unknown as { server: Server }).server;
  server.keepAliveTimeout = 60_000;
  const ids = new WeakMap<Socket, number>();
  const requests: number[] = [];
  const closed = new Set<number>();
  let accepted = 0;
  server.on('connection', (socket) => {
    const id = ++accepted;
    ids.set(socket, id);
    socket.once('close', () => closed.add(id));
  });
  server.on('request', (request) => {
    const id = ids.get(request.socket);
    if (id === undefined) throw new Error('Unobserved fixture connection');
    requests.push(id);
  });
  return {
    server,
    requests,
    closed,
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

async function freshRequest(
  agent: ReturnType<typeof agentFor>,
  prompt: string,
) {
  await using session = await agent.session();
  return (await (await session.submit(prompt)).wait()).finalOutput;
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
  'provider-owned physical HTTP transports',
  () => {
    it('reuses a socket across fresh Sessions with current ambient auth, while a new provider opens another', async () => {
      const model = new ModelServer([
        [message('first answer')],
        [message('second answer')],
        [message('new provider answer')],
      ]);
      const observed = connections(model);
      const url = await baseUrl(model);
      await using provider = new NativeProvider({
        baseUrl: url,
        supportsWebsockets: false,
      });
      const agent = agentFor(provider);
      vi.stubEnv('OPENAI_API_KEY', 'synthetic-first-opening');
      await using first = await agent.session();
      expect(
        (await (await first.submit('first isolated marker')).wait())
          .finalOutput,
      ).toBe('first answer');
      await first.close();
      vi.stubEnv('OPENAI_API_KEY', 'synthetic-second-opening');
      await using second = await agent.session();
      expect(
        (await (await second.submit('second isolated marker')).wait())
          .finalOutput,
      ).toBe('second answer');
      await second.close();
      expect(
        model.requestHeaders.map((headers) => headers.authorization),
      ).toEqual([
        'Bearer synthetic-first-opening',
        'Bearer synthetic-second-opening',
      ]);
      expect(observed.requests).toHaveLength(2);
      expect(observed.requests[1]).toBe(observed.requests[0]);
      expect(observed.accepted).toBe(1);
      expect(JSON.stringify(model.requests[1].input)).toContain(
        'second isolated marker',
      );
      expect(JSON.stringify(model.requests[1].input)).not.toContain(
        'first isolated marker',
      );
      await provider.close();
      await expect
        .poll(() => observed.closed.has(observed.requests[0]!), {
          timeout: 5_000,
        })
        .toBe(true);
      // Keep both closed Sessions reachable while proving physical release.
      expect(first).not.toBe(second);
      await using separate = new NativeProvider({
        baseUrl: url,
        supportsWebsockets: false,
      });
      expect(
        await freshRequest(agentFor(separate), 'new provider marker'),
      ).toBe('new provider answer');
      expect(observed.requests[2]).not.toBe(observed.requests[0]);
      expect(model.requestHeaders[2].authorization).toBe(
        'Bearer synthetic-second-opening',
      );
      model.assertExhausted();
    }, 30_000);

    it('keeps the Provider connection through supplied compaction without disrupting another Session', async () => {
      const model = new ModelServer([
        [message('before compaction')],
        [message('sibling answer')],
        [message('after compaction')],
        [message('sibling continues')],
      ]);
      const observed = connections(model);
      await using provider = new NativeProvider({
        baseUrl: await baseUrl(model),
        apiKey: 'synthetic-compaction-key',
        supportsWebsockets: false,
      });
      const agent = agentFor(provider);
      await using session = await agent.session();
      await using sibling = await agent.session();
      expect(
        (await (await session.submit('before compaction marker')).wait())
          .finalOutput,
      ).toBe('before compaction');
      expect(
        (await (await sibling.submit('sibling isolated marker')).wait())
          .finalOutput,
      ).toBe('sibling answer');
      await session.compact({ summary: 'Supplied transport summary.' });
      expect(model.requests).toHaveLength(2);
      expect(
        (await (await session.submit('after compaction marker')).wait())
          .finalOutput,
      ).toBe('after compaction');
      expect(
        (await (await sibling.submit('sibling continues marker')).wait())
          .finalOutput,
      ).toBe('sibling continues');
      expect(observed.requests).toHaveLength(4);
      expect(new Set(observed.requests).size).toBe(1);
      expect(observed.accepted).toBe(1);
      const compactedInput = JSON.stringify(model.requests[2].input);
      expect(compactedInput).toContain('Supplied transport summary.');
      expect(compactedInput).not.toContain('before compaction marker');
      expect(compactedInput).not.toContain('sibling isolated marker');
      expect(
        model.requestHeaders.map((headers) => headers.authorization),
      ).toEqual(Array(4).fill('Bearer synthetic-compaction-key'));
      await session.close();
      await sibling.close();
      await provider.close();
      await expect
        .poll(() => observed.closed.has(observed.requests[0]!), {
          timeout: 5_000,
        })
        .toBe(true);
      model.assertExhausted();
    }, 30_000);

    it('cancels one in-flight root without closing another root or poisoning its next turn', async () => {
      const enteredA = Promise.withResolvers<void>();
      const enteredB = Promise.withResolvers<void>();
      const releaseA = Promise.withResolvers<void>();
      const releaseB = Promise.withResolvers<void>();
      const closedA = Promise.withResolvers<void>();
      const completedA = Promise.withResolvers<void>();
      let aRequested = false;
      const model = new ModelServer([
        [message('warm answer')],
        async () => {
          aRequested = true;
          enteredA.resolve();
          await releaseA.promise;
          return [message('discarded A')];
        },
        async () => {
          enteredB.resolve();
          await releaseB.promise;
          return [message('surviving B')];
        },
        [message('B continues')],
      ]);
      const observed = connections(model);
      let index = 0;
      let bClosed = false;
      observed.server.on('request', (_request, response) => {
        const current = index++;
        if (current === 1) response.once('close', () => closedA.resolve());
        if (current === 2)
          response.once('close', () => {
            bClosed = true;
          });
      });
      model.onRecord = (phase, detail) => {
        if (
          phase === 'MODEL_COMPLETED_FRAME' &&
          (detail as { requestIndex: number }).requestIndex === 1
        )
          completedA.resolve();
      };
      await using provider = new NativeProvider({
        baseUrl: await baseUrl(model),
        apiKey: 'synthetic-concurrent-key',
        supportsWebsockets: false,
      });
      const agent = agentFor(provider);
      expect(await freshRequest(agent, 'warm marker')).toBe('warm answer');
      await using rootA = await agent.session();
      await using rootB = await agent.session();
      try {
        const turnA = await rootA.submit('isolated root A');
        const outcomeA = turnA.wait().catch((error: unknown) => error);
        await Promise.race([
          enteredA.promise,
          outcomeA.then((error) => {
            throw error;
          }),
        ]);
        const turnB = await rootB.submit('isolated root B');
        const outcomeB = turnB.wait();
        void outcomeB.catch(() => undefined);
        await Promise.race([
          enteredB.promise,
          outcomeB.then(() => {
            throw new Error('B completed before its held response');
          }),
        ]);
        expect(observed.requests[1]).toBe(observed.requests[0]);
        await turnA.cancel();
        expect(await outcomeA).toBeInstanceOf(NativeError);
        await closedA.promise;
        await rootA.close();
        expect(bClosed).toBe(false);
        await expect(provider.close()).rejects.toThrow(
          'open or opening sessions',
        );
        releaseB.resolve();
        expect((await outcomeB).finalOutput).toBe('surviving B');
        expect(
          (await (await rootB.submit('continue root B')).wait()).finalOutput,
        ).toBe('B continues');
        expect(JSON.stringify(model.requests[2].input)).not.toContain(
          'isolated root A',
        );
        expect(
          model.requestHeaders.every(
            (headers) =>
              headers.authorization === 'Bearer synthetic-concurrent-key',
          ),
        ).toBe(true);
      } finally {
        releaseA.resolve();
        releaseB.resolve();
        if (aRequested) await completedA.promise;
      }
      model.assertExhausted();
    }, 30_000);

    it('keeps the real owner through failed-opening cleanup and releases it after cleanup succeeds', async () => {
      const native = await binding();
      const model = new ModelServer([[message('warm answer')]]);
      const observed = connections(model);
      await using provider = new NativeProvider({
        baseUrl: await baseUrl(model),
        apiKey: 'synthetic-cleanup-key',
        supportsWebsockets: false,
      });
      const agent = agentFor(provider);
      await using warm = await agent.session();
      expect(
        (await (await warm.submit('warm cleanup marker')).wait()).finalOutput,
      ).toBe('warm answer');
      await warm.close();
      const closeOwner = vi.spyOn(
        native._ProviderHttpTransports.prototype,
        'close',
      );
      const startThread = vi
        .spyOn(native.Engine.prototype, 'start_replaceable_thread')
        .mockRejectedValueOnce(new Error('injected native startup failure'));
      const closeEngine = vi
        .spyOn(native.Engine.prototype, '_close_report')
        .mockRejectedValueOnce(new Error('first cleanup failure'))
        .mockRejectedValueOnce(new Error('retry cleanup failure'));
      let unexpected: Awaited<ReturnType<typeof agent.session>> | undefined;
      try {
        await expect(
          agent.session().then((session) => {
            unexpected = session;
            return session;
          }),
        ).rejects.toBeInstanceOf(AggregateError);
        expect(closeOwner).not.toHaveBeenCalled();
        await expect(provider.close()).rejects.toThrow(
          'NativeProvider cleanup failed',
        );
        expect(closeOwner).not.toHaveBeenCalled();
        await provider.close();
        expect(closeEngine).toHaveBeenCalledTimes(3);
        expect(closeOwner).toHaveBeenCalledTimes(1);
        await expect
          .poll(() => observed.closed.has(observed.requests[0]!), {
            timeout: 5_000,
          })
          .toBe(true);
        expect(warm).toBeDefined(); // Retain the closed Session through release.
        expect(model.requests).toHaveLength(1);
        await expect(agent.session()).rejects.toThrow('closed');
        model.assertExhausted();
      } finally {
        // Restore injected failures before cleanup if an assertion failed early.
        closeEngine.mockRestore();
        startThread.mockRestore();
        await unexpected?.close();
        await provider.close();
        closeOwner.mockRestore();
      }
    }, 30_000);
  },
);
