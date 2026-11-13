import { expect, it } from 'vitest';
import { z } from 'zod';
import { createOpenAI } from '@ai-sdk/openai';
import { setTimeout as delay } from 'node:timers/promises';
import { Agent, AiSdkModel, NativeProvider, tool } from '../../src';
import type { JsonObject } from '../../src/runtime/binding';

it('delivers an admitted native file to the borrowed AI SDK model', async () => {
  const prompts: unknown[] = [];
  const modelBackend = new AiSdkModel({
    specificationVersion: 'v4',
    modelId: 'fixture-file-model',
    provider: 'fixture.files',
    doGenerate(options) {
      prompts.push(options.prompt);
      return {
        content: [{ type: 'text', text: 'File received.' }],
        finishReason: 'stop',
      };
    },
  });
  await using provider = new NativeProvider({ modelBackend });
  const agent = new Agent({
    model: 'fixture-file-model',
    instructions: 'Acknowledge the attached file.',
    provider,
  });
  const result = await agent.run({
    role: 'user',
    content: [
      {
        type: 'input_file',
        file_data: 'data:text/plain;base64,YQ==',
        filename: 'note.txt',
      },
    ],
  });
  expect(result.finalOutput).toBe('File received.');
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContainEqual({
    role: 'user',
    content: [
      {
        type: 'file',
        data: { type: 'data', data: 'YQ==' },
        mediaType: 'text/plain',
        filename: 'note.txt',
      },
    ],
  });
});

it.each(['v2', 'v3', 'v4'] as const)(
  'runs a borrowed AI SDK %s stream and function continuation in native Core',
  async (specificationVersion) => {
    let bufferedCalls = 0;
    const prompts: any[][] = [];
    const effects: number[] = [];
    const model = {
      specificationVersion,
      modelId: 'fixture-ai-stream',
      provider: 'fixture.language-model',
      async doGenerate() {
        bufferedCalls++;
        return {
          content: [{ type: 'text', text: 'buffered fallback' }],
          finishReason: 'stop',
        };
      },
      async doStream(options: any) {
        prompts.push(options.prompt);
        const initial = prompts.length === 1;
        const parts = initial
          ? [
              {
                type: 'tool-input-start',
                id: 'call_double',
                toolName: 'double',
              },
              {
                type: 'tool-input-delta',
                id: 'call_double',
                delta: '{"value":21}',
              },
              { type: 'tool-input-end', id: 'call_double' },
              {
                type: 'tool-call',
                toolCallId: 'call_double',
                toolName: 'double',
                input: '{"value":21}',
              },
            ]
          : [
              { type: 'text-start', id: 'answer' },
              { type: 'text-delta', id: 'answer', delta: 'streamed ' },
              { type: 'text-delta', id: 'answer', delta: '42' },
              { type: 'text-end', id: 'answer' },
            ];
        parts.push({
          type: 'finish',
          finishReason:
            specificationVersion === 'v2'
              ? initial
                ? 'tool-calls'
                : 'stop'
              : { unified: initial ? 'tool-calls' : 'stop', raw: 'fixture' },
          usage:
            specificationVersion === 'v2'
              ? { inputTokens: 3, outputTokens: 2 }
              : {
                  inputTokens: { total: 3, cacheRead: 1 },
                  outputTokens: { total: 2, reasoning: 0 },
                },
        } as any);
        return {
          stream: new ReadableStream({
            start(controller) {
              for (const part of parts) controller.enqueue(part);
              controller.close();
            },
          }),
        };
      },
    };
    const adapter = new AiSdkModel(model, {}, { stream: true } as any);
    await using provider = new NativeProvider({ modelBackend: adapter });
    const double = tool({
      name: 'double',
      parameters: z.object({ value: z.number() }),
      execute({ value }) {
        effects.push(value);
        return String(value * 2);
      },
    });
    const result = await new Agent({
      model: model.modelId,
      instructions: 'Use double, then answer.',
      provider,
      tools: [double],
    }).run('Double 21.');
    expect(result.finalOutput).toBe('streamed 42');
    expect(result.threadUsage?.totalTokenUsage.inputTokens).toBe(6);
    expect(result.threadUsage?.totalTokenUsage.outputTokens).toBe(4);
    expect(result.threadUsage?.totalTokenUsage.cachedInputTokens).toBe(
      specificationVersion === 'v2' ? 0 : 2,
    );
    expect(bufferedCalls).toBe(0);
    expect(effects).toEqual([21]);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContainEqual(
      expect.objectContaining({
        role: 'tool',
        content: expect.arrayContaining([
          expect.objectContaining({
            type: 'tool-result',
            toolCallId: 'call_double',
          }),
        ]),
      }),
    );
  },
);

