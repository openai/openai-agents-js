import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  Agent,
  InputGuardrailTripwireTriggered,
  MemorySession,
  ModelTimeoutError,
  retryPolicies,
  run,
  Runner,
  RunStreamEvent,
  setDefaultModelProvider,
  setTracingDisabled,
} from '../src';
import { mergeAgentToolRunConfig } from '../src/agentToolRunConfig';
import type {
  Model,
  ModelRequest,
  RetryPolicy,
  RetryPolicyContext,
} from '../src/model';
import type { StreamEvent } from '../src/types/protocol';
import { RequestUsage, Usage } from '../src/usage';
import {
  getResponseWithRetry,
  getStreamedResponseWithRetry,
} from '../src/runner/modelRetry';
import {
  attachModelFailureUsage,
  consumeModelFailureUsage,
  reportModelFailureUsage,
} from '../src/runner/usageTracking';
import {
  ScriptedModel,
  modelError,
  modelResponder,
  modelResponse,
  modelStream,
  modelStreamResponder,
} from '../src/testing';
import { fakeModelMessage, ScriptedModelProvider } from './stubs';

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

function errorWith<T extends Record<string, unknown>>(
  message: string,
  properties: T,
): Error & T {
  return Object.assign(new Error(message), properties);
}

function textResponse(text: string, usage = new Usage({ requests: 1 })) {
  return modelResponse({ usage, output: [fakeModelMessage(text)] });
}

function responseUsage(inputTokens: number, outputTokens: number): Usage {
  return new Usage({
    requests: 1,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    requestUsageEntries: [
      new RequestUsage({
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        endpoint: 'responses.create',
      }),
    ],
  });
}

async function consumeRetryStream(model: Model, request: ModelRequest) {
  for await (const _event of getStreamedResponseWithRetry(model, request)) {
    // Consume the stream through its final success or error boundary.
  }
}

beforeAll(() => {
  setTracingDisabled(true);
  setDefaultModelProvider(new ScriptedModelProvider());
});

