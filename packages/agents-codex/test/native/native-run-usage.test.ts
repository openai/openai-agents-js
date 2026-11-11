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

it.each([false, true])(
  'keeps original provider usage out of history and checkpoints with capture=%s',
  async (capture) => {
    const sentinel = 'synthetic-provider-usage-extension';
    const usage = [0, 1].map((sequence) => ({
      ...modelUsage,
      vendor_extension: {
        sample: [0, false, null, sentinel],
        sequence,
      },
      ['__proto__']: 'synthetic JSON key',
    }));
    const lookup = tool({
      name: 'lookup',
      description: 'Resolve a code.',
      parameters: z.object({}),
      execute: () => 'resolved',
    });
    const server = new ModelServer(
      [[call('lookup', {}, { callId: 'raw-usage-a' })], [message('done')]],
      usage.map((record) => JSON.stringify(record)),
    );
    await using provider = await providerFor(server);
    const agent = new Agent({
      instructions: 'Use lookup once.',
      tools: [lookup],
      provider,
    });
    const result = await agent.run('look up A', {
      returnRawUsage: capture,
      returnHistory: true,
      returnState: true,
    });

    expect(result.finalOutput).toBe('done');
    expect(result.runUsage).toMatchObject({ requests: 2, totalTokens: 28 });
    expect(server.requests).toHaveLength(2);
    expect(result.state).toBeDefined();
    expect(JSON.stringify(result.state)).not.toContain(sentinel);
    expect(result.history).toBeDefined();
    expect(JSON.stringify(result.history)).not.toContain(sentinel);
    if (capture) {
      expect(result.rawUsage?.map((record) => record.usage)).toEqual(usage);
      expect(result.rawUsage?.map((record) => record.responseId)).toEqual([
        'response-1',
        'response-2',
      ]);
    } else {
      expect(result).not.toHaveProperty('rawUsage');
    }
  },
);

it('keeps original provider usage for the resumed manual invocation', async () => {
  const decision = manualTool({
    name: 'decision',
    description: 'Request approval.',
    parameters: z.object({}),
    result: z.string(),
  });
  const usage = { ...modelUsage, vendor_extension: 'resumed-provider-usage' };
  const server = new ModelServer(
    [
      [call('decision', {}, { callId: 'raw-usage-manual' })],
      [message('finished')],
    ],
    usage,
  );
  await using provider = await providerFor(server);
  const agent = new Agent({
    instructions: 'Request approval and finish.',
    tools: [decision],
    provider,
  });
  await using session = await agent.session();
  const turn = await session.submit('go');
  const pending = await turn.wait({ until: 'manual_tool' });
  expect(pending).toHaveProperty('requests');
  const state = parseSessionState(JSON.stringify(await session.suspend()));
  await session.close();

  const resumed = await agent.run(null, {
    state,
    returnRawUsage: true,
    onInteraction(action) {
      const request = decision.match(action);
      if (!request) throw new Error('Expected the restored decision request');
      return request.reply('approved');
    },
  });

  expect(resumed.finalOutput).toBe('finished');
  expect(server.requests).toHaveLength(2);
  expect(resumed.rawUsage).toMatchObject([{ responseId: 'response-2', usage }]);
});

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

it('captures invalid and successful output-repair responses in request order', async () => {
  const usage = [0, 1, 2].map((sequence) => ({ ...modelUsage, sequence }));
  const server = new ModelServer(
    [
      [message('{"label":"x"}')],
      [message('{"label":"y"}')],
      [message('{"label":"corrected"}')],
    ],
    usage.map((record) => JSON.stringify(record)),
  );
  await using provider = await providerFor(server);
  const result = await new Agent({
    instructions: 'Answer.',
    provider,
    outputType: {
      mode: 'prompted',
      schema: z.object({ label: z.string().min(2) }),
      maxRetries: 2,
    },
  }).run('run', { returnRawUsage: true });
  expect(result.finalOutput).toEqual({ label: 'corrected' });
  expect(result.rawUsage?.map((record) => record.responseId)).toEqual([
    'response-1',
    'response-2',
    'response-3',
  ]);
  expect(result.rawUsage?.map((record) => record.usage)).toEqual(usage);
  expect(server.requests).toHaveLength(3);
  server.assertExhausted();
}, 30_000);

it.each([false, true])(
  'orders correction usage before resumed sampling and defers combined overflow=%s',
  async (overflow) => {
    const usage = [0, 1, 2].map((sequence) => ({
      ...modelUsage,
      sequence,
      ...(overflow && sequence < 2 ? { padding: 'x'.repeat(4_500_000) } : {}),
    }));
    const server = new ModelServer(
      [
        [message('{"label":"x"}')],
        [message('{"label":"corrected"}')],
        [message('{"label":"final"}')],
      ],
      usage.map((record) => JSON.stringify(record)),
    );
    await using provider = await providerFor(server);
    let continued = false;
    const pending = new Agent({
      instructions: 'Answer.',
      provider,
      outputType: {
        mode: 'prompted',
        schema: z.object({ label: z.string().min(2) }),
        maxRetries: 1,
      },
      beforeComplete(context) {
        if (context.text?.includes('corrected')) {
          continued = true;
          return {
            action: 'continue',
            instructions: 'Sample the final response.',
          };
        }
      },
    }).run('run', { returnRawUsage: true });
    if (overflow) await expect(pending).rejects.toThrow('capture limit');
    else {
      const result = await pending;
      expect(result.finalOutput).toEqual({ label: 'final' });
      expect(result.rawUsage?.map((record) => record.responseId)).toEqual([
        'response-1',
        'response-2',
        'response-3',
      ]);
      expect(result.rawUsage?.map((record) => record.usage)).toEqual(usage);
    }
    expect(continued).toBe(true);
    expect(server.requests).toHaveLength(3);
    server.assertExhausted();
  },
  30_000,
);
