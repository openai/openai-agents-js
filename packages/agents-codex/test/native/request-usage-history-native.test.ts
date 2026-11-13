import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  type RecordedTurn,
  type Session,
  tool,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());
async function records(session: Session) {
  const turns: RecordedTurn[] = [];
  for await (const turn of session.turns()) turns.push(turn);
  return turns;
}
it.each([false, true])(
  'retains SDK failed and successful attempt usage across state restore (measured failure=%s)',
  async (measured) => {
    let requests = 0;
    await using provider = new NativeProvider({
      modelBackend: {
        getRetryAdvice: () => ({ suggested: true }),
        complete(request) {
          if (++requests === 1) {
            if (measured)
              request.reportUsage!({
                inputTokens: 4,
                cachedInputTokens: 0,
                cacheWriteInputTokens: 0,
                outputTokens: 0,
                reasoningOutputTokens: 0,
                totalTokens: 4,
              });
            throw Object.assign(new Error('synthetic upstream failure'), {
              status: 503,
            });
          }
          return {
            output: [
              {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'ok' }],
              },
            ],
            usage: { input_tokens: 3, total_tokens: 3 },
          };
        },
      },
    });
    const agent = new Agent({
      model: 'custom-model',
      instructions: 'Answer.',
      provider,
      modelSettings: {
        retry: { maxRetries: 1, policy: () => ({ retry: true, delayMs: 0 }) },
      },
    });
    const session = await agent.session();
    let state;
    let retained: RecordedTurn[];
    try {
      const turn = await session.submit('Answer.');
      expect((await turn.wait()).runUsage).toMatchObject({
        requests: 2,
        missingUsageRequests: measured ? 0 : 1,
        inputTokens: measured ? 7 : 3,
      });
      retained = await records(session);
      const record = retained.find((record) => record.id === turn.turnId)!;
      expect(record.requestUsageEntriesComplete).toBe(true);
      expect(record.requestUsageEntries).toMatchObject([
        {
          scope: 'sdk_model_attempt',
          requestOrdinal: 1,
          tokenUsageKnown: measured,
          inputTokens: measured ? 4 : 0,
          totalTokens: measured ? 4 : 0,
        },
        {
          scope: 'sdk_model_attempt',
          requestOrdinal: 2,
          tokenUsageKnown: true,
          inputTokens: 3,
          totalTokens: 3,
        },
      ]);
      expect(record.requestUsageEntries![0].attemptId).not.toBe(
        record.requestUsageEntries![1].attemptId,
      );
      state = await session.saveState();
    } finally {
      await session.close();
    }
    await using restored = await agent.session({ state });
    const summary = (turns: RecordedTurn[]) =>
      turns.map((turn) => ({
        id: turn.id,
        entries: turn.requestUsageEntries,
        complete: turn.requestUsageEntriesComplete,
        usage: turn.runUsage,
      }));
    expect(summary(await records(restored))).toEqual(summary(retained));
  },
  20_000,
);
it('retains a known zero-token native attempt independently of unknown failed usage', async () => {
  await using provider = new NativeProvider({
    modelBackend: {
      complete() {
        return {
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'zero' }],
            },
          ],
          usage: { input_tokens: 0, total_tokens: 0 },
        };
      },
    },
  });
  await using session = await new Agent({
    model: 'custom-model',
    instructions: 'Answer.',
    provider,
  }).session();
  const turn = await session.submit('Answer.');
  await turn.wait();
  const record = (await records(session)).find(
    (record) => record.id === turn.turnId,
  )!;
  expect(record.requestUsageEntriesComplete).toBe(true);
  expect(record.requestUsageEntries).toMatchObject([
    { requestOrdinal: 1, tokenUsageKnown: true, totalTokens: 0 },
  ]);
});

it('retains available per-request cache writes across a native Responses run and restore', async () => {
  const usage = (cacheWrite?: number) =>
    JSON.stringify({
      input_tokens: 10,
      input_tokens_details: {
        cached_tokens: 1,
        ...(cacheWrite === undefined ? {} : { cache_write_tokens: cacheWrite }),
      },
      output_tokens: 2,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 12,
    });
  const server = new ModelServer(
    [
      [call('probe', {}, { callId: 'first' })],
      [call('probe', {}, { callId: 'second' })],
      [message('done')],
    ],
    [usage(), usage(0), usage(4)],
  );
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic',
    supportsWebsockets: false,
  });
  const agent = new Agent({
    model: 'gpt-5.5',
    instructions: 'Use probe and answer.',
    provider,
    tools: [
      tool({ name: 'probe', parameters: z.object({}), execute: () => 'ok' }),
    ],
  });
  const session = await agent.session();
  let state;
  let turnId: string;
  const check = async (live: Session) => {
    const record = (await records(live)).find((turn) => turn.id === turnId)!;
    expect(record.requestUsageEntriesComplete).toBe(true);
    expect(
      record.requestUsageEntries?.map((entry) => entry.inputTokensDetails),
    ).toEqual([
      { cachedTokens: 1 },
      { cachedTokens: 1, cacheWriteTokens: 0 },
      { cachedTokens: 1, cacheWriteTokens: 4 },
    ]);
  };
  try {
    const turn = await session.submit('read');
    turnId = turn.turnId;
    await turn.wait();
    await check(session);
    state = await session.saveState();
  } finally {
    await session.close();
  }
  await using restored = await agent.session({ state });
  await check(restored);
  server.assertExhausted();
});
