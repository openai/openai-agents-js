import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { it, expect, vi } from 'vitest';
import { APIUserAbortError } from 'openai';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  manualTool,
  parseSessionState,
  tool,
  type ModelRequest,
  type ModelResponse,
  type RetryContext,
} from '../../src';
function authenticateTestState(state: unknown) {
  const serialized = JSON.stringify(state);
  return parseSessionState(serialized, {
    expectedSha256: createHash('sha256').update(serialized).digest('hex'),
  });
}
function message(text = 'ok', input = 1): ModelResponse {
  return {
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text }],
      },
    ],
    usage: { input_tokens: input },
  };
}
function failure(label: string) {
  return Object.assign(new Error(label), { status: 503, code: 'server_error' });
}
it.each([
  ['omitted', {}],
  ['undefined', { retry: undefined }],
  ['null', { retry: null }],
  ['partial backoff', { retry: { backoff: { initialDelayMs: 0 } } }],
] as const)(
  'merges opening retry %s without changing later Agent defaults',
  async (kind, modelSettings) => {
    const error = failure('opening retry boundary');
    const complete = vi.fn(() => {
      throw error;
    });
    const policy = vi.fn(() => ({ retry: true, delayMs: 0 }));
    await using provider = new NativeProvider({ modelBackend: { complete } });
    const agent = new Agent({
      model: 'custom-model',
      instructions: 'Answer.',
      provider,
      modelSettings: {
        retry: {
          maxRetries: 1,
          policy,
          backoff: {
            initialDelayMs: 5,
            maxDelayMs: 20,
            multiplier: 3,
            jitter: false,
          },
        },
      },
    });
    for (const options of [{ modelSettings }, {}]) {
      complete.mockClear();
      policy.mockClear();
      await using session = await agent.session(options);
      const cleared = 'modelSettings' in options && kind === 'null';
      const partial = 'modelSettings' in options && kind === 'partial backoff';
      // Observe native-applied settings, including whole-backoff replacement.
      expect(await session.saveState()).toMatchObject({
        history: expect.arrayContaining([
          expect.objectContaining({
            type: 'event_msg',
            payload: expect.objectContaining({
              type: 'thread_settings_applied',
              thread_settings: expect.objectContaining({
                request_controls: expect.objectContaining({
                  retry: cleared
                    ? null
                    : {
                        configured: true,
                        has_policy: true,
                        max_retries: 1,
                        backoff: {
                          initial_delay_ms: partial ? 0 : 5,
                          max_delay_ms: partial ? 2000 : 20,
                          multiplier: partial ? 2 : 3,
                          jitter: partial,
                        },
                      },
                }),
              }),
            }),
          }),
        ]),
      });
      await expect((await session.submit('fail')).wait()).rejects.toBe(error);
      expect(complete).toHaveBeenCalledTimes(cleared ? 1 : 2);
      expect(policy).toHaveBeenCalledTimes(cleared ? 0 : 1);
    }
  },
  20_000,
);
it.each([0, 1])(
  'uses only current retry bounds after restore (maxRetries=%s)',
  async (maxRetries) => {
    let stage: 'seed' | 'success' | 'failure' = 'seed';
    const complete = vi.fn(
      async (request: ModelRequest): Promise<ModelResponse> => {
        if (stage !== 'seed') {
          await delay(250, undefined, { signal: request.signal });
          if (stage === 'failure') throw failure('restored provider failure');
        }
        return message('ok');
      },
    );
    const currentPolicy = vi.fn(() => ({ retry: true, delayMs: 0 }));
    await using provider = new NativeProvider({
      modelBackend: { complete, getRetryAdvice: () => ({ suggested: true }) },
    });
    const declaration = {
      model: 'custom-model',
      instructions: 'Answer.',
      provider,
    };
    let state;
    {
      await using original = await new Agent({
        ...declaration,
        modelSettings: {
          attemptTimeoutMs: 100,
          retry: {
            maxRetries: 3,
            backoff: { initialDelayMs: 0, jitter: false },
          },
        },
      }).session();
      expect((await (await original.submit('seed')).wait()).finalOutput).toBe(
        'ok',
      );
      state = await original.saveState();
    }
    const current = new Agent({
      ...declaration,
      modelSettings: maxRetries
        ? {
            retry: {
              maxRetries,
              policy: currentPolicy,
            },
          }
        : undefined,
    });
    await using restored = await current.session({ state });
    stage = 'success';
    complete.mockClear();
    expect((await (await restored.submit('continue')).wait()).finalOutput).toBe(
      'ok',
    );
    expect(complete).toHaveBeenCalledTimes(1);

    stage = 'failure';
    complete.mockClear();
    await expect((await restored.submit('fail')).wait()).rejects.toThrow(
      'restored provider failure',
    );
    expect(complete).toHaveBeenCalledTimes(maxRetries + 1);
    expect(currentPolicy).toHaveBeenCalledTimes(maxRetries);
  },
  20_000,
);
it('uses Core retries with captured callback identity, new logical advice signal and exact cumulative usage', async () => {
  const error = failure('first');
  const requests: ModelRequest[] = [];
  const contexts: RetryContext[] = [];
  const order: string[] = [];
  const laterAdvice = vi.fn(() => ({ suggested: false }));
  const advice = vi.fn((args) => {
    order.push('advice');
    expect(args.error).toBe(error);
    expect(args.request.body).toEqual(requests[0].body);
    expect(args.signal).not.toBe(requests[0].signal);
    expect(args.signal.aborted).toBe(false);
    return { suggested: true, replaySafety: 'safe' as const };
  });
  const laterPolicy = vi.fn(() => ({ retry: false }));
  const backend = {
    getRetryAdvice: advice,
    complete(request: ModelRequest): ModelResponse {
      requests.push(request);
      order.push(`request${requests.length}`);
      if (requests.length === 1) {
        backend.getRetryAdvice = laterAdvice;
        agent.modelSettings = { retry: { maxRetries: 1, policy: laterPolicy } };
        throw error;
      }
      return message('ok', 3);
    },
  };
  await using provider = new NativeProvider({ modelBackend: backend });
  const agent = new Agent({
    model: 'custom-model',
    instructions: 'Answer.',
    provider,
    modelSettings: {
      retry: {
        maxRetries: 1,
        backoff: { initialDelayMs: 0, jitter: false },
        policy(context) {
          contexts.push(context);
          order.push('policy');
          expect(context.error).toBe(error);
          expect(context.normalizedError.statusCode).toBe(503);
          expect(context.providerAdvice?.suggested).toBe(true);
          expect(context.replaySafety).toBe('safe');
          expect(context.stateful).toBe(false);
          expect(context.signal.aborted).toBe(false);
          return { retry: true, delayMs: 0 };
        },
      },
    },
  });
  const result = await agent.run('answer', {
    modelSettings: { retry: { maxRetries: 1 } },
  });
  expect(result.finalOutput).toBe('ok');
  expect(order).toEqual(['request1', 'advice', 'policy', 'request2']);
  expect(laterAdvice).not.toHaveBeenCalled();
  expect(laterPolicy).not.toHaveBeenCalled();
  expect(requests[0].attemptId).not.toBe(requests[1].attemptId);
  expect(requests.map((x) => x.attempt)).toEqual([1, 2]);
  expect(requests[1].disableProviderRetries).toBe(true);
  for (const req of requests) {
    expect(req.body).not.toHaveProperty('retry');
    expect(req.body).not.toHaveProperty('attempt_timeout_ms');
    expect(req.body).not.toHaveProperty('has_policy');
  }
  expect(contexts[0].attempt).toBe(1);
  expect(contexts[0].requestAttempt).toBe(1);
  expect(result.runUsage).toMatchObject({
    requests: 2,
    missingUsageRequests: 1,
    inputTokens: 3,
    totalTokens: 3,
  });
}, 20_000);
it.each(['decline', 'exhaust', 'zero'] as const)(
  'preserves exact final borrowed error on %s',
  async (mode) => {
    const errors: Error[] = [];
    const policy = vi.fn(() => ({ retry: mode === 'exhaust', delayMs: 0 }));
    await using provider = new NativeProvider({
      modelBackend: {
        complete() {
          const error = failure(`provider${errors.length}`);
          errors.push(error);
          throw error;
        },
      },
    });
    const agent = new Agent({
      model: 'custom-model',
      instructions: 'Answer.',
      provider,
      modelSettings: { retry: { maxRetries: mode === 'zero' ? 0 : 1, policy } },
    });
    let caught: unknown;
    try {
      await agent.run('fail');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(errors.at(-1));
    expect(errors).toHaveLength(mode === 'exhaust' ? 2 : 1);
    expect(policy).toHaveBeenCalledTimes(mode === 'zero' ? 0 : 1);
  },
  20_000,
);
it.each(['advice', 'policy'] as const)(
  'keeps %s exception primary and prevents another request',
  async (kind) => {
    const original = failure('provider');
    const callbackError = new Error(kind);
    const complete = vi.fn(() => {
      throw original;
    });
    const policy = vi.fn(() => {
      throw callbackError;
    });
    await using provider = new NativeProvider({
      modelBackend: {
        complete,
        getRetryAdvice() {
          if (kind === 'advice') throw callbackError;
          return { suggested: true };
        },
      },
    });
    await expect(
      new Agent({
        model: 'custom-model',
        instructions: 'Answer.',
        provider,
        modelSettings: { retry: { maxRetries: 1, policy } },
      }).run('fail'),
    ).rejects.toBe(callbackError);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(policy).toHaveBeenCalledTimes(kind === 'policy' ? 1 : 0);
  },
  20_000,
);
it('joins an expired request before advice/policy and retains exact cleanup usage without overlap', async () => {
  let count = 0,
    entered = 0,
    cleaned = false;
  let expired: AbortSignal | undefined;
  const artifact = new APIUserAbortError();
  const order: string[] = [];
  const advice = vi.fn((args) => {
    order.push('advice');
    expect(args.error).toBe(artifact);
    expect(args.request.signal.aborted).toBe(true);
    expect(args.signal.aborted).toBe(false);
    return { suggested: true };
  });
  await using provider = new NativeProvider({
    modelBackend: {
      getRetryAdvice: advice,
      async complete(request) {
        count++;
        entered++;
        try {
          if (count === 1) {
            expired = request.signal;
            await new Promise<void>((resolve) =>
              request.signal.addEventListener('abort', () => resolve(), {
                once: true,
              }),
            );
            await Promise.resolve();
            request.reportUsage!({
              inputTokens: 13,
              cachedInputTokens: 0,
              cacheWriteInputTokens: 0,
              outputTokens: 0,
              reasoningOutputTokens: 0,
              totalTokens: 13,
            });
            cleaned = true;
            order.push('cleanup');
            throw artifact;
          }
          expect(entered).toBe(1);
          return message();
        } finally {
          entered--;
        }
      },
    },
  });
  const policy = vi.fn((context: RetryContext) => {
    order.push('policy');
    expect(cleaned).toBe(true);
    expect(expired?.aborted).toBe(true);
    expect(context.signal.aborted).toBe(false);
    expect(context.error).not.toBe(artifact);
    expect(context.normalizedError.isTimeout).toBe(true);
    return { retry: true, delayMs: 0, approveUnsafeReplay: true };
  });
  const result = await new Agent({
    model: 'custom-model',
    instructions: 'Answer.',
    provider,
    modelSettings: {
      attemptTimeoutMs: 100,
      invocationTimeoutMs: 2000,
      retry: { maxRetries: 1, policy },
    },
  }).run('answer');
  expect(result.finalOutput).toBe('ok');
  expect(count).toBe(2);
  expect(policy).toHaveBeenCalledTimes(1);
  expect(advice).toHaveBeenCalledTimes(1);
  expect(order).toEqual(['cleanup', 'advice', 'policy']);
  expect(result.runUsage).toMatchObject({
    requests: 2,
    missingUsageRequests: 0,
    inputTokens: 14,
    totalTokens: 14,
  });
}, 20_000);
it('vetoes retry when cancelled producer cleanup throws a non-abort error', async () => {
  const cleanup = new Error('cleanup failed', {
    cause: Object.assign(new Error('cancelled'), {
      name: 'AbortError',
      code: 'ABORT_ERR',
    }),
  });
  const policy = vi.fn(() => ({
    retry: true,
    delayMs: 0,
    approveUnsafeReplay: true,
  }));
  const complete = vi.fn(
    async (request: ModelRequest): Promise<ModelResponse> => {
      await new Promise<void>((resolve) =>
        request.signal.addEventListener('abort', () => resolve(), {
          once: true,
        }),
      );
      throw cleanup;
    },
  );
  await using provider = new NativeProvider({ modelBackend: { complete } });
  await expect(
    new Agent({
      model: 'custom-model',
      instructions: 'Answer.',
      provider,
      modelSettings: {
        attemptTimeoutMs: 100,
        retry: { maxRetries: 1, policy },
      },
    }).run('answer'),
  ).rejects.toBe(cleanup);
  expect(complete).toHaveBeenCalledTimes(1);
  expect(policy).not.toHaveBeenCalled();
}, 20_000);
it('keeps correction-submission usage when the predecessor publishes its final native snapshot', async () => {
  let calls = 0;
  const policy = vi.fn(() => ({ retry: true, delayMs: 0 }));
  await using provider = new NativeProvider({
    modelBackend: {
      complete() {
        calls++;
        if (calls === 1) throw failure('first root attempt');
        return calls === 2
          ? message('{"label":"x"}', 5)
          : message('{"label":"fixed"}', 7);
      },
    },
  });
  const result = await new Agent({
    model: 'custom-model',
    instructions: 'Answer.',
    provider,
    modelSettings: { retry: { maxRetries: 1, policy } },
    outputType: {
      mode: 'prompted',
      schema: z.object({ label: z.string().min(2) }),
      maxRetries: 1,
    },
  }).run('answer');
  expect(result.finalOutput).toEqual({ label: 'fixed' });
  expect(calls).toBe(3);
  expect(result.runUsage).toMatchObject({
    requests: 3,
    missingUsageRequests: 1,
    inputTokens: 12,
    totalTokens: 12,
  });
  expect(result.repairAttempts).toHaveLength(1);
}, 20_000);
it('keeps explicit tool usage additive through retry and model continuation', async () => {
  let count = 0;
  const metered = tool({
    name: 'metered',
    description: 'Measure.',
    parameters: z.object({}),
    execute(_args, context) {
      context.reportUsage(
        {
          inputTokens: 3,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
          totalTokens: 3,
        },
        { requests: 0 },
      );
      return 'done';
    },
  });
  await using provider = new NativeProvider({
    modelBackend: {
      complete(): ModelResponse {
        count++;
        if (count === 1) throw failure('retry');
        if (count === 2)
          return {
            output: [
              {
                type: 'function_call',
                name: 'metered',
                call_id: 'meter',
                arguments: '{}',
              },
            ],
            usage: { input_tokens: 2 },
          };
        return message('ok', 4);
      },
    },
  });
  const result = await new Agent({
    model: 'custom-model',
    instructions: 'Answer.',
    provider,
    tools: [metered],
    modelSettings: {
      retry: { maxRetries: 1, policy: () => ({ retry: true, delayMs: 0 }) },
    },
  }).run('measure');
  expect(count).toBe(3);
  expect(result.runUsage).toMatchObject({
    requests: 3,
    missingUsageRequests: 1,
    inputTokens: 9,
    totalTokens: 9,
  });
}, 20_000);
it('joins a cancelled retry callback and prevents its late decision from starting another request', async () => {
  const entered = Promise.withResolvers<void>(),
    aborted = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let calls = 0,
    cleaned = false;
  await using provider = new NativeProvider({
    modelBackend: {
      complete() {
        calls++;
        if (calls === 1) throw failure('first');
        return message();
      },
    },
  });
  const agent = new Agent({
    model: 'custom-model',
    instructions: 'Answer.',
    provider,
    modelSettings: {
      retry: {
        maxRetries: 1,
        async policy(context) {
          entered.resolve();
          context.signal.addEventListener('abort', () => aborted.resolve(), {
            once: true,
          });
          await release.promise;
          cleaned = true;
          return { retry: true, delayMs: 0 };
        },
      },
    },
  });
  await using session = await agent.session();
  const first = await session.submit('cancel');
  await entered.promise;
  let stopped = false;
  const stopping = first.cancel().then(() => {
    stopped = true;
  });
  await aborted.promise;
  expect(stopped).toBe(false);
  release.resolve();
  await stopping;
  expect(cleaned).toBe(true);
  await expect(first.wait()).rejects.toThrow();
  expect(calls).toBe(1);
  const next = await session.submit('new root');
  await expect(next.wait()).resolves.toMatchObject({ finalOutput: 'ok' });
  expect(calls).toBe(2);
}, 20_000);

it.each([true, false])(
  'uses provider advice suggested=%s without a custom retry policy',
  async (suggested) => {
    const original = suggested
      ? new Error('not natively retryable')
      : failure('natively retryable');
    const complete = vi.fn(() => {
      if (complete.mock.calls.length === 1) throw original;
      return message();
    });
    const getRetryAdvice = vi.fn(() => ({
      suggested,
      replaySafety: 'safe' as const,
    }));
    await using provider = new NativeProvider({
      modelBackend: { complete, getRetryAdvice },
    });
    const run = new Agent({
      provider,
      model: 'custom-model',
      instructions: 'Answer.',
      modelSettings: {
        retry: { maxRetries: 1, backoff: { initialDelayMs: 0, maxDelayMs: 0 } },
      },
    }).run('answer');
    if (suggested) {
      const result = await run;
      expect(result.finalOutput).toBe('ok');
      expect(result.runUsage).toMatchObject({
        requests: 2,
        missingUsageRequests: 1,
      });
    } else await expect(run).rejects.toBe(original);
    expect(complete).toHaveBeenCalledTimes(suggested ? 2 : 1);
    expect(getRetryAdvice).toHaveBeenCalledTimes(1);
  },
);

it.each([false, true])(
  'joins expired transform cleanup before retry (cleanup failure: %s)',
  async (failCleanup) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let cleanupStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      cleanupStarted = resolve;
    });
    let transforms = 0;
    let cleaned = false;
    const cleanupError = new Error('transform cleanup failed');
    const complete = vi.fn(() => message());
    const policy = vi.fn(() => {
      expect(cleaned).toBe(true);
      return { retry: true, delayMs: 0 };
    });
    await using provider = new NativeProvider({ modelBackend: { complete } });
    const running = new Agent({
      model: 'custom-model',
      instructions: 'Answer.',
      provider,
      modelSettings: {
        attemptTimeoutMs: 100,
        invocationTimeoutMs: 3000,
        retry: { maxRetries: 1, policy },
      },
      async transformContext(context) {
        if (++transforms !== 1) {
          expect(cleaned).toBe(true);
          return;
        }
        try {
          await new Promise<void>((resolve) => {
            if (context.signal.aborted) resolve();
            else
              context.signal.addEventListener('abort', () => resolve(), {
                once: true,
              });
          });
        } finally {
          cleanupStarted();
          await gate;
          cleaned = true;
          // eslint-disable-next-line no-unsafe-finally -- Exercise cleanup failure overriding cancellation.
          if (failCleanup) throw cleanupError;
        }
      },
    }).run('answer');
    const settled = running.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    try {
      await started;
      expect(policy).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
      expect(transforms).toBe(1);
    } finally {
      release();
    }
    const outcome = await settled;
    if (failCleanup) {
      expect(outcome).toEqual({ error: cleanupError });
      expect(policy).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
    } else {
      expect('value' in outcome && outcome.value.finalOutput).toBe('ok');
      expect(policy).toHaveBeenCalledTimes(1);
      expect(complete).toHaveBeenCalledTimes(1);
      expect(transforms).toBe(2);
    }
  },
  20_000,
);

