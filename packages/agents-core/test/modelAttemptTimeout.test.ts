import { afterEach, describe, expect, it, vi } from 'vitest';

import { Agent, retryPolicies, run, Runner } from '../src';
import type { Model, ModelRequest, ModelResponse } from '../src/model';
import type { StreamEvent } from '../src/types/protocol';
import { getResponseWithRetry } from '../src/runner/modelRetry';
import { Usage } from '../src/usage';

function response(text: string): ModelResponse {
  return {
    usage: new Usage({ requests: 1 }),
    output: [
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text }],
      },
    ],
  };
}

async function waitForAbort(signal: AbortSignal | undefined): Promise<never> {
  if (!signal) {
    throw new Error('Expected model request signal');
  }

  return await new Promise<never>((_resolve, reject) => {
    const onAbort = () => {
      const fallback = new Error('The operation was aborted.');
      fallback.name = 'AbortError';
      reject(signal.reason ?? fallback);
    };

    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

class TimeoutThenResponseModel implements Model {
  calls = 0;

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      return await waitForAbort(request.signal);
    }
    return response('Recovered');
  }

  async *getStreamedResponse(): AsyncIterable<StreamEvent> {
    yield* [];
  }
}

class TimeoutThenStreamModel implements Model {
  calls = 0;

  async getResponse(): Promise<ModelResponse> {
    return response('unused');
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    this.calls += 1;
    if (this.calls === 1) {
      await waitForAbort(request.signal);
      return;
    }

    yield { type: 'response_started' };
    yield {
      type: 'response_done',
      response: {
        id: 'response_timeout_recovered',
        usage: new Usage({ requests: 1 }),
        output: response('Stream recovered').output,
      },
    };
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('model attempt timeout', () => {
  it('retries a timed-out non-streaming attempt through networkError policy', async () => {
    vi.useFakeTimers();
    const model = new TimeoutThenResponseModel();
    const agent = new Agent({
      name: 'AttemptTimeoutAgent',
      model,
      modelSettings: {
        retry: {
          attemptTimeoutMs: 25,
          maxRetries: 1,
          backoff: { initialDelayMs: 0, jitter: false },
          policy: retryPolicies.networkError(),
        },
      },
    });

    const resultPromise = run(agent, 'hello');
    await vi.advanceTimersByTimeAsync(25);
    const result = await resultPromise;

    expect(result.finalOutput).toBe('Recovered');
    expect(model.calls).toBe(2);
  });

  it('surfaces a timeout error when retry policy does not opt in', async () => {
    vi.useFakeTimers();
    const model = new TimeoutThenResponseModel();
    const agent = new Agent({
      name: 'AttemptTimeoutNoRetryAgent',
      model,
      modelSettings: {
        retry: {
          attemptTimeoutMs: 25,
          maxRetries: 1,
        },
      },
    });

    const resultPromise = run(agent, 'hello');
    await vi.advanceTimersByTimeAsync(25);

    await expect(resultPromise).rejects.toMatchObject({
      name: 'ModelAttemptTimeoutError',
      code: 'ETIMEDOUT',
    });
    expect(model.calls).toBe(1);
  });

  it('rejects invalid attempt timeout before calling the model', async () => {
    const model = new TimeoutThenResponseModel();
    const agent = new Agent({
      name: 'InvalidAttemptTimeoutAgent',
      model,
      modelSettings: {
        retry: {
          attemptTimeoutMs: 0,
        },
      },
    });

    await expect(run(agent, 'hello')).rejects.toThrow(
      'modelSettings.retry.attemptTimeoutMs must be a positive finite number',
    );
    expect(model.calls).toBe(0);
  });

  it('rejects attempt timeouts above the platform timer limit', async () => {
    const model = new TimeoutThenResponseModel();
    const agent = new Agent({
      name: 'OverflowAttemptTimeoutAgent',
      model,
      modelSettings: { retry: { attemptTimeoutMs: 2_147_483_648 } },
    });

    await expect(run(agent, 'hello')).rejects.toThrow(
      'modelSettings.retry.attemptTimeoutMs must be less than or equal to 2147483647ms',
    );
    expect(model.calls).toBe(0);
  });

  it('marks a surfaced stateful timeout as possibly accepted', async () => {
    vi.useFakeTimers();
    const model = new TimeoutThenResponseModel();
    const onPossiblyAcceptedRequestFailure = vi.fn();
    const request = {
      conversationId: 'conv_timeout',
      modelSettings: { retry: { attemptTimeoutMs: 25 } },
    } as ModelRequest;

    const responsePromise = getResponseWithRetry(model, request, {
      onPossiblyAcceptedRequestFailure,
    });
    await vi.advanceTimersByTimeAsync(25);

    await expect(responsePromise).rejects.toMatchObject({
      name: 'ModelAttemptTimeoutError',
      code: 'ETIMEDOUT',
    });
    expect(onPossiblyAcceptedRequestFailure).toHaveBeenCalledOnce();
  });

  it('does not mark a stateful timeout accepted when the provider says replay is safe', async () => {
    vi.useFakeTimers();
    const model: Model = new TimeoutThenResponseModel();
    model.getRetryAdvice = vi.fn().mockReturnValue({ replaySafety: 'safe' });
    const onPossiblyAcceptedRequestFailure = vi.fn();
    const request = {
      previousResponseId: 'resp_timeout',
      modelSettings: { retry: { attemptTimeoutMs: 25 } },
    } as ModelRequest;

    const responsePromise = getResponseWithRetry(model, request, {
      onPossiblyAcceptedRequestFailure,
    });
    await vi.advanceTimersByTimeAsync(25);

    await expect(responsePromise).rejects.toMatchObject({
      name: 'ModelAttemptTimeoutError',
      code: 'ETIMEDOUT',
    });
    expect(onPossiblyAcceptedRequestFailure).not.toHaveBeenCalled();
  });

  it('does not turn parent run cancellation into a retryable timeout', async () => {
    const model = new TimeoutThenResponseModel();
    const policy = vi.fn().mockReturnValue(true);
    const controller = new AbortController();
    const agent = new Agent({
      name: 'AttemptTimeoutCancelledAgent',
      model,
      modelSettings: {
        retry: {
          attemptTimeoutMs: 10_000,
          maxRetries: 1,
          policy,
        },
      },
    });

    const resultPromise = new Runner().run(agent, 'hello', {
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();

    await expect(resultPromise).rejects.toMatchObject({ name: 'AbortError' });
    expect(model.calls).toBe(1);
    expect(policy).not.toHaveBeenCalled();
  });

  it('retries a streaming timeout only before any stream event is emitted', async () => {
    vi.useFakeTimers();
    const model = new TimeoutThenStreamModel();
    const agent = new Agent({
      name: 'StreamingAttemptTimeoutAgent',
      model,
      modelSettings: {
        retry: {
          attemptTimeoutMs: 25,
          maxRetries: 1,
          backoff: { initialDelayMs: 0, jitter: false },
          policy: retryPolicies.networkError(),
        },
      },
    });

    const result = await run(agent, 'hello', { stream: true });
    const consume = (async () => {
      for await (const _event of result) {
        // Consume to completion.
      }
    })();

    await vi.advanceTimersByTimeAsync(25);
    await consume;

    expect(result.finalOutput).toBe('Stream recovered');
    expect(model.calls).toBe(2);
  });
});
