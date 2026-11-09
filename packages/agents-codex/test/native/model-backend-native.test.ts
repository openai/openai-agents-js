import { createServer } from 'node:http';
import { once } from 'node:events';
import OpenAI from 'openai';
import { expect, it, vi } from 'vitest';
import type { Engine } from '../../native/index.js';
import { binding } from '../../src/runtime/binding';
import { z } from 'zod';
import {
  Agent,
  ChatCompletionsModel,
  NativeProvider,
  tool,
  type ModelRequest,
  type ModelResponse,
} from '../../src';

it('keeps custom model tool calls, results and continuation in native Core', async () => {
  const seen: ModelRequest[] = [];
  const effects: number[] = [];
  const double = tool({
    name: 'double',
    description: 'Double.',
    parameters: z.object({ value: z.number() }),
    execute: ({ value }) => {
      effects.push(value);
      return String(value * 2);
    },
  });
  await using provider = new NativeProvider({
    baseUrl: 'https://example.invalid/v1',
    modelBackend: {
      complete(request): ModelResponse {
        seen.push(request);
        if (seen.length === 1)
          return {
            output: [
              {
                type: 'function_call',
                name: 'double',
                call_id: 'call_double',
                arguments: '{"value":21}',
              },
            ],
            usage: { input_tokens: 3, output_tokens: 2 },
          };
        expect(
          (request.body.input as any[]).some(
            (item) =>
              item.type === 'function_call_output' &&
              JSON.stringify(item.output).includes('42'),
          ),
        ).toBe(true);
        return {
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: '42' }],
            },
          ],
          usage: { input_tokens: 5, output_tokens: 1 },
        };
      },
    },
  });
  const result = await new Agent({
    model: 'custom-model',
    instructions: 'Use double.',
    tools: [double],
    provider,
  }).run('Double21.', { context: { tenant: 'synthetic' } });
  expect(result.finalOutput).toBe('42');
  expect(effects).toEqual([21]);
  expect(seen).toHaveLength(2);
  expect(seen[0].context).toEqual({ tenant: 'synthetic' });
}, 20_000);

