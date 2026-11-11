import { expect, it } from 'vitest';
import {
  ResponsesModel,
  captureModelResponse,
  type ModelRequest,
} from '../src/runtime/models';

it('serializes original Responses usage only at the enabled capture boundary', async () => {
  let reads = 0;
  const usage = {
    input_tokens: 3,
    output_tokens: 2,
    total_tokens: 5,
    get provider_extension() {
      reads++;
      return { enabled: false, values: [0, null, 'original'] };
    },
  };
  const model = new ResponsesModel({
    responses: {
      create: async () => ({
        id: 'resp_original',
        status: 'completed',
        _request_id: 'req_original',
        output: [],
        usage,
      }),
    },
  });
  const request: ModelRequest = {
    body: { model: 'synthetic-routing-hint' },
    context: null,
    sessionId: 'session',
    turnId: 'turn',
    signal: new AbortController().signal,
  };
  const response = await model.complete(request);
  expect(reads).toBe(0);
  expect(captureModelResponse(response)).not.toHaveProperty('original_usage');
  expect(reads).toBe(0);
  expect(captureModelResponse(response, true)).toMatchObject({
    original_usage: {
      response_id: 'resp_original',
      upstream_request_id: 'req_original',
      usage: {
        provider_extension: { enabled: false, values: [0, null, 'original'] },
      },
    },
  });
  expect(reads).toBeGreaterThan(0);
});

it('keeps an accepted missing-ID completion when raw capture is enabled', async () => {
  const model = new ResponsesModel({
    responses: {
      create: async () => ({
        status: 'completed',
        output: [],
        usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      }),
    },
  });
  const response = await model.complete({
    body: {},
    context: null,
    sessionId: 'session',
    turnId: 'turn',
    signal: new AbortController().signal,
  });
  const captured = captureModelResponse(response, true);
  expect(captured).not.toHaveProperty('original_usage');
  expect(captured).toMatchObject({
    response_id: expect.any(String),
    usage: { total_tokens: 5 },
  });
});