describe('retry policies', () => {
  it('retries non-streaming requests only when the user policy opts in', async () => {
    const model = new ScriptedModel([
      modelError(errorWith('Rate limited', { statusCode: 429 })),
      textResponse('Recovered'),
    ]);

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
    expect(model.calls).toHaveLength(2);
    expect(result.state.usage.requests).toBe(2);
    expect(result.rawResponses[0]?.usage.requests).toBe(2);
  });

  it('preserves provider-managed retries on the first runner attempt and disables them on replay', async () => {
    const seenRunnerManagedRetry: Array<boolean | undefined> = [];
    const model = new ScriptedModel([
      modelResponder((call) => {
        seenRunnerManagedRetry.push(call.request._internal?.runnerManagedRetry);
        throw errorWith('Rate limited', { statusCode: 429 });
      }),
      modelResponder((call) => {
        seenRunnerManagedRetry.push(call.request._internal?.runnerManagedRetry);
        return {
          usage: new Usage({ requests: 1 }),
          output: [fakeModelMessage('Recovered')],
        };
      }),
    ]);

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

    const model = new ScriptedModel([
      modelResponder((call) => {
        seenRunnerManagedRetry.push(call.request._internal?.runnerManagedRetry);
        return {
          usage: new Usage({ requests: 1 }),
          output: [fakeModelMessage('ok')],
        };
      }),
    ]);

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
    const model = new ScriptedModel([
      modelError(errorWith('Rate limited', { statusCode: 429 })),
    ]);

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
    expect(model.calls).toHaveLength(1);
  });

  it('preserves provider-managed retry metadata on the first attempt when maxRetries is set without a policy', async () => {
    const seenRequests: ModelRequest[] = [];
    const model = new ScriptedModel([
      modelResponder((call) => {
        seenRequests.push(call.request as ModelRequest);
        return {
          usage: new Usage({ requests: 1 }),
          output: [fakeModelMessage('ok')],
        };
      }),
    ]);

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
    const model = new ScriptedModel([
      modelResponder((call) => {
        seenRequests.push(call.request as ModelRequest);
        return {
          usage: new Usage({ requests: 1 }),
          output: [fakeModelMessage('ok')],
        };
      }),
    ]);

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
    const model = new ScriptedModel([
      modelError(errorWith('Rate limited', { statusCode: 429 })),
      modelResponse({
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
      }),
    ]);

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

    expect(model.calls).toHaveLength(2);
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
    const model = new ScriptedModel([
      modelError(new Error('Retry me')),
      textResponse('Recovered with explicit delay'),
    ]);
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
    expect(model.calls).toHaveLength(2);
    expect(policy).toHaveBeenCalledTimes(1);
  });

  it('retries until maxRetries is exhausted, then throws the last error', async () => {
    const policy = vi.fn().mockReturnValue(true);
    const model = new ScriptedModel([
      modelError(errorWith('failure 1', { statusCode: 503 })),
      modelError(errorWith('failure 2', { statusCode: 503 })),
      modelError(errorWith('failure 3', { statusCode: 503 })),
    ]);

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
    expect(model.calls).toHaveLength(3);
    expect(policy).toHaveBeenCalledTimes(2);
  });

  it('passes incrementing attempt numbers to the retry policy', async () => {
    const seenAttempts: number[] = [];
    const policy = vi.fn().mockImplementation(({ attempt }) => {
      seenAttempts.push(attempt);
      return true;
    });
    const model = new ScriptedModel([
      modelError(new Error('retry 1')),
      modelError(new Error('retry 2')),
      textResponse('Recovered on third attempt'),
    ]);

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
    expect(model.calls).toHaveLength(3);
    expect(seenAttempts).toEqual([1, 2]);
  });

  it('prefers retry-after delays over backoff when a policy opts in without delayMs', async () => {
    vi.useFakeTimers();
    try {
      const model = new ScriptedModel([
        modelError(
          errorWith('Rate limited', {
            statusCode: 429,
            responseHeaders: new Headers([['retry-after-ms', '0']]),
          }),
        ),
        textResponse('Recovered after retry-after'),
      ]);

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
      expect(model.calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('honors retry-after-ms zero without falling back to backoff delays', async () => {
    vi.useFakeTimers();
    try {
      const model = new ScriptedModel([
        modelError(
          errorWith('retry immediately', {
            statusCode: 429,
            responseHeaders: new Headers([['retry-after-ms', '0']]),
          }),
        ),
        textResponse('Recovered immediately'),
      ]);

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

      expect(model.calls).toHaveLength(2);
      await expect(resultPromise).resolves.toMatchObject({
        finalOutput: 'Recovered immediately',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses exponential backoff delays when no explicit delay or retry-after is provided', async () => {
    vi.useFakeTimers();
    try {
      const model = new ScriptedModel([
        modelError(errorWith('temporary failure 1', { statusCode: 503 })),
        modelError(errorWith('temporary failure 2', { statusCode: 503 })),
        textResponse('Recovered after backoff'),
      ]);

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
      expect(model.calls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(model.calls).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(149);
      expect(model.calls).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(1);
      const result = await resultPromise;

      expect(model.calls).toHaveLength(3);
      expect(result.finalOutput).toBe('Recovered after backoff');
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries from retry-after seconds headers exposed as plain objects', async () => {
    const model = new ScriptedModel([
      modelError(
        errorWith('retry after seconds header', {
          responseHeaders: { 'retry-after': '0' },
        }),
      ),
      textResponse('Recovered from seconds header'),
    ]);

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
    expect(model.calls).toHaveLength(2);
  });

  it('preserves provider vetoes when providerSuggested() is composed with any()', async () => {
    const model = new ScriptedModel([
      modelError(errorWith('Provider said no', { statusCode: 429 }), {
        suggested: false,
        reason: 'provider veto',
      }),
    ]);

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
    expect(model.calls).toHaveLength(1);
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
    try {
      const model = new ScriptedModel([
        modelError(errorWith('Provider suggested retry', { statusCode: 429 }), {
          suggested: true,
          retryAfterMs: 50,
          reason: 'provider requested retry',
        }),
        textResponse('Recovered from provider advice'),
      ]);

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
      expect(model.calls).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1);
      const result = await resultPromise;

      expect(model.calls).toHaveLength(2);
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
    const controller = new AbortController();
    const policy = vi.fn().mockResolvedValue({ retry: true, delayMs: 100 });

    try {
      const model = new ScriptedModel([
        modelError(new Error('retry me until aborted')),
      ]);

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
      expect(model.calls).toHaveLength(1);
      expect(policy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats websocket transport error codes as network errors', async () => {
    const model = new ScriptedModel([
      modelError(errorWith('socket not open', { code: 'socket_not_open' })),
      textResponse('Recovered from websocket transport error'),
    ]);

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
    expect(model.calls).toHaveLength(2);
  });

  it('retries streaming requests when the stream fails before any visible event', async () => {
    const model = new ScriptedModel([
      modelError(errorWith('temporary stream failure', { statusCode: 503 })),
      modelStream([
        { type: 'response_started' },
        createDoneEvent('Stream recovered'),
      ]),
    ]);

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
    expect(model.calls).toHaveLength(2);
    expect(result.state.usage.requests).toBe(2);
    expect(result.rawResponses[0]?.usage.requests).toBe(2);
  });

  it('does not retry streaming requests after raw model events are emitted', async () => {
    const seenEvents: RunStreamEvent[] = [];
    const model = new ScriptedModel([
      modelStreamResponder(() =>
        (async function* () {
          yield {
            type: 'model',
            event: { type: 'provider.debug', detail: 'pre-output' } as any,
          };
          throw errorWith('temporary stream failure', { statusCode: 503 });
        })(),
      ),
    ]);

    const agent = new Agent({
      name: 'StreamingRetryAfterModelEventAgent',
      model,
      modelSettings: {
        retry: {
          maxRetries: 1,
          backoff: { initialDelayMs: 0, jitter: false },
          policy: () => ({ retry: true, approveUnsafeReplay: true }),
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
    expect(model.calls).toHaveLength(1);
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
    const model = new ScriptedModel([
      modelStreamResponder(() =>
        (async function* () {
          yield { type: 'response_started' } satisfies StreamEvent;
          throw errorWith('stream broke after start', { statusCode: 503 });
        })(),
      ),
    ]);

    const agent = new Agent({
      name: 'VisibleEventAgent',
      model,
      modelSettings: {
        retry: {
          maxRetries: 1,
          backoff: { initialDelayMs: 0, jitter: false },
          policy: () => ({ retry: true, approveUnsafeReplay: true }),
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
    expect(model.calls).toHaveLength(1);
  });

  it('does not retry streaming requests after a text delta was emitted', async () => {
    const model = new ScriptedModel([
      modelStreamResponder(() =>
        (async function* () {
          yield { type: 'response_started' } satisfies StreamEvent;
          yield {
            type: 'output_text_delta',
            delta: 'hel',
          } satisfies StreamEvent;
          throw errorWith('stream broke after delta', { statusCode: 503 });
        })(),
      ),
    ]);

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
    expect(model.calls).toHaveLength(1);
  });

  it('does not retry non-streaming requests when provider advice marks replay as unsafe', async () => {
    const model = new ScriptedModel([
      modelError(
        errorWith('request may have been accepted', { statusCode: 503 }),
        {
          suggested: false,
          replaySafety: 'unsafe',
          reason: 'request may have been accepted',
        },
      ),
    ]);

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
    expect(model.calls).toHaveLength(1);
  });

  it('retries a non-streaming unsafe replay only with explicit application approval', async () => {
    const seenContexts: Array<{
      replaySafety?: string;
      responseStarted?: boolean;
      statefulRequest?: boolean;
    }> = [];
    const firstError = new Error('request may have been accepted');
    attachModelFailureUsage(firstError, responseUsage(3, 4));
    const model = new ScriptedModel([
      modelError(firstError, {
        suggested: false,
        replaySafety: 'unsafe',
        responseStarted: true,
        reason: 'request may have been accepted',
      }),
      textResponse('Explicitly approved replay', responseUsage(1, 1)),
    ]);

    const result = await run(
      new Agent({
        name: 'ExplicitUnsafeReplayAgent',
        model,
        modelSettings: {
          retry: {
            maxRetries: 1,
            backoff: { initialDelayMs: 0, jitter: false },
            policy: (context) => {
              seenContexts.push(context);
              return {
                retry: true,
                approveUnsafeReplay: true,
                reason: 'read-only model turn',
              };
            },
          },
        },
      }),
      'hello',
    );

    expect(result.finalOutput).toBe('Explicitly approved replay');
    expect(model.calls).toHaveLength(2);
    expect(seenContexts).toHaveLength(1);
    expect(seenContexts[0]).toMatchObject({
      replaySafety: 'unsafe',
      responseStarted: true,
      statefulRequest: false,
    });
    expect(result.state.usage).toMatchObject({
      requests: 2,
      inputTokens: 4,
      outputTokens: 5,
      totalTokens: 9,
    });
    expect(result.state.usage.requestUsageEntries).toEqual([
      expect.objectContaining({
        inputTokens: 3,
        outputTokens: 4,
        endpoint: 'responses.create',
      }),
      expect.objectContaining({
        inputTokens: 1,
        outputTokens: 1,
        endpoint: 'responses.create',
      }),
    ]);
    expect(result.rawResponses[0]?.usage).toMatchObject({
      requests: 1,
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
    });
  });

  it('preserves known usage when an approved replay also fails', async () => {
    const firstError = new Error('first terminal failure');
    const finalError = new Error('final terminal failure');
    attachModelFailureUsage(firstError, responseUsage(2, 3));
    attachModelFailureUsage(finalError, responseUsage(5, 7));
    const unsafeReplayAdvice = {
      suggested: false,
      replaySafety: 'unsafe' as const,
      responseStarted: true,
    };
    const model = new ScriptedModel([
      modelError(firstError, unsafeReplayAdvice),
      modelError(finalError, unsafeReplayAdvice),
    ]);

    const error = await getResponseWithRetry(model, {
      modelSettings: {
        retry: {
          maxRetries: 1,
          backoff: { initialDelayMs: 0, jitter: false },
          policy: () => ({ retry: true, approveUnsafeReplay: true }),
        },
      },
    } as unknown as ModelRequest).catch((caughtError: unknown) => caughtError);

    expect(error).toBe(finalError);
    expect(consumeModelFailureUsage(error)).toMatchObject({
      requests: 2,
      inputTokens: 7,
      outputTokens: 10,
      totalTokens: 17,
      requestUsageEntries: [
        expect.objectContaining({ inputTokens: 2, outputTokens: 3 }),
        expect.objectContaining({ inputTokens: 5, outputTokens: 7 }),
      ],
    });
    expect(consumeModelFailureUsage(error)).toBeUndefined();
  });

  it('moves known terminal usage to a retry policy error', async () => {
    const terminalError = new Error('terminal failure');
    const policyError = Object.freeze(new Error('retry policy failed'));
    attachModelFailureUsage(terminalError, responseUsage(8, 13));
    const model = new ScriptedModel([
      modelError(terminalError, {
        suggested: false,
        replaySafety: 'unsafe',
        responseStarted: true,
      }),
    ]);

    const error = await getResponseWithRetry(model, {
      modelSettings: {
        retry: {
          maxRetries: 1,
          policy: () => {
            throw policyError;
          },
        },
      },
    } as unknown as ModelRequest).catch((caughtError: unknown) => caughtError);

    expect(error).toBe(policyError);
    expect(consumeModelFailureUsage(error)).toMatchObject({
      requests: 1,
      inputTokens: 8,
      outputTokens: 13,
      totalTokens: 21,
    });
  });

  it('moves known terminal usage to a frozen retry advice error', async () => {
    const terminalError = new Error('terminal failure');
    const adviceError = Object.freeze(new Error('retry advice failed'));
    attachModelFailureUsage(terminalError, responseUsage(3, 5));
    const model = new ScriptedModel([
      modelError(terminalError, () => {
        throw adviceError;
      }),
    ]);

    const error = await getResponseWithRetry(model, {
      modelSettings: { retry: { maxRetries: 1 } },
    } as unknown as ModelRequest).catch((caughtError: unknown) => caughtError);

    expect(error).toBe(adviceError);
    expect(consumeModelFailureUsage(error)).toMatchObject({
      requests: 1,
      inputTokens: 3,
      outputTokens: 5,
      totalTokens: 8,
    });
  });

  it('moves known terminal usage to a frozen retry delay cancellation', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const terminalError = new Error('terminal failure');
    const cancellationError = Object.freeze(new Error('retry cancelled'));
    attachModelFailureUsage(terminalError, responseUsage(5, 8));
    const model = new ScriptedModel([
      modelError(terminalError, {
        suggested: false,
        replaySafety: 'unsafe',
        responseStarted: true,
      }),
    ]);

    try {
      const resultPromise = getResponseWithRetry(model, {
        signal: controller.signal,
        modelSettings: {
          retry: {
            maxRetries: 1,
            policy: () => ({
              retry: true,
              approveUnsafeReplay: true,
              delayMs: 100,
            }),
          },
        },
      } as unknown as ModelRequest);

      await vi.advanceTimersByTimeAsync(50);
      controller.abort(cancellationError);
      const error = await resultPromise.catch(
        (caughtError: unknown) => caughtError,
      );

      expect(error).toBe(cancellationError);
      expect(consumeModelFailureUsage(error)).toMatchObject({
        requests: 1,
        inputTokens: 5,
        outputTokens: 8,
        totalTokens: 13,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves known usage when a safe streaming retry succeeds', async () => {
    const terminalError = new Error('retryable provider failure');
    attachModelFailureUsage(terminalError, responseUsage(3, 4));
    const model = new ScriptedModel([
      modelError(terminalError, { suggested: true, replaySafety: 'safe' }),
      textResponse('Recovered', responseUsage(1, 1)),
    ]);
    const result = await run(
      new Agent({
        name: 'StreamingUsageRetryAgent',
        model,
        modelSettings: {
          retry: {
            maxRetries: 1,
            backoff: { initialDelayMs: 0, jitter: false },
            policy: retryPolicies.providerSuggested(),
          },
        },
      }),
      'hello',
      { stream: true },
    );

    await result.completed;
    expect(result.state.usage).toMatchObject({
      requests: 2,
      inputTokens: 4,
      outputTokens: 5,
      totalTokens: 9,
    });
    expect(result.state.usage.requestUsageEntries).toHaveLength(2);
    expect(consumeModelFailureUsage(terminalError)).toBeUndefined();
  });

  it.each([false, true])(
    'retains failed usage when a guardrail rejects after retry success (stream=%s)',
    async (stream) => {
      let releaseGuardrail!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseGuardrail = resolve;
      });
      const firstError = new Error('retryable provider failure');
      attachModelFailureUsage(firstError, responseUsage(3, 4));
      const finishRetry = async () => {
        releaseGuardrail();
        await new Promise<void>((resolve) => setImmediate(resolve));
        return {
          usage: responseUsage(1, 1),
          output: [fakeModelMessage('Blocked retry output')],
        };
      };
      const model = new ScriptedModel([
        modelError(firstError, { suggested: true, replaySafety: 'safe' }),
        stream
          ? modelStreamResponder(() =>
              (async function* () {
                const response = await finishRetry();
                yield {
                  type: 'response_done',
                  response: { id: 'blocked_retry', ...response },
                } satisfies StreamEvent;
              })(),
            )
          : modelResponder(finishRetry),
      ]);
      const session = new MemorySession();
      const agent = new Agent({
        name: 'RetryAdmissionGuardrailAgent',
        model,
        modelSettings: {
          retry: {
            maxRetries: 1,
            backoff: { initialDelayMs: 0, jitter: false },
            policy: retryPolicies.providerSuggested(),
          },
        },
        inputGuardrails: [
          {
            name: 'parallel',
            execute: async () => {
              await gate;
              return { outputInfo: null, tripwireTriggered: true };
            },
          },
        ],
      });
      let error: unknown;
      try {
        if (stream) {
          const result = await run(agent, 'hello', { stream: true, session });
          await result.completed;
        } else {
          await run(agent, 'hello', { session });
        }
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(InputGuardrailTripwireTriggered);
      const state = (error as InputGuardrailTripwireTriggered).state!;
      // Non-streaming already records the successful response before this guardrail.
      expect(state.usage).toMatchObject({
        requests: stream ? 1 : 2,
        totalTokens: stream ? 7 : 9,
      });
      expect(state.usage.requestUsageEntries).toHaveLength(stream ? 1 : 2);
      expect(state._modelResponses).toHaveLength(stream ? 0 : 1);
      expect(await session.getItems()).toEqual([]);
      expect(model.calls).toHaveLength(2);
      expect(consumeModelFailureUsage(firstError)).toBeUndefined();
    },
  );

  it.each([false, true])(
    'preserves direct retry aggregation without a Runner (stream=%s)',
    async (stream) => {
      const firstError = new Error('retryable provider failure');
      attachModelFailureUsage(firstError, responseUsage(3, 4));
      const model = new ScriptedModel([
        modelError(firstError, { suggested: true, replaySafety: 'safe' }),
        textResponse('Recovered', responseUsage(1, 1)),
      ]);
      const request = {
        modelSettings: {
          retry: {
            maxRetries: 1,
            backoff: { initialDelayMs: 0, jitter: false },
            policy: retryPolicies.providerSuggested(),
          },
        },
      } as unknown as ModelRequest;
      let usage: Usage | undefined;
      if (stream) {
        for await (const event of getStreamedResponseWithRetry(
          model,
          request,
        )) {
          if (event.type === 'response_done') {
            usage = new Usage(event.response.usage);
          }
        }
      } else {
        usage = (await getResponseWithRetry(model, request)).usage;
      }
      expect(usage).toMatchObject({ requests: 2, totalTokens: 9 });
      expect(usage?.requestUsageEntries).toHaveLength(2);
    },
  );

  it('does not recount failed attempts after streaming usage was delivered', async () => {
    const firstError = new Error('retryable provider failure');
    const cleanupError = new Error('stream cleanup failed');
    attachModelFailureUsage(firstError, responseUsage(3, 4));
    const done = createDoneEvent('Recovered');
    if (done.type === 'response_done') {
      done.response.usage = responseUsage(1, 1);
    }
    const model = new ScriptedModel([
      modelError(firstError, { suggested: true, replaySafety: 'safe' }),
      modelStream(
        (async function* () {
          yield done;
          throw cleanupError;
        })(),
      ),
    ]);
    const result = await run(
      new Agent({
        name: 'StreamingUsageCleanupAgent',
        model,
        modelSettings: {
          retry: {
            maxRetries: 1,
            backoff: { initialDelayMs: 0, jitter: false },
            policy: retryPolicies.providerSuggested(),
          },
        },
      }),
      'hello',
      { stream: true },
    );

    await expect(result.completed).rejects.toBe(cleanupError);
    expect(result.state.usage).toMatchObject({ requests: 2, totalTokens: 9 });
    expect(result.state.usage.requestUsageEntries).toHaveLength(2);
    expect(consumeModelFailureUsage(cleanupError)).toBeUndefined();
  });

  it.each(['advice', 'policy', 'delay'] as const)(
    'moves known streamed usage to a frozen retry %s error',
    async (phase) => {
      const controller = new AbortController();
      const terminalError = new Error('streamed terminal failure');
      const replacementError = Object.freeze(
        new Error(`retry ${phase} failed`),
      );
      attachModelFailureUsage(terminalError, responseUsage(3, 5));
      const model = new ScriptedModel([
        modelError(terminalError, () => {
          if (phase === 'advice') {
            throw replacementError;
          }
          return { suggested: true, replaySafety: 'safe' };
        }),
      ]);
      const error = await consumeRetryStream(model, {
        signal: controller.signal,
        modelSettings: {
          retry: {
            maxRetries: 1,
            policy: () => {
              if (phase === 'policy') {
                throw replacementError;
              }
              queueMicrotask(() => controller.abort(replacementError));
              return { retry: true, delayMs: 100 };
            },
          },
        },
      } as unknown as ModelRequest).catch((caught: unknown) => caught);

      expect(error).toBe(replacementError);
      expect(consumeModelFailureUsage(error)).toMatchObject({
        requests: 1,
        inputTokens: 3,
        outputTokens: 5,
        totalTokens: 8,
      });
      expect(consumeModelFailureUsage(error)).toBeUndefined();
    },
  );

  it('moves known streamed usage to a normalized model timeout', async () => {
    vi.useFakeTimers();
    const terminalError = new Error('terminal failure after timeout');
    attachModelFailureUsage(terminalError, responseUsage(2, 3));
    const model = new ScriptedModel([
      modelStreamResponder((call) =>
        (async function* () {
          yield* [];
          await new Promise<void>((resolve) =>
            call.request.signal?.addEventListener('abort', () => resolve(), {
              once: true,
            }),
          );
          throw terminalError;
        })(),
      ),
    ]);

    try {
      const result = consumeRetryStream(model, {
        modelSettings: { timeoutMs: 25 },
      } as unknown as ModelRequest).catch((caught: unknown) => caught);
      await vi.advanceTimersByTimeAsync(25);
      const error = await result;

      expect(error).toBeInstanceOf(ModelTimeoutError);
      expect(consumeModelFailureUsage(error)).toMatchObject({
        requests: 1,
        inputTokens: 2,
        outputTokens: 3,
        totalTokens: 5,
      });
      expect(consumeModelFailureUsage(terminalError)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes reported usage when the retry iterator is returned early', async () => {
    const terminalError = new Error('terminal failure');
    const recordUsage = vi.fn();
    // This double preserves the exact internal request identity used by the recorder.
    const model: Model = {
      async getResponse() {
        throw new Error('not used');
      },
      async *getStreamedResponse(request) {
        reportModelFailureUsage(request, terminalError, responseUsage(3, 4));
        yield { type: 'model', event: { type: 'provider.terminal' } as any };
        throw terminalError;
      },
    };
    const iterator = getStreamedResponseWithRetry(
      model,
      { modelSettings: {} } as ModelRequest,
      { onModelFailureUsage: recordUsage },
    )[Symbol.asyncIterator]();

    expect((await iterator.next()).value?.type).toBe('model');
    expect(recordUsage).toHaveBeenCalledTimes(1);
    await iterator.return?.();
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage.mock.calls[0][0]).toMatchObject({
      requests: 1,
      totalTokens: 7,
    });
    expect(consumeModelFailureUsage(terminalError)).toBeUndefined();
  });

  it('includes usage already carried by a retry replacement error', async () => {
    const terminalError = new Error('terminal failure');
    const replacementError = Object.freeze(new Error('policy failure'));
    attachModelFailureUsage(terminalError, responseUsage(3, 4));
    attachModelFailureUsage(replacementError, responseUsage(2, 3));
    const recordUsage = vi.fn();
    const model = new ScriptedModel([
      modelError(terminalError, { suggested: true, replaySafety: 'safe' }),
    ]);

    await expect(
      getResponseWithRetry(
        model,
        {
          modelSettings: {
            retry: {
              maxRetries: 1,
              policy: () => {
                throw replacementError;
              },
            },
          },
        } as unknown as ModelRequest,
        { onModelFailureUsage: recordUsage },
      ),
    ).rejects.toBe(replacementError);
    expect(recordUsage).toHaveBeenCalledTimes(2);
    const recordedUsage = new Usage();
    for (const [usage] of recordUsage.mock.calls) {
      recordedUsage.add(usage);
    }
    expect(recordedUsage).toMatchObject({
      requests: 2,
      totalTokens: 12,
    });
    expect(consumeModelFailureUsage(replacementError)).toBeUndefined();
  });

  it('records usage from handled stream abort and reconciliation failures', async () => {
    const abortError = new DOMException('aborted', 'AbortError');
    const reconciliationError = new Error('reconciliation failed');
    attachModelFailureUsage(abortError, responseUsage(3, 4));
    attachModelFailureUsage(reconciliationError, responseUsage(2, 3));
    const model = new ScriptedModel([
      modelStreamResponder(() =>
        (async function* () {
          yield {
            type: 'model',
            event: {
              type: 'response.created',
              response: { id: 'resp_usage_abort' },
            },
          } as StreamEvent;
          yield {
            type: 'model',
            event: {
              type: 'response.output_item.done',
              item: {
                type: 'function_call',
                id: 'fc_usage_abort',
                call_id: 'call_usage_abort',
                name: 'slow_tool',
                arguments: '{}',
                status: 'completed',
              },
            },
          } as StreamEvent;
          throw abortError;
        })(),
      ),
      modelError(reconciliationError),
    ]);
    const result = await run(
      new Agent({ name: 'ReconciliationUsageAgent', model }),
      'hello',
      { stream: true, conversationId: 'conv_usage_abort' },
    );

    await expect(result.completed).resolves.toBeUndefined();
    expect(model.calls).toHaveLength(2);
    expect(result.state.usage).toMatchObject({
      requests: 2,
      inputTokens: 5,
      outputTokens: 7,
      totalTokens: 12,
    });
    expect(result.state.usage.requestUsageEntries).toHaveLength(2);
    expect(consumeModelFailureUsage(abortError)).toBeUndefined();
    expect(consumeModelFailureUsage(reconciliationError)).toBeUndefined();
  });

  it('does not treat missing response-start evidence as explicit false', async () => {
    const policy = vi.fn((context: RetryPolicyContext) => {
      expect(context.responseStarted).toBeUndefined();
      return {
        retry: true,
        approveUnsafeReplay: context.responseStarted === false,
      };
    });
    const model = new ScriptedModel([
      modelError(new Error('request may have been accepted'), {
        suggested: false,
        replaySafety: 'unsafe',
        reason: 'response-start state is unknown',
      }),
    ]);

    await expect(
      run(
        new Agent({
          name: 'UnknownResponseStartAgent',
          model,
          modelSettings: {
            retry: {
              maxRetries: 1,
              backoff: { initialDelayMs: 0, jitter: false },
              policy,
            },
          },
        }),
        'hello',
      ),
    ).rejects.toThrow('request may have been accepted');

    expect(model.calls).toHaveLength(1);
    expect(policy).toHaveBeenCalledTimes(1);
  });

  it('allows explicit unsafe replay approval for both stateful request forms', async () => {
    const exercise = async (options: {
      previousResponseId?: string;
      conversationId?: string;
    }) => {
      const seenContexts: Array<{
        previousResponseId?: string;
        conversationId?: string;
        replaySafety?: string;
        responseStarted?: boolean;
        statefulRequest?: boolean;
      }> = [];
      const model = new ScriptedModel([
        modelError(new Error('stateful request may have been accepted'), {
          suggested: false,
          replaySafety: 'unsafe',
          reason: 'stateful request may have been accepted',
        }),
        textResponse('Recovered stateful request'),
      ]);

      const result = await run(
        new Agent({
          name: 'StatefulUnsafeReplayAgent',
          model,
          modelSettings: {
            retry: {
              maxRetries: 1,
              backoff: { initialDelayMs: 0, jitter: false },
              policy: (context) => {
                seenContexts.push(context);
                return { retry: true, approveUnsafeReplay: true };
              },
            },
          },
        }),
        'hello',
        options,
      );

      return {
        attempts: model.calls.length,
        finalOutput: result.finalOutput,
        seenContexts,
      };
    };

    const previousResponse = await exercise({
      previousResponseId: 'resp_unsafe',
    });
    expect(previousResponse).toMatchObject({
      attempts: 2,
      finalOutput: 'Recovered stateful request',
      seenContexts: [
        {
          previousResponseId: 'resp_unsafe',
          replaySafety: 'unsafe',
          responseStarted: undefined,
          statefulRequest: true,
        },
      ],
    });

    const conversation = await exercise({ conversationId: 'conv_unsafe' });
    expect(conversation).toMatchObject({
      attempts: 2,
      finalOutput: 'Recovered stateful request',
      seenContexts: [
        {
          conversationId: 'conv_unsafe',
          replaySafety: 'unsafe',
          responseStarted: undefined,
          statefulRequest: true,
        },
      ],
    });
  });

  it('does not apply unsafe replay approval to stateful requests with unknown safety', async () => {
    const policy = vi.fn((context) => {
      expect(context).toMatchObject({
        previousResponseId: 'resp_unknown',
        replaySafety: 'unknown',
        responseStarted: undefined,
        statefulRequest: true,
      });
      return { retry: true, approveUnsafeReplay: true };
    });
    const model = new ScriptedModel([
      modelError(new Error('unknown stateful failure')),
    ]);

    await expect(
      run(
        new Agent({
          name: 'UnknownStatefulReplayAgent',
          model,
          modelSettings: {
            retry: {
              maxRetries: 1,
              backoff: { initialDelayMs: 0, jitter: false },
              policy,
            },
          },
        }),
        'hello',
        { previousResponseId: 'resp_unknown' },
      ),
    ).rejects.toThrow('unknown stateful failure');

    expect(model.calls).toHaveLength(1);
    expect(policy).toHaveBeenCalledTimes(1);
  });

  it('accepts captured provider-safe evidence for a custom stateful policy', async () => {
    const model = new ScriptedModel([
      modelError(new Error('safe stateful failure'), {
        suggested: true,
        replaySafety: 'safe',
      }),
      textResponse('Provider-safe replay'),
    ]);

    const result = await run(
      new Agent({
        name: 'ProviderSafeCustomPolicyAgent',
        model,
        modelSettings: {
          retry: {
            maxRetries: 1,
            backoff: { initialDelayMs: 0, jitter: false },
            policy: () => true,
          },
        },
      }),
      'hello',
      { previousResponseId: 'resp_safe' },
    );

    expect(result.finalOutput).toBe('Provider-safe replay');
    expect(model.calls).toHaveLength(2);
  });

  it('does not let unsafe replay approval override provider-unsafe streaming failures', async () => {
    const policy = vi.fn(() => ({
      retry: true,
      approveUnsafeReplay: true,
    }));
    const model = new ScriptedModel([
      modelError(new Error('unsafe streamed failure'), {
        suggested: false,
        replaySafety: 'unsafe',
        reason: 'unsafe streamed failure',
      }),
    ]);

    const result = await run(
      new Agent({
        name: 'UnsafeStreamingReplayAgent',
        model,
        modelSettings: {
          retry: {
            maxRetries: 1,
            backoff: { initialDelayMs: 0, jitter: false },
            policy,
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

    await expect(consume()).rejects.toThrow('unsafe streamed failure');
    expect(model.calls).toHaveLength(1);
    expect(policy).not.toHaveBeenCalled();
  });

  it('does not let provider normalization clear raw abort evidence', async () => {
    const policy = vi.fn(() => ({
      retry: true,
      approveUnsafeReplay: true,
    }));
    const abortError = new Error('cancelled');
    abortError.name = 'AbortError';
    const model = new ScriptedModel([
      modelError(abortError, {
        suggested: false,
        replaySafety: 'unsafe',
        normalized: { isAbort: false },
      }),
    ]);

    await expect(
      run(
        new Agent({
          name: 'ProviderAbortOverrideAgent',
          model,
          modelSettings: {
            retry: {
              maxRetries: 1,
              backoff: { initialDelayMs: 0, jitter: false },
              policy,
            },
          },
        }),
        'hello',
      ),
    ).rejects.toThrow('cancelled');

    expect(model.calls).toHaveLength(1);
    expect(policy).not.toHaveBeenCalled();
  });

  it('propagates unsafe replay approval through any() and all() in either order', async () => {
    const createContext = () => ({
      error: new Error('request may have been accepted'),
      attempt: 1,
      maxRetries: 1,
      stream: false,
      providerAdvice: {
        suggested: false,
        replaySafety: 'unsafe' as const,
        reason: 'provider veto',
      },
      normalized: {
        isAbort: false,
        isNetworkError: true,
      },
    });
    const approving = () => ({
      retry: true,
      approveUnsafeReplay: true,
      reason: 'application approval',
    });

    for (const combinator of ['any', 'all'] as const) {
      for (const providerFirst of [false, true]) {
        const providerPolicy = retryPolicies.providerSuggested();
        const policies = providerFirst
          ? [providerPolicy, approving]
          : [approving, providerPolicy];
        const combined =
          combinator === 'any'
            ? retryPolicies.any(...policies)
            : retryPolicies.all(...policies);

        await expect(combined(createContext())).resolves.toMatchObject({
          retry: true,
          approveUnsafeReplay: true,
          reason: 'application approval',
        });
      }
    }
  });

  it('keeps provider replay authority stable across composed policy mutation', async () => {
    for (const combinator of ['any', 'all'] as const) {
      const providerAdvice = {
        suggested: false,
        replaySafety: 'unsafe' as 'safe' | 'unsafe',
        responseStarted: true,
        reason: 'provider veto',
      };
      const mutateAdvice = (context: RetryPolicyContext) => {
        expect(context.replaySafety).toBe('unsafe');
        expect(context.responseStarted).toBe(true);
        const authority = Object.getOwnPropertySymbols(context)
          .map(
            (symbol) => (context as unknown as Record<symbol, unknown>)[symbol],
          )
          .find(
            (value): value is Record<string, unknown> =>
              typeof value === 'object' &&
              value !== null &&
              'replaySafety' in value,
          );
        expect(authority).toBeDefined();
        expect(Object.isFrozen(authority)).toBe(true);
        expect(Reflect.set(authority!, 'replaySafety', 'safe')).toBe(false);
        context.providerAdvice!.suggested = true;
        context.providerAdvice!.replaySafety = 'safe';
        context.providerAdvice!.responseStarted = false;
        expect(context.replaySafety).toBe('unsafe');
        expect(context.responseStarted).toBe(true);
        return true;
      };
      const policies: RetryPolicy[] = [
        mutateAdvice,
        retryPolicies.providerSuggested(),
      ];
      const combined =
        combinator === 'any'
          ? retryPolicies.any(...policies)
          : retryPolicies.all(...policies);

      await expect(
        combined({
          error: new Error('request may have been accepted'),
          attempt: 1,
          maxRetries: 1,
          stream: false,
          providerAdvice,
          normalized: {
            isAbort: false,
            isNetworkError: true,
          },
        }),
      ).resolves.toMatchObject({
        retry: false,
        reason: 'provider veto',
      });
    }
  });

  it('retries stateful follow-up requests when providerSuggested() approves replay', async () => {
    const model = new ScriptedModel([
      modelError(
        errorWith('connection closed before opening', { statusCode: 503 }),
        {
          suggested: true,
          replaySafety: 'safe',
          reason: 'request never left the client',
        },
      ),
      textResponse('Recovered after provider-approved replay'),
    ]);

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
    expect(model.calls).toHaveLength(2);
  });

  it('retries stateful follow-up requests when all() includes providerSuggested()', async () => {
    const model = new ScriptedModel([
      modelError(
        errorWith('connection closed before opening', { statusCode: 429 }),
        {
          suggested: true,
          replaySafety: 'safe',
          reason: 'request never left the client',
        },
      ),
      textResponse('Recovered after all() replay approval'),
    ]);

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
    expect(model.calls).toHaveLength(2);
  });

  it('does not retry stateful follow-up requests from non-provider policies alone', async () => {
    const model = new ScriptedModel([
      modelError(errorWith('temporary stateful failure', { statusCode: 503 }), {
        suggested: true,
        reason: 'provider would allow retry',
      }),
    ]);

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
    expect(model.calls).toHaveLength(1);
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
      ModelRequest['modelSettings']['retry'] | undefined;

    const model = new ScriptedModel([
      modelResponder((call) => {
        capturedRetrySettings = call.request.modelSettings.retry;
        return {
          usage: new Usage({ requests: 1 }),
          output: [fakeModelMessage('Merged retry settings')],
        };
      }),
    ]);

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
      ModelRequest['modelSettings']['retry'] | undefined;

    const model = new ScriptedModel([
      modelResponder((call) => {
        capturedRetrySettings = call.request.modelSettings.retry;
        return {
          usage: new Usage({ requests: 1 }),
          output: [fakeModelMessage('Merged retry settings')],
        };
      }),
    ]);

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
    const model = new ScriptedModel([
      modelError(
        Object.assign(new Error('retry after header'), {
          responseHeaders: new Headers([['retry-after-ms', '0']]),
        }),
      ),
      textResponse('Recovered from headers'),
    ]);

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
    expect(model.calls).toHaveLength(2);
  });
});
