import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it } from 'vitest';
import { Agent, NativeProvider, type DecisionProvider } from '../../src';
import { ModelServer, message } from './fixtures/model-server';

const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');
afterEach(() => ModelServer.closeAll());

nativeIt.each(['failure', 'cancellation'] as const)(
  'joins admitted sibling decision cleanup after %s',
  async (mode) => {
    const both = Promise.withResolvers<void>();
    const cleanupEntered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const entered = new Set<string>();
    const problem = new Error('synthetic first decision failure');
    let cleaned = 0;
    let aborts = 0;
    const decisions: DecisionProvider = {
      async getDecision(request, { signal }) {
        entered.add(request.input as string);
        if (entered.size === 2) both.resolve();
        await both.promise;
        if (mode === 'failure' && request.input === 'first') throw problem;
        const aborted = Promise.withResolvers<void>();
        if (signal!.aborted) aborted.resolve();
        else
          signal!.addEventListener('abort', () => aborted.resolve(), {
            once: true,
          });
        await aborted.promise;
        if (++aborts === (mode === 'failure' ? 1 : 2)) cleanupEntered.resolve();
        await release.promise;
        cleaned++;
        signal!.throwIfAborted();
        return { value: true };
      },
    };
    const server = new ModelServer([[message('Candidate.')]]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-decision-siblings',
      supportsWebsockets: false,
    });
    const session = await new Agent({
      instructions: 'Answer.',
      model: 'gpt-5.5',
      provider,
      decisions,
      async beforeComplete(context) {
        await Promise.all([
          context.decide('Check', { input: 'first' }),
          context.decide('Check', { input: 'second' }),
        ]);
      },
    }).session();
    let settled = false;
    let closed = false;
    let closing: Promise<void> | undefined;
    const turn = await session.submit('Start.');
    const outcome = turn.wait().then(
      (value) => {
        settled = true;
        return { value };
      },
      (error: unknown) => {
        settled = true;
        return { error };
      },
    );
    try {
      await both.promise;
      if (mode === 'cancellation') {
        closing = session.close().then(() => {
          closed = true;
        });
      }
      await cleanupEntered.promise;
      await delay(30);
      if (mode === 'failure') {
        expect(settled).toBe(false);
        closing = session.close().then(() => {
          closed = true;
        });
      }
      await delay(30);
      expect(closed).toBe(false);
      expect(cleaned).toBe(0);
      expect(entered).toEqual(new Set(['first', 'second']));
      release.resolve();
      await closing;
      const result = await outcome;
      if (mode === 'failure') {
        expect(result).toHaveProperty('error', problem);
      }
      expect(cleaned).toBe(mode === 'failure' ? 1 : 2);
      expect(server.requests).toHaveLength(1);
    } finally {
      release.resolve();
      await session.close();
      await closing;
      await outcome;
    }
  },
  30000,
);
