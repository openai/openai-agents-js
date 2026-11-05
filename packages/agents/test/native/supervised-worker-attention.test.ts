import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Agent,
  NativeProvider,
  localStorage,
  manualTool,
  tool,
} from '@openai/agents';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  WorkerSignals,
  type AccountQuotaObservation,
} from '../../examples/supervised-worker/signals';
import { waitForWorkerAttention } from '../../examples/supervised-worker/supervision';
import { ModelServer, call, message } from './fixtures/model-server';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function providerFor(model: ModelServer) {
  const config = await model.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-loopback-only',
    supportsWebsockets: false,
  });
}

function quotaRead({
  accountId = 'fixture-a',
  generation = 1,
  observedAt = Date.now() / 1000 - 1,
  expiresAt = Date.now() / 1000 + 60,
  usableCredits = false,
}: {
  accountId?: string;
  generation?: number;
  observedAt?: number;
  expiresAt?: number;
  usableCredits?: boolean;
} = {}): AccountQuotaObservation {
  return {
    generation,
    observedAt,
    expiresAt,
    response: {
      accountId,
      ordinaryUsageAllowed: false,
      rateLimits: {
        limitId: 'unrelated-bucket',
        credits: { hasCredits: false, unlimited: false, balance: '0' },
      },
      rateLimitsByLimitId: {
        codex: {
          limitId: 'codex',
          primary: {
            usedPercent: 100,
            windowDurationMins: 300,
            resetsAt: Math.floor(observedAt) + 3_600,
          },
          secondary: { usedPercent: 20, windowDurationMins: 10_080 },
          credits: {
            hasCredits: usableCredits,
            unlimited: false,
            balance: usableCredits ? '7.50' : '0',
          },
        },
      },
    },
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});

it('does not accept a quota observation with a blank account identity', () => {
  const signals = new WorkerSignals({ accountId: ' ', generation: 1 });
  signals.updateQuota(quotaRead({ accountId: ' ' }));
  expect(signals.quota).toBeUndefined();
});

it('waits across an ordinary tool and advisory quota for a live question, then completion', async () => {
  const continued = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const effects: string[] = [];
  const record = tool({
    name: 'record',
    description: 'Record a synthetic ordinary effect.',
    parameters: z.object({ value: z.string() }),
    async execute({ value }) {
      effects.push(value);
      return 'ordinary effect recorded';
    },
  });
  const ask = manualTool({
    name: 'ask',
    description: 'Ask the supervisor a question.',
    parameters: z.object({ question: z.string() }),
    result: z.string(),
  });
  const model = new ModelServer([
    [call('record', { value: 'once' }, { callId: 'ordinary' })],
    async (request) => {
      expect(JSON.stringify(request.input)).toContain(
        'ordinary effect recorded',
      );
      continued.resolve();
      await release.promise;
      return [call('ask', { question: 'Which date?' }, { callId: 'question' })];
    },
    (request) => {
      expect(JSON.stringify(request.input)).toContain('Tuesday');
      return [message('Completed on Tuesday.')];
    },
  ]);
  await using provider = await providerFor(model);
  await using session = await new Agent({
    instructions: 'Use the supplied tools.',
    model: 'gpt-5',
    provider,
    tools: [record, ask],
  }).session();

  const turn = await session.submit('Prepare the work.');
  const signals = new WorkerSignals({ accountId: 'fixture-a', generation: 1 });
  let settled = false;
  const waiting = waitForWorkerAttention(turn, { signals }).finally(() => {
    settled = true;
  });
  void waiting.catch(() => {});
  try {
    await continued.promise;
    expect(effects).toEqual(['once']);
    const now = Date.now() / 1000;
    signals.updateQuota(
      quotaRead({ observedAt: now - 2, usableCredits: true }),
    );
    expect(signals.quota).toMatchObject({
      fresh: true,
      blocked: false,
      usableCredits: true,
      primary: {
        usedPercent: 100,
        windowDurationMins: 300,
        resetsAt: Math.floor(now - 2) + 3_600,
      },
      secondary: { windowDurationMins: 10_080, resetsAt: null },
      credits: { balance: '7.50' },
    });

    // An older or expired full read cannot replace a current observation.
    signals.updateQuota(quotaRead({ observedAt: now - 4 }));
    signals.updateQuota(
      quotaRead({ observedAt: now - 1, expiresAt: now - 0.5 }),
    );
    expect(signals.quota?.usableCredits).toBe(true);
    await tick();
    expect(settled).toBe(false);

    // A different attachment can supersede the source before the wake is delivered.
    signals.updateQuota(quotaRead({ observedAt: now - 1 }));
    signals.attach({ accountId: 'fixture-b', generation: 2 });
    signals.updateQuota(quotaRead({ generation: 2 }));
    signals.updateQuota(quotaRead({ accountId: 'fixture-b', generation: 1 }));
    expect(signals.quota).toBeUndefined();

    const rounded = quotaRead({
      accountId: 'fixture-b',
      generation: 2,
      observedAt: now - 1,
    });
    rounded.response.ordinaryUsageAllowed = null;
    signals.updateQuota(rounded);
    expect(signals.quota).toMatchObject({
      fresh: true,
      blocked: false,
      ordinaryUsageAllowed: null,
      usableCredits: false,
      primary: { usedPercent: 100 },
    });

    signals.updateQuota({
      generation: 2,
      observedAt: now,
      expiresAt: now + 60,
      response: {
        accountId: 'fixture-b',
        ordinaryUsageAllowed: false,
        rateLimits: {
          limitId: 'codex',
          primary: { usedPercent: 100 },
          credits: { hasCredits: false },
        },
      },
    });
    expect(signals.quota).toMatchObject({
      fresh: true,
      blocked: false,
      usableCredits: null,
      primary: { usedPercent: 100, windowDurationMins: null, resetsAt: null },
      secondary: null,
      credits: { hasCredits: false, unlimited: null, balance: null },
    });
    await tick();
    expect(settled).toBe(false);

    release.resolve();
    const attention = await waiting;
    if (!('requests' in attention))
      throw new Error('Expected a live question.');
    expect(attention.turn).toBe(turn);
    const question = ask.match(attention.requests[0]);
    expect(question?.arguments).toEqual({ question: 'Which date?' });
    if (!question) throw new Error('Question did not match the owning tool.');
    await session.respond(question.reply('Tuesday'));
    await expect(
      waitForWorkerAttention(turn, { signals }),
    ).resolves.toMatchObject({
      finalOutput: 'Completed on Tuesday.',
    });
    expect(effects).toEqual(['once']);
    model.assertExhausted();
  } finally {
    release.resolve();
  }
});

