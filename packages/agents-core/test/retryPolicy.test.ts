import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  Agent,
  retryPolicies,
  run,
  Runner,
  RunStreamEvent,
  setDefaultModelProvider,
  setTracingDisabled,
} from '../src';
import { mergeAgentToolRunConfig } from '../src/agentToolRunConfig';
import type { Model, ModelRequest } from '../src/model';
import type { StreamEvent } from '../src/types/protocol';
import { RequestUsage, Usage } from '../src/usage';
import { fakeModelMessage, FakeModelProvider } from './stubs';

function createDoneEvent(text: string): StreamEvent {
  return {
    type: 'response_done',
    response: {
      id: 'response_retry',
      usage: new Usage({ requests: 1 }),
      output: [fakeModelMessage(text)],
    },
  };
}

beforeAll(() => {
  setTracingDisabled(true);
  setDefaultModelProvider(new FakeModelProvider());
});

describe('retry policies', () => {
  it('retries non-streaming requests only when the user policy opts in', async () => {
    let attempts = 0;
    const model: Model = {
      async getResponse() {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error('Rate limited');
          (error as Error & { statusCode?: number }).statusCode = 429;
          throw error;
        }

        return {
          usage: new Usage({ requests: 1 }),
          output: [fakeModelMessage('Recovered')],
        };
      },
      async *getStreamedResponse() {
        yield* [];
      },
    };

    const agent = new Agent({
      name: 'RetryingAgent',
      model,
      modelSettings: {
        retry: {
          maxRetries: 1,
          backoff: { initialDelayMs: 0, jitter: false },
          policy: retryPolicies.any(
            retryPolicies.never(),
            retryPolicies.httpStatus([429]),
          ),
        },
      },
    });

    const result = await run(agent, 'hello');

    expect(result.finalOutput).toBe('Recovered');
    expect(attempts).toBe(2);
    expect(result.state.usage.requests).toBe(2);
    expect(result.rawResponses[0]?.usage.requests).toBe(2);
  });

  it('preserves provider-managed retries on the first runner attempt and disables them on replay', async () => {
    const seenRunnerManagedRetry: Array<boolean | undefined> = [];
    let attempts = 0;

    const model: Model = {
      async getResponse(request: ModelRequest) {
        attempts += 1;
        seenRunnerManagedRetry.push(request._internal?.runnerManagedRetry);
        if (attempts === 1) {
          const error = new Error('Rate limited');
          (error as Error & { statusCode?: number }).statusCode = 429;
          throw error;
        }

        return {
          usage: new Usage({ requests: 1 }),
          output: [fakeModelMessage('Recovered')],
        };
      },
      async *getStreamedResponse() {
        yield* [];
      },
    };

    const agent = new Agent({
      name: 'ProviderRetryOwnershipAgent',
      model,
      modelSettings: {
        retry: {
          maxRetries: 1,
          backoff: { initialDelayMs: 0, jitter: false },
          policy: retryPolicies.httpStatus([429]),
        },
      },
    });

    const result = await run(agent, 'hello');

    expect(result.finalOutput).toBe('Recovered');
    expect(seenRunnerManagedRetry).toEqual([undefined, true]);
  });

  it('preserves provider-managed retries on the first stateful attempt', async () => {
    const seenRunnerManagedRetry: Array<boolean | undefined> = [];

    const model: Model = {
      async getResponse(request: ModelRequest) {
        seenRunnerManagedRetry.push(request._internal?.runnerManagedRetry);
        return {
          usage: new Usage({ requests: 1 }),
          output: [fakeModelMessage('ok')],
        };
      },
      async *getStreamedResponse() {
        yield* [];
      },
    };

    const result = await run(
      new Agent({
        name: 'StatefulProviderRetryOwnershipAgent',
        model,
        modelSettings: {
          retry: {
            maxRetries: 1,
            backoff: { initialDelayMs: 0, jitter: false },
            policy: retryPolicies.httpStatus([429]),
          },
        },
      }),
      'hello',
      {
        previousResponseId: 'resp-stateful',
      },
    );

    expect(result.finalOutput).toBe('ok');
    expect(seenRunnerManagedRetry).toEqual([undefined]);
  });

  it('does not retry without a retry policy even when maxRetries is configured', async () => {
    let attempts = 0;
    const model: Model = {
      async getResponse() {
        attempts += 1;
        const error = new Error('Rate limited');
        (error as Error & { statusCode?: number }).statusCode = 429;
        throw error;
      },
      async *getStreamedResponse() {
        yield* [];
      },
    };

    const agent = new Agent({
      name: 'NoPolicyAgent',
      model,
      modelSettings: {
        retry: {
          maxRetries: 2,
        },
      },
    });

    await expect(run(agent, 'hello')).rejects.toThrow('Rate limited');
    expect(attempts).toBe(1);
  });

  it('preserves provider-managed retry metadata on the first attempt when maxRetries is set without a policy', async () => {
    const seenRequests: ModelRequest[] = [];
    const model: Model = {
      async getResponse(request) {
        seenRequests.push(request);
        return {
          usage: new Usage({ requests: 1 }),
          output: [fakeModelMessage('ok')],
        };
      },
      async *getStreamedResponse() {
        yield* [];
      },
    };

    const result = await run(
      new Agent({
        name: 'DisableProviderRetriesNoPolicyAgent',
        model,
        modelSettings: {
          retry: {
            maxRetries: 2,
          },
        },
      }),
      'hello',
    );

    expect(result.finalOutput).toBe('ok');
    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0]?._internal?.runnerManagedRetry).toBeUndefined();
  });

  it('preserves provider-managed retry metadata on the first attempt when maxRetries is zero', async () => {
    const seenRequests: ModelRequest[] = [];
    const model: Model = {
      async getResponse(request) {
        seenRequests.push(request);
        return {
          usage: new Usage({ requests: 1 }),
          output: [fakeModelMessage('ok')],
        };
      },
      async *getStreamedResponse() {
        yield* [];
      },
    };

    const result = await run(
      new Agent({
        name: 'DisableProviderRetriesZeroMaxRetriesAgent',
        model,
        modelSettings: {
          retry: {
            maxRetries: 0,
            policy: retryPolicies.any(),
          },
        },
      }),
      'hello',
    );

    expect(result.finalOutput).toBe('ok');
    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0]?._internal?.runnerManagedRetry).toBeUndefined();
  });

  it('preserves per-request usage entries when a retried request succeeds', async () => {
    let attempts = 0;
    const model: Model = {
      async getResponse() {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error('Rate limited');
          (error as Error & { statusCode?: number }).statusCode = 429;
          throw error;
        }

        return {
          usage: new Usage({
            requests: 1,
            inputTokens: 11,
            outputTokens: 7,
            totalTokens: 18,
            requestUsageEntries: [
              new RequestUsage({
                inputTokens: 11,
                outputTokens: 7,
                totalTokens: 18,
                endpoint: 'responses.create',
              }),
            ],
          }),
          output: [fakeModelMessage('Recovered with usage entries')],
        };
      },
      async *getStreamedResponse() {
        yield* [];
      },
    };

    const result = await run(
      new Agent({
        name: 'RetryUsageEntriesAgent',
        model,
        modelSettings: {
          retry: {
            maxRetries: 1,
            backoff: { initialDelayMs: 0, jitter: false },
            policy: retryPolicies.httpStatus([429]),
          },
        },
      }),
      'hello',
    );

    expect(attempts).toBe(2);
    expect(result.state.usage.requests).toBe(2);
    expect(result.state.usage.requestUsageEntries).toEqual([
      {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        inputTokensDetails: {},
        outputTokensDetails: {},
        endpoint: 'responses.create',
      },
      {
        inputTokens: 11,
        outputTokens: 7,
        totalTokens: 18,
        inputTokensDetails: {},
        outputTokensDetails: {},
        endpoint: 'responses.create',
      },
    ]);
    expect(result.rawResponses[0]?.usage.requestUsageEntries).toEqual([
      {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        inputTokensDetails: {},
        outputTokensDetails: {},
        endpoint: 'responses.create',
      },
      {
        inputTokens: 11,
        outputTokens: 7,
        totalTokens: 18,
        inputTokensDetails: {},
        outputTokensDetails: {},
        endpoint: 'responses.create',
      },
    ]);
  });

  it('honors explicit retry decisions that set delayMs', async () => {
    let attempts = 0;
    const model: Model = {
      async getResponse() {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('Retry me');
        }
        return {
          usage: new Usage({ requests: 1 }),
          output: [fakeModelMessage('Recovered with explicit delay')],
        };
      },
      async *getStreamedResponse() {
        yield* [];
      },
    };
    const policy = vi.fn().mockResolvedValue({ retry: true, delayMs: 0 });

    const agent = new Agent({
      name: 'ExplicitDelayAgent',
      model,
      modelSettings: {
        retry: {
          maxRetries: 1,
          policy,
        },
      },
    });

    const result = await run(agent, 'hello');

    expect(result.finalOutput).toBe('Recovered with explicit delay');
    expect(attempts).toBe(2);
    expect(policy).toHaveBeenCalledTimes(1);
  });

  it('retries until maxRetries is exhausted, then throws the last error', async () => {
    let attempts = 0;
    const policy = vi.fn().mockReturnValue(true);
    const model: Model = {
      async getResponse() {
        attempts += 1;
        const error = new Error(`failure ${attempts}`);
        (error as Error & { statusCode?: number }).statusCode = 503;
        throw error;
      },
      async *getStreamedResponse() {
        yield* [];
      },
    };

    const agent = new Agent({
      name: 'ExhaustedRetriesAgent',
      model,
      modelSettings: {
        retry: {
          maxRetries: 2,
          backoff: { initialDelayMs: 0, jitter: false },
          policy,
        },
      },
    });

    await expect(run(agent, 'hello')).rejects.toThrow('failure 3');
    expect(attempts).toBe(3);
    expect(policy).toHaveBeenCalledTimes(2);
  });

  it('passes incrementing attempt numbers to the retry policy', async () => {
    let attempts = 0;
    const seenAttempts: number[] = [];
    const policy = vi.fn().mockImplementation(({ attempt }) => {
      seenAttempts.push(attempt);
      return true;
    });
    const model: Model = {
      async getResponse() {
        attempts += 1;
        if (attempts < 3) {
          throw new Error(`retry ${attempts}`);
        }
        return {
          usage: new Usage({ requests: 1 }),
          output: [fakeModelMessage('Recovered on third attempt')],
        };
      },
      async *getStreamedResponse() {
        yield* [];
      },
    };

    const agent = new Agent({
      name: 'AttemptTrackingAgent',
      model,
      modelSettings: {
        retry: {
          maxRetries: 2,
          backoff: { initialDelayMs: 0, jitter: false },
          policy,
        },
      },
    });

    const result = await run(agent, 'hello');

    expect(result.finalOutput).toBe('Recovered on third attempt');
    expect(attempts).toBe(3);
    expect(seenAttempts).toEqual([1, 2]);
  });

  it('prefers retry-after delays over backoff when a policy opts in without delayMs', async () => {
    vi.useFakeTimers();
    let attempts = 0;

    try {
      const model: Model = {
        async getResponse() {
          attempts += 1;
          if (attempts === 1) {
            const error = new Error('Rate limited');
            (
              error as Error & {
                statusCode?: number;
                responseHeaders?: Headers;
              }
            ).statusCode = 429;
            (error as Error & { responseHeaders?: Headers }).responseHeaders =
              new Headers([['retry-after-ms', '0']]);
            throw error;
          }

          return {
            usage: new Usage({ requests: 1 }),
            output: [fakeModelMessage('Recovered after retry-after')],
          };
        },
        async *getStreamedResponse() {
          yield* [];
        },
      };

      const agent = new Agent({
        name: 'RetryAfterPreferredAgent',
        model,
        modelSettings: {
          retry: {
            maxRetries: 1,
            backoff: { initialDelayMs: 10_000, jitter: false },
            policy: retryPolicies.httpStatus([429]),
          },
        },
      });

      const resultPromise = run(agent, 'hello');
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(result.finalOutput).toBe('Recovered after retry-after');
      expect(attempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('honors retry-after-ms zero without falling back to backoff delays', async () => {
    vi.useFakeTimers();
    let attempts = 0;

    try {
      const model: Model = {
        async getResponse() {
          attempts += 1;
          if (attempts === 1) {
            const error = new Error('retry immediately');
            (
              error as Error & {
                statusCode?: number;
                responseHeaders?: Headers;
              }
            ).statusCode = 429;
            (error as Error & { responseHeaders?: Headers }).responseHeaders =
              new Headers([['retry-after-ms', '0']]);
            throw error;
          }

          return {
            usage: new Usage({ requests: 1 }),
            output: [fakeModelMessage('Recovered immediately')],
          };
        },
        async *getStreamedResponse() {
          yield* [];
        },
      };

      const resultPromise = run(
        new Agent({
          name: 'RetryAfterZeroMsAgent',
          model,
          modelSettings: {
            retry: {
              maxRetries: 1,
              backoff: { initialDelayMs: 10_000, jitter: false },
              policy: retryPolicies.httpStatus([429]),
            },
          },
        }),
        'hello',
      );

      await vi.advanceTimersByTimeAsync(0);

      expect(attempts).toBe(2);
      await expect(resultPromise).resolves.toMatchObject({
        finalOutput: 'Recovered immediately',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses exponential backoff delays when no explicit delay or retry-after is provided', async () => {
    vi.useFakeTimers();
    let attempts = 0;

    try {
      const model: Model = {
        async getResponse() {
          attempts += 1;
          if (attempts < 3) {
            const error = new Error(`temporary failure ${attempts}`);
            (error as Error & { statusCode?: number }).statusCode = 503;
            throw error;
          }
          return {
            usage: new Usage({ requests: 1 }),
            output: [fakeModelMessage('Recovered after backoff')],
          };
        },
        async *getStreamedResponse() {
          yield* [];
        },
      };

      const resultPromise = run(
        new Agent({
          name: 'BackoffAgent',
          model,
          modelSettings: {
            retry: {
              maxRetries: 2,
              backoff: {
                initialDelayMs: 100,
                multiplier: 2,
                maxDelayMs: 150,
                jitter: false,
              },
              policy: retryPolicies.httpStatus([503]),
            },
          },
        }),
        'hello',
      );

      await vi.advanceTimersByTimeAsync(99);
      expect(attempts).toBe(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toBe(2);

      await vi.advanceTimersByTimeAsync(149);
      expect(attempts).toBe(2);

      await vi.advanceTimersByTimeAsync(1);
      const result = await resultPromise;

      expect(attempts).toBe(3);
      expect(result.finalOutput).toBe('Recovered after backoff');
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries from retry-after seconds headers exposed as plain objects', async () => {
    let attempts = 0;
    const model: Model = {
      async getResponse() {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error('retry after seconds header'), {
            responseHeaders: { 'retry-after': '0' },
          });
        }

        return {
          usage: new Usage({ requests: 1 }),
          output: [fakeModelMessage('Recovered from seconds header')],
        };
      },
      async *getStreamedResponse() {
        yield* [];
      },
    };

    const agent = new Agent({
      name: 'RetryAfterSecondsAgent',
      model,
      modelSettings: {
        retry: {
          maxRetries: 1,
          policy: retryPolicies.retryAfter(),
        },
      },
    });

    const result = await run(agent, 'hello');

    expect(result.finalOutput).toBe('Recovered from seconds header');
    expect(attempts).toBe(2);
  });

  it('preserves provider vetoes when providerSuggested() is composed with any()', async () => {
    let attempts = 0;
    const model: Model = {
      async getResponse() {
        attempts += 1;
        const error = new Error('Provider said no');
        (error as Error & { statusCode?: number }).statusCode = 429;
        throw error;
      },
      getRetryAdvice() {
        return {
          suggested: false,
          reason: 'provider veto',
        };
      },
      async *getStreamedResponse() {
        yield* [];
      },
    };

    const agent = new Agent({
      name: 'ProviderVetoAgent',
      model,
      modelSettings: {
        retry: {
          maxRetries: 1,
          policy: retryPolicies.any(
            retryPolicies.providerSuggested(),
            retryPolicies.networkError(),
            retryPolicies.httpStatus([429]),
          ),
        },
      },
    });

    await expect(run(agent, 'hello')).rejects.toThrow('Provider said no');
    expect(attempts).toBe(1);
  });

  it('preserves provider vetoes in any() even when an earlier policy opts in', async () => {
    const decision = await retryPolicies.any(
      retryPolicies.httpStatus([429]),
      retryPolicies.providerSuggested(),
    )({
      error: new Error('Rate limited'),
      attempt: 1,
      maxRetries: 1,
      stream: false,
      providerAdvice: {
        suggested: false,
        reason: 'provider veto',
      },
      normalized: {
        statusCode: 429,
        isAbort: false,
        isNetworkError: false,
      },
    });

    expect(decision).toEqual({ retry: false, reason: 'provider veto' });
  });

  it('preserves provider vetoes when all() is nested inside any()', async () => {
    const decision = await retryPolicies.any(
      retryPolicies.all(
        retryPolicies.providerSuggested(),
        retryPolicies.networkError(),
      ),
      retryPolicies.httpStatus([429]),
    )({
      error: new Error('Rate limited'),
      attempt: 1,
      maxRetries: 1,
      stream: false,
      providerAdvice: {
        suggested: false,
        reason: 'provider veto',
      },
      normalized: {
        statusCode: 429,
        isAbort: false,
        isNetworkError: true,
      },
    });

    expect(decision).toEqual({ retry: false, reason: 'provider veto' });
  });

  it('keeps evaluating any() after object-shaped negative decisions', async () => {
    const decision = await retryPolicies.any(
      () => ({ retry: false, reason: 'not this condition' }),
      retryPolicies.httpStatus([429]),
    )({
      error: new Error('Rate limited'),
      attempt: 1,
      maxRetries: 1,
      stream: false,
      normalized: {
        statusCode: 429,
        isAbort: false,
        isNetworkError: false,
      },
    });

    expect(decision).toEqual({ retry: true });
  });

  it('returns the last object-shaped negative decision from any() when no policy retries', async () => {
    const decision = await retryPolicies.any(
      () => ({ retry: false, reason: 'first diagnostic' }),
      retryPolicies.networkError(),
      () => ({ retry: false, reason: 'final diagnostic' }),
    )({
      error: new Error('Rate limited'),
      attempt: 1,
      maxRetries: 1,
      stream: false,
      normalized: {
        statusCode: 429,
        isAbort: false,
        isNetworkError: false,
      },
    });

    expect(decision).toEqual({ retry: false, reason: 'final diagnostic' });
  });

  it('retries when providerSuggested() opts in with a delay hint', async () => {
    vi.useFakeTimers();
    let attempts = 0;

    try {
      const model: Model = {
        async getResponse() {
          attempts += 1;
          if (attempts === 1) {
            const error = new Error('Provider suggested retry');
            (error as Error & { statusCode?: number }).statusCode = 429;
            throw error;
          }
          return {
            usage: new Usage({ requests: 1 }),
            output: [fakeModelMessage('Recovered from provider advice')],
          };
        },
        getRetryAdvice() {
          return {
            suggested: true,
            retryAfterMs: 50,
            reason: 'provider requested retry',
          };
        },
        async *getStreamedResponse() {
          yield* [];
        },
      };

      const resultPromise = run(
        new Agent({
          name: 'ProviderSuggestedAgent',
          model,
          modelSettings: {
            retry: {
              maxRetries: 1,
              policy: retryPolicies.providerSuggested(),
            },
          },
        }),
        'hello',
      );

      await vi.advanceTimersByTimeAsync(49);
      expect(attempts).toBe(1);

      await vi.advanceTimersByTimeAsync(1);
      const result = await resultPromise;

      expect(attempts).toBe(2);
      expect(result.finalOutput).toBe('Recovered from provider advice');
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats retryPolicies.all() with no predicates as opt-out', async () => {
    const decision = await retryPolicies.all()({
      error: new Error('boom'),
      attempt: 1,
      maxRetries: 2,
      stream: false,
      normalized: {
        isAbort: false,
        isNetworkError: false,
      },
    });

    expect(decision).toBe(false);
  });

  it('does not retry aborted requests even when the policy returns true', async () => {
    let attempts = 0;
    const abortError = new Error('The operation was aborted.');
    abortError.name = 'AbortError';

    const model: Model = {
      async getResponse(request: ModelRequest) {
        attempts += 1;
        expect(request.signal?.aborted).toBe(true);
        throw abortError;
      },
      async *getStreamedResponse() {
        yield* [];
      },
    };

    const controller = new AbortController();
    controller.abort();

    const agent = new Agent({
      name: 'AbortedAgent',
      model,
      modelSettings: {
        retry: {
          maxRetries: 2,
          policy: () => true,
        },
      },
    });

    await expect(
      new Runner().run(agent, 'hello', {
        signal: controller.signal,
      }),
    ).rejects.toThrow('The operation was aborted.');
    expect(attempts).toBe(1);
  });

  it('stops retrying when the signal aborts during retry delay', async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const controller = new AbortController();
    const policy = vi.fn().mockResolvedValue({ retry: true, delayMs: 100 });

    try {
      const model: Model = {
        async getResponse() {
          attempts += 1;
          throw new Error('retry me until aborted');
        },
        async *getStreamedResponse() {
          yield* [];
        },
      };

      const resultPromise = new Runner().run(
        new Agent({
          name: 'AbortDuringDelayAgent',
          model,
          modelSettings: {
            retry: {
              maxRetries: 2,
              policy,
            },
          },
        }),
        'hello',
        { signal: controller.signal },
      );

      await vi.advanceTimersByTimeAsync(50);
      controller.abort();

      await expect(resultPromise).rejects.toMatchObject({
        name: 'AbortError',
      });
      expect(attempts).toBe(1);
      expect(policy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats websocket transport error codes as network errors', async () => {
    let attempts = 0;
    const model: Model = {
      async getResponse() {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error('socket not open');
          (error as Error & { code?: string }).code = 'socket_not_open';
          throw error;
        }

        return {
          usage: new Usage({ requests: 1 }),
          output: [
            fakeModelMessage('Recovered from websocket transport error'),
          ],
        };
      },
      async *getStreamedResponse() {
        yield* [];
      },
    };

    const agent = new Agent({
      name: 'WebSocketTransportRetryAgent',
      model,
      modelSettings: {
        retry: {
          maxRetries: 1,
          backoff: { initialDelayMs: 0, jitter: false },
          policy: retryPolicies.networkError(),
        },
      },
    });

    const result = await run(agent, 'hello');

    expect(result.finalOutput).toBe('Recovered from websocket transport error');
    expect(attempts).toBe(2);
  });

  it('retries streaming requests when the stream fails before any visible event', async () => {
    let attempts = 0;
    const model: Model = {
      async getResponse() {
        throw new Error('not used');
      },
      async *getStreamedResponse(): AsyncIterable<StreamEvent> {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error('temporary stream failure');
          (error as Error & { statusCode?: number }).statusCode = 503;
          throw error;
        }

        yield { type: 'response_started' };
        yield createDoneEvent('Stream recovered');
      },
    };

    const agent = new Agent({
      name: 'StreamingRetryAgent',
      model,
      modelSettings: {
        retry: {
          maxRetries: 1,
          backoff: { initialDelayMs: 0, jitter: false },
          policy: retryPolicies.httpStatus([503]),
        },
      },
    });

    const result = await run(agent, 'hello', { stream: true });
    for await (const _event of result) {
      // Consume the stream to completion.
    }

    expect(result.finalOutput).toBe('Stream recovered');
    expect(attempts).toBe(2);
    expect(result.state.usage.requests).toBe(2);
    expect(result.rawResponses[0]?.usage.requests).toBe(2);
  });

  it('does not retry streaming requests after raw model events are emitted', async () => {
    let attempts = 0;
    const seenEvents: RunStreamEvent[] = [];
    const model: Model = {
      async getResponse() {
        throw new Error('not used');
      },
      async *getStreamedResponse(): AsyncIterable<StreamEvent> {
        attempts += 1;
        if (attempts === 1) {
          yield {
            type: 'model',
            event: { type: 'provider.debug', detail: 'pre-output' } as any,
          };
          const error = new Error('temporary stream failure');
          (error as Error & { statusCode?: number }).statusCode = 503;
          throw error;
        }
      },
    };

    const agent = new Agent({
      name: 'StreamingRetryAfterModelEventAgent',
      model,
      modelSettings: {
        retry: {
          maxRetries: 1,
          backoff: { initialDelayMs: 0, jitter: false },
          policy: retryPolicies.httpStatus([503]),
        },
      },
    });

    const result = await run(agent, 'hello', { stream: true });
    const consume = async () => {
      for await (const event of result) {
        seenEvents.push(event);
      }
    };

    await expect(consume()).rejects.toThrow('temporary stream failure');
    expect(attempts).toBe(1);
    expect(seenEvents).toHaveLength(1);
    expect(seenEvents[0]).toMatchObject({
      type: 'raw_model_stream_event',
      data: {
        type: 'model',
        event: { type: 'provider.debug', detail: 'pre-output' },
      },
    });
  });

  it('does not retry streaming requests after a visible event was emitted', async () => {
    let attempts = 0;
    const model: Model = {
      async getResponse() {
        throw new Error('not used');
      },
      async *getStreamedResponse(): AsyncIterable<StreamEvent> {
        attempts += 1;
        yield { type: 'response_started' };
        const error = new Error('stream broke after start');
        (error as Error & { statusCode?: number }).statusCode = 503;
        throw error;
      },
    };

    const agent = new Agent({
      name: 'VisibleEventAgent',
      model,
      modelSettings: {
        retry: {
          maxRetries: 1,
          backoff: { initialDelayMs: 0, jitter: false },
          policy: retryPolicies.httpStatus([503]),
        },
      },
    });

    const result = await run(agent, 'hello', { stream: true });
    const consume = async () => {
      for await (const _event of result) {
        // Consume until the stream throws.
      }
    };

    await expect(consume()).rejects.toThrow('stream broke after start');
    expect(attempts).toBe(1);
  });

  it('does not retry streaming requests after a text delta was emitted', async () => {
    let attempts = 0;
    const model: Model = {
      async getResponse() {
        throw new Error('not used');
      },
      async *getStreamedResponse(): AsyncIterable<StreamEvent> {
        attempts += 1;
        yield { type: 'response_started' };
        yield {
          type: 'output_text_delta',
          delta: 'hel',
        };
        const error = new Error('stream broke after delta');
        (error as Error & { statusCode?: number }).statusCode = 503;
        throw error;
      },
    };

    const result = await run(
      new Agent({
        name: 'VisibleDeltaAgent',
        model,
        modelSettings: {
          retry: {
            maxRetries: 1,
            backoff: { initialDelayMs: 0, jitter: false },
            policy: retryPolicies.httpStatus([503]),
          },
        },
      }),
      'hello',
      { stream: true },
    );

    const consume = async () => {
      for await (const _event of result) {
        // Consume until the stream throws.
      }
    };

    await expect(consume()).rejects.toThrow('stream broke after delta');
    expect(attempts).toBe(1);
  });

  it('does not retry non-streaming requests when provider advice marks replay as unsafe', async () => {
    let attempts = 0;
    const model: Model = {
      async getResponse() {
        attempts += 1;
        const error = new Error('request may have been accepted');
        (error as Error & { statusCode?: number }).statusCode = 503;
        throw error;
      },
      async *getStreamedResponse() {
        yield* [];
      },
      getRetryAdvice() {
        return {
          suggested: false,
          replaySafety: 'unsafe',
          reason: 'request may have been accepted',
        };
      },
    };

    const agent = new Agent({
      name: 'UnsafeReplayAgent',
      model,
      modelSettings: {
        retry: {
          maxRetries: 1,
          backoff: { initialDelayMs: 0, jitter: false },
          policy: () => true,
        },
      },
    });

    await expect(run(agent, 'hello')).rejects.toThrow(
      'request may have been accepted',
    );
    expect(attempts).toBe(1);
  });

  it('retries stateful follow-up requests when providerSuggested() approves replay', async () => {
    let attempts = 0;
    const model: Model = {
      async getResponse() {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error('connection closed before opening');
          (error as Error & { statusCode?: number }).statusCode = 503;
          throw error;
        }

        return {
          usage: new Usage({ requests: 1 }),
          output: [
            fakeModelMessage('Recovered after provider-approved replay'),
          ],
        };
      },
      async *getStreamedResponse() {
        yield* [];
      },
      getRetryAdvice() {
        return {
          suggested: true,
          replaySafety: 'safe',
          reason: 'request never left the client',
        };
      },
    };

    const agent = new Agent({
      name: 'ProviderApprovedStatefulRetryAgent',
      model,
      modelSettings: {
        retry: {
          maxRetries: 1,
          backoff: { initialDelayMs: 0, jitter: false },
          policy: retryPolicies.any(
            retryPolicies.httpStatus([503]),
            retryPolicies.providerSuggested(),
          ),
        },
      },
    });

    const result = await run(agent, 'hello', {
      previousResponseId: 'resp-safe-retry',
    });

    expect(result.finalOutput).toBe('Recovered after provider-approved replay');
    expect(attempts).toBe(2);
  });

  it('retries stateful follow-up requests when all() includes providerSuggested()', async () => {
    let attempts = 0;
    const model: Model = {
      async getResponse() {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error('connection closed before opening');
          (error as Error & { statusCode?: number }).statusCode = 429;
          throw error;
        }

        return {
          usage: new Usage({ requests: 1 }),
          output: [fakeModelMessage('Recovered after all() replay approval')],
        };
      },
      async *getStreamedResponse() {
        yield* [];
      },
      getRetryAdvice() {
        return {
          suggested: true,
          replaySafety: 'safe',
          reason: 'request never left the client',
        };
      },
    };

    const agent = new Agent({
      name: 'ProviderApprovedStatefulAllRetryAgent',
      model,
      modelSettings: {
        retry: {
          maxRetries: 1,
          backoff: { initialDelayMs: 0, jitter: false },
          policy: retryPolicies.all(
            retryPolicies.providerSuggested(),
            retryPolicies.httpStatus([429]),
          ),
        },
      },
    });

    const result = await run(agent, 'hello', {
      previousResponseId: 'resp-safe-retry-all',
    });

    expect(result.finalOutput).toBe('Recovered after all() replay approval');
    expect(attempts).toBe(2);
  });

  it('does not retry stateful follow-up requests from non-provider policies alone', async () => {
    let attempts = 0;
    const model: Model = {
      async getResponse() {
        attempts += 1;
        const error = new Error('temporary stateful failure');
        (error as Error & { statusCode?: number }).statusCode = 503;
        throw error;
      },
      async *getStreamedResponse() {
        yield* [];
      },
      getRetryAdvice() {
        return {
          suggested: true,
          reason: 'provider would allow retry',
        };
      },
    };

    const agent = new Agent({
      name: 'StatefulNonProviderPolicyAgent',
      model,
      modelSettings: {
        retry: {
          maxRetries: 1,
          backoff: { initialDelayMs: 0, jitter: false },
          policy: retryPolicies.httpStatus([503]),
        },
      },
    });

    await expect(
      run(agent, 'hello', {
        previousResponseId: 'resp-no-provider-policy',
      }),
    ).rejects.toThrow('temporary stateful failure');
    expect(attempts).toBe(1);
  });

  it('deep merges inherited agent tool retry settings', () => {
    const policy = () => true;
    const merged = mergeAgentToolRunConfig(
      {
        modelSettings: {
          retry: {
            maxRetries: 3,
            policy,
            backoff: {
              initialDelayMs: 100,
            },
          },
        },
      },
      {
        modelSettings: {
          retry: {
            maxRetries: 0,
            backoff: {
              maxDelayMs: 500,
            },
          },
        },
      },
    );

    expect(merged.modelSettings?.retry).toEqual({
      maxRetries: 0,
      policy,
      backoff: {
        initialDelayMs: 100,
        maxDelayMs: 500,
      },
    });
  });

  it('inherits retry policy into Agent.asTool when only backoff is overridden', () => {
    const policy = () => true;
    const merged = mergeAgentToolRunConfig(
      {
        modelSettings: {
          retry: {
            maxRetries: 3,
            policy,
            backoff: {
              initialDelayMs: 100,
            },
          },
        },
      },
      {
        modelSettings: {
          retry: {
            backoff: {
              maxDelayMs: 500,
            },
          },
        },
      },
    );

    expect(merged.modelSettings?.retry).toEqual({
      maxRetries: 3,
      policy,
      backoff: {
        initialDelayMs: 100,
        maxDelayMs: 500,
      },
    });
  });

  it('deep merges retry settings between runner and agent configs', async () => {
    const policy = () => true;
    let capturedRetrySettings:
      | ModelRequest['modelSettings']['retry']
      | undefined;

    const model: Model = {
      async getResponse(request: ModelRequest) {
        capturedRetrySettings = request.modelSettings.retry;
        return {
          usage: new Usage({ requests: 1 }),
          output: [fakeModelMessage('Merged retry settings')],
        };
      },
      async *getStreamedResponse() {
        yield* [];
      },
    };

    const runner = new Runner({
      modelSettings: {
        retry: {
          maxRetries: 3,
          policy,
          backoff: {
            initialDelayMs: 100,
          },
        },
      },
    });
    const agent = new Agent({
      name: 'MergedRunnerRetryAgent',
      model,
      modelSettings: {
        retry: {
          maxRetries: 0,
          backoff: {
            maxDelayMs: 500,
          },
        },
      },
    });

    const result = await runner.run(agent, 'hello');

    expect(result.finalOutput).toBe('Merged retry settings');
    expect(capturedRetrySettings).toEqual({
      maxRetries: 0,
      policy,
      backoff: {
        initialDelayMs: 100,
        maxDelayMs: 500,
      },
    });
  });

  it('inherits runner retry policy when an agent overrides only backoff', async () => {
    const policy = () => true;
    let capturedRetrySettings:
      | ModelRequest['modelSettings']['retry']
      | undefined;

    const model: Model = {
      async getResponse(request: ModelRequest) {
        capturedRetrySettings = request.modelSettings.retry;
        return {
          usage: new Usage({ requests: 1 }),
          output: [fakeModelMessage('Merged retry settings')],
        };
      },
      async *getStreamedResponse() {
        yield* [];
      },
    };

    const runner = new Runner({
      modelSettings: {
        retry: {
          maxRetries: 3,
          policy,
          backoff: {
            initialDelayMs: 100,
          },
        },
      },
    });
    const agent = new Agent({
      name: 'MergedRunnerRetryAgentBackoffOnly',
      model,
      modelSettings: {
        retry: {
          backoff: {
            maxDelayMs: 500,
          },
        },
      },
    });

    const result = await runner.run(agent, 'hello');

    expect(result.finalOutput).toBe('Merged retry settings');
    expect(capturedRetrySettings).toEqual({
      maxRetries: 3,
      policy,
      backoff: {
        initialDelayMs: 100,
        maxDelayMs: 500,
      },
    });
  });

  it('retries when responseHeaders is a Headers instance', async () => {
    let attempts = 0;
    const model: Model = {
      async getResponse() {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error('retry after header'), {
            responseHeaders: new Headers([['retry-after-ms', '0']]),
          });
        }

        return {
          usage: new Usage({ requests: 1 }),
          output: [fakeModelMessage('Recovered from headers')],
        };
      },
      async *getStreamedResponse() {
        yield* [];
      },
    };

    const agent = new Agent({
      name: 'RetryAfterHeadersAgent',
      model,
      modelSettings: {
        retry: {
          maxRetries: 1,
          policy: retryPolicies.retryAfter(),
        },
      },
    });

    const result = await run(agent, 'hello');

    expect(result.finalOutput).toBe('Recovered from headers');
    expect(attempts).toBe(2);
  });
});
