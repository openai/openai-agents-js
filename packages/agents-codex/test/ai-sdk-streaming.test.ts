import { expect, it, vi } from 'vitest';
import { AiSdkModel, type ModelRequest } from '../src/runtime/models';

function request(signal = new AbortController().signal): ModelRequest {
  return {
    body: { model: 'fixture', input: [], tools: [] },
    sessionId: 'session',
    turnId: 'turn',
    context: undefined,
    signal,
  };
}
function adapter(
  parts: any[],
  options: { cancel?: () => Promise<void> | void; close?: boolean } = {},
) {
  return new AiSdkModel(
    {
      specificationVersion: 'v3',
      modelId: 'fixture',
      provider: 'fixture',
      doGenerate: vi.fn(() => {
        throw new Error('Buffered path');
      }),
      doStream: () => ({
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part);
            if (options.close) controller.close();
          },
          cancel: options.cancel,
        }),
      }),
    },
    {},
    { stream: true },
  );
}

it('emits text before the provider finishes and cancels its borrowed reader on return', async () => {
  const cancel = vi.fn();
  const model = adapter([{ type: 'text-delta', id: 'one', delta: 'live' }], {
    cancel,
  });
  const stream = model.stream!(request())[Symbol.asyncIterator]();
  const events: any[] = [];
  while (events.at(-1)?.type !== 'response.output_text.delta') {
    const next = await stream.next();
    expect(next.done).toBe(false);
    events.push(next.value);
  }
  expect(events.at(-1).delta).toBe('live');
  await stream.return!();
  expect(cancel).toHaveBeenCalledOnce();
});

it('retains response metadata before the first output and projects versioned finish usage', async () => {
  const model = adapter(
    [
      { type: 'stream-start', warnings: [] },
      { type: 'response-metadata', id: 'provider-response' },
      { type: 'text-delta', id: 'one', delta: 'answer' },
      {
        type: 'finish',
        finishReason: { unified: 'stop' },
        usage: {
          inputTokens: { total: 8, cacheRead: 2, cacheWrite: 1 },
          outputTokens: { total: 3, reasoning: 1 },
        },
      },
    ],
    { close: true },
  );
  const measured = vi.fn();
  const events = await Array.fromAsync(
    model.stream!({ ...request(), reportUsage: measured }),
  );
  expect(events[0]).toEqual({
    type: 'response.created',
    response: { id: 'provider-response' },
  });
  expect((events.at(-1) as any).response.usage).toEqual({
    input_tokens: 8,
    output_tokens: 3,
    total_tokens: 11,
    input_tokens_details: { cached_tokens: 2, cache_write_tokens: 1 },
    output_tokens_details: { reasoning_tokens: 1 },
  });
  expect(measured).toHaveBeenCalledExactlyOnceWith({
    inputTokens: 8,
    outputTokens: 3,
    totalTokens: 11,
    cachedInputTokens: 2,
    cacheWriteInputTokens: 1,
    reasoningOutputTokens: 1,
  });
});

it('joins an abort-triggered reader cancellation without leaving a pending read', async () => {
  const controller = new AbortController();
  let release!: () => void;
  let cancelled!: () => void;
  const cancellationEntered = new Promise<void>((resolve) => {
    cancelled = resolve;
  });
  const cancellation = new Promise<void>((resolve) => {
    release = resolve;
  });
  const model = adapter([], {
    cancel() {
      cancelled();
      return cancellation;
    },
  });
  const stream = model.stream!(request(controller.signal))[
    Symbol.asyncIterator
  ]();
  const next = stream.next();
  const outcome = next.then(
    () => 'resolved',
    (error) => error,
  );
  let settled = false;
  void outcome.then(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const reason = new Error('fixture cancellation');
  controller.abort(reason);
  await cancellationEntered;
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  release();
  expect(await outcome).toBe(reason);
});

it('keeps streaming opt-in and rejects an explicitly selected missing implementation', () => {
  const model = {
    specificationVersion: 'v2' as const,
    modelId: 'fixture',
    provider: 'fixture',
    doGenerate: vi.fn(),
  };
  expect(new AiSdkModel(model).stream).toBeUndefined();
  expect(() => new AiSdkModel(model, {}, { stream: true })).toThrow(
    'requires doStream',
  );
});

it('preserves the existing thought-signature refusal on streamed text metadata', async () => {
  const model = adapter([
    {
      type: 'text-delta',
      id: 'one',
      delta: 'opaque',
      providerMetadata: { google: { thoughtSignature: 'unsupported' } },
    },
  ]);
  await expect(Array.fromAsync(model.stream!(request()))).rejects.toThrow(
    'thought signatures',
  );
});