it('publishes Responses reasoning before the borrowed stream can finish', async () => {
  const waiting = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const live = Promise.withResolvers<JsonObject>();
  let cancelled = false;
  const model = new AiSdkModel(
    {
      specificationVersion: 'v3',
      modelId: 'fixture-live-reasoning',
      provider: 'openai.responses',
      doGenerate() {
        throw new Error('Expected streaming');
      },
      doStream() {
        return {
          stream: new ReadableStream({
            start(controller) {
              controller.enqueue({
                type: 'reasoning-start',
                id: 'summary',
                providerMetadata: { openai: { itemId: 'rs_live' } },
              });
              controller.enqueue({
                type: 'reasoning-delta',
                id: 'summary',
                delta: 'Checking the record.',
              });
            },
            async pull(controller) {
              waiting.resolve();
              await release.promise;
              if (cancelled) return;
              controller.enqueue({
                type: 'reasoning-end',
                id: 'summary',
                providerMetadata: {
                  openai: { reasoningEncryptedContent: 'private-ciphertext' },
                },
              });
              controller.enqueue({
                type: 'text-delta',
                id: 'answer',
                delta: 'Done.',
              });
              controller.enqueue({
                type: 'finish',
                finishReason: { unified: 'stop', raw: 'stop' },
              });
              controller.close();
            },
            cancel() {
              cancelled = true;
            },
          }),
        };
      },
    },
    {},
    { stream: true },
  );
  await using provider = new NativeProvider({ modelBackend: model });
  await using session = await new Agent({
    model: 'fixture-live-reasoning',
    instructions: 'Check the record.',
    provider,
  }).session({ includeRawProviderEvents: true, observationRetention: 'all' });
  const turn = await session.submit('Begin.');
  const reasoning: JsonObject[] = [];
  const observations = (async () => {
    for await (const event of turn.events({ includeExecutionDetails: true })) {
      if (event.type !== 'raw_provider_event') continue;
      const part = event.payload;
      if (
        part.type === 'reasoning-start' ||
        part.type === 'reasoning-delta' ||
        part.type === 'reasoning-end'
      ) {
        reasoning.push(part);
        if (part.type === 'reasoning-delta') live.resolve(part);
      }
    }
  })();

  let beforeFinish: JsonObject | undefined;
  try {
    await waiting.promise;
    beforeFinish =
      (await Promise.race([live.promise, delay(3000)])) ?? undefined;
  } finally {
    release.resolve();
  }
  expect((await turn.wait()).finalOutput).toBe('Done.');
  await observations;
  expect(beforeFinish).toMatchObject({
    type: 'reasoning-delta',
    id: 'summary',
    delta: 'Checking the record.',
  });
  expect(reasoning).toEqual([
    {
      type: 'reasoning-start',
      id: 'summary',
      providerMetadata: { openai: { itemId: 'rs_live' } },
    },
    { type: 'reasoning-delta', id: 'summary', delta: 'Checking the record.' },
    {
      type: 'reasoning-end',
      id: 'summary',
      providerMetadata: {
        openai: { reasoningEncryptedContent: 'private-ciphertext' },
      },
    },
  ]);
}, 20_000);