it.each([
  [undefined, false],
  ['gpt-5.2', false],
  [undefined, true],
  ['gpt-5.2', true],
] as const)(
  'uses an injected OpenAI Chat client with native model %s and parallel=%s while Core executes tools',
  async (nativeModel, parallel) => {
    const seen: any[] = [];
    const effects: string[] = [];
    const server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      seen.push(body);
      const pending = new Set<string>();
      for (const message of body.messages) {
        if (message.role === 'tool') {
          if (!pending.delete(message.tool_call_id))
            throw new Error('Unexpected Chat tool result');
        } else {
          if (pending.size) {
            response.writeHead(400, { 'content-type': 'application/json' }).end(
              JSON.stringify({
                error: {
                  message: 'Missing tool outputs before next Chat message',
                  type: 'invalid_request_error',
                },
              }),
            );
            return;
          }
          for (const call of message.tool_calls ?? []) pending.add(call.id);
        }
      }
      if (pending.size) throw new Error('Missing final Chat tool outputs');
      const message =
        seen.length === 1
          ? {
              content: parallel ? 'Calling echo twice.' : null,
              tool_calls: [
                {
                  type: 'function',
                  id: 'call_echo',
                  function: {
                    name: 'echo',
                    arguments: '{"value":"from-tool"}',
                  },
                },
                ...(parallel
                  ? [
                      {
                        type: 'function',
                        id: 'call_echo_two',
                        function: {
                          name: 'echo',
                          arguments: '{"value":"second-tool"}',
                        },
                      },
                    ]
                  : []),
              ],
            }
          : { content: 'native chat finished' };
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          id: `chat_${seen.length}`,
          object: 'chat.completion',
          created: 0,
          model: 'chat-model',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', ...message },
              finish_reason: seen.length === 1 ? 'tool_calls' : 'stop',
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected port');
    try {
      const client = new OpenAI({
        apiKey: 'synthetic-key',
        baseURL: `http://127.0.0.1:${address.port}/v1`,
      });
      const echo = tool({
        name: 'echo',
        description: 'Echo.',
        parameters: z.object({ value: z.string() }),
        execute: ({ value }) => {
          effects.push(value);
          return value;
        },
      });
      await using provider = new NativeProvider({
        modelBackend: new ChatCompletionsModel(client, 'chat-model'),
      });
      const result = await new Agent({
        model: nativeModel,
        instructions: 'Use echo.',
        tools: [echo],
        provider,
      }).run('Call echo.');
      expect(result.finalOutput).toBe('native chat finished');
      expect(seen).toHaveLength(2);
      expect(effects.sort()).toEqual(
        parallel ? ['from-tool', 'second-tool'] : ['from-tool'],
      );
      if (parallel) {
        const assistants = seen[1].messages.filter(
          (message: any) => message.role === 'assistant',
        );
        expect(assistants).toHaveLength(1);
        expect(assistants[0].tool_calls.map((call: any) => call.id)).toEqual([
          'call_echo',
          'call_echo_two',
        ]);
        expect(JSON.stringify(assistants[0].content)).toContain(
          'Calling echo twice.',
        );
      }
      expect(seen[0]).toMatchObject({ model: 'chat-model', stream: false });
      expect(
        seen[1].messages.some(
          (item: any) =>
            item.role === 'tool' && item.content.includes('from-tool'),
        ),
      ).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  20_000,
);

it('joins admitted asynchronous model work and discards a late tool call on cancellation', async () => {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const effects: string[] = [];
  const forbidden = tool({
    name: 'forbidden',
    description: 'Forbidden.',
    parameters: z.object({}),
    execute: () => {
      effects.push('called');
      return 'bad';
    },
  });
  await using provider = new NativeProvider({
    modelBackend: {
      async complete() {
        enter();
        await released;
        return {
          output: [
            {
              type: 'function_call',
              name: 'forbidden',
              call_id: 'late',
              arguments: '{}',
            },
          ],
        };
      },
    },
  });
  await using session = await new Agent({
    instructions: 'Answer.',
    tools: [forbidden],
    provider,
  }).session();
  const turn = await session.submit('Begin.');
  await entered;
  let stopped = false;
  const stopping = turn.cancel().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  release();
  await stopping;
  await expect(turn.wait()).rejects.toThrow();
  expect(effects).toEqual([]);
}, 20_000);

it('keeps current producer, instructions and controls on consecutive private roots', async () => {
  const native = await binding();
  const original = native.Engine.prototype._private_start_thread;
  let reused = 0;
  const trace = vi
    .spyOn(native.Engine.prototype, '_private_start_thread')
    .mockImplementation(async function (this: Engine, ...args) {
      const thread = await original.apply(this, args);
      if (thread) reused++;
      return thread;
    });
  const seen: ModelRequest[] = [];
  let stage = 'first';
  const response = (text: string): ModelResponse => ({
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text }],
      },
    ],
  });
  try {
    await using provider = new NativeProvider({
      modelBackend: {
        getModel() {
          const selected = stage;
          return {
            complete(request: ModelRequest) {
              seen.push(request);
              return response(selected);
            },
          };
        },
      },
    });
    const agent = new Agent({
      provider,
      model: 'custom-model',
      instructions: 'Original private instruction.',
      modelSettings: { extraBody: { private_stage: 'first' } },
    });
    expect((await agent.run('first private user marker')).finalOutput).toBe(
      'first',
    );
    stage = 'second';
    agent.instructions = 'Current private instruction.';
    agent.modelSettings = { extraBody: { private_stage: 'second' } };
    expect((await agent.run('second private user marker')).finalOutput).toBe(
      'second',
    );
    expect(reused).toBe(1);
    expect(seen).toHaveLength(2);
    expect(seen[1].sessionId).not.toBe(seen[0].sessionId);
    expect(seen[1].body.private_stage).toBe('second');
    const current = JSON.stringify(seen[1].body);
    expect(current).toContain('Current private instruction.');
    expect(current).toContain('second private user marker');
    expect(current).not.toContain('Original private instruction.');
    expect(current).not.toContain('first private user marker');
  } finally {
    trace.mockRestore();
  }
}, 20_000);

