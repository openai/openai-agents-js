import type OpenAI from 'openai';
import { afterEach, expect, it } from 'vitest';
import { Agent, NativeProvider, responsesCompaction } from '../../src';
import { ModelServer, message } from './fixtures/model-server';
afterEach(() => ModelServer.closeAll());
it.each([
  'success',
  'invalid_output',
  'transport_failure',
  'cancel_after_response',
] as const)(
  'retains borrowed compact endpoint usage after %s',
  async (outcome) => {
    const server = new ModelServer([[message('accepted answer')]]);
    const config = await server.config();
    let calls = 0;
    const started = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const client = {
      responses: {
        compact: async (_body: unknown, options?: { signal?: AbortSignal }) => {
          calls++;
          if (outcome === 'cancel_after_response') {
            options?.signal?.addEventListener(
              'abort',
              () => aborted.resolve(),
              { once: true },
            );
            started.resolve();
            await released.promise;
          }
          if (outcome === 'transport_failure')
            throw new Error('transport failed');
          return {
            id: 'untrusted-provider-response',
            output:
              outcome === 'invalid_output'
                ? 'invalid'
                : [{ type: 'compaction', encrypted_content: 'OPAQUE_WINDOW' }],
            usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
          };
        },
      },
    } as unknown as OpenAI;
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-compact',
      supportsWebsockets: false,
      requestMaxRetries: 0,
      streamMaxRetries: 0,
    });
    const agent = new Agent({
      provider,
      model: 'gpt-5.5',
      instructions: 'Answer.',
      compaction: responsesCompaction({
        client,
        model: 'compact',
        shouldCompact: () => true,
      }),
    });
    const session = await agent.session();
    try {
      const turn = await session.submit('go');
      const completion = turn.wait().then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      if (outcome === 'cancel_after_response') {
        await started.promise;
        const cancellation = turn.cancel();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            aborted.promise,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new Error(
                      'Compaction cancellation did not reach its callback',
                    ),
                  ),
                2000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
          released.resolve();
        }
        await cancellation;
        await completion;
      } else {
        expect(await completion).toMatchObject({
          value: { finalOutput: 'accepted answer' },
        });
      }
      expect(calls).toBe(1);
      const records = await Array.fromAsync(session.turns());
      const record = records.find((record) => record.id === turn.turnId)!;
      const entries =
        record.requestUsageEntries?.filter(
          (entry) => entry.endpoint === 'responses.compact',
        ) ?? [];
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        scope: 'compaction',
        tokenUsageKnown: outcome !== 'transport_failure',
        inputTokens: outcome === 'transport_failure' ? 0 : 4,
        outputTokens: outcome === 'transport_failure' ? 0 : 2,
        totalTokens: outcome === 'transport_failure' ? 0 : 6,
      });
      expect(entries[0].attemptId).not.toBe('untrusted-provider-response');
      expect(turn.runUsage.requests).toBe(2);
      const state = await session.saveState();
      await session.close();
      await using restored = await agent.session({ state });
      const cold = await Array.fromAsync(restored.turns());
      expect(
        cold.find((item) => item.id === turn.turnId)?.requestUsageEntries,
      ).toEqual(record.requestUsageEntries);
      expect(calls).toBe(1);
      expect(server.requests).toHaveLength(1);
      server.assertExhausted();
    } finally {
      released.resolve();
      await session.close();
    }
  },
  30000,
);