it.each([false, true])(
  'composes text across reasoning before completion checks, streamed=%s',
  async (stream) => {
    const finishReason = { unified: 'stop', raw: 'stop' };
    const content = [
      { type: 'text', text: 'First' },
      {
        type: 'reasoning',
        text: 'Check.',
        providerMetadata: { openai: { itemId: 'rs_first' } },
      },
      { type: 'text', text: ' ' },
      {
        type: 'reasoning',
        text: 'Confirm.',
        providerMetadata: { openai: { itemId: 'rs_second' } },
      },
      { type: 'text', text: 'last.' },
    ];
    const backend = new AiSdkModel(
      {
        specificationVersion: 'v3',
        modelId: 'fixture-final-text',
        provider: 'openai.responses',
        doGenerate() {
          return { content, finishReason };
        },
        doStream() {
          return {
            stream: new ReadableStream({
              start(controller) {
                for (const [index, part] of content.entries()) {
                  const id = String(index);
                  if (part.type === 'text') {
                    controller.enqueue({
                      type: 'text-delta',
                      id,
                      delta: part.text,
                    });
                  } else {
                    controller.enqueue({
                      type: 'reasoning-start',
                      id,
                      providerMetadata: part.providerMetadata,
                    });
                    controller.enqueue({
                      type: 'reasoning-delta',
                      id,
                      delta: part.text,
                    });
                    controller.enqueue({ type: 'reasoning-end', id });
                  }
                }
                controller.enqueue({ type: 'finish', finishReason });
                controller.close();
              },
            }),
          };
        },
      },
      {},
      { stream },
    );
    const checked: unknown[] = [];
    await using provider = new NativeProvider({ modelBackend: backend });
    const result = await new Agent({
      model: 'fixture-final-text',
      instructions: 'Answer.',
      provider,
      beforeComplete({ text }) {
        checked.push(text);
      },
    }).run('Begin.');
    expect({ checked, finalOutput: result.finalOutput }).toEqual({
      checked: ['First last.'],
      finalOutput: 'First last.',
    });
  },
);

