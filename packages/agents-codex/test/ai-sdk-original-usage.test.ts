import { expect, it } from 'vitest';
import { copyJsonValue, type JsonObject } from '../src/runtime/binding';
import {
  AiSdkModel,
  captureModelResponse,
  markRawUsageRequest,
  isAiSdkModelStream,
  markRawProviderRequest,
  captureAiSdkOriginalUsageFrame,
  type AiSdkLanguageModel,
  type ModelRequest,
} from '../src/runtime/models';
function request() {
  return {
    body: { model: 'usage-fixture', input: [] },
    context: null,
    sessionId: 'usage',
    turnId: 'turn',
    signal: new AbortController().signal,
  } satisfies ModelRequest;
}
function fixture(id?: string) {
  const usage = {
    inputTokens: { total: 3, cacheRead: 1, cacheWrite: undefined },
    outputTokens: { total: 2, text: 2 },
    raw: { nested: [0, null, false] },
  };
  const result = {
    content: [{ type: 'text', text: 'accepted' }],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage,
    ...(id ? { response: { id } } : {}),
  };
  const parts = [
    ...(id ? [{ type: 'response-metadata', id }] : []),
    { type: 'text-start', id: 'text' },
    { type: 'text-delta', id: 'text', delta: 'accepted' },
    { type: 'text-end', id: 'text' },
    { type: 'finish', finishReason: result.finishReason, usage },
  ];
  const model: AiSdkLanguageModel = {
    specificationVersion: 'v3',
    provider: 'fixture',
    modelId: 'usage-fixture',
    doGenerate() {
      return result;
    },
    doStream() {
      return {
        stream: new ReadableStream({
          start(c) {
            for (const p of parts) c.enqueue(p);
            c.close();
          },
        }),
      };
    },
  };
  return { model, usage };
}
it('keeps strict JSON copying by default and omits only undefined object properties when requested', () => {
  const value = {
    a: undefined,
    nested: { b: undefined, values: [0, null, false] },
  };
  expect(() => copyJsonValue(value)).toThrow();
  expect(copyJsonValue(value, new Set(), true)).toEqual({
    nested: { values: [0, null, false] },
  });
  for (const bad of [
    [undefined],
    Array(1),
    { x: NaN },
    { x: Infinity },
    new Date(),
  ])
    expect(() => copyJsonValue(bad, new Set(), true)).toThrow();
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  expect(() => copyJsonValue(cyclic, new Set(), true)).toThrow();
});
it.each([undefined, 'provider-real'])(
  'binds detached buffered original usage to its canonical response without inventing provider identity: %s',
  async (id) => {
    const f = fixture(id),
      req = request();
    markRawUsageRequest(req);
    const result = await new AiSdkModel(f.model).complete(req);
    f.usage.raw.nested[0] = 99;
    const data = captureModelResponse(result, true);
    const original = data.original_usage as JsonObject;
    expect(original.ai_sdk).toBe(true);
    expect(original.provider_response_id).toBe(id ?? null);
    expect(original.response_id).toBe(data.response_id);
    expect(original.usage).toEqual({
      inputTokens: { total: 3, cacheRead: 1 },
      outputTokens: { total: 2, text: 2 },
      raw: { nested: [0, null, false] },
    });
    expect(captureModelResponse(result, false)).not.toHaveProperty(
      'original_usage',
    );
    expect(result.responseId).toBe(id);
  },
);
it('keeps opt-out from retaining any original carrier', async () => {
  const f = fixture('provider-real'),
    result = await new AiSdkModel(f.model).complete(request());
  expect(captureModelResponse(result, true)).not.toHaveProperty(
    'original_usage',
  );
});
it('captures original usage before an awaited output mapper can mutate borrowed data', async () => {
  const f = fixture('provider-real'),
    req = request();
  markRawUsageRequest(req);
  const adapter = new AiSdkModel(
    f.model,
    {},
    {
      transformOutputText: async (text) => {
        f.usage.raw.nested[0] = 99;
        await Promise.resolve();
        return text;
      },
    },
  );
  const data = captureModelResponse(await adapter.complete(req), true);
  expect(((data.original_usage as JsonObject).usage as JsonObject).raw).toEqual(
    { nested: [0, null, false] },
  );
});
it.each([undefined, 'provider-real'])(
  'keeps streamed original usage in a private owner-bound completion sidecar: %s',
  async (id) => {
    const f = fixture(id),
      req = request();
    markRawUsageRequest(req);
    const adapter = new AiSdkModel(f.model, {}, { stream: true });
    let completed: JsonObject | undefined;
    const stream = adapter.stream!(req);
    expect(isAiSdkModelStream(stream)).toBe(true);
    for await (const e of stream)
      if (e.type === 'response.completed') completed = e;
    expect(completed).toBeDefined();
    const event = completed!;
    expect(event).not.toHaveProperty('__sdk_ai_sdk_original_usage');
    const encoded = JSON.stringify(event),
      wire = JSON.parse(captureAiSdkOriginalUsageFrame(encoded, event));
    const original = wire.__sdk_ai_sdk_original_usage;
    expect(original.response_id).toBe((event.response as JsonObject).id);
    expect(original.provider_response_id).toBe(id ?? null);
    expect(original.usage.raw).toEqual({ nested: [0, null, false] });
    event.extra = 'changed';
    expect(() =>
      captureAiSdkOriginalUsageFrame(JSON.stringify(event), event),
    ).toThrow('changed before settlement');
  },
);
it('reports terminal usage before a raw-finish consumer can retire the iterator', async () => {
  const f = fixture('provider-real'),
    reports: unknown[] = [],
    req: ModelRequest = { ...request(), reportUsage: (u) => reports.push(u) };
  markRawProviderRequest(req);
  const iterator = new AiSdkModel(f.model, {}, { stream: true }).stream!(req)[
    Symbol.asyncIterator
  ]();
  try {
    for (;;) {
      const next = await iterator.next();
      if (next.done) throw Error('missing finish');
      if (next.value.type === 'finish') break;
    }
    expect(reports).toEqual([
      {
        inputTokens: 3,
        cachedInputTokens: 1,
        cacheWriteInputTokens: 0,
        outputTokens: 2,
        reasoningOutputTokens: 0,
        totalTokens: 5,
      },
    ]);
  } finally {
    await iterator.return?.();
  }
});

it('discards invalid optional raw data without changing valid normalized output', async () => {
  const f = fixture('provider-real'),
    req = request();
  markRawUsageRequest(req);
  Object.assign(f.usage.raw, { invalid: Infinity });
  const result = await new AiSdkModel(f.model).complete(req);
  expect(result.usage).toMatchObject({
    input_tokens: 3,
    output_tokens: 2,
    total_tokens: 5,
  });
  expect(captureModelResponse(result, true)).not.toHaveProperty(
    'original_usage',
  );
});

it.each([undefined, 'provider-real'])(
  'keeps captured provider identity after the caller changes the buffered response: %s',
  async (id) => {
    const req = request();
    markRawUsageRequest(req);
    const response = await new AiSdkModel(fixture(id).model).complete(req);
    Object.assign(response, { responseId: 'forged-provider-id' });
    const captured = captureModelResponse(response, true);
    expect((captured.original_usage as JsonObject).provider_response_id).toBe(
      id ?? null,
    );
    expect(captured.response_id).toBe('forged-provider-id');
  },
);