it('joins cancelled producer work on a reused private root before starting another root', async () => {
  const native = await binding();
  const original = native.Engine.prototype._private_start_thread;
  let reused = 0;
  const trace = vi
    .spyOn(native.Engine.prototype, '_private_start_thread')
    .mockImplementation(async function (this: Engine, ...args) {
      const thread = await original.apply(this, args);
      if (thread) reused++;
      return thread;
    });
  let enter!: () => void;
  let release!: () => void;
  let aborted!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const cancelled = new Promise<void>((resolve) => {
    aborted = resolve;
  });
  let calls = 0;
  const seen: ModelRequest[] = [];
  const response = (text: string): ModelResponse => ({
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text }],
      },
    ],
  });
  try {
    await using provider = new NativeProvider({
      modelBackend: {
        async complete(request) {
          seen.push(request);
          if (++calls === 2) {
            request.signal.addEventListener('abort', aborted, { once: true });
            enter();
            await released;
            return response('discarded late private output');
          }
          return response(calls === 1 ? 'warm' : 'fresh');
        },
      },
    });
    const agent = new Agent({
      provider,
      model: 'custom-model',
      instructions: 'Answer.',
    });
    expect((await agent.run('warm private root marker')).finalOutput).toBe(
      'warm',
    );
    const controller = new AbortController();
    let settled = false;
    let failure: unknown;
    const stopping = agent
      .run('cancel private root marker', { signal: controller.signal })
      .then(
        () => {
          settled = true;
        },
        (error) => {
          settled = true;
          failure = error;
        },
      );
    await entered;
    expect(reused).toBe(1);
    controller.abort(new Error('cancel reused producer'));
    await cancelled;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    release();
    await stopping;
    expect(failure).toBeDefined();
    expect((await agent.run('fresh private root marker')).finalOutput).toBe(
      'fresh',
    );
    const fresh = JSON.stringify(seen[2].body);
    expect(fresh).not.toContain('warm private root marker');
    expect(fresh).not.toContain('cancel private root marker');
    expect(fresh).not.toContain('discarded late private output');
  } finally {
    release?.();
    trace.mockRestore();
  }
}, 20_000);