it.each(['retry', 'attempt', 'invocation'] as const)(
  'rebinds forged graph %s controls to current declarations',
  async (control) => {
    let restored = false;
    let roundtrip = false;
    let routes = 0;
    const complete = vi.fn(
      async (request: ModelRequest): Promise<ModelResponse> => {
        if (restored) {
          if (roundtrip && routes++ < 2)
            return {
              output: [
                {
                  type: 'function_call',
                  name:
                    routes === 1 ? 'transfer_to_worker' : 'transfer_to_root',
                  call_id: `roundtrip-${routes}`,
                  arguments: '{}',
                },
              ],
              usage: { input_tokens: 1 },
            };
          if (control === 'retry')
            throw failure('current no-retry declaration');
          await delay(100, undefined, { signal: request.signal });
        }
        return message('ok');
      },
    );
    await using provider = new NativeProvider({
      modelBackend: { complete, getRetryAdvice: () => ({ suggested: true }) },
    });
    const target = new Agent({
      name: 'Worker',

      instructions: 'Answer.',
      provider,
      modelSettings: { retry: { maxRetries: 0 } },
    });
    const agent = new Agent({
      name: 'Root',

      instructions: 'Answer.',
      provider,
      modelSettings: { retry: { maxRetries: 0 } },
      handoffs: [target],
    });
    target.handoffs = [agent];
    let state;
    {
      await using original = await agent.session();
      expect((await (await original.submit('seed')).wait()).finalOutput).toBe(
        'ok',
      );
      state = await original.saveState();
    }
    let changed = 0;
    const forged = JSON.parse(JSON.stringify(state), (key, value: unknown) => {
      if (key !== 'sdk_agent_profile') return value;
      const receipt = z
        .object({ model: z.record(z.string(), z.unknown()) })
        .passthrough()
        .parse(value);
      const controls = z
        .record(z.string(), z.unknown())
        .parse(receipt.model.request_controls ?? {});
      if (control === 'retry') {
        controls.retry = {
          configured: true,
          has_policy: false,
          max_retries: 2,
          backoff: {
            initial_delay_ms: 0,
            max_delay_ms: 0,
            multiplier: 1,
            jitter: false,
          },
        };
      } else if (control === 'attempt') controls.attempt_timeout_ms = 1;
      else receipt.model.invocation_timeout_ms = 1;
      receipt.model.request_controls = controls;
      changed++;
      return receipt;
    }) as typeof state;
    expect(changed).toBeGreaterThan(0);
    restored = true;
    complete.mockClear();
    await expect(agent.session({ state: forged })).rejects.toThrow(
      'Restoring changed Agent instructions requires authenticated SessionState',
    );
    await using session = await agent.session({
      state: authenticateTestState(forged),
    });
    const turn = await session.submit('continue');
    if (control === 'retry')
      await expect(turn.wait()).rejects.toThrow('current no-retry declaration');
    else expect((await turn.wait()).finalOutput).toBe('ok');
    expect(complete).toHaveBeenCalledTimes(1);
    roundtrip = true;
    complete.mockClear();
    const returned = await session.submit('handoff away and back');
    if (control === 'retry')
      await expect(returned.wait()).rejects.toThrow(
        'current no-retry declaration',
      );
    else expect((await returned.wait()).finalOutput).toBe('ok');
    expect(complete).toHaveBeenCalledTimes(3);
  },
  20_000,
);

