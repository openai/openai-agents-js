import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createGenerationSpan,
  getGlobalTraceProvider,
  createFunctionSpan,
  setTraceProcessors,
  setTracingDisabled,
  withTrace,
  type Span,
  type Trace,
  type TracingProcessor,
} from '@openai/agents-core';
import { OpenAITracingExporter } from '../src/openaiTracingExporter';
import { OpenAIChatCompletionsModel } from '../src/openaiChatCompletionsModel';

const endpoint = 'https://api.openai.com/v1/traces/ingest';
const reasoning = {
  type: 'reasoning',
  content: [{ type: 'input_text', text: 'synthetic-private-thought' }],
  rawContent: [{ type: 'reasoning_text', text: 'synthetic-private-thought' }],
};
const answer = {
  type: 'message',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text: 'ordinary answer' }],
};

describe('generation reasoning trace exports', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    setTraceProcessors([]);
    setTracingDisabled(false);
    fetchMock.mockReset().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    setTraceProcessors([]);
    setTracingDisabled(true);
    vi.unstubAllGlobals();
  });

  function span(
    data: NonNullable<Parameters<typeof createGenerationSpan>[0]>['data'],
  ) {
    return createGenerationSpan(
      { data },
      getGlobalTraceProvider().createTrace({ name: 'synthetic' }),
    );
  }
  async function exported(item: Span<any>, destination?: string) {
    await new OpenAITracingExporter({
      apiKey: 'synthetic-key',
      endpoint: destination,
    }).export([item]);
    return JSON.parse(fetchMock.mock.calls.at(-1)![1].body).data[0];
  }

  it.each([undefined, endpoint, `${endpoint}/`])(
    'omits supported reasoning at the default destination %s without mutating spans',
    async (destination) => {
      const tool = {
        type: 'function_call',
        name: 'lookup',
        callId: 'call_1',
        arguments: JSON.stringify({ reasoning: 'ordinary tool data' }),
      };
      const input = [
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'synthetic-private-thought' },
            { type: 'text', text: 'ordinary input' },
            {
              type: 'tool-call',
              toolCallId: 'call_1',
              toolName: 'lookup',
              input: { reasoning: 'ordinary tool data' },
            },
          ],
        },
      ];
      const item = span({
        input,
        output: [reasoning, answer, tool],
        model: 'test-model',
        model_config: { reasoning_effort: 'high' },
        usage: {
          input_tokens: 4,
          output_tokens: 8,
          output_tokens_details: { reasoning_tokens: 3 },
        },
      });
      const before = structuredClone(item.toJSON());
      const sent = await exported(item, destination);
      expect(JSON.stringify(sent)).not.toContain('synthetic-private-thought');
      expect(sent.span_data.input).toEqual([
        { ...input[0], content: input[0].content.slice(1) },
      ]);
      expect(sent.span_data.output).toEqual([answer, tool]);
      expect(sent.span_data).toMatchObject({
        model: 'test-model',
        model_config: { reasoning_effort: 'high' },
        usage: {
          input_tokens: 4,
          output_tokens: 8,
          details: { output_tokens_details: { reasoning_tokens: 3 } },
        },
      });
      expect(sent).toMatchObject({ id: item.spanId, trace_id: item.traceId });
      expect(item.toJSON()).toEqual(before);
      const custom = await exported(item, 'https://example.test/ingest');
      expect(custom.span_data.input).toEqual(input);
      expect(custom.span_data.output).toEqual([reasoning, answer, tool]);
      expect(custom.span_data.usage).toEqual(sent.span_data.usage);
    },
  );

  it('filters before byte truncation and still bounds retained text', async () => {
    const retained = {
      ...answer,
      content: [{ type: 'output_text', text: 'a'.repeat(70_000) }],
    };
    const oversizedReasoning = {
      ...reasoning,
      content: [{ type: 'input_text', text: 'r'.repeat(70_000) }],
    };
    const item = span({ output: [oversizedReasoning, retained] });
    expect((await exported(item)).span_data.output).toEqual([retained]);
    const custom = (await exported(item, 'https://example.test/ingest'))
      .span_data.output;
    expect(custom.some((entry: any) => entry.type === 'reasoning')).toBe(true);
    expect(
      new TextEncoder().encode(JSON.stringify(custom)).length,
    ).toBeLessThanOrEqual(100_000);
    item.spanData.output = [
      {
        ...answer,
        content: [{ type: 'output_text', text: 'a'.repeat(150_000) }],
      },
    ];
    const limited = (await exported(item)).span_data.output;
    expect(
      new TextEncoder().encode(JSON.stringify(limited)).length,
    ).toBeLessThanOrEqual(100_000);
    expect(JSON.stringify(limited)).toContain('[truncated]');
  });

  it('keeps empty reasoning-only results and assistant envelopes', async () => {
    const item = span({
      input: [
        {
          role: 'assistant',
          content: [{ type: 'reasoning', text: 'synthetic-private-thought' }],
        },
      ],
      output: [reasoning],
      model: 'test-model',
    });
    expect((await exported(item)).span_data).toEqual({
      type: 'generation',
      input: [{ role: 'assistant', content: [] }],
      output: [],
      model: 'test-model',
    });
  });

  it('preserves user and tool data, opaque metadata, and non-generation spans', async () => {
    const ordinary = {
      reasoning: 'ordinary data',
      nested: { type: 'reasoning', text: 'ordinary data' },
    };
    const input = [
      {
        role: 'user',
        content: 'reasoning is a word',
        reasoning: 'ordinary data',
      },
      { role: 'tool', content: ordinary },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: JSON.stringify(ordinary),
            reasoning: 'ordinary data',
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'text',
            text: JSON.stringify(ordinary),
            reasoning: 'ordinary data',
          },
        ],
      },
      {
        role: 'assistant',
        content: 'ordinary text',
        providerOptions: ordinary,
      },
    ];
    expect((await exported(span({ input }))).span_data.input).toEqual(input);
    const functionSpan = createFunctionSpan(
      {
        data: {
          name: 'lookup',
          input: JSON.stringify(ordinary),
          output: JSON.stringify([reasoning]),
        },
      },
      getGlobalTraceProvider().createTrace({ name: 'synthetic' }),
    );
    expect((await exported(functionSpan)).span_data).toEqual(
      functionSpan.spanData,
    );
  });

  it.each([
    { stream: false, refusal: false },
    { stream: true, refusal: false },
    { stream: false, refusal: true },
  ])(
    'exports replayed Chat Completions reasoning only to custom destinations ($stream, $refusal)',
    async ({ stream, refusal }) => {
      const ended: Span<any>[] = [];
      const processor: TracingProcessor = {
        async onTraceStart(_trace: Trace) {},
        async onTraceEnd(_trace: Trace) {},
        async onSpanStart(_span: Span<any>) {},
        async onSpanEnd(span) {
          ended.push(span);
        },
        async shutdown() {},
        async forceFlush() {},
      };
      setTraceProcessors([processor]);
      const raw = {
        id: 'completion_1',
        object: 'chat.completion',
        created: 1,
        model: 'test-model',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            logprobs: null,
            message: {
              role: 'assistant',
              content: refusal ? null : 'ordinary answer',
              ...(refusal ? { refusal: 'ordinary refusal' } : {}),
              reasoning: 'synthetic-private-thought',
            },
          },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      };
      const chunks = [
        {
          id: raw.id,
          object: 'chat.completion.chunk',
          created: 1,
          model: raw.model,
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                content: 'ordinary answer',
                reasoning: 'synthetic-private-thought',
              },
              finish_reason: null,
            },
          ],
        },
        {
          id: raw.id,
          object: 'chat.completion.chunk',
          created: 1,
          model: raw.model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: raw.usage,
        },
      ];
      const create = vi.fn().mockImplementation(async (params) =>
        params.stream
          ? (async function* () {
              yield* chunks;
            })()
          : raw,
      );
      const model = new OpenAIChatCompletionsModel(
        {
          chat: { completions: { create } },
          baseURL: 'https://example.test',
        } as any,
        'test-model',
      );
      const request = {
        input: 'Hello',
        modelSettings: {},
        tools: [],
        handoffs: [],
        outputType: 'text' as const,
        tracing: true as const,
      };
      let output: unknown;
      let replay: Awaited<ReturnType<typeof model.getResponse>>['output'];
      await withTrace('synthetic', async () => {
        const first = await model.getResponse(request);
        replay = first.output;
        const followUp = { ...request, input: replay };
        if (stream) {
          for await (const event of model.getStreamedResponse(followUp)) {
            if (event.type === 'response_done') output = event.response.output;
          }
        } else output = (await model.getResponse(followUp)).output;
      });
      const item = ended
        .filter((entry) => entry.spanData.type === 'generation')
        .at(-1)!;
      expect(item).toBeDefined();
      const before = structuredClone(item.toJSON());
      const outputBefore = structuredClone(output);
      const replayBefore = structuredClone(replay!);
      expect(item.spanData.input[0].content[0].reasoning).toBe(
        'synthetic-private-thought',
      );
      expect(JSON.stringify(output)).toContain('synthetic-private-thought');
      expect(item.spanData.input[0].reasoning).toBe(
        'synthetic-private-thought',
      );
      const sent = await exported(item);
      expect(JSON.stringify(sent)).not.toContain('synthetic-private-thought');
      expect(sent.span_data.input[0].content).toEqual([
        refusal
          ? {
              type: 'refusal',
              refusal: 'ordinary refusal',
              role: 'assistant',
              content: null,
            }
          : { type: 'text', text: 'ordinary answer', role: 'assistant' },
      ]);
      expect(sent.span_data.output[0].choices[0].message).toMatchObject(
        refusal
          ? { content: null, refusal: 'ordinary refusal' }
          : { content: 'ordinary answer' },
      );
      expect(item.toJSON()).toEqual(before);
      expect(output).toEqual(outputBefore);
      expect(replay!).toEqual(replayBefore);
      const custom = await exported(item, 'https://example.test/ingest');
      expect(custom.span_data.input[0].reasoning).toBe(
        'synthetic-private-thought',
      );
      if (!stream)
        expect(custom.span_data.output[0].choices[0].message.reasoning).toBe(
          'synthetic-private-thought',
        );
      expect(custom.span_data.input).toEqual(item.spanData.input);
      expect(ended).toHaveLength(2);
    },
  );
});