it.each([false, true])(
  'preserves native Chat facts and controls with refusal=%s',
  async (refusal) => {
    const requests: any[] = [];
    const capturedInstructions: unknown[] = [];
    const effects: string[] = [];
    const privateRefusal = 'private-model-refusal';
    const token = {
      token: 'ok',
      bytes: [111, 107],
      logprob: -0.25,
      top_logprobs: [],
    };
    const server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          id: 'chat_facts',
          object: 'chat.completion',
          created: 0,
          model: 'chat-model',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: refusal ? null : 'ok',
                refusal: refusal ? privateRefusal : null,
                tool_calls: refusal
                  ? [
                      {
                        type: 'function',
                        id: 'never',
                        function: {
                          name: 'echo',
                          arguments: '{"value":"never"}',
                        },
                      },
                    ]
                  : null,
              },
              logprobs: refusal ? null : { content: [token] },
            },
          ],
        }),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('Expected port');
    try {
      const adapter = new ChatCompletionsModel(
        new OpenAI({
          apiKey: 'synthetic-key',
          baseURL: `http://127.0.0.1:${address.port}/v1`,
        }),
        'chat-model',
      );
      await using provider = new NativeProvider({
        modelBackend: {
          complete(request: ModelRequest) {
            capturedInstructions.push(
              (request.body.input as any[])
                .filter(
                  (item) =>
                    item.type === 'message' &&
                    ['system', 'developer'].includes(item.role),
                )
                .map((item) => ({
                  role: item.role,
                  content: item.content.map((part: any) => ({
                    type: 'text',
                    text: part.text,
                  })),
                })),
            );
            return adapter.complete(request);
          },
        },
      });
      const echo = tool({
        name: 'echo',
        description: 'Echo.',
        parameters: z.object({ value: z.string() }),
        execute: ({ value }) => {
          effects.push(value);
          return value;
        },
      });
      await using session = await new Agent({
        model: 'gpt-5.2',
        instructions: 'Preserve this exact instruction.',
        modelSettings: {
          verbosity: 'high',
          topLogprobs: 1,
          serviceTier: 'flex',
          promptCacheRetention: '24h',
          promptCacheTtl: '12h',
        },
        tools: [echo],
        provider,
      }).session();
      const turn = await session.submit('answer');
      if (refusal) {
        const error = await turn.wait().then(
          () => {
            throw Error('Refusal accepted');
          },
          (error) => error,
        );
        expect(error.responseIntegrityReason).toBe('provider_refusal');
        expect(String(error)).not.toContain(privateRefusal);
      } else expect((await turn.wait()).finalOutput).toBe('ok');
      const recorded = [];
      for await (const row of session.turns()) recorded.push(row);
      const facts = (recorded[0].responseFacts ?? []).map((row) => row.fact);
      if (refusal) {
        expect(
          facts.some(
            (fact) => fact.kind === 'refusal' && fact.text === privateRefusal,
          ),
        ).toBe(true);
        expect(recorded[0].status).toBe('failed');
      } else
        expect(
          facts.flatMap((fact) =>
            fact.kind === 'text_probabilities' ? fact.tokens : [],
          ),
        ).toEqual([
          { token: 'ok', bytes: [111, 107], logprob: -0.25, topLogprobs: [] },
        ]);
      expect(effects).toEqual([]);
      expect(requests).toHaveLength(1);
      expect(
        requests[0].messages.filter((message: any) =>
          ['system', 'developer'].includes(message.role),
        ),
      ).toEqual(capturedInstructions[0]);
      expect(JSON.stringify(capturedInstructions[0])).toContain(
        'Preserve this exact instruction.',
      );
      expect(requests[0]).toMatchObject({
        verbosity: 'high',
        service_tier: 'flex',
        prompt_cache_retention: '24h',
        prompt_cache_options: { ttl: '12h' },
        logprobs: true,
        top_logprobs: 1,
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
  20_000,
);

it.each(['refusal', 'malformed'] as const)(
  'validates whole completed output before any tool when later item is %s',
  async (later) => {
    const effects: string[] = [];
    const echo = tool({
      name: 'echo',
      description: 'Echo.',
      parameters: z.object({ value: z.string() }),
      execute: ({ value }) => {
        effects.push(value);
        return value;
      },
    });
    await using provider = new NativeProvider({
      modelBackend: {
        complete(): ModelResponse {
          return {
            output: [
              {
                type: 'function_call',
                call_id: 'never',
                name: 'echo',
                arguments: '{"value":"never"}',
              },
              later === 'refusal'
                ? {
                    type: 'message',
                    role: 'assistant',
                    content: [
                      { type: 'refusal', refusal: 'private-later-refusal' },
                    ],
                  }
                : {
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'output_text', text: 7 }],
                  },
            ],
          };
        },
      },
    });
    await using session = await new Agent({
      instructions: 'Answer.',
      tools: [echo],
      provider,
    }).session();
    const turn = await session.submit('answer');
    const error = await turn.wait().then(
      () => {
        throw Error('Invalid output accepted');
      },
      (error) => error,
    );
    expect(error.responseIntegrityReason).toBe(
      later === 'refusal' ? 'provider_refusal' : 'undecodable_output_item',
    );
    expect(effects).toEqual([]);
  },
  20_000,
);