it('uses the restored worker retry bound instead of the root bound', async () => {
  let restored = false;
  let seedCalls = 0;
  const complete = vi.fn((): ModelResponse => {
    if (restored) throw failure('worker retry boundary');
    if (++seedCalls === 1)
      return {
        output: [
          {
            type: 'function_call',
            name: 'transfer_to_worker',
            call_id: 'worker-handoff',
            arguments: '{}',
          },
        ],
        usage: { input_tokens: 1 },
      };
    return message('saved');
  });
  await using provider = new NativeProvider({
    modelBackend: { complete, getRetryAdvice: () => ({ suggested: true }) },
  });
  const worker = new Agent({
    name: 'Worker',
    provider,
    instructions: 'Worker.',
    modelSettings: { retry: { maxRetries: 0 } },
  });
  const root = new Agent({
    name: 'Root',
    provider,
    instructions: 'Root.',
    handoffs: [worker],
    modelSettings: {
      retry: { maxRetries: 1, backoff: { initialDelayMs: 0, jitter: false } },
    },
  });
  let state;
  {
    await using original = await root.session();
    expect((await (await original.submit('handoff')).wait()).finalOutput).toBe(
      'saved',
    );
    expect(await original.getActiveAgent()).toBe(worker);
    state = await original.saveState();
  }
  restored = true;
  complete.mockClear();
  await using session = await root.session({ state });
  expect(await session.getActiveAgent()).toBe(worker);
  await expect((await session.submit('continue')).wait()).rejects.toThrow(
    'worker retry boundary',
  );
  expect(complete).toHaveBeenCalledTimes(1);
}, 20_000);

