import type OpenAI from 'openai';
import { afterEach, expect, it, vi } from 'vitest';
import { Agent, NativeProvider, responsesCompaction } from '../../src';
import { ModelServer, message } from './fixtures/model-server';

const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');
afterEach(() => ModelServer.closeAll());

nativeIt.each(['success', 'failure', 'skip'] as const)(
  'reports borrowed automatic compaction coverage after %s',
  async (outcome) => {
    const server = new ModelServer([[message('accepted answer')]]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-borrowed-compaction-attempts',
      supportsWebsockets: false,
      requestMaxRetries: 0,
      streamMaxRetries: 0,
    });
    const compact = vi.fn(async () => {
      if (outcome === 'failure')
        throw new Error('synthetic borrowed compaction failure');
      return {
        id: 'synthetic-compacted-window',
        output: [{ type: 'compaction', encrypted_content: 'OPAQUE_WINDOW' }],
        usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
      };
    });
    const client = { responses: { compact } } as unknown as OpenAI;
    await using session = await new Agent({
      provider,
      model: 'gpt-5.5',
      instructions: 'Answer.',
      compaction: responsesCompaction({
        client,
        model: 'compact',
        shouldCompact: () => outcome !== 'skip',
      }),
    }).session({ includeRequestAttempts: true });
    const turn = await session.submit('go');
    expect((await turn.wait()).finalOutput).toBe('accepted answer');
    expect(compact).toHaveBeenCalledTimes(outcome === 'skip' ? 0 : 1);
    expect(server.requests).toHaveLength(1);
    expect(turn.requestAttempts).toEqual({
      availability: outcome === 'skip' ? 'complete' : 'partial',
      counts: [
        {
          owner: 'root',
          operation: 'generation',
          transport: 'http_sse',
          count: 1,
        },
      ],
      borrowedRequestsUnavailable: outcome !== 'skip',
    });
    const snapshot = turn.requestAttempts;
    expect(Object.isFrozen(snapshot)).toBe(true);
    await session.close();
    expect(turn.requestAttempts).toBe(snapshot);
    server.assertExhausted();
  },
  30_000,
);
