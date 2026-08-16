import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  Agent,
  MemorySession,
  ModelTimeoutError,
  retryPolicies,
  run,
  Runner,
  tool,
} from '../src';
import type {
  Model,
  ModelRequest,
  ModelResponse,
  ModelRetryAdviceRequest,
} from '../src/model';
import type { StreamEvent } from '../src/types/protocol';
import { Usage } from '../src/usage';
import {
  getResponseWithRetry,
  getStreamedResponseWithRetry,
} from '../src/runner/modelRetry';
import { modelResponse, ScriptedModel } from '../src/testing';

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

  async *getStreamedResponse(
    request: ModelRequest,
  ): AsyncIterable<StreamEvent> {
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
        output: [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'Stream recovered' }],
          },
        ],
      },
    };
  }
}

class EventThenTimeoutStreamModel implements Model {
  calls = 0;

  async getResponse(): Promise<ModelResponse> {
    return response('unused');
  }

  async *getStreamedResponse(
    request: ModelRequest,
  ): AsyncIterable<StreamEvent> {
    this.calls += 1;
    yield { type: 'response_started' };
    await waitForAbort(request.signal);
  }
}

class EventThenTimeoutWithFailingAdviceStreamModel extends EventThenTimeoutStreamModel {
  getRetryAdvice(): never {
    throw new Error('retry advice failed after stream timeout');
  }
}

class ImmediateFailureWithSlowAdviceModel implements Model {
  async getResponse(): Promise<ModelResponse> {
    throw new Error('failed before timeout');
  }

  async *getStreamedResponse(): AsyncIterable<StreamEvent> {
    yield* [];
  }

  async getRetryAdvice(_args: ModelRetryAdviceRequest): Promise<undefined> {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return undefined;
  }
}

class TimeoutWithSlowAdviceModel extends TimeoutThenResponseModel {
  async getRetryAdvice(_args: ModelRetryAdviceRequest): Promise<undefined> {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return undefined;
  }
}

class TimeoutWithFailingAdviceModel extends TimeoutThenResponseModel {
  getRetryAdvice(): undefined {
    throw new Error('retry advice failed');
  }
}

class LateSuccessModel implements Model {
  async getResponse(): Promise<ModelResponse> {
    await new Promise((resolve) => setTimeout(resolve, 50));
    return response('Late success');
  }

  async *getStreamedResponse(): AsyncIterable<StreamEvent> {
    yield* [];
  }
}

class LateEventThenStreamModel implements Model {
  calls = 0;

  async getResponse(): Promise<ModelResponse> {
    return response('unused');
  }

  async *getStreamedResponse(): AsyncIterable<StreamEvent> {
    this.calls += 1;
    if (this.calls === 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      yield { type: 'response_started' };
      return;
    }
    yield { type: 'response_started' };
    yield {
      type: 'response_done',
      response: {
        id: 'response_after_late_event',
        usage: new Usage({ requests: 1 }),
        output: [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'Recovered' }],
          },
        ],
      },
    };
  }
}

class CompletedStreamModel implements Model {
  async getResponse(): Promise<ModelResponse> {
    return response('unused');
  }

  async *getStreamedResponse(): AsyncIterable<StreamEvent> {
    yield {
      type: 'response_done',
      response: {
        id: 'response_completed_before_timeout',
        usage: new Usage({ requests: 1 }),
        output: [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'Completed' }],
          },
        ],
      },
    };
  }
}

class GenericAbortThenResponseModel extends TimeoutThenResponseModel {
  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    this.calls += 1;
    if (this.calls === 1) {
      try {
        return await waitForAbort(request.signal);
      } catch {
        const error = new Error('generic abort');
        error.name = 'AbortError';
        throw error;
      }
    }
    return response('Recovered from generic abort');
  }
}

class GenericAbortWithAbortAdviceModel extends GenericAbortThenResponseModel {
  getRetryAdvice() {
    return { normalized: { isAbort: true } };
  }
}

