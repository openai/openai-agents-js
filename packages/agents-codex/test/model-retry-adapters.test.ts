import OpenAI from 'openai';
import { it, expect, vi } from 'vitest';
import {
  ChatCompletionsModel,
  ResponsesModel,
  type ModelRequest,
} from '../src/runtime/models';
import {
  modelRetryFailureToNative,
  retryContextFromNative,
  retryDecisionToNative,
  captureModelRetryAdvice,
} from '../src/runtime/model-retry';
function request(): ModelRequest {
  return {
    body: {
      model: 'fixture',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'hello' }],
        },
      ],
    },
    context: undefined,
    sessionId: 'session',
    turnId: 'turn',
    signal: new AbortController().signal,
  };
}
for (const Adapter of [ChatCompletionsModel, ResponsesModel]) {
  it(`${Adapter.name} applies native retry suppression after the real options factory without changing its client`, async () => {
    const fetch = vi.fn(async () =>
      Response.json(
        { error: { message: 'temporary', private_payload: 'not normalized' } },
        {
          status: 503,
          headers: {
            'retry-after-ms': '0',
            'x-should-retry': 'false',
            'x-request-id': 'exact-request',
          },
        },
      ),
    );
    const client = new OpenAI({
      apiKey: 'fixture',
      baseURL: 'https://fixture.invalid/v1',
      maxRetries: 2,
      fetch,
    });
    const adapter = new Adapter(client, undefined, {
      requestOptions: async () => ({ maxRetries: 4 }),
    });
    let error: unknown;
    const req = {
      ...request(),
      attemptId: 'native-id',
      attempt: 2,
      disableProviderRetries: true,
    };
    try {
      await adapter.complete(req);
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(OpenAI.APIError);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(client.maxRetries).toBe(2);
    expect(
      adapter.getRetryAdvice({
        request: req,
        error,
        attemptId: 'native-id',
        attempt: 2,
        signal: req.signal,
      }),
    ).toEqual({ suggested: false });
    const normalized = modelRetryFailureToNative(error);
    expect(normalized).toMatchObject({
      status_code: 503,
      request_id: 'exact-request',
      retry_after_ms: 0,
      is_abort: false,
      is_timeout: false,
    });
    expect(JSON.stringify(normalized)).not.toContain('private_payload');
  });
  it(`${Adapter.name} preserves stateless initial SDK retry defaults`, async () => {
    const fetch = vi.fn(async () =>
      Response.json(
        { error: { message: 'temporary' } },
        { status: 503, headers: { 'retry-after-ms': '0' } },
      ),
    );
    const client = new OpenAI({
      apiKey: 'fixture',
      baseURL: 'https://fixture.invalid/v1',
      maxRetries: 2,
      fetch,
    });
    const adapter = new Adapter(client);
    await expect(
      adapter.complete({
        ...request(),
        attemptId: 'first',
        attempt: 1,
        disableProviderRetries: false,
      }),
    ).rejects.toBeInstanceOf(OpenAI.APIError);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(client.maxRetries).toBe(2);
  });
}
it('captures retry context authority and validates only a narrow decision/advice reply', () => {
  const error = new Error('same');
  const signal = new AbortController().signal;
  const native = {
    attempt_id: 'id',
    attempt: 4294967296,
    request_attempt: 4294967299,
    max_retries: 4294967295,
    thread_id: 'thread',
    turn_id: 'turn',
    model: 'model',
    transport: 'http',
    policy_enabled: false,
    normalized: {
      message: 'failure',
      status_code: 503,
      is_abort: false,
      is_network_error: false,
      is_timeout: true,
    },
    provider_advice: { suggested: false, replay_safety: 'unsafe' },
    response_started: false,
    retry_unsafe_output: false,
    local_effects: true,
    stateful: true,
    previous_response_id: 'response',
    conversation_id: null,
  };
  const captured = retryContextFromNative(native, signal, error);
  native.normalized.status_code = 400;
  expect(captured.policyEnabled).toBe(false);
  expect(captured.context.error).toBe(error);
  expect(captured.context.signal).toBe(signal);
  expect(captured.context.normalizedError.statusCode).toBe(503);
  expect(Object.isFrozen(captured.context.providerAdvice)).toBe(true);
  expect(captured.context.localEffects).toBe(true);
  expect(
    retryDecisionToNative({
      retry: true,
      delayMs: 0,
      approveUnsafeReplay: true,
    }),
  ).toEqual({ retry: true, delay_ms: 0, approve_unsafe_replay: true });
  for (const value of [
    true,
    null,
    { retry: true, delayMs: -1 },
    { retry: true, delayMs: Infinity },
    { retry: true, approveUnsafeReplay: 1 },
    { retry: true, arbitrary: {} },
  ])
    expect(() => retryDecisionToNative(value)).toThrow(TypeError);
  expect(() =>
    captureModelRetryAdvice({ suggested: true, retryAfterMs: NaN }),
  ).toThrow(TypeError);
});
it('keeps malformed error metadata from replacing an original failure', () => {
  const error = Object.defineProperty(new Error('original'), 'status', {
    get() {
      throw new Error('metadata');
    },
  });
  expect(modelRetryFailureToNative(error)).toMatchObject({
    message: 'original',
    is_abort: false,
    is_timeout: false,
  });
});