it.each([false, true])(
  'keeps current invocation authority through manual restore (graph=%s)',
  async (graph) => {
    let calls = 0;
    const lookup = manualTool({
      name: 'lookup',
      description: 'Ask.',
      parameters: z.object({}),
      result: z.string(),
    });
    await using provider = new NativeProvider({
      modelBackend: {
        async complete(request: ModelRequest): Promise<ModelResponse> {
          if (++calls === 1)
            return {
              output: [
                {
                  type: 'function_call',
                  name: 'lookup',
                  call_id: 'manual-clock',
                  arguments: '{}',
                },
              ],
              usage: { input_tokens: 1 },
            };
          await delay(50, undefined, { signal: request.signal });
          return message('resumed');
        },
      },
    });
    const worker = new Agent({
      name: 'Worker',
      provider,
      instructions: 'Worker.',
      modelSettings: { invocationTimeoutMs: 1000 },
    });
    const agent = new Agent({
      provider,
      instructions: 'Ask.',
      tools: [lookup],
      modelSettings: { invocationTimeoutMs: 1000 },
      handoffs: graph ? [worker] : [],
    });
    let state;
    {
      await using original = await agent.session();
      const turn = await original.submit('ask');
      const completion = turn.wait().catch((error: unknown) => error);
      const pending = await turn.wait({ until: 'manual_tool' });
      expect('requests' in pending).toBe(true);
      state = await original.suspend();
      await completion;
    }
    let changed = 0;
    const forged = JSON.parse(JSON.stringify(state), (key, value: unknown) => {
      if (key !== 'thread_settings') return value;
      const settings = z.record(z.string(), z.unknown()).parse(value);
      if ('invocation_timeout_ms' in settings) {
        settings.invocation_timeout_ms = 1;
        changed++;
      }
      return settings;
    }) as typeof state;
    expect(changed).toBeGreaterThan(0);
    if (graph)
      await expect(agent.session({ state: forged })).rejects.toThrow(
        'Restoring changed Agent instructions requires authenticated SessionState',
      );
    await using restored = await agent.session({
      state: graph ? authenticateTestState(forged) : forged,
    });
    for await (const event of restored.events()) {
      if (event.type !== 'action_requested') continue;
      await restored.respond(event.reply('accepted'));
      break;
    }
    expect((await restored.restoredTurn!.wait()).finalOutput).toBe('resumed');
    expect(calls).toBe(2);
  },
  20_000,
);