it('wakes on authoritative exhaustion and leaves interruption to the turn owner', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const model = new ModelServer([
    async () => {
      entered.resolve();
      await release.promise;
      return [message('Still owned by the original turn.')];
    },
  ]);
  await using provider = await providerFor(model);
  await using session = await new Agent({
    instructions: 'Answer.',
    model: 'gpt-5',
    provider,
  }).session();

  const turn = await session.submit('Hold.');
  const signals = new WorkerSignals({ accountId: 'fixture-a', generation: 1 });
  const waiting = waitForWorkerAttention(turn, { signals });
  void waiting.catch(() => {});
  const notifications = new EventEmitter();
  const refetch = (
    generation: number,
    read: () => Promise<AccountQuotaObservation['response']>,
  ) => {
    const refreshed = Promise.withResolvers<void>();
    notifications.once('account/rateLimits/updated', () => {
      void signals
        .refreshQuota({ generation, maxAgeSeconds: 60, read })
        .then(refreshed.resolve, refreshed.reject);
    });
    notifications.emit('account/rateLimits/updated', {
      rateLimits: { limitId: 'codex', primary: { usedPercent: 100 } },
    });
    return refreshed.promise;
  };
  try {
    await entered.promise;
    signals.updateQuota(quotaRead());
    await expect(waiting).resolves.toMatchObject({
      type: 'account_quota_blocked',
      quota: { fresh: true, blocked: true, usableCredits: false },
    });

    const oldAccountRead =
      Promise.withResolvers<AccountQuotaObservation['response']>();
    const oldRefresh = refetch(1, () => oldAccountRead.promise);
    signals.attach({ accountId: 'fixture-b', generation: 2 });
    oldAccountRead.resolve(quotaRead().response);
    await oldRefresh;
    expect(signals.quota).toBeUndefined();

    for (const [generation, hardBlock] of [
      [2, { spendControlReached: true }],
      [3, { rateLimitReachedType: 'workspace_member_usage_limit_reached' }],
    ] as const) {
      signals.attach({ accountId: 'fixture-b', generation });
      const waitingForRefetch = waitForWorkerAttention(turn, { signals });
      void waitingForRefetch.catch(() => {});
      const { response } = quotaRead({
        accountId: 'fixture-b',
        generation,
        usableCredits: true,
      });
      response.ordinaryUsageAllowed = true;
      Object.assign(response.rateLimitsByLimitId!.codex, hardBlock);
      await refetch(generation, async () => response);
      await expect(waitingForRefetch).resolves.toMatchObject({
        type: 'account_quota_blocked',
        quota: {
          ordinaryUsageAllowed: true,
          usableCredits: true,
          ...hardBlock,
        },
      });
    }

    signals.attach({ accountId: 'fixture-b', generation: 4 });
    const observer = new AbortController();
    const detached = waitForWorkerAttention(turn, {
      signals,
      signal: observer.signal,
    });
    const disconnected = new Error('Supervisor observer detached.');
    observer.abort(disconnected);
    await expect(detached).rejects.toBe(disconnected);

    const interrupted = waitForWorkerAttention(turn, { signals });
    await turn.cancel();
    await expect(interrupted).resolves.toMatchObject({
      type: 'needs_attention',
      reason: 'interrupted',
    });
    expect(model.requests).toHaveLength(1);
  } finally {
    release.resolve();
  }
});

