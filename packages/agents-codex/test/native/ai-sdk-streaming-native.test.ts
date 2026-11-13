import { expect, it } from 'vitest';
import { z } from 'zod';
import { createOpenAI } from '@ai-sdk/openai';
import { Agent, AiSdkModel, NativeProvider, tool } from '../../src';

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

it.each([
  'missing-finish',
  'incomplete',
  'error-after-finish',
  'pending-input',
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
        provider: 'fixture',
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