it('retains one root admission through retry and portable manual restore', async () => {
  const lookup = manualTool({
    name: 'lookup',
    description: 'Read a record.',
    parameters: z.object({}),
    result: z.string(),
  });
  const complete = vi.fn((): ModelResponse => {
    if (complete.mock.calls.length === 1) throw failure('first root attempt');
    return {
      output: [
        {
          type: 'function_call',
          name: 'lookup',
          call_id: 'retry-manual',
          arguments: '{}',
        },
      ],
      usage: { input_tokens: 1 },
    };
  });
  const policy = vi.fn(() => ({ retry: true, delayMs: 0 }));
  await using provider = new NativeProvider({ modelBackend: { complete } });
  const agent = new Agent({
    provider,
    model: 'custom-model',
    instructions: 'Use the tool and answer.',
    tools: [lookup],
    modelSettings: { retry: { maxRetries: 1, policy } },
  });
  let state;
  {
    await using original = await agent.session();
    const turn = await original.submit('begin', { budget: { maxRequests: 1 } });
    const pending = await turn.wait({ until: 'manual_tool' });
    expect('requests' in pending).toBe(true);
    state = await original.suspend();
  }
  expect(complete).toHaveBeenCalledTimes(2);
  expect(policy).toHaveBeenCalledTimes(1);
  expect(state.run_budget).toEqual({
    version: 1,
    maxRequests: 1,
    admittedRequests: 1,
  });
  await using restored = await agent.session({
    state,
    resumeBudget: { maxRequests: 1 },
  });
  for await (const event of restored.interactions()) {
    const request = lookup.match(event);
    if (!request) continue;
    await restored.respond(request.reply('live result'));
    break;
  }
  await expect(restored.restoredTurn!.wait()).rejects.toMatchObject({
    code: 'run_budget_exceeded',
    retryable: false,
  });
  expect(complete).toHaveBeenCalledTimes(2);
  expect(policy).toHaveBeenCalledTimes(1);
}, 20_000);
