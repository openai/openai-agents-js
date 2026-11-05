import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, NativeProvider, tool, type RecordedTurn } from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

it('retains per-turn cache writes through public history and restore', async () => {
  const server = new ModelServer(
    [
      [call('probe', {}, { callId: 'probe' })],
      [message('first done')],
      [message('second done')],
    ],
    {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 4 },
      output_tokens: 2,
      total_tokens: 12,
    },
  );
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-history-fixture',
    supportsWebsockets: false,
  });
  const agent = new Agent({
    instructions: 'Use probe then answer.',
    model: 'gpt-5.5',
    provider,
    tools: [
      tool({ name: 'probe', parameters: z.object({}), execute: () => 'ok' }),
    ],
  });
  const session = await agent.session();
  let state;
  let firstId: string;
  let secondId: string;
  try {
    const first = await session.submit('first');
    firstId = first.turnId;
    expect(
      (await first.wait()).usage?.totalTokenUsage.cacheWriteInputTokens,
    ).toBe(8);
    const second = await session.submit('second');
    secondId = second.turnId;
    expect(
      (await second.wait()).usage?.totalTokenUsage.cacheWriteInputTokens,
    ).toBe(12);
    const turns: RecordedTurn[] = [];
    for await (const turn of session.turns()) turns.push(turn);
    expect(
      turns.find((turn) => turn.id === firstId)?.usage?.inputTokensDetails
        .cacheWriteTokens,
    ).toBe(8);
    expect(
      turns.find((turn) => turn.id === secondId)?.usage?.inputTokensDetails
        .cacheWriteTokens,
    ).toBe(4);
    state = await session.saveState();
  } finally {
    await session.close();
  }
  await using restored = await agent.session({ state });
  const restoredTurns: RecordedTurn[] = [];
  for await (const turn of restored.turns()) restoredTurns.push(turn);
  expect(
    restoredTurns.find((turn) => turn.id === firstId)?.usage?.inputTokensDetails
      .cacheWriteTokens,
  ).toBe(8);
  expect(
    restoredTurns.find((turn) => turn.id === secondId)?.usage
      ?.inputTokensDetails.cacheWriteTokens,
  ).toBe(4);
  server.assertExhausted();
}, 30_000);
