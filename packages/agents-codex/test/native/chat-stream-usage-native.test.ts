import { expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, ChatCompletionsModel, NativeProvider, tool } from '../../src';

it.each([true, false])(
  'streams Chat text and requests terminal usage=%s through native execution',
  async (includeUsage) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let terminal = false;
    let sent: any;
    const client = {
      chat: {
        completions: {
          async *create(body: any) {
            sent = body;
            yield {
              id: 'chat-native',
              choices: [
                {
                  index: 0,
                  delta: { role: 'assistant', content: 'Native stream' },
                  finish_reason: null,
                },
              ],
            };
            await gate;
            terminal = true;
            yield {
              id: 'chat-native',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            };
            if (includeUsage)
              yield {
                id: 'chat-native',
                choices: [],
                usage: {
                  prompt_tokens: 5,
                  completion_tokens: 2,
                  total_tokens: 7,
                  prompt_tokens_details: { cached_tokens: 3 },
                  completion_tokens_details: { reasoning_tokens: 1 },
                },
              };
          },
        },
      },
    };
    await using provider = new NativeProvider({
      modelBackend: new ChatCompletionsModel(client, 'chat-model', {
        stream: true,
        includeUsage,
      }),
    });
    await using session = await new Agent({
      instructions: 'Answer.',
      model: 'fixture-stream-model',
      provider,
    }).session();
    const turn = await session.submit('Hello');
    try {
      for await (const event of turn.events())
        if (event.type === 'output_text_delta') {
          expect(event.delta).toBe('Native stream');
          expect(terminal).toBe(false);
          break;
        }
    } finally {
      release();
    }
    expect((await turn.wait()).finalOutput).toBe('Native stream');
    expect(sent).toMatchObject({ stream: true });
    if (includeUsage)
      expect(sent).toMatchObject({ stream_options: { include_usage: true } });
    else expect(sent).not.toHaveProperty('stream_options');
    const responses = [];
    for await (const turn of session.turns())
      responses.push(...(turn.responses ?? []));
    expect(responses).toHaveLength(1);
    if (includeUsage)
      expect(responses[0]).toMatchObject({
        responseId: 'chat-native',
        usageSource: 'received',
        usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      });
    else
      expect(responses[0]).toMatchObject({
        responseId: 'chat-native',
        usage: null,
      });
  },
  20_000,
);

it.each([true, false])(
  'observes original Chat chunks only when requested (%s)',
  async (includeRawProviderEvents) => {
    const chunks = [
      {
        id: 'raw-chat-stream',
        object: 'chat.completion.chunk',
        choices: [
          { index: 0, delta: { content: 'Original' }, finish_reason: 'stop' },
        ],
        vendor: { sequence: 1, fields: ['opaque', null] },
      },
      {
        id: 'raw-chat-stream',
        object: 'chat.completion.chunk',
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        vendor: { sequence: 2 },
      },
    ];
    const client = {
      chat: {
        completions: {
          async *create() {
            yield* chunks;
          },
        },
      },
    };
    await using provider = new NativeProvider({
      modelBackend: new ChatCompletionsModel(client, 'chat-model', {
        stream: true,
      }),
    });
    await using session = await new Agent({
      instructions: 'Answer.',
      model: 'fixture-stream-model',
      provider,
    }).session({ includeRawProviderEvents });
    const turn = await session.submit('Begin.');
    expect((await turn.wait()).finalOutput).toBe('Original');
    const raw = [];
    for await (const event of turn.events({ includeExecutionDetails: true })) {
      if (event.type === 'raw_provider_event')
        raw.push({
          source: event.source,
          transport: event.transport,
          payload: event.payload,
        });
    }
    expect(raw).toEqual(
      includeRawProviderEvents
        ? chunks.map((payload) => ({
            source: 'chat_completions',
            transport: 'json',
            payload,
          }))
        : [],
    );
  },
  20_000,
);

