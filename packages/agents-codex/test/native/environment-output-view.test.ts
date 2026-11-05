import { afterEach, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Environment,
  NativeProvider,
  type EnvironmentSource,
} from '../../src';
import { ModelServer, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(() => ModelServer.closeAll());

it('preserves selected output and full run cancellation through an EnvironmentSource', async () => {
  const caller = new AbortController();
  const requested = Promise.withResolvers<void>();
  const releaseResponse = Promise.withResolvers<void>();
  const selected = {
    format: { schema: { properties: { answer: { type: 'string' } } } },
  };
  const server = new ModelServer([
    (request) => {
      expect(request.text).toMatchObject(selected);
      return [message('{"answer":"selected output"}')];
    },
    async (request) => {
      expect(request.text).toMatchObject(selected);
      requested.resolve();
      await releaseResponse.promise;
      return [message('{"answer":"cancelled response"}')];
    },
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-environment-output-view',
    supportsWebsockets: false,
  });
  let acquired = 0;
  let disposed = 0;
  const peers = new Set<Awaited<ReturnType<typeof startPublicExecutor>>>();
  const source: EnvironmentSource<undefined> = async ({ signal }) => {
    const peer = await startPublicExecutor();
    peers.add(peer);
    try {
      signal.throwIfAborted();
      const environment = new Environment({
        url: peer.url,
        cwd: peer.cwd,
        headers: peer.headers,
        tools: [],
      });
      acquired++;
      return Environment.lease(environment, async () => {
        await peer.close();
        peers.delete(peer);
        disposed++;
      });
    } catch (error) {
      await peer.close();
      peers.delete(peer);
      throw error;
    }
  };
  const agent = new Agent({
    instructions: 'Answer with the selected object.',
    provider,
  });
  const view = agent.withOutputType(z.object({ answer: z.string() }));
  let cancelled: Promise<unknown> | undefined;
  try {
    const first = await view.run('FIRST', {
      environment: source,
      signal: caller.signal,
    });
    expectTypeOf(first.finalOutput).toEqualTypeOf<{ answer: string }>();
    expect(first.finalOutput).toEqual({ answer: 'selected output' });
    expect([acquired, disposed]).toEqual([1, 1]);

    cancelled = view
      .run('SECOND', { environment: source, signal: caller.signal })
      .then(
        () => {
          throw new Error('Expected the second run to be cancelled');
        },
        (error) => error,
      );
    await Promise.race([
      requested.promise,
      cancelled.then((result) => {
        throw result;
      }),
    ]);
    const reason = new Error('cancel output view after publication');
    caller.abort(reason);
    expect(await cancelled).toBe(reason);
    expect([acquired, disposed]).toEqual([2, 2]);
    expect(agent.outputType).toBeUndefined();
    server.assertExhausted();
  } finally {
    releaseResponse.resolve();
    await cancelled;
    await Promise.all([...peers].map((peer) => peer.close()));
  }
}, 30_000);
