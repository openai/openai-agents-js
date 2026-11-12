import OpenAI from 'openai';
import { createOpenAI } from '@ai-sdk/openai';
import { expect, it } from 'vitest';
import {
  AiSdkModel,
  ResponsesModel,
  captureModelResponse,
  type ModelRequest,
} from '../src/runtime/models';

const request: ModelRequest = {
  body: { model: 'gpt-4.1', input: [] },
  context: null,
  sessionId: 'session',
  turnId: 'turn',
  signal: new AbortController().signal,
};

it.each(['responses', 'ai-sdk-responses'] as const)(
  'captures explicit cache-write availability through the real %s adapter',
  async (adapter) => {
    for (const cacheWrite of [4, 0, undefined, Number.MAX_SAFE_INTEGER]) {
      const raw = {
        id: 'resp_cache',
        status: 'completed',
        output: [],
        usage: {
          input_tokens: 10,
          input_tokens_details: {
            cached_tokens: 2,
            ...(cacheWrite === undefined
              ? {}
              : { cache_write_tokens: cacheWrite }),
          },
          output_tokens: 3,
          output_tokens_details: { reasoning_tokens: 1 },
          total_tokens: 13,
        },
      };
      const options = {
        apiKey: 'synthetic',
        fetch: async () =>
          new Response(JSON.stringify(raw), {
            headers: { 'content-type': 'application/json' },
          }),
      };
      const model =
        adapter === 'responses'
          ? new ResponsesModel(new OpenAI(options))
          : new AiSdkModel(createOpenAI(options).responses('gpt-4.1'));
      const result = await model.complete(request);
      const captured = captureModelResponse(result);
      expect(captured.usage).toMatchObject({
        input_tokens: 10,
        cache_write_input_tokens: cacheWrite ?? 0,
        total_tokens: 13,
      });
      expect(captured).not.toHaveProperty('original_usage');
      expect(captured.received_cache_write_usage).toEqual({
        count: cacheWrite ?? null,
      });
      expect(captureModelResponse(result, true)).toMatchObject({
        original_usage: { response_id: 'resp_cache', usage: raw.usage },
      });
    }
  },
);

it.each(['responses', 'ai-sdk-responses'] as const)(
  'keeps %s extension getters unread with raw off and unchanged with raw on',
  async (adapter) => {
    let reads = 0;
    const usage = {
      input_tokens_details: { cache_write_tokens: 0 },
      get provider_extension() {
        reads++;
        return { private: 'synthetic' };
      },
    };
    const raw: {
      id?: string;
      status: string;
      output: [];
      usage?: typeof usage;
    } = {
      id: 'resp_getter',
      status: 'completed',
      output: [],
      usage,
    };
    const model =
      adapter === 'responses'
        ? new ResponsesModel({ responses: { create: async () => raw } })
        : new AiSdkModel({
            specificationVersion: 'v3',
            provider: 'openai.responses',
            modelId: 'gpt-4.1',
            doGenerate: async () => ({
              content: [],
              finishReason: { unified: 'stop' },
              response: { body: raw },
            }),
          });
    const result = await model.complete(request);
    expect(captureModelResponse(result)).toMatchObject({
      response_id: 'resp_getter',
      received_cache_write_usage: { count: 0 },
    });
    expect(reads).toBe(0);
    expect(captureModelResponse(result, true)).toMatchObject({
      original_usage: {
        response_id: 'resp_getter',
        usage: { provider_extension: { private: 'synthetic' } },
      },
    });
    expect(reads).toBeGreaterThan(0);
    reads = 0;
    delete raw.id;
    const unidentified = await model.complete(request);
    expect(captureModelResponse(unidentified)).toMatchObject({
      response_id: expect.any(String),
      received_cache_write_usage: { count: 0 },
    });
    expect(captureModelResponse(unidentified, true)).not.toHaveProperty(
      'original_usage',
    );
    expect(reads).toBe(0);
    delete raw.usage;
    const absent = captureModelResponse(await model.complete(request));
    expect(absent.usage).toBeNull();
    expect(absent.received_cache_write_usage).toEqual({ count: null });
  },
);

it('keeps incomplete refusal usage partial without raw capture', async () => {
  const model = new ResponsesModel({
    responses: {
      create: async () => ({
        status: 'incomplete',
        output: [
          {
            type: 'message',
            content: [{ type: 'refusal', refusal: 'synthetic' }],
          },
        ],
        usage: { input_tokens_details: { cache_write_tokens: 4 } },
      }),
    },
  });
  const result = await model.complete(request);
  expect(captureModelResponse(result)).toMatchObject({
    received_cache_write_usage: { count: 4 },
  });
  expect(captureModelResponse(result, true)).not.toHaveProperty(
    'original_usage',
  );
});

it('keeps generic custom replies on their existing accounting path', () => {
  for (const cacheWrite of [4, 0, undefined]) {
    const captured = captureModelResponse({
      output: [],
      usage:
        cacheWrite === undefined
          ? {}
          : { cache_write_input_tokens: cacheWrite },
    });
    expect(captured.usage).toMatchObject({
      cache_write_input_tokens: cacheWrite ?? 0,
    });
    expect(captured).not.toHaveProperty('received_cache_write_usage');
  }
});

it('does not accept a public-looking string property as adapter-owned availability', () => {
  const response = {
    output: [],
    usage: { cache_write_input_tokens: 4 },
    received_cache_write_usage: { count: 4 },
  };
  expect(captureModelResponse(response)).not.toHaveProperty(
    'received_cache_write_usage',
  );
});
