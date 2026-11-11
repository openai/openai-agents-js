import { it, expect, vi } from 'vitest';
import { APIUserAbortError } from 'openai';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  tool,
  type ModelRequest,
  type ModelResponse,
  type RetryContext,
} from '../../src';
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
    return { suggested: true };
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