class TimeoutWithUnsafeReplayAdviceModel extends TimeoutThenResponseModel {
  getRetryAdvice() {
    return { replaySafety: 'unsafe' as const };
  }
}

afterEach(() => {
  vi.useRealTimers();
});

const approveUnsafeTimeoutRetry = () => ({
  retry: true,
  approveUnsafeReplay: true,
});

describe('model timeout', () => {
  it('retries a timed-out non-streaming call with explicit unsafe replay approval', async () => {
    vi.useFakeTimers();
    const model = new TimeoutThenResponseModel();
    const agent = new Agent({
      name: 'ModelTimeoutAgent',
      model,
      modelSettings: {
        timeoutMs: 25,
        retry: {
          maxRetries: 1,
          backoff: { initialDelayMs: 0, jitter: false },
          policy: approveUnsafeTimeoutRetry,
        },
      },
    });

    const resultPromise = run(agent, 'hello');
    await vi.waitFor(() => expect(model.calls).toBe(1));
    await vi.advanceTimersByTimeAsync(25);
    const result = await resultPromise;

    expect(result.finalOutput).toBe('Recovered');
    expect(model.calls).toBe(2);
  });

  it('does not replay an ambiguous timeout through networkError policy alone', async () => {
    vi.useFakeTimers();
    const model = new TimeoutThenResponseModel();
    const resultPromise = run(
      new Agent({
        name: 'AmbiguousTimeoutAgent',
        model,
        modelSettings: {
          timeoutMs: 25,
          retry: {
            maxRetries: 1,
            backoff: { initialDelayMs: 0, jitter: false },
            policy: retryPolicies.networkError(),
          },
        },
      }),
      'hello',
    );
    const rejection =
      expect(resultPromise).rejects.toBeInstanceOf(ModelTimeoutError);

    await vi.waitFor(() => expect(model.calls).toBe(1));
    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(model.calls).toBe(1);
  });

  it('surfaces ModelTimeoutError when retry policy does not opt in', async () => {
    vi.useFakeTimers();
    const model = new TimeoutThenResponseModel();
    const resultPromise = run(
      new Agent({
        name: 'NoRetryAgent',
        model,
        modelSettings: { timeoutMs: 25 },
      }),
      'hello',
    );
    const errorPromise = resultPromise.catch((error: unknown) => error);
    await vi.waitFor(() => expect(model.calls).toBe(1));
    await vi.advanceTimersByTimeAsync(25);

    const error = await errorPromise;
    expect(error).toBeInstanceOf(ModelTimeoutError);
    expect((error as ModelTimeoutError).state).toBeDefined();
    expect(model.calls).toBe(1);
  });

  it('rejects invalid timeout values before calling the model', async () => {
    const model = new TimeoutThenResponseModel();
    const agent = new Agent({
      name: 'InvalidTimeoutAgent',
      model,
      modelSettings: { timeoutMs: 2_147_483_648 },
    });
    const runner = new Runner();
    const agentStart = vi.fn();
    const session = new MemorySession();
    const getItems = vi.spyOn(session, 'getItems');
    const sessionInputCallback = vi.fn();
    runner.on('agent_start', agentStart);

    await expect(
      runner.run(agent, 'hello', { session, sessionInputCallback }),
    ).rejects.toThrow(
      'modelSettings.timeoutMs must be a positive finite number',
    );
    expect(getItems).not.toHaveBeenCalled();
    expect(sessionInputCallback).not.toHaveBeenCalled();
    expect(agentStart).not.toHaveBeenCalled();
    expect(model.calls).toBe(0);
  });

  it('rejects invalid agent-tool timeouts before tool side effects', async () => {
    const inputBuilder = vi.fn(() => 'nested input');
    const siblingExecute = vi.fn(() => 'sibling output');
    const nestedAgent = new Agent({
      name: 'InvalidNestedTimeoutAgent',
      modelSettings: { timeoutMs: 0 },
    });
    const nestedTool = nestedAgent.asTool({
      toolName: 'nested_agent',
      toolDescription: 'Runs a nested agent.',
      parameters: z.object({ input: z.string() }),
      inputBuilder,
    });
    const siblingTool = tool({
      name: 'sibling_tool',
      description: 'Runs a sibling side effect.',
      parameters: z.object({}),
      execute: siblingExecute,
    });
    const parent = new Agent({
      name: 'ParentAgent',
      model: new ScriptedModel([
        modelResponse({
          output: [
            {
              type: 'function_call',
              id: 'nested-call-id',
              callId: 'nested-call',
              name: 'nested_agent',
              status: 'completed',
              arguments: JSON.stringify({ input: 'hello' }),
            },
            {
              type: 'function_call',
              id: 'sibling-call-id',
              callId: 'sibling-call',
              name: 'sibling_tool',
              status: 'completed',
              arguments: '{}',
            },
          ],
          usage: new Usage(),
        }),
      ]),
      tools: [nestedTool, siblingTool],
    });

    await expect(run(parent, 'hello')).rejects.toThrow(
      'modelSettings.timeoutMs must be a positive finite number',
    );
    expect(inputBuilder).not.toHaveBeenCalled();
    expect(siblingExecute).not.toHaveBeenCalled();
  });

  it('preserves parent run cancellation as a non-retryable abort', async () => {
    const model = new TimeoutThenResponseModel();
    const policy = vi.fn().mockReturnValue(true);
    const controller = new AbortController();
    const agent = new Agent({
      name: 'CancelledAgent',
      model,
      modelSettings: {
        timeoutMs: 10_000,
        retry: { maxRetries: 1, policy },
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

  it('retries a streaming timeout only before stream output', async () => {
    vi.useFakeTimers();
    const model = new TimeoutThenStreamModel();
    const agent = new Agent({
      name: 'StreamingTimeoutAgent',
      model,
      modelSettings: {
        timeoutMs: 25,
        retry: {
          maxRetries: 1,
          backoff: { initialDelayMs: 0, jitter: false },
          policy: approveUnsafeTimeoutRetry,
        },
      },
    });

    const result = await run(agent, 'hello', { stream: true });
    const consume = (async () => {
      for await (const _event of result) {
        // Consume to completion.
      }
    })();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(25);
    await consume;

    expect(result.finalOutput).toBe('Stream recovered');
    expect(model.calls).toBe(2);
  });

  it('does not retry a streaming timeout after stream output', async () => {
    vi.useFakeTimers();
    const model = new EventThenTimeoutStreamModel();
    const agent = new Agent({
      name: 'StreamingOutputTimeoutAgent',
      model,
      modelSettings: {
        timeoutMs: 25,
        retry: {
          maxRetries: 1,
          backoff: { initialDelayMs: 0, jitter: false },
          policy: retryPolicies.networkError(),
        },
      },
    });

    const result = await run(agent, 'hello', { stream: true });
    const consume = (async () => {
      for await (const _event of result) {
        // Consume until the timeout fails the stream.
      }
    })();
    const rejection = expect(consume).rejects.toBeInstanceOf(ModelTimeoutError);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(model.calls).toBe(1);
  });

  it('reports a timed-out stream when retry advice replaces the surfaced error', async () => {
    vi.useFakeTimers();
    const onModelTimeout = vi.fn();
    const iterator = getStreamedResponseWithRetry(
      new EventThenTimeoutWithFailingAdviceStreamModel(),
      {
        modelSettings: { timeoutMs: 25 },
      } as ModelRequest,
      { onModelTimeout },
    )[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'response_started' },
    });
    const rejection = expect(iterator.next()).rejects.toThrow(
      'retry advice failed after stream timeout',
    );
    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(onModelTimeout).toHaveBeenCalledTimes(1);
  });

  it('clears the timeout timer when parent cancellation wins', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const resultPromise = getResponseWithRetry(new LateSuccessModel(), {
      signal: controller.signal,
      modelSettings: { timeoutMs: 10_000 },
    } as ModelRequest);
    const rejection = expect(resultPromise).rejects.toMatchObject({
      name: 'AbortError',
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(2);
    controller.abort();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(50);
    await rejection;
  });

  it('marks a timed-out stateful request as possibly accepted', async () => {
    vi.useFakeTimers();
    const model = new TimeoutThenResponseModel();
    const markPossiblyAccepted = vi.fn();
    const resultPromise = getResponseWithRetry(
      model,
      {
        conversationId: 'conv-timeout',
        modelSettings: { timeoutMs: 25 },
      } as ModelRequest,
      { onPossiblyAcceptedRequestFailure: markPossiblyAccepted },
    );
    const rejection =
      expect(resultPromise).rejects.toBeInstanceOf(ModelTimeoutError);
    await vi.waitFor(() => expect(model.calls).toBe(1));
    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(markPossiblyAccepted).toHaveBeenCalledTimes(1);
  });

  it('retries a timed-out stateful request with explicit unsafe replay approval', async () => {
    vi.useFakeTimers();
    const model = new TimeoutWithUnsafeReplayAdviceModel();
    const policy = vi.fn().mockReturnValue({
      retry: true,
      approveUnsafeReplay: true,
    });
    const resultPromise = getResponseWithRetry(model, {
      conversationId: 'conv-unsafe-timeout',
      modelSettings: {
        timeoutMs: 25,
        retry: {
          maxRetries: 1,
          backoff: { initialDelayMs: 0, jitter: false },
          policy,
        },
      },
    } as unknown as ModelRequest);
    await vi.waitFor(() => expect(model.calls).toBe(1));
    await vi.advanceTimersByTimeAsync(25);
    await expect(resultPromise).resolves.toMatchObject({
      output: expect.any(Array),
    });
    expect(policy).toHaveBeenCalledTimes(1);
    expect(model.calls).toBe(2);
  });

  it('does not turn post-failure retry advice time into a model timeout', async () => {
    vi.useFakeTimers();
    const markPossiblyAccepted = vi.fn();
    const resultPromise = getResponseWithRetry(
      new ImmediateFailureWithSlowAdviceModel(),
      {
        conversationId: 'conv-failed-before-timeout',
        modelSettings: { timeoutMs: 25 },
      } as ModelRequest,
      { onPossiblyAcceptedRequestFailure: markPossiblyAccepted },
    );
    const rejection = expect(resultPromise).rejects.toThrow(
      'failed before timeout',
    );

    await vi.advanceTimersByTimeAsync(50);
    await rejection;
    expect(markPossiblyAccepted).not.toHaveBeenCalled();
  });

  it('preserves parent abort precedence while retry advice is pending', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const resultPromise = getResponseWithRetry(
      new TimeoutWithSlowAdviceModel(),
      {
        signal: controller.signal,
        modelSettings: { timeoutMs: 25 },
      } as ModelRequest,
    );
    const rejection = expect(resultPromise).rejects.toMatchObject({
      name: 'AbortError',
    });

    await vi.advanceTimersByTimeAsync(25);
    controller.abort();
    await vi.advanceTimersByTimeAsync(50);
    await rejection;
  });

  it('marks an ambiguous stateful timeout when retry advice fails', async () => {
    vi.useFakeTimers();
    const markPossiblyAccepted = vi.fn();
    const resultPromise = getResponseWithRetry(
      new TimeoutWithFailingAdviceModel(),
      {
        conversationId: 'conv-advice-failure',
        modelSettings: { timeoutMs: 25 },
      } as ModelRequest,
      { onPossiblyAcceptedRequestFailure: markPossiblyAccepted },
    );
    const rejection = expect(resultPromise).rejects.toThrow(
      'retry advice failed',
    );

    await vi.advanceTimersByTimeAsync(25);
    await rejection;
    expect(markPossiblyAccepted).toHaveBeenCalledTimes(1);
  });

  it('rejects a provider response that resolves after the timeout', async () => {
    vi.useFakeTimers();
    const resultPromise = getResponseWithRetry(new LateSuccessModel(), {
      modelSettings: { timeoutMs: 25 },
    } as ModelRequest);
    const errorPromise = resultPromise.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(50);
    const error = await errorPromise;
    expect(error).toBeInstanceOf(ModelTimeoutError);
    expect((error as ModelTimeoutError).cause).toBeUndefined();
  });

  it('does not wrap a late stream event timeout as its own cause', async () => {
    vi.useFakeTimers();
    const result = await run(
      new Agent({
        name: 'LateStreamEventTimeoutAgent',
        model: new LateEventThenStreamModel(),
        modelSettings: { timeoutMs: 25 },
      }),
      'hello',
      { stream: true },
    );
    const consume = (async () => {
      for await (const _event of result) {
        // Consume until the late event fails the stream.
      }
    })();
    const errorPromise = consume.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(50);
    const error = await errorPromise;
    expect(error).toBeInstanceOf(ModelTimeoutError);
    expect((error as ModelTimeoutError).cause).toBeUndefined();
  });

  it('retries before exposing a stream event that arrives after timeout', async () => {
    vi.useFakeTimers();
    const model = new LateEventThenStreamModel();
    const result = await run(
      new Agent({
        name: 'LateStreamEventAgent',
        model,
        modelSettings: {
          timeoutMs: 25,
          retry: {
            maxRetries: 1,
            backoff: { initialDelayMs: 0, jitter: false },
            policy: approveUnsafeTimeoutRetry,
          },
        },
      }),
      'hello',
      { stream: true },
    );
    const consume = (async () => {
      for await (const _event of result) {
        // Consume to completion.
      }
    })();

    await vi.advanceTimersByTimeAsync(50);
    await consume;
    expect(result.finalOutput).toBe('Recovered');
    expect(model.calls).toBe(2);
  });

  it('does not time out after yielding the terminal stream event', async () => {
    vi.useFakeTimers();
    const iterator = getStreamedResponseWithRetry(new CompletedStreamModel(), {
      modelSettings: { timeoutMs: 25 },
    } as ModelRequest)[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'response_done' },
    });
    await vi.advanceTimersByTimeAsync(25);
    await expect(iterator.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });

  it('retries a timeout when the provider throws a generic AbortError', async () => {
    vi.useFakeTimers();
    const model = new GenericAbortThenResponseModel();
    const resultPromise = run(
      new Agent({
        name: 'GenericAbortTimeoutAgent',
        model,
        modelSettings: {
          timeoutMs: 25,
          retry: {
            maxRetries: 1,
            backoff: { initialDelayMs: 0, jitter: false },
            policy: approveUnsafeTimeoutRetry,
          },
        },
      }),
      'hello',
    );

    await vi.waitFor(() => expect(model.calls).toBe(1));
    await vi.advanceTimersByTimeAsync(25);
    const result = await resultPromise;
    expect(result.finalOutput).toBe('Recovered from generic abort');
    expect(model.calls).toBe(2);
  });

  it('does not let provider abort advice veto an SDK timeout', async () => {
    vi.useFakeTimers();
    const model = new GenericAbortWithAbortAdviceModel();
    const resultPromise = run(
      new Agent({
        name: 'ProviderAbortAdviceTimeoutAgent',
        model,
        modelSettings: {
          timeoutMs: 25,
          retry: {
            maxRetries: 1,
            backoff: { initialDelayMs: 0, jitter: false },
            policy: approveUnsafeTimeoutRetry,
          },
        },
      }),
      'hello',
    );

    await vi.waitFor(() => expect(model.calls).toBe(1));
    await vi.advanceTimersByTimeAsync(25);
    const result = await resultPromise;
    expect(result.finalOutput).toBe('Recovered from generic abort');
    expect(model.calls).toBe(2);
  });
});
