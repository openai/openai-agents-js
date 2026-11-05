import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent, NativeProvider, tool, type RecordedTurn } from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

async function providerFor(server: ModelServer, noRetries = false) {
  const config = await server.config();
  const provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-response-history',
    supportsWebsockets: false,
  });
  if (noRetries) {
    // Select Core's existing test configuration; preserve production retry policy.
    const acquire = provider._acquire.bind(provider);
    vi.spyOn(provider, '_acquire').mockImplementationOnce((captured) => {
      const lease = acquire(captured);
      lease.config['model_providers.native_agent.request_max_retries'] = 0;
      lease.config['model_providers.native_agent.stream_max_retries'] = 0;
      return lease;
    });
  }
  return provider;
}
async function turnsOf(session: { turns(): AsyncIterable<RecordedTurn> }) {
  const turns: RecordedTurn[] = [];
  for await (const turn of session.turns()) turns.push(turn);
  return turns;
}

it('retains two response occurrences with repeated provider IDs through save, restore and fork', async () => {
  const terminal =
    '{"type":"response.completed","response":{"id":"same","usage":{"input_tokens":11,"input_tokens_details":{"cached_tokens":0},"output_tokens":2,"total_tokens":13}}}';
  const server = new ModelServer(
    [[call('probe', {}, { callId: 'probe' })], [message('done')]],
    [],
    undefined,
    [terminal, terminal],
  );
  await using provider = await providerFor(server);
  const agent = new Agent({
    instructions: 'Use probe then answer.',
    model: 'gpt-5.5',
    provider,
    tools: [
      tool({ name: 'probe', parameters: z.object({}), execute: () => 'ok' }),
    ],
  });
  await using session = await agent.session();
  const turn = await session.submit('go');
  await turn.wait();
  const recorded = (await turnsOf(session))[0];
  expect(recorded.usage?.totalTokens).toBe(26);
  expect(recorded.responses).toHaveLength(2);
  expect(new Set(recorded.responses!.map((row) => row.id)).size).toBe(2);
  expect(
    recorded.responses!.every(
      (row) =>
        row.id !== null &&
        row.responseId === 'same' &&
        row.status === 'completed' &&
        row.usageSource === 'received',
    ),
  ).toBe(true);
  expect(recorded.responses![0].usage).toEqual({
    inputTokens: 11,
    inputTokensDetails: { cachedTokens: 0 },
    outputTokens: 2,
    totalTokens: 13,
  });
  const state = await session.saveState();
  await using restored = await agent.session({ state });
  expect((await turnsOf(restored))[0].responses).toEqual(recorded.responses);
  const fork = await session.fork();
  await using inherited = await agent.session({ state: fork });
  expect((await turnsOf(inherited))[0].responses).toEqual(recorded.responses);
  expect((await turnsOf(session))[0].responses).toEqual(recorded.responses);
  server.assertExhausted();
}, 30_000);

for (const reason of ['max_output_tokens', 'content_filter']) {
  it(`retains ${reason} incomplete facts without retrying inference`, async () => {
    const terminal = JSON.stringify({
      type: 'response.incomplete',
      response: {
        id: 'partial',
        incomplete_details: { reason },
        usage: {
          input_tokens: 7,
          output_tokens: 0,
          total_tokens: 7,
        },
      },
    });
    const server = new ModelServer([[]], [], undefined, [terminal]);
    await using provider = await providerFor(server, true);
    const agent = new Agent({
      instructions: 'Answer.',
      model: 'gpt-5.5',
      provider,
    });
    await using session = await agent.session();
    const submission = await session.submit('go');
    await expect(submission.wait()).rejects.toThrow();
    const recorded = (await turnsOf(session))[0];
    expect(recorded.status).toBe('failed');
    expect(recorded.responses).toEqual([
      expect.objectContaining({
        responseId: 'partial',
        status: 'incomplete',
        incompleteReason: reason,
        usageSource: 'received',
        usage: { inputTokens: 7, outputTokens: 0, totalTokens: 7 },
      }),
    ]);
    expect(server.requests).toHaveLength(1);
    server.assertExhausted();
  }, 30_000);
}

it('retains provider completed facts when SDK integrity rejects output', async () => {
  const server = new ModelServer([[]]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    instructions: 'Answer.',
    model: 'gpt-5.5',
    provider,
  });
  await using session = await agent.session();
  const submission = await session.submit('go');
  await expect(submission.wait()).rejects.toThrow();
  const recorded = (await turnsOf(session))[0];
  expect(recorded.status).toBe('failed');
  expect(recorded.responses).toEqual([
    expect.objectContaining({ status: 'completed', usage: null }),
  ]);
  expect(server.requests).toHaveLength(1);
  server.assertExhausted();
}, 30_000);