it.each(['cleanup failure', 'cancel', 'timeout'] as const)(
  'retains Chat usage after %s while withholding tools',
  async (retirement) => {
    const accounted = Promise.withResolvers<void>();
    const cleaning = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const cleanupError = new Error('synthetic Chat cleanup failure');
    let effects = 0;
    const record = tool({
      name: 'record',
      parameters: z.object({}),
      execute() {
        effects++;
        return 'recorded';
      },
    });
    const client = {
      chat: {
        completions: {
          async *create(_body: unknown, { signal }: { signal: AbortSignal }) {
            try {
              yield {
                id: 'retired-chat-usage',
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: 'withheld-record',
                          type: 'function',
                          function: { name: 'record', arguments: '{}' },
                        },
                      ],
                    },
                    finish_reason: 'tool_calls',
                  },
                ],
              };
              yield {
                id: 'retired-chat-usage',
                choices: [],
                usage: {
                  prompt_tokens: 3,
                  completion_tokens: 2,
                  total_tokens: 5,
                  prompt_tokens_details: { cached_tokens: 1 },
                  completion_tokens_details: { reasoning_tokens: 1 },
                },
              };
              accounted.resolve();
              if (retirement === 'cleanup failure') throw cleanupError;
              if (!signal.aborted)
                await new Promise<void>((resolve) =>
                  signal.addEventListener('abort', () => resolve(), {
                    once: true,
                  }),
                );
            } finally {
              cleaning.resolve();
              await release.promise;
            }
          },
        },
      },
    };
    await using provider = new NativeProvider({
      modelBackend: new ChatCompletionsModel(client, 'chat-model', {
        stream: true,
      }),
    });
    await using session = await new Agent({
      instructions: 'Use record.',
      model: 'fixture-stream-model',
      modelSettings:
        retirement === 'timeout' ? { invocationTimeoutMs: 1000 } : {},
      provider,
      tools: [record],
    }).session();
    const turn = await session.submit('Begin.');
    const completion = turn.wait();
    void completion.catch(() => {});
    let cancellation: Promise<void> | undefined;
    try {
      await accounted.promise;
      if (retirement === 'cancel') cancellation = turn.cancel();
      await cleaning.promise;
      expect(effects).toBe(0);
    } finally {
      release.resolve();
    }
    await cancellation;
    if (retirement === 'cleanup failure')
      await expect(completion).rejects.toBe(cleanupError);
    else await expect(completion).rejects.toThrow();
    expect(effects).toBe(0);
    const usage = {
      requests: 1,
      missingUsageRequests: 0,
      inputTokens: 3,
      cachedInputTokens: 1,
      outputTokens: 2,
      reasoningOutputTokens: 1,
      totalTokens: 5,
    };
    expect(turn.runUsage).toMatchObject(usage);
    const turns = [];
    for await (const recorded of session.turns()) turns.push(recorded);
    expect(turns).toHaveLength(1);
    expect(turns[0].runUsage).toMatchObject(usage);
  },
  20_000,
);

it('settles fragmented Chat tool calls only after iterator completion and replays their result', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let closed = false;
  let requests = 0;
  const effects: string[] = [];
  const record = tool({
    name: 'record',
    parameters: z.object({ value: z.string() }),
    execute: ({ value }) => {
      expect(closed).toBe(true);
      effects.push(value);
      return 'recorded';
    },
  });
  const client = {
    chat: {
      completions: {
        async *create(body: any) {
          if (++requests === 1) {
            try {
              yield {
                id: 'tool-stream',
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        {
                          index: 0,
                          id: 'record-call',
                          type: 'function',
                          function: { name: 'record', arguments: '{"value":' },
                        },
                      ],
                    },
                    finish_reason: null,
                  },
                ],
              };
              yield {
                id: 'tool-stream',
                choices: [
                  {
                    index: 0,
                    delta: {
                      tool_calls: [
                        { index: 0, function: { arguments: '"once"}' } },
                      ],
                    },
                    finish_reason: 'tool_calls',
                  },
                ],
              };
              entered.resolve();
              await release.promise;
            } finally {
              closed = true;
            }
          } else {
            expect(body.messages).toContainEqual(
              expect.objectContaining({
                role: 'tool',
                tool_call_id: 'record-call',
              }),
            );
            yield {
              id: 'done-stream',
              choices: [
                { index: 0, delta: { content: 'Done' }, finish_reason: 'stop' },
              ],
            };
          }
        },
      },
    },
  };
  await using provider = new NativeProvider({
    modelBackend: new ChatCompletionsModel(client, 'chat-model', {
      stream: true,
    }),
  });
  const result = new Agent({
    model: 'fixture-stream-model',
    instructions: 'Use record.',
    tools: [record],
    provider,
  }).run('Record once');
  try {
    await entered.promise;
    expect(effects).toEqual([]);
  } finally {
    release.resolve();
  }
  expect((await result).finalOutput).toBe('Done');
  expect(effects).toEqual(['once']);
  expect(requests).toBe(2);
}, 20_000);

it('joins borrowed Chat cleanup and drops a cancelled tool suffix', async () => {
  const entered = Promise.withResolvers<void>();
  const cleaning = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const controller = new AbortController();
  let cleaned = false;
  let settled = false;
  let effects = 0;
  const record = tool({
    name: 'record',
    parameters: z.object({}),
    execute: () => {
      effects++;
      return 'bad';
    },
  });
  const client = {
    chat: {
      completions: {
        async *create(_body: any, options: any) {
          try {
            yield {
              id: 'cancel-stream',
              choices: [
                { index: 0, delta: { role: 'assistant' }, finish_reason: null },
              ],
            };
            entered.resolve();
            if (!options.signal.aborted)
              await new Promise<void>((resolve) =>
                options.signal.addEventListener('abort', () => resolve(), {
                  once: true,
                }),
              );
            yield {
              id: 'cancel-stream',
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'late-call',
                        type: 'function',
                        function: { name: 'record', arguments: '{}' },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            };
          } finally {
            cleaning.resolve();
            await release.promise;
            cleaned = true;
          }
        },
      },
    },
  };
  await using provider = new NativeProvider({
    modelBackend: new ChatCompletionsModel(client, 'chat-model', {
      stream: true,
    }),
  });
  const result = new Agent({
    model: 'fixture-stream-model',
    instructions: 'Do not run after cancellation.',
    tools: [record],
    provider,
  }).run('Wait', { signal: controller.signal });
  void result.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    await entered.promise;
    controller.abort(new Error('stop Chat stream'));
    await cleaning.promise;
    expect(settled).toBe(false);
    expect(effects).toBe(0);
  } finally {
    release.resolve();
  }
  await expect(result).rejects.toThrow();
  expect(cleaned).toBe(true);
  expect(effects).toBe(0);
}, 20_000);
