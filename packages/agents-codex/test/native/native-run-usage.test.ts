import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  Turn,
  tool,
  manualTool,
  parseSessionState,
  type ToolContext,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());
const reported = {
  inputTokens: 3,
  cachedInputTokens: 1,
  cacheWriteInputTokens: 0,
  outputTokens: 2,
  reasoningOutputTokens: 0,
  totalTokens: 5,
};
const modelUsage = {
  input_tokens: 11,
  output_tokens: 3,
  total_tokens: 14,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens_details: { reasoning_tokens: 0 },
};
async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic',
    supportsWebsockets: false,
  });
}
it('captures explicit usage atomically and ignores model-visible usage-shaped output', async () => {
  const retained: ToolContext[] = [];
  const snapshots: unknown[] = [];
  const metered = tool({
    name: 'metered',
    description: 'Report measured usage.',
    parameters: z.object({}),
    execute(_args, context) {
      expect(context.submission).toBeInstanceOf(Turn);
      snapshots.push((context.submission as Turn).runUsage);
      const captured = { ...reported };
      context.reportUsage(captured);
      captured.inputTokens = 9000;
      captured.totalTokens = 9000;
      retained.push(context);
      return { usage: { input_tokens: 9000, output_tokens: 9000 } };
    },
  });
  const server = new ModelServer(
    [[call('metered', {}, { callId: 'meter' })], [message('done')]],
    modelUsage,
  );
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Use metered.',
    model: 'gpt-5',
    provider,
    tools: [metered],
  }).session();
  const turn = await session.submit('Run');
  const result = await turn.wait();
  expect(result.runUsage).toMatchObject({
    requests: 3,
    missingUsageRequests: 0,
    inputTokens: 25,
    outputTokens: 8,
    totalTokens: 33,
  });
  expect(turn.runUsage).toEqual(result.runUsage);
  // A callback may start before its streamed model completion is observed.
  expect(snapshots[0]).toMatchObject({ requests: expect.any(Number) });
  expect((snapshots[0] as { requests: number }).requests).toBeLessThan(3);
  expect(Object.isFrozen(snapshots[0])).toBe(true);
  expect(Object.isFrozen(result.runUsage)).toBe(true);
  expect(() => retained[0]!.reportUsage(null)).toThrow();
  expect((await turn.wait()).runUsage).toEqual(result.runUsage);
});
it('retains unknown token usage and rejects invalid reports without partial updates', async () => {
  const metered = tool({
    name: 'metered',
    parameters: z.object({}),
    execute(_args, context) {
      const before = (context.submission as Turn).runUsage;
      expect(() =>
        context.reportUsage({ ...reported, inputTokens: -1 }),
      ).toThrow();
      expect(() =>
        context.reportUsage(reported, {
          requests: Number.MAX_SAFE_INTEGER + 1,
        }),
      ).toThrow();
      expect((context.submission as Turn).runUsage).toEqual(before);
      context.reportUsage(null, { requests: 3 });
      return 'done';
    },
  });
  const server = new ModelServer(
    [[call('metered', {}, { callId: 'missing' })], [message('done')]],
    modelUsage,
  );
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Use metered.',
    model: 'gpt-5',
    provider,
    tools: [metered],
  }).session();
  const result = await (await session.submit('Run')).wait();
  expect(result.runUsage).toMatchObject({
    requests: 5,
    missingUsageRequests: 3,
    totalTokens: 28,
  });
});
it('preserves exact large reported counters outside provider context estimates', async () => {
  const metered = tool({
    name: 'metered',
    parameters: z.object({}),
    execute(_args, context) {
      context.reportUsage({
        ...reported,
        inputTokens: 9007199254740993n,
        totalTokens: 9007199254740995n,
      });
      return 'done';
    },
  });
  const server = new ModelServer(
    [[call('metered', {}, { callId: 'large' })], [message('done')]],
    modelUsage,
  );
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Use metered.',
    model: 'gpt-5',
    provider,
    tools: [metered],
  }).session();
  const result = await (await session.submit('Run')).wait();
  expect(result.runUsage.requests).toBe(3);
  expect(result.runUsage.inputTokens).toBe(9007199254741015n);
  expect(result.runUsage.totalTokens).toBe(9007199254741023n);
  expect(result.threadUsage?.totalTokenUsage.totalTokens).not.toBe(
    result.runUsage.totalTokens,
  );
});

it('continues captured manual usage exactly once and starts idle restored runs fresh', async () => {
  const effects: string[] = [];
  const metered = tool({
    name: 'metered',
    parameters: z.object({}),
    execute(_args, context) {
      context.reportUsage(reported);
      effects.push('reported');
      return 'done';
    },
  });
  const lookup = manualTool({
    name: 'lookup',
    description: 'Read a record.',
    parameters: z.object({ key: z.string() }),
    result: z.string(),
  });
  const server = new ModelServer(
    [
      [
        call('metered', {}, { callId: 'meter' }),
        call('lookup', { key: 'A' }, { callId: 'manual' }),
      ],
      [message('continued')],
      [message('fresh')],
    ],
    modelUsage,
  );
  await using provider = await providerFor(server);
  const agent = new Agent({
    instructions: 'Read both.',
    model: 'gpt-5',
    provider,
    tools: [metered, lookup],
  });
  const source = await agent.session();
  const turn = await source.submit('Read');
  const batch = await turn.wait({ until: 'manual_tool' });
  if (!('requests' in batch))
    throw new Error('Expected pending manual request');
  const saved = parseSessionState(JSON.stringify(await source.suspend()));
  expect(turn.runUsage).toMatchObject({ requests: 2, totalTokens: 19 });
  await source.close();
  const restored = await agent.session({ state: saved });
  const continuation = restored.restoredTurn;
  if (!continuation) throw new Error('Expected captured continuation');
  const pending = await continuation.wait({ until: 'manual_tool' });
  if (!('requests' in pending)) throw new Error('Expected restored request');
  const request = lookup.match(pending.requests[0]);
  if (!request) throw new Error('Expected exact lookup request');
  await restored.respond(request.reply('known'));
  const result = await continuation.wait();
  expect(result.runUsage).toMatchObject({
    requests: 3,
    totalTokens: 33,
    missingUsageRequests: 0,
  });
  expect(effects).toEqual(['reported']);
  const idle = await restored.saveState();
  await restored.close();
  await using fresh = await agent.session({ state: idle });
  const next = await (await fresh.submit('Next')).wait();
  expect(next.runUsage).toMatchObject({ requests: 1, totalTokens: 14 });
});

it.each([true, false])(
  'projects only witnessed plain completion usage (known=%s)',
  async (known) => {
    const server = new ModelServer(
      [[message('done')]],
      known ? modelUsage : [],
    );
    await using provider = await providerFor(server);
    const result = await new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
    }).run('Run');
    expect(result.runUsage).toMatchObject({
      requests: 1,
      missingUsageRequests: known ? 0 : 1,
      totalTokens: known ? 14 : 0,
    });
    expect(result.turn.runUsage).toEqual(result.runUsage);
    expect(Object.isFrozen(result.runUsage)).toBe(true);
  },
);