it('preserves default retry behavior and keeps failed received usage out of turn totals', async () => {
  const incomplete = JSON.stringify({
    type: 'response.incomplete',
    response: {
      id: 'partial',
      incomplete_details: { reason: 'max_output_tokens' },
      usage: { input_tokens: 7, output_tokens: 0, total_tokens: 7 },
    },
  });
  const completed = JSON.stringify({
    type: 'response.completed',
    response: {
      id: 'finished',
      usage: { input_tokens: 11, output_tokens: 3, total_tokens: 14 },
    },
  });
  const server = new ModelServer([[], [message('done')]], [], undefined, [
    incomplete,
    completed,
  ]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    instructions: 'Answer.',
    model: 'gpt-5.5',
    provider,
  });
  await using session = await agent.session();
  const submission = await session.submit('go');
  expect((await submission.wait()).finalOutput).toBe('done');
  const recorded = (await turnsOf(session))[0];
  expect(recorded.status).toBe('completed');
  expect(
    recorded.responses?.map((row) => [
      row.status,
      row.responseId,
      row.usage?.totalTokens,
    ]),
  ).toEqual([
    ['incomplete', 'partial', 7],
    ['completed', 'finished', 14],
  ]);
  expect(new Set(recorded.responses?.map((row) => row.id)).size).toBe(2);
  expect(recorded.usage?.totalTokens).toBe(14);
  expect(server.requests).toHaveLength(2);
  server.assertExhausted();
}, 30_000);

it('keeps negative counters unknown in retained prompted-repair history across save/restore', async () => {
  const original = JSON.stringify({
    type: 'response.completed',
    response: {
      id: 'original',
      usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
    },
  });
  const incomplete = JSON.stringify({
    type: 'response.incomplete',
    response: {
      id: 'malformed-correction',
      incomplete_details: { reason: 'max_output_tokens' },
      usage: {
        input_tokens: -7,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: -1 },
        output_tokens: 0,
        output_tokens_details: { reasoning_tokens: -3 },
        total_tokens: 7,
      },
    },
  });
  const completed = JSON.stringify({
    type: 'response.completed',
    response: {
      id: 'finished-correction',
      usage: { input_tokens: 11, output_tokens: 3, total_tokens: 14 },
    },
  });
  const server = new ModelServer(
    [[message('{"label":"x"}')], [], [message('{"label":"corrected"}')]],
    [],
    undefined,
    [original, incomplete, completed],
  );
  await using provider = await providerFor(server);
  const agent = new Agent({
    instructions: 'Answer.',
    model: 'gpt-5.5',
    provider,
    outputType: {
      mode: 'prompted',
      schema: z.object({ label: z.string().min(2) }),
      maxRetries: 1,
    },
  });
  await using session = await agent.session();
  const turn = await session.submit('go');
  const result = await turn.wait();
  // Validate retained correction observations before inspecting ordinary history.
  const state = await session.saveState();
  expect(result.finalOutput).toEqual({ label: 'corrected' });
  expect(result.repairAttempts).toHaveLength(1);
  const attempt = result.repairAttempts[0];
  expect(attempt).toMatchObject({
    parentSessionId: session.id,
    parentTurnId: turn.turnId,
    status: 'completed',
    usage: { inputTokens: 11, outputTokens: 3, totalTokens: 14 },
  });
  expect(attempt.sessionId).not.toBe(session.id);
  expect(attempt.responses).toEqual([
    expect.objectContaining({
      responseId: 'malformed-correction',
      status: 'incomplete',
      usageSource: 'received',
      usage: {
        inputTokensDetails: { cachedTokens: 0 },
        outputTokens: 0,
        totalTokens: 7,
      },
    }),
    expect.objectContaining({
      responseId: 'finished-correction',
      status: 'completed',
      usageSource: 'received',
      usage: { inputTokens: 11, outputTokens: 3, totalTokens: 14 },
    }),
  ]);
  expect(new Set(attempt.responses?.map((row) => row.id)).size).toBe(2);
  const recorded = await turnsOf(session);
  expect(recorded).toHaveLength(2);
  expect(recorded[0].usage?.totalTokens).toBe(7);
  expect(recorded[1]).toEqual(attempt);
  if (state.format_version !== 4)
    throw new Error('Expected output-aware idle state');
  expect(state.repair_turns).toHaveLength(1);
  expect(state.repair_turns[0].responses).toHaveLength(2);
  await using restored = await agent.session({ state });
  expect(await turnsOf(restored)).toEqual(recorded);
  expect((await restored.saveState()).format_version).toBe(4);
  expect(await turnsOf(session)).toEqual(recorded);
  expect(server.requests).toHaveLength(3);
  server.assertExhausted();
}, 30_000);

it('rejects a negative received usage count when restoring a checkpoint', async () => {
  const server = new ModelServer([]);
  await using provider = await providerFor(server);
  const agent = new Agent({ instructions: 'Check restored state.', provider });
  await using session = await agent.session();
  const state = await session.saveState();
  const observation = {
    type: 'response_observation_record' as const,
    payload: {
      id: 'restored-observation',
      thread_id: '00000000-0000-4000-8000-000000000001',
      turn_id: 'restored-turn',
      response_id: 'restored-response',
      status: 'completed',
      incomplete_reason: null,
      usage: { input_tokens: -1, total_tokens: 3 },
    },
  };
  const restore = async () => {
    await using candidate = await agent.session({
      state: { ...state, history: [...state.history, observation] },
    });
    await candidate.saveState();
  };
  await expect(restore()).rejects.toThrow(
    'Received response usage counters must be nonnegative',
  );
  expect(server.requests).toHaveLength(0);
});
