import { createServer, type Server } from 'node:http';
import OpenAI from 'openai';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent, OpenAIDecisions, DecisionError } from '../src';

// Transport tests isolate the shared native compiler; native callback tests use the real compiler.
const compiler = vi.hoisted(() => ({
  _decision_questions: vi.fn(),
  _decision_result: vi.fn(),
}));
vi.mock('../src/runtime/binding', async (original) => ({
  ...(await original<typeof import('../src/runtime/binding')>()),
  binding: async () => compiler,
}));
const servers: Server[] = [];
const requests: { path: string; body: Record<string, unknown> }[] = [];
const usage = { input_tokens: 7, output_tokens: 3, total_tokens: 10 };
async function endpoint(body: unknown) {
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      path: request.url!,
      body: JSON.parse(Buffer.concat(chunks).toString()),
    });
    response.writeHead(200, {
      'content-type': 'application/json',
      'x-request-id': 'physical-request',
    });
    response.end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Missing fixture address');
  return new OpenAI({
    apiKey: 'synthetic',
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    maxRetries: 0,
  });
}
beforeEach(() => {
  requests.length = 0;
  compiler._decision_questions.mockReset().mockReturnValue(
    JSON.stringify({
      supported: true,
      questions: [{ name: 'field_1', type: 'boolean', question: 'Ready?' }],
    }),
  );
  compiler._decision_result
    .mockReset()
    .mockReturnValue(JSON.stringify({ response: true }));
});
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
    ),
  );
});
it('sends one Decisions request and normalizes completed metadata', async () => {
  const client = await endpoint({
    answers: [{ name: 'field_1' }],
    usage,
    model: 'resolved-decision-model',
  });
  const provider = new OpenAIDecisions({ client });
  const response = await provider.getDecision(
    {
      question: 'Ready?',
      input: 'Explicit input.',
      outputSchema: { type: 'boolean' },
    },
    {},
  );
  expect(response.value).toEqual({ response: true });
  expect(requests).toEqual([
    {
      path: '/v1/decisions',
      body: {
        model: 'gpt-6-luna',
        input: 'Explicit input.',
        questions: [{ name: 'field_1', type: 'boolean', question: 'Ready?' }],
      },
    },
  ]);
  expect(response).toMatchObject({
    requestId: 'physical-request',
    model: 'resolved-decision-model',
    usage: {
      inputTokens: 7,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 3,
      reasoningOutputTokens: 0,
      totalTokens: 10,
    },
  });
});
it('resolves constant-only output locally with known zero usage', async () => {
  compiler._decision_questions.mockReturnValue(
    JSON.stringify({ supported: true, questions: [] }),
  );
  const provider = new OpenAIDecisions({ client: await endpoint(null) });
  const response = await provider.getDecision(
    { question: 'Ready?', input: 'Explicit.', outputSchema: { const: true } },
    {},
  );
  expect(response.usage?.totalTokens).toBe(0);
  expect(requests).toHaveLength(0);
  expect(compiler._decision_result).toHaveBeenCalledWith(
    JSON.stringify({ const: true }),
    'Ready?',
    '[]',
  );
});
it('rejects unsupported schemas before dispatch without explicit fallback', async () => {
  compiler._decision_questions.mockReturnValue(
    JSON.stringify({ supported: false, questions: [] }),
  );
  const provider = new OpenAIDecisions({ client: await endpoint(null) });
  await expect(
    new Agent({ instructions: 'Answer.', decisions: provider }).decide(
      'Summarize.',
      {
        input: 'Explicit.',
        outputType: z.string(),
      },
    ),
  ).rejects.toBeInstanceOf(TypeError);
  expect(requests).toHaveLength(0);
});
it.each(['completed', 'incomplete', undefined])(
  'selects explicit Responses fallback before inference and checks completion status=%s',
  async (status) => {
    compiler._decision_questions.mockReturnValue(
      JSON.stringify({ supported: false, questions: [] }),
    );
    const provider = new OpenAIDecisions({
      client: await endpoint({
        status,
        usage,
        model: 'resolved-fallback',
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: '{"response":"summary"}' }],
          },
        ],
      }),
      fallbackModel: 'generative-alias',
    });
    const result = new Agent({
      instructions: 'Answer.',
      decisions: provider,
    }).decide('Summarize.', {
      input: [{ role: 'user', content: 'Original input.' }],
      outputType: z.string(),
    });
    if (status === 'completed') await expect(result).resolves.toBe('summary');
    else
      await expect(result).rejects.toMatchObject({
        reason: 'invalid_response',
        requestId: 'physical-request',
        model: 'resolved-fallback',
        usage: { totalTokens: 10 },
      });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      path: '/v1/responses',
      body: {
        model: 'generative-alias',
        instructions: 'Summarize.',
        input: [{ role: 'user', content: 'Original input.' }],
        stream: false,
        text: { format: { type: 'json_schema', strict: true } },
      },
    });
    expect(compiler._decision_result).not.toHaveBeenCalled();
  },
);
it.each(['Decisions refused a question', 'invalid Decisions answer'])(
  'retains known completion metadata without fallback on %s',
  async (message) => {
    compiler._decision_result.mockImplementation(() => {
      throw new Error(message);
    });
    const provider = new OpenAIDecisions({
      client: await endpoint({ answers: [], usage, model: 'resolved' }),
      fallbackModel: 'generative-alias',
    });
    const failure = await new Agent({
      instructions: 'Answer.',
      decisions: provider,
    })
      .decide('Ready?', { input: 'PRIVATE_INPUT' })
      .catch((error) => error);
    expect(failure).toBeInstanceOf(DecisionError);
    expect(failure).toMatchObject({
      reason: message.startsWith('Decisions refused')
        ? 'refusal'
        : 'invalid_response',
      requestId: 'physical-request',
      model: 'resolved',
      usage: { totalTokens: 10 },
    });
    expect(String(failure)).not.toContain('PRIVATE_INPUT');
    expect(requests.map((request) => request.path)).toEqual(['/v1/decisions']);
  },
);
it('reports a malformed completed body safely with its request receipt', async () => {
  compiler._decision_result.mockImplementation(() => {
    throw new Error('invalid Decisions answer');
  });
  const provider = new OpenAIDecisions({ client: await endpoint(null) });
  await expect(
    new Agent({ instructions: 'Answer.', decisions: provider }).decide(
      'Ready?',
      { input: 'Explicit.' },
    ),
  ).rejects.toMatchObject({
    reason: 'invalid_response',
    requestId: 'physical-request',
  });
});

