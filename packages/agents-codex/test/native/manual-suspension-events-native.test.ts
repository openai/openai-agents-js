import { firstNativeBatchWire } from '../fixtures/native-event-batches';
import { afterEach, expect, it, onTestFinished, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  InteractionRequired,
  NativeProvider,
  manualTool,
  type ObservedEvent,
} from '../../src';
import { binding, type NativeThread } from '../../src/runtime/binding';
import { ModelServer, call } from './fixtures/model-server';

afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});

it('drains genuine usage after manual suspension overtakes the next native read', async () => {
  const native = await binding();
  const prototype = native.NativeThread.prototype;
  const next = prototype._next_session_events;
  const seal = prototype._seal_manual_checkpoint;
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let target: NativeThread | undefined;
  let completedTurnId: string | undefined;
  let requestedTurnId: string | undefined;
  let heldRead = false;
  let sealReturned = false;
  const unblock = () => {
    held.resolve();
    release.resolve();
  };
  // Also release gates if the test deadline interrupts an awaited operation.
  onTestFinished(unblock);
  vi.spyOn(prototype, '_next_session_events').mockImplementation(
    async function (this: NativeThread, ...args) {
      // The regression must read from this same native receiver after suspension.
      // eslint-disable-next-line @typescript-eslint/no-this-alias
      target ??= this;
      if (
        this === target &&
        completedTurnId !== undefined &&
        requestedTurnId === completedTurnId &&
        !heldRead
      ) {
        heldRead = true;
        held.resolve();
        await release.promise;
      }
      const raw = await next.apply(this, args);
      if (this === target) {
        const event = JSON.parse(firstNativeBatchWire(raw));
        if (event.msg?.type === 'raw_response_completed')
          completedTurnId = event.id;
        // Native root events and tool requests may arrive in either order.
        // Let the real manual request through before holding the usage tail.
        if (
          event.msg?.type === 'dynamic_tool_call_request' &&
          event.msg.callId === 'decision1'
        )
          requestedTurnId = event.msg.turnId;
      }
      return raw;
    },
  );
  vi.spyOn(prototype, '_seal_manual_checkpoint').mockImplementation(
    async function (this: NativeThread, ...args) {
      if (this !== target) return seal.apply(this, args);
      // Keep the genuine next read outside native until the genuine seal returns.
      await held.promise;
      try {
        const raw = await seal.apply(this, args);
        sealReturned = true;
        return raw;
      } finally {
        release.resolve();
      }
    },
  );

  // Emit exact JSON integer tokens rather than rounded JavaScript numbers.
  const rawUsage =
    '{"input_tokens":9007199254740993,"input_tokens_details":{"cached_tokens":9007199254740990},"output_tokens":7,"output_tokens_details":{"reasoning_tokens":2},"total_tokens":9007199254741000}';
  const server = new ModelServer(
    [[call('decision', {}, { callId: 'decision1' })]],
    [rawUsage],
  );
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-manual-tail',
    supportsWebsockets: false,
  });
  await using session = await new Agent({
    instructions: 'Ask the decision once.',
    model: 'gpt-5',
    provider,
    tools: [
      manualTool({
        name: 'decision',
        description: 'Ask.',
        parameters: z.object({}),
        result: z.string(),
      }),
    ],
  }).session();
  const events: ObservedEvent[] = [];
  const requested = Promise.withResolvers<void>();
  const observing = (async () => {
    for await (const event of session.events()) {
      events.push(event);
      if (event.type === 'action_requested' && event.callId === 'decision1')
        requested.resolve();
    }
  })();
  // Observe a failure immediately while preserving it for the assertion below.
  void observing.catch(() => {});
  try {
    const turn = await session.submit('Ask for a decision.');
    const outcome = turn.wait().catch((error: unknown) => error);
    await requested.promise;
    const state = await session.suspend();
    expect(heldRead).toBe(true);
    expect(sealReturned).toBe(true);
    expect(completedTurnId).toBe(turn.turnId);
    expect(state.format_version).toBe(5);
    if (state.format_version !== 5)
      throw new Error('Expected a manual suspension checkpoint');
    expect(state.manual_continuation.turn_id).toBe(turn.turnId);
    expect(await outcome).toBeInstanceOf(InteractionRequired);
    if (!target) throw new Error('Missing native event reader');
    // Explicit close must also release a read after Core has retired.
    const remainingRead = target._next_session_events();
    void remainingRead.catch(() => {});
    await session.close();
    await expect(remainingRead).rejects.toThrow(/closed/i);
    await observing;

    const actionIndex = events.findIndex(
      (event) =>
        event.type === 'action_requested' &&
        event.sessionId === session.id &&
        event.turnId === turn.turnId &&
        event.submissionId === turn.submissionId &&
        event.callId === 'decision1',
    );
    expect(actionIndex).toBeGreaterThanOrEqual(0);
    const usage = events
      .slice(actionIndex + 1)
      .find(
        (event) =>
          event.type === 'usage_updated' &&
          event.sessionId === session.id &&
          event.turnId === turn.turnId &&
          event.submissionId === turn.submissionId &&
          event.usage?.lastTokenUsage.inputTokens === 9007199254740993n,
      );
    expect(usage?.type).toBe('usage_updated');
    if (!usage || usage.type !== 'usage_updated' || !usage.usage)
      throw new Error('Missing native reported usage after manual suspension');
    const expected = {
      inputTokens: 9007199254740993n,
      cachedInputTokens: 9007199254740990,
      cacheWriteInputTokens: 0,
      outputTokens: 7,
      reasoningOutputTokens: 2,
      totalTokens: 9007199254741000n,
    };
    expect(usage.usage.lastTokenUsage).toEqual(expected);
    expect(usage.usage.totalTokenUsage).toEqual(expected);
    expect(server.requests).toHaveLength(1);
    server.assertExhausted();
  } finally {
    unblock();
  }
}, 30_000);