it('surfaces a terminal provider quota error despite a current credit observation', async () => {
  const model = new ModelServer([
    {
      status: 429,
      body: JSON.stringify({
        error: {
          message: 'Fixture provider account quota exhausted.',
          type: 'insufficient_quota',
          code: 'insufficient_quota',
        },
      }),
    },
  ]);
  const signals = new WorkerSignals({ accountId: 'fixture-a', generation: 1 });
  signals.updateQuota(quotaRead({ usableCredits: true }));
  await using provider = await providerFor(model);
  await using session = await new Agent({
    instructions: 'Answer.',
    model: 'gpt-5',
    provider,
  }).session();
  const turn = await session.submit('Try once.');
  await expect(
    waitForWorkerAttention(turn, { signals }),
  ).resolves.toMatchObject({
    type: 'needs_attention',
    reason: 'quota_blocked',
    error: { category: 'usage_limit_exceeded' },
  });
  expect(signals.quota?.usableCredits).toBe(true);
  model.assertExhausted();
});

it('reports native connection loss and lets a supervisor reopen the original session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'worker-attention-profile-'));
  try {
    const storage = localStorage(directory);
    const signals = new WorkerSignals({
      accountId: 'fixture-a',
      generation: 1,
    });
    signals.updateQuota(quotaRead({ usableCredits: true }));
    const config = { instructions: 'Answer.', model: 'gpt-5' };
    const initial = new ModelServer([[message('Connected.')]]);
    await using broken = await providerFor(initial);
    // Bound this fixture's attempts while retaining the real native transport.
    const acquire = broken._acquire.bind(broken);
    vi.spyOn(broken, '_acquire').mockImplementation((captured) => {
      const lease = acquire(captured);
      lease.config['model_providers.native_agent.request_max_retries'] = 0;
      lease.config['model_providers.native_agent.stream_max_retries'] = 0;
      return lease;
    });
    await using session = await new Agent({
      ...config,
      provider: broken,
    }).session({ storage });
    const warm = await session.submit('Check the initial connection.');
    await expect(
      waitForWorkerAttention(warm, { signals }),
    ).resolves.toMatchObject({
      finalOutput: 'Connected.',
    });
    initial.assertExhausted();
    // Remove the working HTTP listener. The next native connection is refused.
    await ModelServer.closeAll();
    const turn = await session.submit('Original request.');
    await expect(
      waitForWorkerAttention(turn, {
        signals,
        signal: AbortSignal.timeout(20_000),
      }),
    ).resolves.toMatchObject({
      type: 'needs_attention',
      reason: 'connection_lost',
    });
    const threadId = session.id;
    await session.close();

    signals.attach({ accountId: 'fixture-b', generation: 2 });
    signals.updateQuota(quotaRead());
    expect(signals.quota).toBeUndefined();
    const model = new ModelServer([
      (request) => {
        expect(JSON.stringify(request.input)).toContain('Explicit follow-up.');
        return [message('Reconnected.')];
      },
    ]);
    await using replacement = await providerFor(model);
    await using reopened = await new Agent({
      ...config,
      provider: replacement,
    }).session({
      storage,
      resume: threadId,
    });
    expect(reopened.id).toBe(threadId);
    expect(model.requests).toHaveLength(0);
    const next = await reopened.submit('Explicit follow-up.');
    await expect(
      waitForWorkerAttention(next, { signals }),
    ).resolves.toMatchObject({
      finalOutput: 'Reconnected.',
    });
    model.assertExhausted();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