it.each(['v2', 'v3', 'v4'] as const)(
  'replays streamed Responses reasoning under its original provider item ID for %s',
  async (specificationVersion) => {
    const prompts: { role: string; content: { type: string }[] }[][] = [];
    const effects: string[] = [];
    const model = new AiSdkModel(
      {
        specificationVersion,
        modelId: 'fixture-reasoning-stream',
        provider: 'openai.responses',
        doGenerate() {
          throw new Error('Buffered path');
        },
        doStream(options) {
          const initial = prompts.push(options.prompt) === 1;
          const parts = initial
            ? [
                {
                  type: 'reasoning-start',
                  id: 'stream-reasoning',
                  providerMetadata: { openai: { itemId: 'rs_original' } },
                },
                {
                  type: 'reasoning-delta',
                  id: 'stream-reasoning',
                  delta: 'Check the ',
                },
                {
                  type: 'reasoning-delta',
                  id: 'stream-reasoning',
                  delta: 'record.',
                },
                {
                  type: 'reasoning-end',
                  id: 'stream-reasoning',
                },
                {
                  type: 'reasoning-start',
                  id: 'stream-reasoning-second-summary',
                  providerMetadata: { openai: { itemId: 'rs_original' } },
                },
                {
                  type: 'reasoning-delta',
                  id: 'stream-reasoning-second-summary',
                  delta: 'Confirm the match.',
                },
                {
                  type: 'reasoning-end',
                  id: 'stream-reasoning-second-summary',
                  providerMetadata: {
                    openai: { reasoningEncryptedContent: 'fixture-ciphertext' },
                  },
                },
                {
                  type: 'tool-call',
                  toolCallId: 'call_lookup',
                  toolName: 'lookup',
                  input: '{}',
                },
              ]
            : [
                { type: 'text-delta', id: 'answer', delta: 'Found ' },
                { type: 'reasoning-start', id: 'empty-reasoning' },
                { type: 'reasoning-end', id: 'empty-reasoning' },
                { type: 'text-delta', id: 'answer', delta: 'it.' },
              ];
          return {
            stream: new ReadableStream({
              start(controller) {
                for (const part of parts) controller.enqueue(part);
                controller.enqueue({
                  type: 'finish',
                  finishReason:
                    specificationVersion === 'v2'
                      ? initial
                        ? 'tool-calls'
                        : 'stop'
                      : { unified: initial ? 'tool-calls' : 'stop' },
                  usage: {
                    inputTokens:
                      specificationVersion === 'v2' ? 3 : { total: 3 },
                    outputTokens:
                      specificationVersion === 'v2'
                        ? 2
                        : { total: 2, reasoning: initial ? 1 : 0 },
                  },
                });
                controller.close();
              },
            }),
          };
        },
      },
      {},
      { stream: true },
    );
    await using provider = new NativeProvider({ modelBackend: model });
    const lookup = tool({
      name: 'lookup',
      parameters: z.object({}),
      execute() {
        effects.push('lookup');
        return 'present';
      },
    });
    const result = await new Agent({
      model: model.model.modelId,
      instructions: 'Look up the record before answering.',
      provider,
      tools: [lookup],
    }).run('Check the record.');
    expect(result.finalOutput).toBe('Found it.');
    expect(effects).toEqual(['lookup']);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContainEqual({
      role: 'assistant',
      content: [
        {
          type: 'reasoning',
          text: 'Check the record.',
          providerOptions: {
            openai: {
              itemId: 'rs_original',
              reasoningEncryptedContent: 'fixture-ciphertext',
            },
          },
        },
        {
          type: 'reasoning',
          text: 'Confirm the match.',
          providerOptions: {
            openai: {
              itemId: 'rs_original',
              reasoningEncryptedContent: 'fixture-ciphertext',
            },
          },
        },
      ],
      providerOptions: {
        openai: {
          itemId: 'rs_original',
          reasoningEncryptedContent: 'fixture-ciphertext',
        },
      },
    });
    const assistants = prompts[1].filter((entry) => entry.role === 'assistant');
    expect(
      assistants.map((entry) => entry.content.map((part) => part.type)),
    ).toEqual([['reasoning', 'reasoning'], ['tool-call']]);
    expect(assistants[1]).toEqual({
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'call_lookup',
          toolName: 'lookup',
          input: {},
        },
      ],
    });
  },
);