const usageContainerCases: { label: string; raw: unknown; known: boolean }[] = [
  ...['input_tokens_details', 'output_tokens_details'].flatMap((field) =>
    ['', 'invalid', false, true, 0, 1, [], [{}]].map((details) => ({
      label: `${field}=${JSON.stringify(details)}`,
      raw: { ...usage, [field]: details },
      known: false,
    })),
  ),
  ...[
    ['input_tokens_details', 'cached_tokens'],
    ['input_tokens_details', 'cache_write_tokens'],
    ['output_tokens_details', 'reasoning_tokens'],
  ].map(([field, counter]) => ({
    label: `${field}.${counter}=null`,
    raw: { ...usage, [field]: { [counter]: null } },
    known: false,
  })),
  { label: 'top-level usage array', raw: [], known: false },
  ...[undefined, null].flatMap((input) =>
    [undefined, null].map((output) => ({
      label: `accepted input=${input}, output=${output}`,
      raw: {
        ...usage,
        input_tokens_details: input,
        output_tokens_details: output,
      },
      known: true,
    })),
  ),
  {
    label: 'empty detail objects',
    raw: { ...usage, input_tokens_details: {}, output_tokens_details: {} },
    known: true,
  },
];
it.each(usageContainerCases)(
  'preserves a valid decision while validating usage containers: $label',
  async ({ raw, known }) => {
    const provider = new OpenAIDecisions({
      client: await endpoint({ answers: [], usage: raw, model: 'resolved' }),
    });
    const response = await provider.getDecision(
      {
        question: 'Ready?',
        input: 'Explicit.',
        outputSchema: { type: 'boolean' },
      },
      {},
    );
    expect(response).toMatchObject({
      value: { response: true },
      requestId: 'physical-request',
      model: 'resolved',
    });
    if (known)
      expect(response.usage).toEqual({
        inputTokens: 7,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 3,
        reasoningOutputTokens: 0,
        totalTokens: 10,
      });
    else expect(response.usage).toBeUndefined();
    expect(requests.map((request) => request.path)).toEqual(['/v1/decisions']);
  },
);
