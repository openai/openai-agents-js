import { expect, it } from 'vitest';
import {
  Agent,
  NativeProvider,
  type RecordedTurn,
  type Session,
} from '../../src';
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