it.each([
  'missing-finish',
  'incomplete',
  'error-after-finish',
  'pending-input',
  'pending-reasoning',
  'overflow',
] as const)('withholds streamed tool effects on %s', async (outcome) => {
  const effects: string[] = [];
  const parts: any[] = [
    {
      type: 'tool-call',
      toolCallId: 'call_record',
      toolName: 'record',
      input: '{}',
    },
  ];
  if (outcome === 'overflow')
    parts.push({
      type: 'text-delta',
      id: 'oversized',
      delta: 'x'.repeat(9 * 1024 * 1024),
    });
  if (outcome === 'pending-input')
    parts.push({
      type: 'tool-input-start',
      id: 'unfinished',
      toolName: 'record',
    });
  if (outcome === 'pending-reasoning')
    parts.unshift({
      type: 'reasoning-start',
      id: 'unfinished-reasoning',
      providerMetadata: { openai: { itemId: 'rs_unfinished' } },
    });
  if (outcome !== 'missing-finish')
    parts.push({
      type: 'finish',
      finishReason: outcome === 'incomplete' ? 'length' : 'tool-calls',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
  if (outcome === 'error-after-finish')
    parts.push({ type: 'error', error: new Error('fixture stream error') });
  await using provider = new NativeProvider({
    modelBackend: new AiSdkModel(
      {
        specificationVersion: 'v3',
        modelId: 'fixture',
        provider:
          outcome === 'pending-reasoning' ? 'openai.responses' : 'fixture',
        doGenerate() {
          throw new Error('Buffered path');
        },
        doStream() {
          return {
            stream: new ReadableStream({
              start(controller) {
                for (const part of parts) controller.enqueue(part);
                controller.close();
              },
            }),
          };
        },
      },
      {},
      { stream: true },
    ),
  });
  const record = tool({
    name: 'record',
    parameters: z.object({}),
    execute() {
      effects.push('unexpected');
      return 'done';
    },
  });
  await expect(
    new Agent({
      model: 'fixture',
      provider,
      instructions: 'Record.',
      tools: [record],
    }).run('Begin.'),
  ).rejects.toThrow();
  expect(effects).toEqual([]);
});

it('streams a real borrowed OpenAI AI SDK provider through native tool continuation', async () => {
  const requests: any[] = [];
  const borrowed = createOpenAI({
    apiKey: 'fixture-ai-sdk-key',
    fetch: async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      requests.push(request);
      const initial = requests.length === 1;
      const chunk = (delta: any, finish_reason: string | null = null) => ({
        id: 'chat_fixture_' + requests.length,
        object: 'chat.completion.chunk',
        created: 0,
        model: 'fixture',
        choices: [{ index: 0, delta, finish_reason }],
      });
      const chunks = initial
        ? [
            chunk({
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'call_real',
                  type: 'function',
                  function: { name: 'double', arguments: '{"value":21}' },
                },
              ],
            }),
            chunk({}, 'tool_calls'),
          ]
        : [
            chunk({ role: 'assistant', content: 'real streamed ' }),
            chunk({ content: '42' }),
            chunk({}, 'stop'),
          ];
      return new Response(
        chunks
          .map((part) => 'data: ' + JSON.stringify(part) + '\n\n')
          .join('') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const effects: number[] = [];
  await using provider = new NativeProvider({
    modelBackend: new AiSdkModel(
      borrowed.chat('fixture'),
      {},
      { stream: true },
    ),
  });
  const double = tool({
    name: 'double',
    parameters: z.object({ value: z.number() }),
    execute({ value }) {
      effects.push(value);
      return String(value * 2);
    },
  });
  const result = await new Agent({
    model: 'fixture',
    provider,
    instructions: 'Use double.',
    tools: [double],
  }).run('Double 21.');
  expect(result.finalOutput).toBe('real streamed 42');
  expect(effects).toEqual([21]);
  expect(requests).toHaveLength(2);
  expect(requests.every((request) => request.stream === true)).toBe(true);
  expect(requests[1].messages).toContainEqual({
    role: 'tool',
    tool_call_id: 'call_real',
    content: '42',
  });
});

it('delivers public native text events before the borrowed AI SDK stream finishes', async () => {
  let finish!: () => void;
  let controller!: ReadableStreamDefaultController;
  const released = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await using provider = new NativeProvider({
    modelBackend: new AiSdkModel(
      {
        specificationVersion: 'v4',
        modelId: 'fixture',
        provider: 'fixture',
        doGenerate() {
          throw new Error('Buffered path');
        },
        doStream() {
          return {
            stream: new ReadableStream({
              start(value) {
                controller = value;
                controller.enqueue({
                  type: 'text-delta',
                  id: 'one',
                  delta: 'live native answer',
                });
                void released.then(() => {
                  controller.enqueue({
                    type: 'finish',
                    finishReason: { unified: 'stop', raw: 'fixture' },
                  });
                  controller.close();
                });
              },
            }),
          };
        },
      },
      {},
      { stream: true },
    ),
  });
  await using session = await new Agent({
    model: 'fixture',
    provider,
    instructions: 'Answer.',
  }).session();
  const turn = await session.submit('Begin.');
  let observed = false;
  try {
    for await (const event of turn.events()) {
      if (event.type === 'output_text_delta') {
        expect(event.delta).toBe('live native answer');
        observed = true;
        break;
      }
    }
  } finally {
    finish();
  }
  expect(observed).toBe(true);
  expect((await turn.wait()).finalOutput).toBe('live native answer');
});