it.each([
  ['length', false],
  ['content_filter', false],
  ['length', true],
  ['content_filter', true],
] as const)(
  'fails Chat finish_reason=%s with refusal=%s before any tool effect',
  async (finishReason, refusal) => {
    const requests: any[] = [];
    const effects: string[] = [];
    const privateRefusal = 'private-terminal-refusal';
    const server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      const first = requests.length === 1;
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          id: `chat_terminal_${requests.length}`,
          object: 'chat.completion',
          created: 0,
          model: 'chat-model',
          choices: [
            {
              index: 0,
              finish_reason: first ? finishReason : 'stop',
              message: {
                role: 'assistant',
                content: first ? 'private-partial-answer' : 'finished',
                refusal: first && refusal ? privateRefusal : null,
                tool_calls: first
                  ? [
                      {
                        type: 'function',
                        id: 'never',
                        function: {
                          name: 'echo',
                          arguments: '{"value":"never"}',
                        },
                      },
                    ]
                  : null,
              },
            },
          ],
        }),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('Expected port');
    try {
      await using provider = new NativeProvider({
        modelBackend: new ChatCompletionsModel(
          new OpenAI({
            apiKey: 'synthetic-key',
            baseURL: `http://127.0.0.1:${address.port}/v1`,
          }),
          'chat-model',
        ),
      });
      const echo = tool({
        name: 'echo',
        description: 'Echo.',
        parameters: z.object({ value: z.string() }),
        execute: ({ value }) => {
          effects.push(value);
          return value;
        },
      });
      await using session = await new Agent({
        model: 'gpt-5.2',
        instructions: 'Answer.',
        tools: [echo],
        provider,
      }).session();
      const turn = await session.submit('answer');
      const error = await turn.wait().then(
        () => undefined,
        (error) => error,
      );
      expect(error).toBeDefined();
      expect(effects).toEqual([]);
      expect(requests).toHaveLength(1);
      expect(String(error)).not.toContain('private-partial-answer');
      const recorded = [];
      for await (const row of session.turns()) recorded.push(row);
      expect(['failed', 'cancelled']).toContain(recorded[0].status);
      if (refusal) {
        expect(recorded[0].status).toBe('failed');
        expect(error.responseIntegrityReason).toBe('provider_refusal');
        expect(
          recorded[0].responseFacts?.some(
            (row) =>
              row.fact.kind === 'refusal' && row.fact.text === privateRefusal,
          ),
        ).toBe(true);
      } else expect(String(error)).toContain(`finish_reason=${finishReason}`);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
  20_000,
);

it.each(['include', 'extraBody'] as const)(
  'forwards admitted Chat text options and probabilities requested through %s',
  async (source) => {
    const requests: any[] = [];
    const token = {
      token: 'ok',
      bytes: [111, 107],
      logprob: -0.5,
      top_logprobs: [],
    };
    const extras = {
      seed: 7,
      stop: ['stop-marker'],
      logit_bias: { '42': -1 },
      user: 'synthetic-user',
      safety_identifier: 'synthetic-safe',
      prediction: { type: 'content', content: 'ok' },
    };
    const server = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          id: 'chat_options',
          object: 'chat.completion',
          created: 0,
          model: 'chat-model',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: 'ok' },
              logprobs: body.logprobs ? { content: [token] } : null,
            },
          ],
        }),
      );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('Expected port');
    try {
      await using provider = new NativeProvider({
        modelBackend: new ChatCompletionsModel(
          new OpenAI({
            apiKey: 'synthetic-key',
            baseURL: `http://127.0.0.1:${address.port}/v1`,
          }),
          'chat-model',
        ),
      });
      await using session = await new Agent({
        model: 'gpt-5.2',
        instructions: 'Answer.',
        modelSettings: {
          include:
            source === 'include' ? ['message.output_text.logprobs'] : undefined,
          extraBody: {
            ...extras,
            ...(source === 'extraBody' ? { logprobs: true } : {}),
          },
        },
        provider,
      }).session();
      expect((await (await session.submit('answer')).wait()).finalOutput).toBe(
        'ok',
      );
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ ...extras, logprobs: true });
      expect(requests[0]).not.toHaveProperty('top_logprobs');
      const recorded = [];
      for await (const row of session.turns()) recorded.push(row);
      // Core requires its topLogprobs opt-in before persisting sensitive probabilities.
      expect(recorded[0].responseFacts ?? []).toEqual([]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
  20_000,
);
