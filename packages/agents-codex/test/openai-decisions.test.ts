import OpenAI from 'openai';
import { afterEach, expect, it, vi } from 'vitest';
import { Agent, OpenAIDecisions, DecisionError } from '../src';

const compiler = vi.hoisted(() => ({
  _decision_questions: vi.fn(),
  _decision_result: vi.fn(),
}));
vi.mock('../src/runtime/binding', async (original) => ({
  ...(await original<typeof import('../src/runtime/binding')>()),
  binding: async () => compiler,
}));
afterEach(() => {
  compiler._decision_questions.mockReset();
  compiler._decision_result.mockReset();
});
function setup(
  body: string,
  headers: Record<string, string> = {},
  status = 200,
) {
  const fetch = vi.fn(
    async () =>
      new Response(body, {
        status,
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'physical-request',
          ...headers,
        },
      }),
  );
  const client = new OpenAI({ apiKey: 'synthetic', maxRetries: 0, fetch });
  compiler._decision_questions.mockReturnValue(
    JSON.stringify({
      supported: true,
      questions: [{ name: 'ready', type: 'predicate', instructions: 'Ready?' }],
    }),
  );
  compiler._decision_result.mockReturnValue('true');
  return { client, fetch, provider: new OpenAIDecisions({ client }) };
}
const request = {
  question: 'Ready?',
  input: 'Explicit.',
  outputSchema: { type: 'boolean' },
};
const usage = { input_tokens: 7, output_tokens: 3, total_tokens: 10 };
it('uses generated Decisions create and captures normalized metadata', async () => {
  const { provider, fetch, client } = setup(
    JSON.stringify({
      answers: [{ name: 'ready', type: 'predicate', probability: 1 }],
      usage,
      model: 'resolved',
    }),
  );
  const create = client.decisions.create.bind(client.decisions);
  const calls: Parameters<typeof create>[] = [];
  client.decisions.create = (...args) => {
    calls.push(args);
    return create(...args);
  };
  const response = await provider.getDecision(request, {});
  expect(calls).toEqual([
    [
      {
        model: 'gpt-6-luna',
        input: 'Explicit.',
        questions: [
          { name: 'ready', type: 'predicate', instructions: 'Ready?' },
        ],
      },
      { signal: undefined },
    ],
  ]);
  expect(response).toEqual({
    value: true,
    requestId: 'physical-request',
    model: 'resolved',
    usage: {
      inputTokens: 7,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 3,
      reasoningOutputTokens: 0,
      totalTokens: 10,
    },
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it('rejects unsupported schemas locally without another transport', async () => {
  const { provider, fetch } = setup('{}');
  compiler._decision_questions.mockReturnValue(
    JSON.stringify({ supported: false, questions: [] }),
  );
  await expect(provider.getDecision(request, {})).rejects.toThrow(
    'Unsupported Decisions output schema',
  );
  expect(fetch).not.toHaveBeenCalled();
});
it('resolves constant schemas without a model request', async () => {
  const { provider, fetch } = setup('{}');
  compiler._decision_questions.mockReturnValue(
    JSON.stringify({ supported: true, questions: [] }),
  );
  const response = await provider.getDecision(request, {});
  expect(response.value).toBe(true);
  expect(response.usage?.totalTokens).toBe(0);
  expect(fetch).not.toHaveBeenCalled();
});
it.each(['{"PRIVATE_BODY":', 'not JSON PRIVATE_BODY', 'null', '[]'])(
  'sanitizes malformed successful bodies and retains the request header',
  async (body) => {
    const { provider } = setup(body);
    const error = await provider
      .getDecision(request, {})
      .catch((error) => error);
    expect(error).toBeInstanceOf(DecisionError);
    expect(error.reason).toBe('invalid_response');
    expect(error.requestId).toBe('physical-request');
    expect(error.cause).toBeUndefined();
    expect(error.message + error.stack + JSON.stringify(error)).not.toContain(
      'PRIVATE_BODY',
    );
  },
);
it.each(['Decisions refused a question', 'PRIVATE_ANSWER_DETAILS'])(
  'sanitizes answer interpretation and preserves completed usage',
  async (message) => {
    const { provider } = setup(JSON.stringify({ answers: [], usage }));
    compiler._decision_result.mockImplementation(() => {
      throw new Error(message);
    });
    const error = await provider
      .getDecision(request, {})
      .catch((error) => error);
    expect(error).toBeInstanceOf(DecisionError);
    expect(error.reason).toBe(
      message.startsWith('Decisions refused') ? 'refusal' : 'invalid_response',
    );
    expect(error.usage?.totalTokens).toBe(10);
    expect(error.requestId).toBe('physical-request');
    expect(error.message).not.toContain('PRIVATE_ANSWER_DETAILS');
    expect(error.cause).toBeUndefined();
  },
);
it('keeps body-read cancellation distinct from malformed JSON', async () => {
  const controller = new AbortController(),
    reason = new Error('application cancelled');
  const { provider, client } = setup('{}');
  vi.spyOn(client.decisions, 'create').mockReturnValue({
    asResponse: async () => ({
      headers: new Headers({ 'x-request-id': 'physical-request' }),
      json: async () => {
        controller.abort(reason);
        throw reason;
      },
    }),
  } as unknown as ReturnType<typeof client.decisions.create>);
  await expect(
    provider.getDecision(request, { signal: controller.signal }),
  ).rejects.toBe(reason);
});
it('uses direct scalar provider values through Agent.decide', async () => {
  const { provider } = setup(JSON.stringify({ answers: [] }));
  await expect(
    new Agent({ instructions: 'Answer.', decisions: provider }).decide(
      'Ready?',
      { input: 'Explicit.' },
    ),
  ).resolves.toBe(true);
});

it.each([
  { label: 'missing', raw: undefined, total: undefined },
  {
    label: 'zero',
    raw: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    total: 0,
  },
  {
    label: 'inconsistent',
    raw: { ...usage, total_tokens: 11 },
    total: undefined,
  },
  {
    label: 'invalid nested count',
    raw: { ...usage, input_tokens_details: { cached_tokens: 8 } },
    total: undefined,
  },
  {
    label: 'lossless large count',
    raw: {
      input_tokens: '9007199254740993',
      output_tokens: 0,
      total_tokens: '9007199254740993',
    },
    total: 9007199254740993n,
  },
])('keeps $label provider usage distinct', async ({ raw, total }) => {
  const { provider } = setup(JSON.stringify({ answers: [], usage: raw }));
  expect((await provider.getDecision(request, {})).usage?.totalTokens).toBe(
    total,
  );
});
it('preserves generated client transport errors', async () => {
  const { provider } = setup(
    JSON.stringify({ error: { message: 'rate limited' } }),
    {},
    429,
  );
  const error = await provider.getDecision(request, {}).catch((error) => error);
  expect(error).toBeInstanceOf(OpenAI.APIError);
  expect(error).not.toBeInstanceOf(DecisionError);
  expect(error.status).toBe(429);
  expect(error.requestID).toBe('physical-request');
});
