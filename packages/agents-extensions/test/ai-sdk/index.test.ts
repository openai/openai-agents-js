import { describe, test, expect, vi } from 'vitest';
import {
  AiSdkModel,
  aiSdkToolSearchTool,
  aisdk,
  getResponseFormat,
  itemsToLanguageV2Messages,
  parseArguments,
  toolChoiceToLanguageV2Format,
  toolToLanguageV2Tool,
} from '../../src/ai-sdk/index';
import {
  Agent,
  handoff,
  protocol,
  run,
  RunContext,
  tool,
  toolNamespace,
  withTrace,
  UserError,
  setTraceProcessors,
  setTracingDisabled,
  type Span,
  type Trace,
  type TracingProcessor,
} from '@openai/agents';
import { ReadableStream } from 'node:stream/web';
import { APICallError, type JSONSchema7 } from '@ai-sdk/provider';
import type { SerializedOutputType } from '@openai/agents';
import { z } from 'zod';
import { stubModel } from './fixtures';

function partsStream(parts: any[]): ReadableStream<any> {
  return ReadableStream.from(
    (async function* () {
      for (const p of parts) {
        yield p;
      }
    })(),
  );
}

async function collectStreamResponse(
  parts: any[],
  specificationVersion = 'v2',
) {
  const languageModel = stubModel(
    {
      async doStream() {
        return { stream: partsStream(parts) } as any;
      },
    },
    { specificationVersion },
  );
  const model = new AiSdkModel(languageModel);
  let response: any;

  for await (const event of model.getStreamedResponse({
    input: 'test',
    tools: [],
    handoffs: [],
    modelSettings: {},
    outputType: 'text',
    tracing: false,
  } as any)) {
    if (event.type === 'response_done') {
      response = event.response;
    }
  }

  if (!response) {
    throw new Error('Expected a completed streaming response.');
  }
  return { languageModel, response };
}

class RecordingTracingProcessor implements TracingProcessor {
  readonly spansEnded: Span<any>[] = [];

  async onTraceStart(_trace: Trace): Promise<void> {}
  async onTraceEnd(_trace: Trace): Promise<void> {}
  async onSpanStart(_span: Span<any>): Promise<void> {}
  async onSpanEnd(span: Span<any>): Promise<void> {
    this.spansEnded.push(span);
  }
  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

const structuredOutputType: SerializedOutputType = {
  type: 'json_schema',
  name: 'output',
  strict: false,
  schema: {
    type: 'object',
    properties: {
      content: { type: 'string' },
    },
    required: ['content'],
    additionalProperties: false,
  },
};

describe('getResponseFormat', () => {
  test('converts text output type', () => {
    const outputType: SerializedOutputType = 'text';
    const result = getResponseFormat(outputType);
    expect(result).toEqual({ type: 'text' });
  });

  test('converts json schema output type', () => {
    const outputType: SerializedOutputType = {
      type: 'json_schema',
      name: 'output',
      strict: false,
      schema: {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
        required: ['name'],
        additionalProperties: false,
      },
    };
    const result = getResponseFormat(outputType);
    expect(result).toEqual({
      type: 'json',
      name: outputType.name,
      schema: outputType.schema,
    });
  });
});

describe('AiSdkModel end-to-end scenarios', () => {
  test('supports structured final output from plain JSON text without transforms', async () => {
    const model = aisdk(
      stubModel({
        async doGenerate() {
          return {
            content: [
              {
                type: 'text',
                text: '{"content":"structured without transform"}',
              },
            ],
            usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
            providerMetadata: {},
            response: { id: 'id' },
            finishReason: 'stop',
            warnings: [],
          } as any;
        },
      }),
    );

    const agent = new Agent({
      name: 'Structured Agent',
      model,
      outputType: z.object({
        content: z.string(),
      }),
    });

    const result = await run(agent, 'hi');
    expect(result.finalOutput).toEqual({
      content: 'structured without transform',
    });
  });

  test('supports structured final output via transformOutputText', async () => {
    const model = aisdk(
      stubModel({
        async doGenerate() {
          return {
            content: [
              {
                type: 'text',
                text: '```json\n{"content":"structured"}\n```',
              },
            ],
            usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
            providerMetadata: {},
            response: { id: 'id' },
            finishReason: 'stop',
            warnings: [],
          } as any;
        },
      }),
      {
        transformOutputText(text) {
          return (
            text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)?.[1]?.trim() ?? text
          );
        },
      },
    );

    const agent = new Agent({
      name: 'Structured Agent',
      model,
      outputType: z.object({
        content: z.string(),
      }),
    });

    const result = await run(agent, 'hi');
    expect(result.finalOutput).toEqual({ content: 'structured' });
  });

  test.each(['generate', 'stream'] as const)(
    'executes namespaced function tools in %s runs',
    async (mode) => {
      let turn = 0;
      const execute = vi.fn(async () => 'account');
      const [lookupAccount] = toolNamespace({
        name: 'crm',
        description: 'CRM tools.',
        tools: [
          tool({
            name: 'lookup_account',
            description: 'Look up an account.',
            parameters: z.object({}),
            execute,
          }),
        ],
      });
      const languageModel = stubModel({
        async doGenerate() {
          turn += 1;
          return turn === 1
            ? ({
                content: [
                  {
                    type: 'tool-call',
                    toolCallId: 'call_lookup_account',
                    toolName: 'crm.lookup_account',
                    input: {},
                  },
                ],
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                response: { id: 'response_1' },
                finishReason: 'tool-calls',
                warnings: [],
              } as any)
            : ({
                content: [{ type: 'text', text: 'Done.' }],
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                response: { id: 'response_2' },
                finishReason: 'stop',
                warnings: [],
              } as any);
        },
        async doStream() {
          turn += 1;
          return {
            stream: partsStream(
              turn === 1
                ? [
                    {
                      type: 'tool-call',
                      toolCallId: 'call_lookup_account',
                      toolName: 'crm.lookup_account',
                      input: {},
                    },
                    {
                      type: 'finish',
                      finishReason: 'tool-calls',
                      usage: { inputTokens: 1, outputTokens: 1 },
                    },
                  ]
                : [
                    { type: 'text-delta', id: 'text-1', delta: 'Done.' },
                    {
                      type: 'finish',
                      finishReason: 'stop',
                      usage: { inputTokens: 1, outputTokens: 1 },
                    },
                  ],
            ),
          } as any;
        },
      });
      const agent = new Agent({
        name: 'Namespaced tool agent',
        model: new AiSdkModel(languageModel),
        tools: [lookupAccount!],
      });

      let finalOutput: string | undefined;
      if (mode === 'stream') {
        const result = await run(agent, 'hi', { stream: true });
        await result.completed;
        finalOutput = result.finalOutput;
      } else {
        const result = await run(agent, 'hi');
        finalOutput = result.finalOutput;
      }

      expect(execute).toHaveBeenCalledTimes(1);
      expect(finalOutput).toBe('Done.');
    },
  );

  test('preserves separate text message IDs around tool calls', async () => {
    const parts = [
      { type: 'text-delta', id: 'text-1', delta: 'Hello ' },
      {
        type: 'tool-call',
        toolCallId: 'c1',
        toolName: 'search',
        input: '{"q":"a"}',
        providerMetadata: { meta: 1 },
      },
      { type: 'text-delta', id: 'text-2', delta: 'world' },
      {
        type: 'tool-call',
        toolCallId: 'c2',
        toolName: 'lookup',
        input: '{"id":2}',
        providerMetadata: { meta: 2 },
      },
      {
        type: 'response-metadata',
        id: 'resp-stream',
      },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: 3, outputTokens: 5 },
      },
    ];

    const model = new AiSdkModel(
      stubModel({
        async doStream() {
          return { stream: partsStream(parts) } as any;
        },
      }),
    );

    const events: any[] = [];
    for await (const ev of model.getStreamedResponse({
      input: 'hi',
      tools: [],
      handoffs: [],
      modelSettings: {},
      outputType: 'text',
      tracing: false,
    } as any)) {
      events.push(ev);
    }

    const final = events.at(-1);
    expect(
      events.filter((event) => event.type === 'output_text_delta'),
    ).toEqual([
      { type: 'output_text_delta', itemId: 'text-1', delta: 'Hello ' },
      { type: 'output_text_delta', itemId: 'text-2', delta: 'world' },
    ]);
    expect(final.type).toBe('response_done');
    expect(final.response.output).toEqual([
      {
        type: 'message',
        id: 'text-1',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Hello ' }],
        status: 'completed',
        providerData: { model: 'stub:m', responseId: 'resp-stream' },
      },
      {
        type: 'function_call',
        callId: 'c1',
        name: 'search',
        arguments: '{"q":"a"}',
        status: 'completed',
        providerData: { model: 'stub:m', meta: 1, responseId: 'resp-stream' },
      },
      {
        type: 'message',
        id: 'text-2',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'world' }],
        status: 'completed',
        providerData: { model: 'stub:m', responseId: 'resp-stream' },
      },
      {
        type: 'function_call',
        callId: 'c2',
        name: 'lookup',
        arguments: '{"id":2}',
        status: 'completed',
        providerData: { model: 'stub:m', meta: 2, responseId: 'resp-stream' },
      },
    ]);
    expect(final.response.usage).toEqual({
      inputTokens: 3,
      outputTokens: 5,
      totalTokens: 8,
    });
  });

  test('supports v3 models without throwing during conversion', async () => {
    const v3Model: any = {
      specificationVersion: 'v3',
      provider: 'v3-provider',
      modelId: 'v3-model',
      supportedUrls: {},
      async doGenerate(options: any) {
        return {
          content: [
            {
              type: 'text',
              text: 'hello v3',
            },
          ],
          usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
          response: { id: 'resp-v3' },
          providerMetadata: options,
          finishReason: 'stop',
          warnings: [],
        };
      },
      async doStream() {
        return { stream: partsStream([{ type: 'text-delta', delta: 'hi' }]) };
      },
    };

    const model = new AiSdkModel(v3Model);
    const resp = await withTrace('v3-model', () =>
      model.getResponse({
        input: 'prompt',
        tools: [],
        handoffs: [],
        modelSettings: {},
        outputType: 'text',
        tracing: true,
      } as any),
    );

    expect(resp.output[0]).toMatchObject({
      type: 'message',
      content: [{ type: 'output_text', text: 'hello v3' }],
    });
  });

  test('supports v4 generation, reasoning, usage, and abort propagation', async () => {
    const controller = new AbortController();
    let receivedOptions: any;
    const transformOutputText = vi.fn((text, context) => {
      expect(context.specificationVersion).toBe('v4');
      return text;
    });
    const v4Model: any = {
      specificationVersion: 'v4',
      provider: 'deepseek.chat',
      modelId: 'deepseek-chat',
      supportedUrls: {},
      async doGenerate(options: any) {
        receivedOptions = options;
        return {
          content: [
            { type: 'reasoning', text: 'thinking' },
            { type: 'text', text: 'hello v4' },
          ],
          usage: {
            inputTokens: {
              total: 3,
              noCache: 2,
              cacheRead: 1,
              cacheWrite: 0,
            },
            outputTokens: { total: 5, text: 4, reasoning: 1 },
          },
          response: { id: 'resp-v4' },
          providerMetadata: {},
          finishReason: { unified: 'stop', raw: 'stop' },
          warnings: [],
        };
      },
      async doStream() {
        return { stream: partsStream([]) };
      },
    };

    const model = new AiSdkModel(v4Model, { transformOutputText });
    const response = await withTrace('v4-model', () =>
      model.getResponse({
        input: 'prompt',
        tools: [],
        handoffs: [],
        modelSettings: {},
        outputType: 'text',
        tracing: false,
        signal: controller.signal,
      } as any),
    );

    expect(receivedOptions.abortSignal).toBe(controller.signal);
    expect(transformOutputText).toHaveBeenCalledOnce();
    expect(response.output.map((item) => item.type)).toEqual([
      'reasoning',
      'message',
    ]);
    expect(response.output[1]).toMatchObject({
      type: 'message',
      content: [{ type: 'output_text', text: 'hello v4' }],
    });
    expect(response.usage).toMatchObject({
      inputTokens: 3,
      outputTokens: 5,
      totalTokens: 8,
    });
  });

  test('supports v4 streaming reasoning and object-shaped usage', async () => {
    const controller = new AbortController();
    let receivedOptions: any;
    const v4Model: any = {
      specificationVersion: 'v4',
      provider: 'deepseek.chat',
      modelId: 'deepseek-chat',
      supportedUrls: {},
      async doGenerate() {
        return { content: [], usage: {} };
      },
      async doStream(options: any) {
        receivedOptions = options;
        return {
          stream: partsStream([
            { type: 'reasoning-start', id: 'reasoning-1' },
            {
              type: 'reasoning-delta',
              id: 'reasoning-1',
              delta: 'thinking',
            },
            { type: 'reasoning-end', id: 'reasoning-1' },
            { type: 'text-delta', id: 'text-1', delta: 'hello v4' },
            {
              type: 'finish',
              finishReason: { unified: 'stop', raw: 'stop' },
              usage: {
                inputTokens: {
                  total: 2,
                  noCache: 2,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                outputTokens: { total: 4, text: 3, reasoning: 1 },
              },
            },
          ]),
        };
      },
    };

    const model = new AiSdkModel(v4Model);
    const events: any[] = [];
    for await (const event of model.getStreamedResponse({
      input: 'prompt',
      tools: [],
      handoffs: [],
      modelSettings: {},
      outputType: 'text',
      tracing: false,
      signal: controller.signal,
    } as any)) {
      events.push(event);
    }

    const final = events.at(-1);
    expect(receivedOptions.abortSignal).toBe(controller.signal);
    expect(final.response.output.map((item: any) => item.type)).toEqual([
      'reasoning',
      'message',
    ]);
    expect(final.response.usage).toMatchObject({
      inputTokens: 2,
      outputTokens: 4,
      totalTokens: 6,
    });
  });

  test('rejects unsupported specification versions', () => {
    expect(
      () => new AiSdkModel(stubModel({}, { specificationVersion: 'v5' })),
    ).toThrow(
      'Unsupported AI SDK specificationVersion: v5. Only v2, v3, and v4 are supported.',
    );
  });

  test('returns JSON schema output in streaming finish', async () => {
    const schema: JSONSchema7 = {
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
    };
    const model = new AiSdkModel(
      stubModel({
        async doStream() {
          return {
            stream: partsStream([
              {
                type: 'finish',
                finishReason: 'stop',
                usage: { inputTokens: 1, outputTokens: 1 },
                response: { id: 'resp-json' },
              },
            ]),
          };
        },
      }),
    );

    const events: any[] = [];
    for await (const ev of model.getStreamedResponse({
      input: 'hi',
      tools: [],
      handoffs: [],
      modelSettings: {},
      outputType: {
        type: 'json_schema',
        name: 'output',
        schema,
        strict: false,
      },
      tracing: false,
    } as any)) {
      events.push(ev);
    }

    const final = events.at(-1);
    expect(final.type).toBe('response_done');
    expect(final.response.output).toEqual([]);
  });
});

describe('toolToLanguageV2Tool', () => {
  const model = stubModel({});
  test.each([true, false])('maps function tools with strict: %s', (strict) => {
    const tool = {
      type: 'function',
      name: 'foo',
      description: 'd',
      parameters: {} as any,
      strict,
    } as any;
    expect(toolToLanguageV2Tool(model, tool)).toEqual({
      type: 'function',
      name: 'foo',
      description: 'd',
      inputSchema: {},
      strict,
    });
  });

  test('maps namespaced function tools to qualified names', () => {
    const tool = {
      type: 'function',
      name: 'lookup_account',
      namespace: 'crm',
      description: 'd',
      parameters: {} as any,
    } as any;
    expect(toolToLanguageV2Tool(model, tool)).toEqual({
      type: 'function',
      name: 'crm.lookup_account',
      description: 'd',
      inputSchema: {},
    });
  });

  test('maps provider data on function tools to provider options', () => {
    const anthropicModel = stubModel(
      {},
      { provider: 'anthropic.messages', specificationVersion: 'v3' },
    );
    const tool = {
      type: 'function',
      name: 'get_weather',
      description: 'Get the weather.',
      parameters: {} as any,
      providerData: {
        anthropic: { deferLoading: true },
      },
    } as any;

    expect(toolToLanguageV2Tool(anthropicModel, tool)).toEqual({
      type: 'function',
      name: 'get_weather',
      description: 'Get the weather.',
      inputSchema: {},
      providerOptions: {
        anthropic: { deferLoading: true },
      },
    });
  });

  test('maps same-name namespaces to qualified names', () => {
    const tool = {
      type: 'function',
      name: 'lookup_account',
      namespace: 'lookup_account',
      description: 'd',
      parameters: {} as any,
    } as any;
    expect(toolToLanguageV2Tool(model, tool)).toEqual({
      type: 'function',
      name: 'lookup_account.lookup_account',
      description: 'd',
      inputSchema: {},
    });
  });

  test('rejects deferred Responses function tools', () => {
    const tool = {
      type: 'function',
      name: 'lookup_account',
      description: 'd',
      parameters: {} as any,
      deferLoading: true,
    } as any;
    expect(() => toolToLanguageV2Tool(model, tool)).toThrow(
      /AI SDK adapter does not support deferred Responses function tools/,
    );
  });

  test('rejects Programmatic Tool Calling tools', () => {
    expect(() =>
      toolToLanguageV2Tool(model, {
        type: 'function',
        name: 'lookup',
        description: 'd',
        parameters: {} as any,
        allowedCallers: ['programmatic'],
      } as any),
    ).toThrow(/does not support Programmatic Tool Calling/);

    expect(() =>
      toolToLanguageV2Tool(model, {
        type: 'hosted_tool',
        name: 'programmatic_tool_calling',
        providerData: { type: 'programmatic_tool_calling' },
      } as any),
    ).toThrow(/does not support Programmatic Tool Calling/);
  });

  test('maps builtin tools', () => {
    const tool = {
      type: 'hosted_tool',
      name: 'search',
      providerData: { args: { q: 1 } },
    } as any;
    expect(toolToLanguageV2Tool(model, tool)).toEqual({
      type: 'provider-defined',
      id: `${model.provider}.search`,
      name: 'search',
      args: { q: 1 },
    });
  });

  test('maps tool_search config from providerData when hosted args are implicit', () => {
    const tool = {
      type: 'hosted_tool',
      name: 'tool_search',
      providerData: {
        type: 'tool_search',
        name: 'tool_search',
        execution: 'client',
        description: 'Search local deferred tools.',
        parameters: {
          type: 'object',
          properties: {
            namespace: { type: 'string' },
          },
        },
      },
    } as any;
    expect(toolToLanguageV2Tool(model, tool)).toEqual({
      type: 'provider-defined',
      id: `${model.provider}.tool_search`,
      name: 'tool_search',
      args: {
        execution: 'client',
        description: 'Search local deferred tools.',
        parameters: {
          type: 'object',
          properties: {
            namespace: { type: 'string' },
          },
        },
      },
    });
  });

  test('preserves AI SDK provider tool ids for v2, v3, and v4 models', () => {
    const tool = aiSdkToolSearchTool({
      type: 'provider',
      id: 'anthropic.tool_search_regex_20251119',
      args: { maxUses: 2 },
    });

    expect(toolToLanguageV2Tool(model, tool)).toEqual({
      type: 'provider-defined',
      id: 'anthropic.tool_search_regex_20251119',
      name: 'tool_search',
      args: { maxUses: 2 },
    });

    const v3Model = stubModel(
      {},
      { provider: 'anthropic.messages', specificationVersion: 'v3' },
    );
    expect(toolToLanguageV2Tool(v3Model, tool)).toEqual({
      type: 'provider',
      id: 'anthropic.tool_search_regex_20251119',
      name: 'tool_search',
      args: { maxUses: 2 },
    });

    const v4Model = stubModel(
      {},
      { provider: 'anthropic.messages', specificationVersion: 'v4' },
    );
    expect(toolToLanguageV2Tool(v4Model, tool)).toEqual({
      type: 'provider',
      id: 'anthropic.tool_search_regex_20251119',
      name: 'tool_search',
      args: { maxUses: 2 },
    });
  });

  test('normalizes OpenAI v3 and v4 builtin tool IDs', () => {
    const tool = {
      type: 'hosted_tool',
      name: 'file_search',
      providerData: { args: { query: 'x' } },
    } as any;

    for (const specificationVersion of ['v3', 'v4']) {
      const model = stubModel(
        {},
        { provider: 'openai.responses', specificationVersion },
      );
      expect(toolToLanguageV2Tool(model, tool)).toEqual({
        type: 'provider',
        id: 'openai.file_search',
        name: 'file_search',
        args: { query: 'x' },
      });
    }
  });

  test('maps computer tools', () => {
    const tool = {
      type: 'computer',
      name: 'comp',
      environment: 'env',
      dimensions: [2, 3],
    } as any;
    expect(toolToLanguageV2Tool(model, tool)).toEqual({
      type: 'provider-defined',
      id: `${model.provider}.comp`,
      name: 'comp',
      args: { environment: 'env', display_width: 2, display_height: 3 },
    });
  });

  test('rejects computer tools without display metadata', () => {
    const tool = {
      type: 'computer',
      name: 'comp',
    } as any;
    expect(() => toolToLanguageV2Tool(model, tool)).toThrow(
      'The AI SDK adapter requires computer tools to include environment and dimensions metadata.',
    );
  });

  test('throws on unknown type', () => {
    const tool = { type: 'x', name: 'u' } as any;
    expect(() => toolToLanguageV2Tool(model, tool)).toThrow();
  });
});

describe('AiSdkModel.getResponse', () => {
  test('handles text output', async () => {
    const model = new AiSdkModel(
      stubModel({
        async doGenerate() {
          return {
            content: [{ type: 'text', text: 'ok' }],
            usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
            providerMetadata: { p: 1 },
            response: { id: 'id' },
            finishReason: 'stop',
            warnings: [],
          } as any;
        },
      }),
    );

    const res = await withTrace('t', () =>
      model.getResponse({
        input: 'hi',
        tools: [],
        handoffs: [],
        modelSettings: {},
        outputType: 'text',
        tracing: false,
      } as any),
    );

    expect(res.output).toEqual([
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'ok' }],
        status: 'completed',
        providerData: {
          model: 'stub:m',
          responseId: 'id',
          p: 1,
        },
      },
    ]);
  });

  test('concatenates multiple text output parts', async () => {
    const model = new AiSdkModel(
      stubModel({
        async doGenerate() {
          return {
            content: [
              { type: 'text', text: 'Hello ' },
              { type: 'text', text: 'world' },
            ],
            usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
            providerMetadata: { p: 1 },
            response: { id: 'id' },
            finishReason: 'stop',
            warnings: [],
          } as any;
        },
      }),
    );

    const res = await withTrace('t', () =>
      model.getResponse({
        input: 'hi',
        tools: [],
        handoffs: [],
        modelSettings: {},
        outputType: 'text',
        tracing: false,
      } as any),
    );

    expect(res.output).toEqual([
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Hello world' }],
        status: 'completed',
        providerData: {
          model: 'stub:m',
          responseId: 'id',
          p: 1,
        },
      },
    ]);
  });

  test('keeps text contiguous across skipped response content', async () => {
    const model = new AiSdkModel(
      stubModel({
        async doGenerate() {
          return {
            content: [
              { type: 'text', text: 'Hello ' },
              {
                type: 'source',
                sourceType: 'url',
                id: 'source-1',
                url: 'https://example.com/source',
              },
              {
                type: 'file',
                mediaType: 'image/png',
                data: 'iVBORw0KGgo=',
              },
              { type: 'text', text: 'world' },
            ],
            usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
            providerMetadata: {},
            response: { id: 'id' },
            finishReason: 'stop',
            warnings: [],
          } as any;
        },
      }),
    );

    const result = await run(
      new Agent({ name: 'Assistant', model }),
      'Say hello.',
    );

    expect(result.finalOutput).toBe('Hello world');
  });

  test('keeps text contiguous across empty reasoning content', async () => {
    const model = new AiSdkModel(
      stubModel({
        async doGenerate() {
          return {
            content: [
              { type: 'text', text: 'Hello ' },
              { type: 'reasoning', text: '' },
              { type: 'text', text: 'world' },
            ],
            usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
            providerMetadata: {},
            response: { id: 'id' },
            finishReason: 'stop',
            warnings: [],
          } as any;
        },
      }),
    );

    const result = await run(
      new Agent({ name: 'Assistant', model }),
      'Say hello.',
    );

    expect(result.finalOutput).toBe('Hello world');
  });

  test('keeps complete final output across interleaved reasoning', async () => {
    const model = new AiSdkModel(
      stubModel({
        async doGenerate() {
          return {
            content: [
              { type: 'text', text: 'first' },
              { type: 'reasoning', text: 'thinking' },
              { type: 'text', text: 'second' },
              { type: 'reasoning', text: 'checking' },
            ],
            usage: { inputTokens: 1, outputTokens: 3, totalTokens: 4 },
            providerMetadata: {},
            response: { id: 'id' },
            finishReason: 'stop',
            warnings: [],
          } as any;
        },
      }),
    );

    const result = await run(
      new Agent({ name: 'Assistant', model }),
      'Respond in two parts.',
    );

    expect(result.newItems.map((item) => item.rawItem?.type)).toEqual([
      'message',
      'reasoning',
      'message',
      'reasoning',
    ]);
    expect(result.finalOutput).toBe('firstsecond');
  });

  test('transforms complete structured output once across interleaved reasoning', async () => {
    const transformOutputText = vi.fn((text: string) => {
      return text.match(/\{[\s\S]*\}/)?.[0] ?? text;
    });
    const model = new AiSdkModel(
      stubModel({
        async doGenerate() {
          return {
            content: [
              { type: 'text', text: 'Result: {"content":' },
              { type: 'reasoning', text: 'thinking' },
              { type: 'text', text: '"structured"}' },
            ],
            usage: { inputTokens: 1, outputTokens: 3, totalTokens: 4 },
            providerMetadata: {},
            response: { id: 'id' },
            finishReason: 'stop',
            warnings: [],
          } as any;
        },
      }),
      { transformOutputText },
    );

    const result = await run(
      new Agent({
        name: 'Structured Assistant',
        model,
        outputType: z.object({ content: z.string() }),
      }),
      'Respond with structured output.',
    );

    expect(transformOutputText).toHaveBeenCalledOnce();
    expect(transformOutputText).toHaveBeenCalledWith(
      'Result: {"content":"structured"}',
      expect.objectContaining({ stream: false }),
    );
    expect(result.newItems.map((item) => item.rawItem?.type)).toEqual([
      'message',
      'reasoning',
      'message',
    ]);
    expect(result.finalOutput).toEqual({ content: 'structured' });
  });

  test('keeps complete final output when used as an agent tool', async () => {
    const model = new AiSdkModel(
      stubModel({
        async doGenerate() {
          return {
            content: [
              { type: 'text', text: 'first' },
              { type: 'reasoning', text: 'thinking' },
              { type: 'text', text: 'second' },
              { type: 'reasoning', text: 'checking' },
            ],
            usage: { inputTokens: 1, outputTokens: 3, totalTokens: 4 },
            providerMetadata: {},
            response: { id: 'id' },
            finishReason: 'stop',
            warnings: [],
          } as any;
        },
      }),
    );
    const agentTool = new Agent({ name: 'Assistant', model }).asTool({
      toolDescription: 'Respond in two parts.',
    });

    const output = await agentTool.invoke(
      new RunContext(),
      JSON.stringify({ input: 'Respond in two parts.' }),
    );

    expect(output).toBe('firstsecond');
  });

  test('transforms text separately around provider-executed tool search', async () => {
    const transformOutputText = vi.fn((text: string) =>
      text.replace('wrapped:', ''),
    );
    const model = new AiSdkModel(
      stubModel(
        {
          async doGenerate() {
            return {
              content: [
                { type: 'text', text: 'wrapped:first' },
                {
                  type: 'reasoning',
                  text: 'searching',
                  providerMetadata: {
                    anthropic: { signature: 'sig-search' },
                  },
                },
                {
                  type: 'tool-call',
                  toolCallId: 'search_1',
                  toolName: 'tool_search',
                  input: { query: 'weather' },
                  providerExecuted: true,
                },
                { type: 'text', text: 'wrapped:between-call-and-result' },
                {
                  type: 'tool-result',
                  toolCallId: 'search_1',
                  toolName: 'tool_search',
                  result: [{ type: 'tool_reference', toolName: 'get_weather' }],
                },
                { type: 'text', text: 'wrapped:after-result' },
              ],
              usage: { inputTokens: 1, outputTokens: 5, totalTokens: 6 },
              providerMetadata: {},
              response: { id: 'id' },
              finishReason: 'stop',
              warnings: [],
            } as any;
          },
        },
        { provider: 'anthropic.messages', specificationVersion: 'v3' },
      ),
      { transformOutputText },
    );

    const result = await run(
      new Agent({
        name: 'Assistant',
        model,
        tools: [
          aiSdkToolSearchTool({
            type: 'provider',
            id: 'anthropic.tool_search_regex_20251119',
          }),
        ],
      }),
      'Search and answer.',
    );

    expect(result.newItems.map((item) => item.rawItem?.type)).toEqual([
      'message',
      'reasoning',
      'tool_search_call',
      'message',
      'tool_search_output',
      'message',
    ]);
    expect(transformOutputText.mock.calls.map(([text]) => text)).toEqual([
      'wrapped:first',
      'wrapped:between-call-and-result',
      'wrapped:after-result',
    ]);
    expect(
      result.newItems
        .filter((item) => item.rawItem?.type === 'message')
        .map((item) => (item.rawItem as any).content[0].text),
    ).toEqual(['first', 'between-call-and-result', 'after-result']);
    expect(result.finalOutput).toBe('firstbetween-call-and-resultafter-result');
  });

  test('applies transformOutputText to finalized assistant text', async () => {
    const transformOutputText = vi.fn((text: string, context: any) => {
      expect(context.stream).toBe(false);
      expect(context.provider).toBe('stub');
      expect(context.modelId).toBe('m');
      expect(context.request.outputType).toEqual(structuredOutputType);
      return text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)?.[1]?.trim() ?? text;
    });

    const model = aisdk(
      stubModel({
        async doGenerate() {
          return {
            content: [
              {
                type: 'text',
                text: '```json\n{"content":"structured"}\n```',
              },
            ],
            usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
            providerMetadata: {},
            response: { id: 'id' },
            finishReason: 'stop',
            warnings: [],
          } as any;
        },
      }),
      { transformOutputText },
    );

    const res = await withTrace('t', () =>
      model.getResponse({
        input: 'hi',
        tools: [],
        handoffs: [],
        modelSettings: {},
        outputType: structuredOutputType,
        tracing: false,
      } as any),
    );

    expect(transformOutputText).toHaveBeenCalledTimes(1);
    expect(res.output).toEqual([
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '{"content":"structured"}' }],
        status: 'completed',
        providerData: {
          model: 'stub:m',
          responseId: 'id',
        },
      },
    ]);
  });

  test('accepts specificationVersion v3 models with compatible shape', async () => {
    const model = new AiSdkModel(
      stubModel(
        {
          async doGenerate() {
            return {
              content: [{ type: 'text', text: 'ok v3' }],
              usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
              providerMetadata: {},
              response: { id: 'id-v3' },
              finishReason: 'stop',
              warnings: [],
            } as any;
          },
        },
        { specificationVersion: 'v3' },
      ),
    );

    const res = await withTrace('t', () =>
      model.getResponse({
        input: 'hi',
        tools: [],
        handoffs: [],
        modelSettings: {},
        outputType: 'text',
        tracing: false,
      } as any),
    );

    expect(res.output[0]).toMatchObject({
      providerData: {
        model: 'stub:m',
        responseId: 'id-v3',
      },
    });
  });

  test('normalizes empty string tool input for object schemas', async () => {
    const model = new AiSdkModel(
      stubModel({
        async doGenerate() {
          return {
            content: [
              {
                type: 'tool-call',
                toolCallId: 'call-1',
                toolName: 'objectTool',
                input: '',
              },
            ],
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            providerMetadata: { meta: true },
            response: { id: 'id' },
            finishReason: 'tool-calls',
            warnings: [],
          } as any;
        },
      }),
    );

    const res = await withTrace('t', () =>
      model.getResponse({
        input: 'hi',
        tools: [
          {
            type: 'function',
            name: 'objectTool',
            description: 'accepts object',
            parameters: {
              type: 'object',
              properties: {},
              additionalProperties: false,
            },
          } as any,
        ],
        handoffs: [],
        modelSettings: {},
        outputType: 'text',
        tracing: false,
      } as any),
    );

    expect(res.output).toHaveLength(1);
    expect(res.output[0]).toMatchObject({
      type: 'function_call',
      arguments: '{}',
    });
  });

  test('normalizes empty string input for namespaced object tools in doGenerate', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const model = new AiSdkModel(
      stubModel({
        async doGenerate() {
          return {
            content: [
              {
                type: 'tool-call',
                toolCallId: 'call-1',
                toolName: 'crm.lookup_account',
                input: '',
              },
            ],
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            providerMetadata: { meta: true },
            response: { id: 'id' },
            finishReason: 'tool-calls',
            warnings: [],
          } as any;
        },
      }),
    );

    const res = await withTrace('t', () =>
      model.getResponse({
        input: 'hi',
        tools: [
          {
            type: 'function',
            name: 'lookup_account',
            namespace: 'crm',
            description: 'accepts object',
            parameters: {
              type: 'object',
              properties: {},
              additionalProperties: false,
            },
          } as any,
        ],
        handoffs: [],
        modelSettings: {},
        outputType: 'text',
        tracing: false,
      } as any),
    );

    expect(res.output).toHaveLength(1);
    expect(res.output[0]).toMatchObject({
      type: 'function_call',
      name: 'lookup_account',
      namespace: 'crm',
      arguments: '{}',
    });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test('preserves hosted tool_search calls in doGenerate', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const model = new AiSdkModel(
      stubModel({
        async doGenerate() {
          return {
            content: [
              {
                type: 'tool-call',
                toolCallId: 'ts_call_1',
                toolName: 'tool_search',
                input: '{"paths":["crm"],"query":"lookup account"}',
                providerMetadata: { execution: 'client' },
              },
            ],
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            providerMetadata: { meta: true },
            response: { id: 'id' },
            finishReason: 'tool-calls',
            warnings: [],
          } as any;
        },
      }),
    );

    const res = await withTrace('t', () =>
      model.getResponse({
        input: 'hi',
        tools: [
          {
            type: 'hosted_tool',
            name: 'tool_search',
            providerData: {
              type: 'tool_search',
              execution: 'client',
            },
          } as any,
        ],
        handoffs: [],
        modelSettings: {},
        outputType: 'text',
        tracing: false,
      } as any),
    );

    expect(res.output).toEqual([
      {
        type: 'tool_search_call',
        id: 'ts_call_1',
        arguments: {
          paths: ['crm'],
          query: 'lookup account',
        },
        status: 'completed',
        providerData: {
          model: 'stub:m',
          responseId: 'id',
          execution: 'client',
        },
      },
    ]);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test('preserves provider-executed tool search call and result order in doGenerate', async () => {
    const model = new AiSdkModel(
      stubModel(
        {
          async doGenerate() {
            return {
              content: [
                {
                  type: 'tool-call',
                  toolCallId: 'search_1',
                  toolName: 'tool_search',
                  input: { query: 'weather' },
                  providerExecuted: true,
                },
                {
                  type: 'tool-result',
                  toolCallId: 'search_1',
                  toolName: 'tool_search',
                  result: [{ type: 'tool_reference', toolName: 'get_weather' }],
                },
                {
                  type: 'tool-call',
                  toolCallId: 'weather_1',
                  toolName: 'get_weather',
                  input: { city: 'Tokyo' },
                },
              ],
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              providerMetadata: {},
              response: { id: 'response_1' },
              finishReason: 'tool-calls',
              warnings: [],
            } as any;
          },
        },
        { provider: 'anthropic.messages', specificationVersion: 'v3' },
      ),
    );

    const result = await withTrace('t', () =>
      model.getResponse({
        input: 'Find the weather tool and use it.',
        tools: [
          aiSdkToolSearchTool({
            type: 'provider',
            id: 'anthropic.tool_search_regex_20251119',
          }),
          {
            type: 'function',
            name: 'get_weather',
            description: 'Get the weather.',
            parameters: { type: 'object', properties: {} },
            strict: true,
            providerData: { anthropic: { deferLoading: true } },
          } as any,
        ],
        handoffs: [],
        modelSettings: {},
        outputType: 'text',
        tracing: false,
      } as any),
    );

    expect(result.output.map((item) => item.type)).toEqual([
      'tool_search_call',
      'tool_search_output',
      'function_call',
    ]);
    expect(result.output[0]).toMatchObject({
      type: 'tool_search_call',
      id: 'search_1',
      execution: 'server',
      arguments: { query: 'weather' },
    });
    expect(result.output[1]).toMatchObject({
      type: 'tool_search_output',
      callId: 'search_1',
      execution: 'server',
      tools: [{ type: 'tool_reference', toolName: 'get_weather' }],
    });
    expect(result.output[2]).toMatchObject({
      type: 'function_call',
      callId: 'weather_1',
      name: 'get_weather',
    });
  });

  test('preserves interleaved reasoning and tool order in doGenerate', async () => {
    const model = new AiSdkModel(
      stubModel(
        {
          async doGenerate() {
            return {
              content: [
                {
                  type: 'reasoning',
                  text: 'Find a weather tool.',
                  providerMetadata: {
                    anthropic: { signature: 'sig-before-search' },
                  },
                },
                {
                  type: 'tool-call',
                  toolCallId: 'search_1',
                  toolName: 'tool_search',
                  input: { query: 'weather' },
                  providerExecuted: true,
                },
                {
                  type: 'tool-result',
                  toolCallId: 'search_1',
                  toolName: 'tool_search',
                  result: [{ type: 'tool_reference', toolName: 'get_weather' }],
                },
                {
                  type: 'text',
                  text: 'I found the weather tool.',
                },
                {
                  type: 'reasoning',
                  text: 'Call the weather tool.',
                  providerMetadata: {
                    anthropic: { signature: 'sig-after-search' },
                  },
                },
                {
                  type: 'text',
                  text: 'I will call it now.',
                },
                {
                  type: 'tool-call',
                  toolCallId: 'weather_1',
                  toolName: 'get_weather',
                  input: { city: 'Tokyo' },
                },
              ],
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              providerMetadata: {},
              response: { id: 'response_1' },
              finishReason: 'tool-calls',
              warnings: [],
            } as any;
          },
        },
        { provider: 'anthropic.messages', specificationVersion: 'v3' },
      ),
    );

    const result = await withTrace('t', () =>
      model.getResponse({
        input: 'Find the weather tool and use it.',
        tools: [
          aiSdkToolSearchTool({
            type: 'provider',
            id: 'anthropic.tool_search_regex_20251119',
          }),
          {
            type: 'function',
            name: 'get_weather',
            description: 'Get the weather.',
            parameters: { type: 'object', properties: {} },
            strict: true,
            providerData: { anthropic: { deferLoading: true } },
          } as any,
        ],
        handoffs: [],
        modelSettings: {},
        outputType: 'text',
        tracing: false,
      } as any),
    );

    expect(result.output.map((item) => item.type)).toEqual([
      'reasoning',
      'tool_search_call',
      'tool_search_output',
      'message',
      'reasoning',
      'message',
      'function_call',
    ]);
    expect(result.output[0]).toMatchObject({
      providerData: {
        anthropic: { signature: 'sig-before-search' },
      },
    });
    expect(result.output[3]).toMatchObject({
      content: [{ type: 'output_text', text: 'I found the weather tool.' }],
    });
    expect(result.output[4]).toMatchObject({
      providerData: {
        anthropic: { signature: 'sig-after-search' },
      },
    });
    expect(result.output[5]).toMatchObject({
      content: [{ type: 'output_text', text: 'I will call it now.' }],
    });
  });

  test('preserves provider-executed tool search errors and continues the run', async () => {
    const prompts: any[] = [];
    const errorResult = {
      type: 'tool_search_tool_result_error',
      errorCode: 'invalid_pattern',
    };
    const model = new AiSdkModel(
      stubModel(
        {
          async doGenerate(options) {
            prompts.push(options.prompt);
            if (prompts.length > 1) {
              return {
                content: [
                  {
                    type: 'text',
                    text: 'The tool search failed, so I used a fallback.',
                  },
                ],
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                response: { id: 'response_2' },
                finishReason: 'stop',
                warnings: [],
              } as any;
            }

            return {
              content: [
                {
                  type: 'tool-call',
                  toolCallId: 'search_1',
                  toolName: 'tool_search',
                  input: {},
                  providerExecuted: true,
                },
                {
                  type: 'tool-result',
                  toolCallId: 'search_1',
                  toolName: 'tool_search',
                  isError: true,
                  result: errorResult,
                },
              ],
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              response: { id: 'response_1' },
              finishReason: 'error',
              warnings: [],
            } as any;
          },
        },
        { provider: 'anthropic.messages', specificationVersion: 'v3' },
      ),
    );

    const result = await run(
      new Agent({
        name: 'Tool search agent',
        model,
        tools: [
          aiSdkToolSearchTool({
            type: 'provider',
            id: 'anthropic.tool_search_regex_20251119',
          }),
        ],
      }),
      'Find a tool.',
    );

    expect(result.finalOutput).toBe(
      'The tool search failed, so I used a fallback.',
    );
    expect(result.history).toContainEqual(
      expect.objectContaining({
        type: 'tool_search_output',
        callId: 'search_1',
        execution: 'server',
        status: 'failed',
        tools: [errorResult],
      }),
    );
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          content: expect.arrayContaining([
            expect.objectContaining({
              type: 'tool-result',
              toolCallId: 'search_1',
              output: { type: 'error-json', value: errorResult },
            }),
          ]),
        }),
      ]),
    );
  });

  test('rejects malformed successful provider-executed tool search results', async () => {
    const model = new AiSdkModel(
      stubModel(
        {
          async doGenerate() {
            return {
              content: [
                {
                  type: 'tool-call',
                  toolCallId: 'search_1',
                  toolName: 'tool_search',
                  input: {},
                  providerExecuted: true,
                },
                {
                  type: 'tool-result',
                  toolCallId: 'search_1',
                  toolName: 'tool_search',
                  result: { type: 'unexpected_success_shape' },
                },
              ],
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              response: { id: 'response_1' },
              finishReason: 'tool-calls',
              warnings: [],
            } as any;
          },
        },
        { provider: 'anthropic.messages', specificationVersion: 'v3' },
      ),
    );

    await expect(
      withTrace('t', () =>
        model.getResponse({
          input: 'Find a tool.',
          tools: [
            aiSdkToolSearchTool({
              type: 'provider',
              id: 'anthropic.tool_search_regex_20251119',
            }),
          ],
          handoffs: [],
          modelSettings: {},
          outputType: 'text',
          tracing: false,
        } as any),
      ),
    ).rejects.toThrow(
      /Expected an array of tool references or an error object/,
    );
  });

  test('rejects ambiguous hosted and custom tool_search names in doGenerate', async () => {
    const doGenerate = vi.fn();
    const model = new AiSdkModel(
      stubModel({
        async doGenerate(...args: any[]) {
          return doGenerate(...args);
        },
      }),
    );

    await expect(
      withTrace('t', () =>
        model.getResponse({
          input: 'hi',
          tools: [
            {
              type: 'hosted_tool',
              name: 'tool_search',
              providerData: {
                type: 'tool_search',
                execution: 'client',
              },
            } as any,
            {
              type: 'function',
              name: 'tool_search',
              description: 'Custom tool_search function',
              parameters: {
                type: 'object',
                properties: {},
                additionalProperties: false,
              },
            } as any,
          ],
          handoffs: [],
          modelSettings: {},
          outputType: 'text',
          tracing: false,
        } as any),
      ),
    ).rejects.toThrow(
      /cannot disambiguate a hosted tool_search helper from a custom tool or handoff/,
    );
    expect(doGenerate).not.toHaveBeenCalled();
  });

  test('rejects flattened namespace and handoff name collisions in doGenerate', async () => {
    const doGenerate = vi.fn();
    const model = new AiSdkModel(
      stubModel({
        async doGenerate(...args: any[]) {
          return doGenerate(...args);
        },
      }),
    );

    await expect(
      withTrace('t', () =>
        model.getResponse({
          input: 'hi',
          tools: [
            {
              type: 'function',
              name: 'lookup',
              namespace: 'crm',
              description: 'Look up a CRM record.',
              parameters: {
                type: 'object',
                properties: {},
                additionalProperties: false,
              },
            } as any,
          ],
          handoffs: [
            {
              toolName: 'crm.lookup',
              toolDescription: 'Handoff with the same flattened name.',
              inputJsonSchema: {
                type: 'object',
                properties: {},
                additionalProperties: false,
              },
              strictJsonSchema: true,
            },
          ],
          modelSettings: {},
          outputType: 'text',
          tracing: false,
          _internal: { toolNameCollisionPolicy: 'error' },
        } as any),
      ),
    ).rejects.toThrow(
      'AiSdkModel cannot disambiguate function tools and handoffs with the same flattened name.',
    );
    expect(doGenerate).not.toHaveBeenCalled();
  });

  test('rejects flattened deferred and handoff name collisions in doGenerate', async () => {
    const doGenerate = vi.fn();
    const model = new AiSdkModel(stubModel({ doGenerate }));

    await expect(
      withTrace('t', () =>
        model.getResponse({
          input: 'hi',
          tools: [
            {
              type: 'function',
              name: 'lookup',
              description: 'Deferred lookup.',
              parameters: {
                type: 'object',
                properties: {},
                additionalProperties: false,
              },
              deferLoading: true,
            } as any,
          ],
          handoffs: [
            {
              toolName: 'lookup',
              toolDescription: 'Handoff with the same flattened name.',
              inputJsonSchema: {
                type: 'object',
                properties: {},
                additionalProperties: false,
              },
              strictJsonSchema: true,
            },
          ],
          modelSettings: {},
          outputType: 'text',
          tracing: false,
        } as any),
      ),
    ).rejects.toThrow(
      'AiSdkModel cannot disambiguate function tools and handoffs with the same flattened name.',
    );
    expect(doGenerate).not.toHaveBeenCalled();
  });

  test.each([false, true])(
    'redacts flattened collision names from AI SDK span errors (stream: %s)',
    async (stream) => {
      const secretNamespace = 'SECRET_AI_SDK_TRACE';
      const processor = new RecordingTracingProcessor();
      const model = new AiSdkModel(stubModel({}));
      const request = {
        input: 'hi',
        tools: [
          {
            type: 'function',
            name: 'lookup',
            namespace: secretNamespace,
            description: 'Look up a record.',
            parameters: {
              type: 'object',
              properties: {},
              additionalProperties: false,
            },
          } as any,
        ],
        handoffs: [
          {
            toolName: `${secretNamespace}.lookup`,
            toolDescription: 'Conflicting handoff.',
            inputJsonSchema: {
              type: 'object',
              properties: {},
              additionalProperties: false,
            },
            strictJsonSchema: true,
          },
        ],
        modelSettings: {},
        outputType: 'text',
        tracing: 'enabled_without_data',
      } as any;
      vi.stubEnv('OPENAI_AGENTS_DONT_LOG_TOOL_DATA', '0');
      vi.stubEnv('OPENAI_AGENTS_DONT_LOG_MODEL_DATA', '0');
      setTraceProcessors([processor]);
      setTracingDisabled(false);

      try {
        let callerError: unknown;
        if (stream) {
          try {
            await withTrace('trace-redaction', async () => {
              for await (const _event of model.getStreamedResponse(request)) {
                void _event;
              }
            });
          } catch (error) {
            callerError = error;
          }
        } else {
          try {
            await withTrace('trace-redaction', () =>
              model.getResponse(request),
            );
          } catch (error) {
            callerError = error;
          }
        }

        expect(callerError).toBeInstanceOf(UserError);
        expect(String(callerError)).toContain(secretNamespace);
        const spanErrors = processor.spansEnded
          .map((span) => span.error)
          .filter((error) => error !== null);
        expect(spanErrors.length).toBeGreaterThan(0);
        expect(JSON.stringify(spanErrors)).not.toContain(secretNamespace);
      } finally {
        vi.unstubAllEnvs();
        setTraceProcessors([]);
        setTracingDisabled(true);
      }
    },
  );

  test('rejects flattened function and provider tool collisions in doGenerate', async () => {
    const doGenerate = vi.fn();
    const model = new AiSdkModel(stubModel({ doGenerate }));

    await expect(
      withTrace('t', () =>
        model.getResponse({
          input: 'hi',
          tools: [
            {
              type: 'function',
              name: 'lookup',
              namespace: 'crm',
              description: 'Look up a CRM record.',
              parameters: {
                type: 'object',
                properties: {},
                additionalProperties: false,
              },
            } as any,
            {
              type: 'hosted_tool',
              name: 'crm.lookup',
              providerData: { type: 'web_search' },
            } as any,
          ],
          handoffs: [],
          modelSettings: {},
          outputType: 'text',
          tracing: false,
        } as any),
      ),
    ).rejects.toThrow(
      /AiSdkModel cannot disambiguate (?:tools with the same flattened name|the flattened tool name 'crm\.lookup')/,
    );
    expect(doGenerate).not.toHaveBeenCalled();
  });

  test('rejects duplicate provider tool names before doGenerate', async () => {
    const doGenerate = vi.fn();
    const model = new AiSdkModel(stubModel({ doGenerate }));
    const providerTool = {
      type: 'hosted_tool',
      name: 'search',
      providerData: { type: 'web_search' },
    } as any;

    await expect(
      withTrace('t', () =>
        model.getResponse({
          input: 'hi',
          tools: [providerTool, { ...providerTool }],
          handoffs: [],
          modelSettings: {},
          outputType: 'text',
          tracing: false,
        } as any),
      ),
    ).rejects.toThrow(
      /AiSdkModel cannot disambiguate (?:provider tools with the same flattened name|the flattened provider tool name 'search')/,
    );
    expect(doGenerate).not.toHaveBeenCalled();
  });

  test('redacts duplicate provider tool names before doGenerate', async () => {
    const original = process.env.OPENAI_AGENTS_DONT_LOG_TOOL_DATA;
    process.env.OPENAI_AGENTS_DONT_LOG_TOOL_DATA = '1';
    const doGenerate = vi.fn();
    const model = new AiSdkModel(stubModel({ doGenerate }));
    const secret = 'SECRET_DUPLICATE_PROVIDER_TOOL';

    try {
      await expect(
        withTrace('t', () =>
          model.getResponse({
            input: 'hi',
            tools: [
              {
                type: 'hosted_tool',
                name: secret,
                providerData: { type: 'web_search' },
              },
              {
                type: 'hosted_tool',
                name: secret,
                providerData: { type: 'web_search' },
              },
            ],
            handoffs: [],
            modelSettings: {},
            outputType: 'text',
            tracing: false,
          } as any),
        ),
      ).rejects.toThrow(
        'AiSdkModel cannot disambiguate provider tools with the same flattened name.',
      );
      expect(doGenerate).not.toHaveBeenCalled();
    } finally {
      if (original === undefined) {
        delete process.env.OPENAI_AGENTS_DONT_LOG_TOOL_DATA;
      } else {
        process.env.OPENAI_AGENTS_DONT_LOG_TOOL_DATA = original;
      }
    }
  });

  test('rejects a default-policy flattened collision before doGenerate', async () => {
    const doGenerate = vi.fn();
    const model = new AiSdkModel(stubModel({ doGenerate }));
    const [lookup] = toolNamespace({
      name: 'crm',
      description: 'CRM tools.',
      tools: [
        tool({
          name: 'lookup',
          description: 'Look up a CRM record.',
          parameters: z.object({}),
          execute: async () => 'record',
        }),
      ],
    });
    const lookupHandoff = handoff(new Agent({ name: 'CRM specialist' }), {
      toolNameOverride: 'crm.lookup',
    });
    await expect(
      run(
        new Agent({
          name: 'Routing agent',
          model,
          tools: [lookup!],
          handoffs: [lookupHandoff],
        }),
        'hi',
      ),
    ).rejects.toThrow(
      'AiSdkModel cannot disambiguate function tools and handoffs with the same flattened name.',
    );
    expect(doGenerate).not.toHaveBeenCalled();
  });

  test('exposes one winner when the same function tool object is repeated in doGenerate', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const doGenerate = vi.fn(async (_options: any): Promise<any> => ({
      content: [],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      response: { id: 'id' },
      providerMetadata: {},
      finishReason: 'stop',
      warnings: [],
    }));
    const model = new AiSdkModel(stubModel({ doGenerate }));
    const duplicateTool = {
      type: 'function',
      name: 'duplicate',
      description: 'Repeated tool object.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    } as any;

    try {
      await withTrace('t', () =>
        model.getResponse({
          input: 'hi',
          tools: [duplicateTool, duplicateTool],
          handoffs: [],
          modelSettings: {},
          outputType: 'text',
          tracing: false,
        } as any),
      );

      expect(doGenerate.mock.calls[0]![0].tools).toEqual([
        expect.objectContaining({ name: 'duplicate' }),
      ]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('rejects same-name namespaces before doGenerate', async () => {
    const doGenerate = vi.fn();
    const model = new AiSdkModel(stubModel({ doGenerate }));

    await expect(
      withTrace('t', () =>
        model.getResponse({
          input: 'hi',
          tools: [
            {
              type: 'function',
              name: 'lookup_account',
              namespace: 'lookup_account',
              description: 'Same-name namespace lookup tool.',
              parameters: {
                type: 'object',
                properties: {},
                additionalProperties: false,
              },
            } as any,
          ],
          handoffs: [],
          modelSettings: {},
          outputType: 'text',
          tracing: false,
        } as any),
      ),
    ).rejects.toThrow(
      /AiSdkModel cannot route (?:a function tool whose namespace matches its name|the function tool 'lookup_account' because its namespace matches its name)/,
    );
    expect(doGenerate).not.toHaveBeenCalled();
  });

  test('redacts same-name namespaces before doGenerate', async () => {
    const original = process.env.OPENAI_AGENTS_DONT_LOG_TOOL_DATA;
    process.env.OPENAI_AGENTS_DONT_LOG_TOOL_DATA = '1';
    const doGenerate = vi.fn();
    const model = new AiSdkModel(stubModel({ doGenerate }));
    const secret = 'SECRET_SAME_NAME_NAMESPACE';

    try {
      await expect(
        withTrace('t', () =>
          model.getResponse({
            input: 'hi',
            tools: [
              {
                type: 'function',
                name: secret,
                namespace: secret,
                description: 'Same-name namespace tool.',
                parameters: {
                  type: 'object',
                  properties: {},
                  additionalProperties: false,
                },
              } as any,
            ],
            handoffs: [],
            modelSettings: {},
            outputType: 'text',
            tracing: false,
          } as any),
        ),
      ).rejects.toThrow(
        'AiSdkModel cannot route a function tool whose namespace matches its name',
      );
      expect(doGenerate).not.toHaveBeenCalled();
    } finally {
      if (original === undefined) {
        delete process.env.OPENAI_AGENTS_DONT_LOG_TOOL_DATA;
      } else {
        process.env.OPENAI_AGENTS_DONT_LOG_TOOL_DATA = original;
      }
    }
  });

  test('normalizes empty string tool input for handoff schemas', async () => {
    const model = new AiSdkModel(
      stubModel({
        async doGenerate() {
          return {
            content: [
              {
                type: 'tool-call',
                toolCallId: 'handoff-call',
                toolName: 'handoffTool',
                input: '',
              },
            ],
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            providerMetadata: { meta: true },
            response: { id: 'id' },
            finishReason: 'tool-calls',
            warnings: [],
          } as any;
        },
      }),
    );

    const res = await withTrace('t', () =>
      model.getResponse({
        input: 'hi',
        tools: [],
        handoffs: [
          {
            toolName: 'handoffTool',
            toolDescription: 'handoff accepts object',
            inputJsonSchema: {
              type: 'object',
              properties: {},
              additionalProperties: false,
            },
            strictJsonSchema: true,
          } as any,
        ],
        modelSettings: {},
        outputType: 'text',
        tracing: false,
      } as any),
    );

    expect(res.output).toHaveLength(1);
    expect(res.output[0]).toMatchObject({
      type: 'function_call',
      arguments: '{}',
    });
  });

  test('forwards toolChoice to AI SDK (generate)', async () => {
    const seen: any[] = [];
    const model = new AiSdkModel(
      stubModel({
        async doGenerate(options) {
          seen.push(options.toolChoice);
          return {
            content: [{ type: 'text', text: 'ok' }],
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            providerMetadata: {},
            response: { id: 'id' },
            finishReason: 'stop',
            warnings: [],
          } as any;
        },
      }),
    );

    // auto
    await withTrace('t', () =>
      model.getResponse({
        input: 'hi',
        tools: [],
        handoffs: [],
        modelSettings: { toolChoice: 'auto' },
        outputType: 'text',
        tracing: false,
      } as any),
    );
    // required
    await withTrace('t', () =>
      model.getResponse({
        input: 'hi',
        tools: [],
        handoffs: [],
        modelSettings: { toolChoice: 'required' },
        outputType: 'text',
        tracing: false,
      } as any),
    );
    // none
    await withTrace('t', () =>
      model.getResponse({
        input: 'hi',
        tools: [],
        handoffs: [],
        modelSettings: { toolChoice: 'none' },
        outputType: 'text',
        tracing: false,
      } as any),
    );
    // specific tool
    await withTrace('t', () =>
      model.getResponse({
        input: 'hi',
        tools: [],
        handoffs: [],
        modelSettings: { toolChoice: 'myTool' as any },
        outputType: 'text',
        tracing: false,
      } as any),
    );

    expect(seen).toEqual([
      { type: 'auto' },
      { type: 'required' },
      { type: 'none' },
      { type: 'tool', toolName: 'myTool' },
    ]);
  });

  test('aborts when signal already aborted', async () => {
    const abort = new AbortController();
    abort.abort();
    const doGenerate = vi.fn(async (opts: any) => {
      if (opts.abortSignal?.aborted) {
        throw new Error('aborted');
      }
      return {
        content: [{ type: 'text', text: 'should not' }],
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        response: { id: 'id' },
        finishReason: 'stop',
        warnings: [],
      };
    });
    const model = new AiSdkModel(
      stubModel({
        // @ts-expect-error don't care about the type error here
        doGenerate,
      }),
    );

    await expect(
      withTrace('t', () =>
        model.getResponse({
          input: 'hi',
          tools: [],
          handoffs: [],
          modelSettings: {},
          outputType: 'text',
          tracing: false,
          signal: abort.signal,
        } as any),
      ),
    ).rejects.toThrow('aborted');
    expect(doGenerate).toHaveBeenCalled();
  });

  test('handles function call output', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const model = new AiSdkModel(
      stubModel({
        async doGenerate() {
          return {
            content: [
              {
                type: 'tool-call',
                toolCallId: 'c1',
                toolName: 'foo',
                input: {} as any,
              },
            ],
            usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
            providerMetadata: { p: 1 },
            response: { id: 'id' },
            finishReason: 'stop',
            warnings: [],
          } as any;
        },
      }),
    );

    const res = await withTrace('t', () =>
      model.getResponse({
        input: 'hi',
        tools: [],
        handoffs: [],
        modelSettings: {},
        outputType: 'text',
        tracing: false,
      } as any),
    );

    expect(res.output).toEqual([
      {
        type: 'function_call',
        callId: 'c1',
        name: 'foo',
        arguments: '{}',
        status: 'completed',
        providerData: {
          model: 'stub:m',
          responseId: 'id',
          p: 1,
        },
      },
    ]);
    expect(warnSpy).toHaveBeenCalledWith(
      'Received tool call for an unknown tool. Tool name is redacted.',
    );
    warnSpy.mockRestore();
  });

  test.each([
    'OPENAI_AGENTS_DONT_LOG_MODEL_DATA',
    'OPENAI_AGENTS_DONT_LOG_TOOL_DATA',
  ] as const)(
    'redacts unknown tool names when %s is enabled',
    async (flagName) => {
      const original = process.env[flagName];
      process.env[flagName] = '1';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const secret = 'SECRET_UNKNOWN_AI_SDK_TOOL_123';
      const model = new AiSdkModel(
        stubModel({
          async doGenerate() {
            return {
              content: [
                {
                  type: 'tool-call',
                  toolCallId: 'c1',
                  toolName: secret,
                  input: {} as any,
                },
              ],
              usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
              providerMetadata: { p: 1 },
              response: { id: 'id' },
              finishReason: 'stop',
              warnings: [],
            } as any;
          },
        }),
      );

      try {
        const res = await withTrace('t', () =>
          model.getResponse({
            input: 'hi',
            tools: [],
            handoffs: [],
            modelSettings: {},
            outputType: 'text',
            tracing: false,
          } as any),
        );

        expect(res.output[0]).toMatchObject({ name: secret });
        expect(warnSpy).toHaveBeenCalledWith(
          'Received tool call for an unknown tool. Tool name is redacted.',
        );
        expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(secret);
      } finally {
        warnSpy.mockRestore();
        if (typeof original === 'undefined') {
          delete process.env[flagName];
        } else {
          process.env[flagName] = original;
        }
      }
    },
  );

  test('preserves per-tool-call providerMetadata (e.g., Gemini thoughtSignature)', async () => {
    const toolCallProviderMetadata = {
      google: { thoughtSignature: 'sig123' },
    };
    const resultProviderMetadata = {
      google: { usageMetadata: { totalTokenCount: 100 } },
    };

    const model = new AiSdkModel(
      stubModel({
        async doGenerate() {
          return {
            content: [
              {
                type: 'tool-call',
                toolCallId: 'c1',
                toolName: 'get_weather',
                input: { location: 'Tokyo' },
                providerMetadata: toolCallProviderMetadata,
              },
            ],
            usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
            providerMetadata: resultProviderMetadata,
            response: { id: 'resp-1' },
            finishReason: 'tool-calls',
            warnings: [],
          } as any;
        },
      }),
    );

    const res = await withTrace('t', () =>
      model.getResponse({
        input: 'What is the weather in Tokyo?',
        tools: [
          {
            type: 'function',
            name: 'get_weather',
            description: 'Get weather',
            parameters: { type: 'object', properties: {} },
          },
        ],
        handoffs: [],
        modelSettings: {},
        outputType: 'text',
        tracing: false,
      } as any),
    );

    expect(res.output).toHaveLength(1);
    expect(res.output[0]).toMatchObject({
      type: 'function_call',
      callId: 'c1',
      name: 'get_weather',
      providerData: {
        model: 'stub:m',
        responseId: 'resp-1',
        ...toolCallProviderMetadata,
      },
    });
    // Ensure we get per-tool-call metadata, not result-level metadata
    expect(res.output[0].providerData).not.toEqual(resultProviderMetadata);
  });

  test('falls back to result.providerMetadata when toolCall.providerMetadata is undefined', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const resultProviderMetadata = { fallback: true };

    const model = new AiSdkModel(
      stubModel({
        async doGenerate() {
          return {
            content: [
              {
                type: 'tool-call',
                toolCallId: 'c1',
                toolName: 'foo',
                input: {},
                // No providerMetadata on tool call
              },
            ],
            usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
            providerMetadata: resultProviderMetadata,
            response: { id: 'id' },
            finishReason: 'tool-calls',
            warnings: [],
          } as any;
        },
      }),
    );

    const res = await withTrace('t', () =>
      model.getResponse({
        input: 'hi',
        tools: [],
        handoffs: [],
        modelSettings: {},
        outputType: 'text',
        tracing: false,
      } as any),
    );

    expect(res.output[0].providerData).toEqual({
      model: 'stub:m',
      responseId: 'id',
      ...resultProviderMetadata,
    });
    expect(warnSpy).toHaveBeenCalledWith(
      'Received tool call for an unknown tool. Tool name is redacted.',
    );
    warnSpy.mockRestore();
  });

  test('propagates errors', async () => {
    const model = new AiSdkModel(
      stubModel({
        async doGenerate() {
          throw new Error('bad');
        },
      }),
    );

    await expect(
      withTrace('t', () =>
        model.getResponse({
          input: 'hi',
          tools: [],
          handoffs: [],
          modelSettings: {},
          outputType: 'text',
          tracing: false,
        } as any),
      ),
    ).rejects.toThrow('bad');
  });

  test('prepends system instructions to prompt for doGenerate', async () => {
    let received: any;
    const model = new AiSdkModel(
      stubModel({
        async doGenerate(options) {
          received = options.prompt;
          return {
            content: [],
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            providerMetadata: {},
            response: { id: 'id' },
            finishReason: 'stop',
            warnings: [],
          };
        },
      }),
    );

    await withTrace('t', () =>
      model.getResponse({
        systemInstructions: 'inst',
        input: 'hi',
        tools: [],
        handoffs: [],
        modelSettings: {},
        outputType: 'text',
        tracing: false,
      } as any),
    );

    expect(received[0]).toEqual({
      role: 'system',
      content: 'inst',
    });
  });

  test('handles NaN usage in doGenerate', async () => {
    const model = new AiSdkModel(
      stubModel({
        async doGenerate() {
          return {
            content: [],
            usage: {
              inputTokens: Number.NaN,
              outputTokens: Number.NaN,
              totalTokens: Number.NaN,
            },
            providerMetadata: {},
            response: { id: 'id' },
            finishReason: 'stop',
            warnings: [],
          };
        },
      }),
    );

    const res = await withTrace('t', () =>
      model.getResponse({
        input: 'hi',
        tools: [],
        handoffs: [],
        modelSettings: {},
        outputType: 'text',
        tracing: false,
      } as any),
    );

    expect(res.usage).toEqual({
      requests: 1,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      inputTokensDetails: [],
      outputTokensDetails: [],
      requestUsageEntries: undefined,
    });
  });
});

describe('AiSdkModel.getStreamedResponse', () => {
  test('streams events and completes', async () => {
    const parts = [
      { type: 'text-delta', delta: 'a' },
      {
        type: 'tool-call',
        toolCallId: 'c1',
        toolName: 'foo',
        input: '{"k":"v"}',
      },
      { type: 'response-metadata', id: 'id1' },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 2 },
      },
    ];
    const model = new AiSdkModel(
      stubModel({
        async doStream() {
          return {
            stream: partsStream(parts),
          } as any;
        },
      }),
    );

    const events: any[] = [];
    for await (const ev of model.getStreamedResponse({
      input: 'hi',
      tools: [],
      handoffs: [],
      modelSettings: {},
      outputType: 'text',
      tracing: false,
    } as any)) {
      events.push(ev);
    }

    const final = events.at(-1);
    expect(final.type).toBe('response_done');
    expect(final.response.output).toEqual([
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'a' }],
        status: 'completed',
        providerData: {
          model: 'stub:m',
          responseId: 'id1',
        },
      },
      {
        type: 'function_call',
        callId: 'c1',
        name: 'foo',
        arguments: '{"k":"v"}',
        status: 'completed',
        providerData: {
          model: 'stub:m',
          responseId: 'id1',
        },
      },
    ]);
  });

  test('keeps streamed text contiguous across skipped response content', async () => {
    const parts = [
      { type: 'text-delta', id: 'text-1', delta: 'Hello ' },
      {
        type: 'source',
        sourceType: 'url',
        id: 'source-1',
        url: 'https://example.com/source',
      },
      {
        type: 'file',
        mediaType: 'image/png',
        data: 'iVBORw0KGgo=',
      },
      { type: 'text-delta', id: 'text-2', delta: 'world' },
      { type: 'response-metadata', id: 'id1' },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 2 },
      },
    ];
    const model = new AiSdkModel(
      stubModel({
        async doStream() {
          return { stream: partsStream(parts) } as any;
        },
      }),
    );

    const events: any[] = [];
    for await (const event of model.getStreamedResponse({
      input: 'Say hello.',
      tools: [],
      handoffs: [],
      modelSettings: {},
      outputType: 'text',
      tracing: false,
    } as any)) {
      events.push(event);
    }

    const final = events.at(-1);
    expect(final.response.output).toEqual([
      {
        type: 'message',
        id: 'text-1',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Hello world' }],
        status: 'completed',
        providerData: {
          model: 'stub:m',
          responseId: 'id1',
        },
      },
    ]);
  });

  test('keeps streamed text contiguous across empty reasoning frames', async () => {
    const parts = [
      { type: 'text-delta', id: 'text-1', delta: 'Hello ' },
      { type: 'reasoning-start', id: 'reasoning-1' },
      { type: 'reasoning-end', id: 'reasoning-1' },
      { type: 'text-delta', id: 'text-2', delta: 'world' },
      { type: 'response-metadata', id: 'id1' },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 2 },
      },
    ];
    const model = new AiSdkModel(
      stubModel({
        async doStream() {
          return { stream: partsStream(parts) } as any;
        },
      }),
    );

    const events: any[] = [];
    for await (const event of model.getStreamedResponse({
      input: 'Say hello.',
      tools: [],
      handoffs: [],
      modelSettings: {},
      outputType: 'text',
      tracing: false,
    } as any)) {
      events.push(event);
    }

    expect(
      events.filter((event) => event.type === 'output_text_delta'),
    ).toEqual([
      { type: 'output_text_delta', itemId: 'text-1', delta: 'Hello ' },
      { type: 'output_text_delta', itemId: 'text-1', delta: 'world' },
    ]);
    const final = events.at(-1);
    expect(final.response.output).toEqual([
      {
        type: 'message',
        id: 'text-1',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Hello world' }],
        status: 'completed',
        providerData: {
          model: 'stub:m',
          responseId: 'id1',
        },
      },
    ]);
  });

  test('keeps complete streamed final output across interleaved reasoning', async () => {
    const parts = [
      { type: 'text-delta', id: 'text-1', delta: 'first' },
      { type: 'reasoning-start', id: 'reasoning-1' },
      {
        type: 'reasoning-delta',
        id: 'reasoning-1',
        delta: 'thinking',
      },
      { type: 'reasoning-end', id: 'reasoning-1' },
      { type: 'text-delta', id: 'text-2', delta: 'second' },
      { type: 'reasoning-start', id: 'reasoning-2' },
      {
        type: 'reasoning-delta',
        id: 'reasoning-2',
        delta: 'checking',
      },
      { type: 'reasoning-end', id: 'reasoning-2' },
      { type: 'response-metadata', id: 'id1' },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 3 },
      },
    ];
    const model = new AiSdkModel(
      stubModel({
        async doStream() {
          return { stream: partsStream(parts) } as any;
        },
      }),
    );

    const result = await run(
      new Agent({ name: 'Assistant', model }),
      'Respond in two parts.',
      { stream: true },
    );
    await result.completed;

    expect(result.newItems.map((item) => item.rawItem?.type)).toEqual([
      'message',
      'reasoning',
      'message',
      'reasoning',
    ]);
    expect(result.finalOutput).toBe('firstsecond');
  });

  test('transforms complete streamed structured output once across interleaved reasoning', async () => {
    const transformOutputText = vi.fn((text: string) => {
      return text.match(/\{[\s\S]*\}/)?.[0] ?? text;
    });
    const parts = [
      {
        type: 'text-delta',
        id: 'text-1',
        delta: 'Result: {"content":',
      },
      { type: 'reasoning-start', id: 'reasoning-1' },
      {
        type: 'reasoning-delta',
        id: 'reasoning-1',
        delta: 'thinking',
      },
      { type: 'reasoning-end', id: 'reasoning-1' },
      { type: 'text-delta', id: 'text-2', delta: '"structured"}' },
      { type: 'response-metadata', id: 'id1' },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 3 },
      },
    ];
    const model = new AiSdkModel(
      stubModel({
        async doStream() {
          return { stream: partsStream(parts) } as any;
        },
      }),
      { transformOutputText },
    );

    const result = await run(
      new Agent({
        name: 'Structured Assistant',
        model,
        outputType: z.object({ content: z.string() }),
      }),
      'Respond with structured output.',
      { stream: true },
    );
    await result.completed;

    expect(transformOutputText).toHaveBeenCalledOnce();
    expect(transformOutputText).toHaveBeenCalledWith(
      'Result: {"content":"structured"}',
      expect.objectContaining({ stream: true }),
    );
    expect(result.newItems.map((item) => item.rawItem?.type)).toEqual([
      'message',
      'reasoning',
      'message',
    ]);
    expect(result.finalOutput).toEqual({ content: 'structured' });
  });

  test('keeps streamed text contiguous across replacement tool calls', async () => {
    const parts = [
      {
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'lookup',
        input: '{"version":1}',
      },
      { type: 'text-delta', id: 'text-1', delta: 'Hello ' },
      {
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'lookup',
        input: '{"version":2}',
      },
      { type: 'text-delta', id: 'text-2', delta: 'world' },
      { type: 'response-metadata', id: 'id1' },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 2 },
      },
    ];
    const model = new AiSdkModel(
      stubModel({
        async doStream() {
          return { stream: partsStream(parts) } as any;
        },
      }),
    );

    const events: any[] = [];
    for await (const event of model.getStreamedResponse({
      input: 'Say hello.',
      tools: [],
      handoffs: [],
      modelSettings: {},
      outputType: 'text',
      tracing: false,
    } as any)) {
      events.push(event);
    }

    expect(
      events.filter((event) => event.type === 'output_text_delta'),
    ).toEqual([
      { type: 'output_text_delta', itemId: 'text-1', delta: 'Hello ' },
      { type: 'output_text_delta', itemId: 'text-1', delta: 'world' },
    ]);
    const final = events.at(-1);
    expect(final.response.output).toEqual([
      {
        type: 'function_call',
        callId: 'call-1',
        name: 'lookup',
        arguments: '{"version":2}',
        status: 'completed',
        providerData: {
          model: 'stub:m',
          responseId: 'id1',
        },
      },
      {
        type: 'message',
        id: 'text-1',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Hello world' }],
        status: 'completed',
        providerData: {
          model: 'stub:m',
          responseId: 'id1',
        },
      },
    ]);
  });

  test('applies transformOutputText to finalized streamed assistant text', async () => {
    const transformOutputText = vi.fn((text: string, context: any) => {
      expect(context.stream).toBe(true);
      expect(context.request.outputType).toEqual(structuredOutputType);
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      return jsonMatch?.[0] ?? text;
    });

    const model = new AiSdkModel(
      stubModel({
        async doStream() {
          return {
            stream: partsStream([
              {
                type: 'text-delta',
                delta:
                  'Result:\n```json\n{"content":"streamed structured"}\n```',
              },
              { type: 'response-metadata', id: 'id1' },
              {
                type: 'finish',
                finishReason: 'stop',
                usage: { inputTokens: 1, outputTokens: 2 },
              },
            ]),
          } as any;
        },
      }),
      { transformOutputText },
    );

    const events: any[] = [];
    for await (const ev of model.getStreamedResponse({
      input: 'hi',
      tools: [],
      handoffs: [],
      modelSettings: {},
      outputType: structuredOutputType,
      tracing: false,
    } as any)) {
      events.push(ev);
    }

    expect(transformOutputText).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({
      type: 'output_text_delta',
      delta: 'Result:\n```json\n{"content":"streamed structured"}\n```',
    });

    const final = events.at(-1);
    expect(final.type).toBe('response_done');
    expect(final.response.output).toEqual([
      {
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'output_text', text: '{"content":"streamed structured"}' },
        ],
        status: 'completed',
        providerData: {
          model: 'stub:m',
          responseId: 'id1',
        },
      },
    ]);
  });

  test('preserves per-tool-call providerMetadata in streaming mode (e.g., Gemini thoughtSignature)', async () => {
    const toolCallProviderMetadata = {
      google: { thoughtSignature: 'stream-sig-456' },
    };

    const parts = [
      {
        type: 'tool-call',
        toolCallId: 'c1',
        toolName: 'get_weather',
        input: '{"location":"Tokyo"}',
        providerMetadata: toolCallProviderMetadata,
      },
      { type: 'response-metadata', id: 'resp-stream-1' },
      {
        type: 'finish',
        finishReason: 'tool-calls',
        usage: { inputTokens: 10, outputTokens: 20 },
      },
    ];

    const model = new AiSdkModel(
      stubModel({
        async doStream() {
          return {
            stream: partsStream(parts),
          } as any;
        },
      }),
    );

    const events: any[] = [];
    for await (const ev of model.getStreamedResponse({
      input: 'What is the weather?',
      tools: [
        {
          type: 'function',
          name: 'get_weather',
          description: 'Get weather',
          parameters: { type: 'object', properties: {} },
        },
      ],
      handoffs: [],
      modelSettings: {},
      outputType: 'text',
      tracing: false,
    } as any)) {
      events.push(ev);
    }

    const final = events.at(-1);
    expect(final.type).toBe('response_done');
    expect(final.response.output).toHaveLength(1);
    expect(final.response.output[0]).toMatchObject({
      type: 'function_call',
      callId: 'c1',
      name: 'get_weather',
      providerData: {
        model: 'stub:m',
        responseId: 'resp-stream-1',
        ...toolCallProviderMetadata,
      },
    });
  });

  test('preserves hosted tool_search calls in streaming mode', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const parts = [
      {
        type: 'tool-call',
        toolCallId: 'ts_call_1',
        toolName: 'tool_search',
        input: '{"paths":["crm"],"query":"lookup account"}',
        providerMetadata: { execution: 'client' },
      },
      { type: 'response-metadata', id: 'resp-stream-tool-search' },
      {
        type: 'finish',
        finishReason: 'tool-calls',
        usage: { inputTokens: 3, outputTokens: 4 },
      },
    ];

    const model = new AiSdkModel(
      stubModel({
        async doStream() {
          return {
            stream: partsStream(parts),
          } as any;
        },
      }),
    );

    const events: any[] = [];
    for await (const ev of model.getStreamedResponse({
      input: 'hi',
      tools: [
        {
          type: 'hosted_tool',
          name: 'tool_search',
          providerData: {
            type: 'tool_search',
            execution: 'client',
          },
        } as any,
      ],
      handoffs: [],
      modelSettings: {},
      outputType: 'text',
      tracing: false,
    } as any)) {
      events.push(ev);
    }

    const final = events.at(-1);
    expect(final.type).toBe('response_done');
    expect(final.response.output).toEqual([
      {
        type: 'tool_search_call',
        id: 'ts_call_1',
        arguments: {
          paths: ['crm'],
          query: 'lookup account',
        },
        status: 'completed',
        providerData: {
          model: 'stub:m',
          responseId: 'resp-stream-tool-search',
          execution: 'client',
        },
      },
    ]);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test('preserves text transform boundaries and provider-executed tool search order in streaming mode', async () => {
    const transformOutputText = vi.fn((text: string) =>
      text.replace('wrapped:', ''),
    );
    const parts = [
      { type: 'text-delta', id: 'text-1', delta: 'wrapped:first' },
      {
        type: 'tool-call',
        toolCallId: 'search_1',
        toolName: 'tool_search',
        input: { query: 'weather' },
        providerExecuted: true,
      },
      {
        type: 'text-delta',
        id: 'text-2',
        delta: 'wrapped:after-search-call',
      },
      {
        type: 'tool-result',
        toolCallId: 'search_1',
        toolName: 'tool_search',
        result: [{ type: 'tool_reference', toolName: 'get_weather' }],
      },
      {
        type: 'text-delta',
        id: 'text-3',
        delta: 'wrapped:after-search-result',
      },
      {
        type: 'tool-call',
        toolCallId: 'weather_1',
        toolName: 'get_weather',
        input: { city: 'Tokyo' },
      },
      {
        type: 'text-delta',
        id: 'text-4',
        delta: 'wrapped:after-function-call',
      },
      { type: 'response-metadata', id: 'response_stream_1' },
      {
        type: 'finish',
        finishReason: 'tool-calls',
        usage: { inputTokens: 3, outputTokens: 4 },
      },
    ];
    const model = new AiSdkModel(
      stubModel(
        {
          async doStream() {
            return { stream: partsStream(parts) } as any;
          },
        },
        { provider: 'anthropic.messages', specificationVersion: 'v3' },
      ),
      { transformOutputText },
    );

    const events: any[] = [];
    for await (const event of model.getStreamedResponse({
      input: 'Find the weather tool and use it.',
      tools: [
        aiSdkToolSearchTool({
          type: 'provider',
          id: 'anthropic.tool_search_regex_20251119',
        }),
        {
          type: 'function',
          name: 'get_weather',
          description: 'Get the weather.',
          parameters: { type: 'object', properties: {} },
          strict: true,
          providerData: { anthropic: { deferLoading: true } },
        } as any,
      ],
      handoffs: [],
      modelSettings: {},
      outputType: 'text',
      tracing: false,
    } as any)) {
      events.push(event);
    }

    const final = events.at(-1);
    expect(final.response.output.map((item: any) => item.type)).toEqual([
      'message',
      'tool_search_call',
      'message',
      'tool_search_output',
      'message',
      'function_call',
      'message',
    ]);
    expect(final.response.output[1]).toMatchObject({
      id: 'search_1',
      execution: 'server',
    });
    expect(final.response.output[3]).toMatchObject({
      callId: 'search_1',
      execution: 'server',
      tools: [{ type: 'tool_reference', toolName: 'get_weather' }],
    });
    expect(final.response.output[5]).toMatchObject({
      callId: 'weather_1',
      name: 'get_weather',
    });
    expect(transformOutputText.mock.calls.map(([text]) => text)).toEqual([
      'wrapped:first',
      'wrapped:after-search-call',
      'wrapped:after-search-result',
      'wrapped:after-function-call',
    ]);
    expect(
      final.response.output
        .filter((item: any) => item.type === 'message')
        .map((item: any) => item.content[0].text),
    ).toEqual([
      'first',
      'after-search-call',
      'after-search-result',
      'after-function-call',
    ]);
  });

  test('preserves interleaved reasoning and tool order in streaming mode', async () => {
    const parts = [
      {
        type: 'reasoning-start',
        id: 'reasoning_1',
      },
      {
        type: 'reasoning-delta',
        id: 'reasoning_1',
        delta: 'Find a weather tool.',
      },
      {
        type: 'reasoning-end',
        id: 'reasoning_1',
        providerMetadata: {
          anthropic: { signature: 'sig-before-search' },
        },
      },
      {
        type: 'tool-call',
        toolCallId: 'search_1',
        toolName: 'tool_search',
        input: { query: 'weather' },
        providerExecuted: true,
      },
      {
        type: 'tool-result',
        toolCallId: 'search_1',
        toolName: 'tool_search',
        result: [{ type: 'tool_reference', toolName: 'get_weather' }],
      },
      {
        type: 'text-delta',
        id: 'text_1',
        delta: 'I found the weather tool.',
      },
      {
        type: 'reasoning-start',
        id: 'reasoning_2',
      },
      {
        type: 'reasoning-delta',
        id: 'reasoning_2',
        delta: 'Call the weather tool.',
      },
      {
        type: 'reasoning-end',
        id: 'reasoning_2',
        providerMetadata: {
          anthropic: { signature: 'sig-after-search' },
        },
      },
      {
        type: 'text-delta',
        id: 'text_2',
        delta: 'I will call it now.',
      },
      {
        type: 'tool-call',
        toolCallId: 'weather_1',
        toolName: 'get_weather',
        input: { city: 'Tokyo' },
      },
      { type: 'response-metadata', id: 'response_stream_1' },
      {
        type: 'finish',
        finishReason: 'tool-calls',
        usage: { inputTokens: 3, outputTokens: 4 },
      },
    ];
    const model = new AiSdkModel(
      stubModel(
        {
          async doStream() {
            return { stream: partsStream(parts) } as any;
          },
        },
        { provider: 'anthropic.messages', specificationVersion: 'v3' },
      ),
    );

    const events: any[] = [];
    for await (const event of model.getStreamedResponse({
      input: 'Find the weather tool and use it.',
      tools: [
        aiSdkToolSearchTool({
          type: 'provider',
          id: 'anthropic.tool_search_regex_20251119',
        }),
        {
          type: 'function',
          name: 'get_weather',
          description: 'Get the weather.',
          parameters: { type: 'object', properties: {} },
          strict: true,
          providerData: { anthropic: { deferLoading: true } },
        } as any,
      ],
      handoffs: [],
      modelSettings: {},
      outputType: 'text',
      tracing: false,
    } as any)) {
      events.push(event);
    }

    const final = events.at(-1);
    expect(final.response.output.map((item: any) => item.type)).toEqual([
      'reasoning',
      'tool_search_call',
      'tool_search_output',
      'message',
      'reasoning',
      'message',
      'function_call',
    ]);
    expect(final.response.output[0]).toMatchObject({
      providerData: {
        anthropic: { signature: 'sig-before-search' },
      },
    });
    expect(final.response.output[3]).toMatchObject({
      id: 'text_1',
      content: [{ type: 'output_text', text: 'I found the weather tool.' }],
    });
    expect(final.response.output[4]).toMatchObject({
      providerData: {
        anthropic: { signature: 'sig-after-search' },
      },
    });
    expect(final.response.output[5]).toMatchObject({
      id: 'text_2',
      content: [{ type: 'output_text', text: 'I will call it now.' }],
    });
  });

  test('includes base providerData in streaming mode even when providerMetadata is not present', async () => {
    const parts = [
      {
        type: 'tool-call',
        toolCallId: 'c1',
        toolName: 'foo',
        input: '{}',
        // No providerMetadata
      },
      {
        type: 'finish',
        finishReason: 'tool-calls',
        usage: { inputTokens: 1, outputTokens: 2 },
      },
    ];

    const model = new AiSdkModel(
      stubModel({
        async doStream() {
          return {
            stream: partsStream(parts),
          } as any;
        },
      }),
    );

    const events: any[] = [];
    for await (const ev of model.getStreamedResponse({
      input: 'hi',
      tools: [],
      handoffs: [],
      modelSettings: {},
      outputType: 'text',
      tracing: false,
    } as any)) {
      events.push(ev);
    }

    const final = events.at(-1);
    expect(final.type).toBe('response_done');
    expect(final.response.output[0]).toMatchObject({
      type: 'function_call',
      callId: 'c1',
      name: 'foo',
    });
    // Base provider data should be present to preserve model origin
    expect(final.response.output[0].providerData).toEqual({
      model: 'stub:m',
    });
  });

  test('propagates stream errors', async () => {
    const err = new Error('bad');
    const parts = [{ type: 'error', error: err }];
    const model = new AiSdkModel(
      stubModel({
        async doStream() {
          return {
            stream: partsStream(parts),
          } as any;
        },
      }),
    );

    await expect(async () => {
      const iter = model.getStreamedResponse({
        input: 'hi',
        tools: [],
        handoffs: [],
        modelSettings: {},
        outputType: 'text',
        tracing: false,
      } as any);

      for await (const ev of iter) {
        if (ev.type === 'response_done') {
          expect(ev.response.id).toBeDefined();
        } else if (ev.type === 'model') {
          expect(ev.event).toBeDefined();
        }
      }
    }).rejects.toThrow('bad');
  });

  test('aborts streaming when signal already aborted', async () => {
    const abort = new AbortController();
    abort.abort();
    const doStream = vi.fn(async (opts: any) => {
      if (opts.abortSignal?.aborted) {
        throw new Error('aborted');
      }
      return {
        stream: partsStream([]),
      } as any;
    });
    const model = new AiSdkModel(
      stubModel({
        doStream,
      }),
    );

    await expect(async () => {
      const iter = model.getStreamedResponse({
        input: 'hi',
        tools: [],
        handoffs: [],
        modelSettings: {},
        outputType: 'text',
        tracing: false,
        signal: abort.signal,
      } as any);
      for await (const _ of iter) {
        /* nothing */
      }
    }).rejects.toThrow('aborted');
    expect(doStream).toHaveBeenCalled();
  });

  test('prepends system instructions to prompt for doStream', async () => {
    let received: any;
    const model = new AiSdkModel(
      stubModel({
        async doStream(options) {
          received = options.prompt;
          return {
            stream: partsStream([]),
          } as any;
        },
      }),
    );

    const iter = model.getStreamedResponse({
      systemInstructions: 'inst',
      input: 'hi',
      tools: [],
      handoffs: [],
      modelSettings: {},
      outputType: 'text',
      tracing: false,
    } as any);

    for await (const _ of iter) {
      // exhaust iterator
    }

    expect(received[0]).toEqual({
      role: 'system',
      content: 'inst',
    });
  });

  test('handles NaN usage in stream finish event', async () => {
    const parts = [
      { type: 'text-delta', delta: 'a' },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: Number.NaN, outputTokens: Number.NaN },
      },
    ];
    const model = new AiSdkModel(
      stubModel({
        async doStream() {
          return {
            stream: partsStream(parts),
          } as any;
        },
      }),
    );

    let final: any;
    for await (const ev of model.getStreamedResponse({
      input: 'hi',
      tools: [],
      handoffs: [],
      modelSettings: {},
      outputType: 'text',
      tracing: false,
    } as any)) {
      if (ev.type === 'response_done') {
        final = ev.response.usage;
      }
    }

    expect(final).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  });

  test('prepends system instructions to prompt for doStream', async () => {
    let received: any;
    const model = new AiSdkModel(
      stubModel({
        async doStream(options) {
          received = options.prompt;
          return { stream: partsStream([]) } as any;
        },
      }),
    );

    for await (const _ of model.getStreamedResponse({
      systemInstructions: 'inst',
      input: 'hi',
      tools: [],
      handoffs: [],
      modelSettings: {},
      outputType: 'text',
      tracing: false,
    } as any)) {
      // drain
    }

    expect(received[0]).toEqual({ role: 'system', content: 'inst' });
  });
});

describe('AI SDK prompt cache retention', () => {
  async function captureRequest(
    mode: 'generate' | 'stream',
    provider: string,
    modelSettings: Record<string, any>,
    specificationVersion = 'v3',
  ): Promise<any> {
    let received: any;
    const model = new AiSdkModel(
      stubModel(
        {
          async doGenerate(options) {
            received = options;
            return {
              content: [],
              usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
              providerMetadata: {},
              response: { id: 'id' },
              finishReason: 'stop',
              warnings: [],
            } as any;
          },
          async doStream(options) {
            received = options;
            return { stream: partsStream([]) } as any;
          },
        },
        { provider, specificationVersion },
      ),
    );
    const request = {
      input: 'hi',
      tools: [],
      handoffs: [],
      modelSettings,
      outputType: 'text',
      tracing: false,
    } as any;

    if (mode === 'generate') {
      await withTrace('prompt-cache-retention', () =>
        model.getResponse(request),
      );
    } else {
      for await (const _event of model.getStreamedResponse(request)) {
        // Drain the stream.
      }
    }

    return received;
  }

  test.each([
    ['generate', 'in-memory', 'in_memory'],
    ['stream', 'in-memory', 'in_memory'],
    ['generate', '24h', '24h'],
    ['stream', '24h', '24h'],
    ['generate', null, null],
    ['stream', null, null],
  ] as const)(
    'forwards %s prompt cache retention %s to OpenAI Responses',
    async (mode, retention, expected) => {
      const request = await captureRequest(mode, 'openai.responses', {
        promptCacheRetention: retention,
      });

      expect(request.providerOptions).toEqual({
        openai: { promptCacheRetention: expected },
      });
    },
  );

  test.each(['24h', null] as const)(
    'preserves provider options and gives an explicit %s retention precedence',
    async (providerPromptCacheRetention) => {
      const request = await captureRequest('generate', 'openai.responses', {
        promptCacheRetention: 'in-memory',
        providerData: {
          providerOptions: {
            openai: {
              promptCacheRetention: providerPromptCacheRetention,
              reasoningEffort: 'low',
            },
            vendor: { custom: true },
          },
        },
      });

      expect(request.providerOptions).toEqual({
        openai: {
          promptCacheRetention: providerPromptCacheRetention,
          reasoningEffort: 'low',
        },
        vendor: { custom: true },
      });
    },
  );

  test('uses top-level retention when provider override is undefined', async () => {
    const request = await captureRequest('generate', 'openai.responses', {
      promptCacheRetention: 'in-memory',
      providerData: {
        providerOptions: {
          openai: {
            promptCacheRetention: undefined,
            reasoningEffort: 'low',
          },
        },
      },
    });

    expect(request.providerOptions.openai).toEqual({
      promptCacheRetention: 'in_memory',
      reasoningEffort: 'low',
    });
  });

  test('forwards retention for specificationVersion v4', async () => {
    const request = await captureRequest(
      'generate',
      'openai.responses',
      { promptCacheRetention: 'in-memory' },
      'v4',
    );

    expect(request.providerOptions.openai.promptCacheRetention).toBe(
      'in_memory',
    );
  });

  test.each(['generate', 'stream'] as const)(
    'rejects retention for specificationVersion v2 before %s',
    async (mode) => {
      await expect(
        captureRequest(
          mode,
          'openai.responses',
          { promptCacheRetention: 'in-memory' },
          'v2',
        ),
      ).rejects.toThrow(
        'AI SDK prompt cache retention requires specificationVersion v3 or v4; v2 models do not support this option.',
      );
    },
  );

  test('preserves specificationVersion v2 requests without retention', async () => {
    const request = await captureRequest(
      'generate',
      'openai.responses',
      {},
      'v2',
    );

    expect(request.providerOptions).toBeUndefined();
  });

  test('does not add provider options when retention is unset', async () => {
    const request = await captureRequest('generate', 'openai.responses', {});

    expect(request.providerOptions).toBeUndefined();
  });

  test.each([[], { openai: [] }])(
    'preserves malformed provider options for AI SDK validation',
    async (providerOptions) => {
      const request = await captureRequest('generate', 'openai.responses', {
        promptCacheRetention: '24h',
        providerData: { providerOptions },
      });

      expect(request.providerOptions).toEqual(providerOptions);
    },
  );

  test.each(['custom.responses', 'openai.chat', 'anthropic.messages'])(
    'does not forward retention to %s',
    async (provider) => {
      const request = await captureRequest('generate', provider, {
        promptCacheRetention: '24h',
      });

      expect(request.providerOptions).toBeUndefined();
    },
  );
});

describe('toolChoiceToLanguageV2Format', () => {
  test('maps default choices and specific tool', () => {
    expect(toolChoiceToLanguageV2Format(undefined)).toBeUndefined();
    expect(toolChoiceToLanguageV2Format(null as any)).toBeUndefined();
    expect(toolChoiceToLanguageV2Format('auto')).toEqual({ type: 'auto' });
    expect(toolChoiceToLanguageV2Format('required')).toEqual({
      type: 'required',
    });
    expect(toolChoiceToLanguageV2Format('none')).toEqual({ type: 'none' });
    expect(toolChoiceToLanguageV2Format('runTool' as any)).toEqual({
      type: 'tool',
      toolName: 'runTool',
    });
  });
});

describe('Extended thinking / Reasoning support', () => {
  describe('Non-streaming (getResponse)', () => {
    test('captures reasoning parts and outputs them before tool calls', async () => {
      const model = new AiSdkModel(
        stubModel({
          async doGenerate() {
            return {
              content: [
                {
                  type: 'reasoning',
                  text: 'Let me think through this step by step...',
                  providerMetadata: {
                    anthropic: { signature: 'sig_abc123' },
                  },
                },
                {
                  type: 'tool-call',
                  toolCallId: 'call-1',
                  toolName: 'get_weather',
                  input: { location: 'Tokyo' },
                },
              ],
              usage: { inputTokens: 50, outputTokens: 100, totalTokens: 150 },
              providerMetadata: { anthropic: { thinkingTokens: 30 } },
              response: { id: 'resp-1' },
              finishReason: 'tool-calls',
              warnings: [],
            } as any;
          },
        }),
      );

      const res = await withTrace('t', () =>
        model.getResponse({
          input: 'What is the weather in Tokyo?',
          tools: [
            {
              type: 'function',
              name: 'get_weather',
              description: 'Get weather info',
              parameters: { type: 'object', properties: {} },
            },
          ],
          handoffs: [],
          modelSettings: {},
          outputType: 'text',
          tracing: false,
        } as any),
      );

      // Reasoning item should come FIRST, before tool calls
      expect(res.output).toHaveLength(2);
      expect(res.output[0]).toMatchObject({
        type: 'reasoning',
        content: [
          {
            type: 'input_text',
            text: 'Let me think through this step by step...',
          },
        ],
        rawContent: [
          {
            type: 'reasoning_text',
            text: 'Let me think through this step by step...',
          },
        ],
        providerData: {
          model: 'stub:m',
          responseId: 'resp-1',
          anthropic: { signature: 'sig_abc123' },
        },
      });
      expect(res.output[1]).toMatchObject({
        type: 'function_call',
        callId: 'call-1',
        name: 'get_weather',
      });
    });

    test('handles reasoning without signature (non-Anthropic providers)', async () => {
      const model = new AiSdkModel(
        stubModel({
          async doGenerate() {
            return {
              content: [
                {
                  type: 'reasoning',
                  text: 'Thinking about this problem...',
                  // No providerMetadata / signature
                },
                { type: 'text', text: 'The answer is 42.' },
              ],
              usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
              providerMetadata: {},
              response: { id: 'resp-2' },
              finishReason: 'stop',
              warnings: [],
            } as any;
          },
        }),
      );

      const res = await withTrace('t', () =>
        model.getResponse({
          input: 'What is the meaning of life?',
          tools: [],
          handoffs: [],
          modelSettings: {},
          outputType: 'text',
          tracing: false,
        } as any),
      );

      expect(res.output).toHaveLength(2);
      expect(res.output[0]).toMatchObject({
        type: 'reasoning',
        content: [
          { type: 'input_text', text: 'Thinking about this problem...' },
        ],
        providerData: {
          model: 'stub:m',
          responseId: 'resp-2',
        },
      });
      expect(res.output[1]).toMatchObject({
        type: 'message',
        content: [{ type: 'output_text', text: 'The answer is 42.' }],
      });
    });
  });

  describe('Streaming (getStreamedResponse)', () => {
    test('captures reasoning stream events and outputs them before tool calls', async () => {
      const parts = [
        {
          type: 'reasoning-start',
          id: 'reasoning-1',
          providerMetadata: { anthropic: { thinking: 'enabled' } },
        },
        {
          type: 'reasoning-delta',
          id: 'reasoning-1',
          delta: 'Let me think...',
        },
        { type: 'reasoning-delta', id: 'reasoning-1', delta: ' step by step.' },
        {
          type: 'reasoning-end',
          id: 'reasoning-1',
          providerMetadata: { anthropic: { signature: 'sig_stream_123' } },
        },
        {
          type: 'tool-call',
          toolCallId: 'c1',
          toolName: 'search',
          input: '{"query":"test"}',
        },
        { type: 'response-metadata', id: 'resp-stream-1' },
        {
          type: 'finish',
          finishReason: 'tool-calls',
          usage: { inputTokens: 20, outputTokens: 40 },
        },
      ];

      const model = new AiSdkModel(
        stubModel({
          async doStream() {
            return {
              stream: partsStream(parts),
            } as any;
          },
        }),
      );

      const events: any[] = [];
      for await (const ev of model.getStreamedResponse({
        input: 'Search for something',
        tools: [],
        handoffs: [],
        modelSettings: {},
        outputType: 'text',
        tracing: false,
      } as any)) {
        events.push(ev);
      }

      const final = events.at(-1);
      expect(final.type).toBe('response_done');

      // Reasoning should come FIRST in output
      expect(final.response.output).toHaveLength(2);
      expect(final.response.output[0]).toMatchObject({
        type: 'reasoning',
        id: 'reasoning-1',
        content: [
          { type: 'input_text', text: 'Let me think... step by step.' },
        ],
        rawContent: [
          { type: 'reasoning_text', text: 'Let me think... step by step.' },
        ],
        providerData: {
          model: 'stub:m',
          responseId: 'resp-stream-1',
          anthropic: { signature: 'sig_stream_123' },
        },
      });
      expect(final.response.output[1]).toMatchObject({
        type: 'function_call',
        callId: 'c1',
        name: 'search',
      });
    });

    test('preserves Anthropic signatures from empty reasoning deltas', async () => {
      const { response } = await collectStreamResponse([
        { type: 'reasoning-start', id: '0' },
        { type: 'reasoning-delta', id: '0', delta: 'Hidden thought.' },
        {
          type: 'reasoning-delta',
          id: '0',
          delta: '',
          providerMetadata: {
            anthropic: { signature: 'sig_from_signature_delta' },
          },
        },
        { type: 'reasoning-end', id: '0' },
        { type: 'response-metadata', id: 'resp-signature' },
      ]);

      expect(response.output).toEqual([
        {
          type: 'reasoning',
          id: '0',
          content: [{ type: 'input_text', text: 'Hidden thought.' }],
          rawContent: [{ type: 'reasoning_text', text: 'Hidden thought.' }],
          providerData: {
            model: 'stub:m',
            anthropic: { signature: 'sig_from_signature_delta' },
            responseId: 'resp-signature',
          },
        },
      ]);
    });

    test('preserves Anthropic redacted data from reasoning start', async () => {
      const { response } = await collectStreamResponse([
        {
          type: 'reasoning-start',
          id: '0',
          providerMetadata: {
            anthropic: { redactedData: 'redacted_thinking_data' },
          },
        },
        { type: 'reasoning-end', id: '0' },
      ]);

      expect(response.output[0]).toMatchObject({
        type: 'reasoning',
        id: '0',
        content: [{ type: 'input_text', text: '' }],
        providerData: {
          model: 'stub:m',
          anthropic: { redactedData: 'redacted_thinking_data' },
        },
      });
    });

    test.each(['v2', 'v3', 'v4'])(
      'merges reasoning metadata from start, delta, and end for %s',
      async (specificationVersion) => {
        const { response } = await collectStreamResponse(
          [
            {
              type: 'reasoning-start',
              id: '0',
              providerMetadata: {
                test: { start: true, conflict: 'start' },
              },
            },
            {
              type: 'reasoning-delta',
              id: '0',
              delta: '',
              providerMetadata: {
                test: { delta: true, conflict: 'delta' },
              },
            },
            {
              type: 'reasoning-delta',
              id: '0',
              delta: '',
              providerMetadata: {
                test: { secondDelta: true },
              },
            },
            {
              type: 'reasoning-end',
              id: '0',
              providerMetadata: {
                test: { end: true, conflict: 'end' },
              },
            },
          ],
          specificationVersion,
        );

        expect(response.output[0].providerData).toEqual({
          model: 'stub:m',
          test: {
            start: true,
            delta: true,
            secondDelta: true,
            end: true,
            conflict: 'end',
          },
        });
      },
    );

    test('preserves empty provider metadata namespaces', async () => {
      const { languageModel, response } = await collectStreamResponse([
        {
          type: 'reasoning-start',
          id: '0',
          providerMetadata: { vendor: {} },
        },
        {
          type: 'reasoning-delta',
          id: '0',
          delta: '',
          providerMetadata: { vendor: {} },
        },
        { type: 'reasoning-end', id: '0' },
      ]);

      expect(response.output[0].providerData).toEqual({
        model: 'stub:m',
        vendor: {},
      });
      expect(itemsToLanguageV2Messages(languageModel, response.output)).toEqual(
        [
          {
            role: 'assistant',
            content: [
              {
                type: 'reasoning',
                text: '',
                providerOptions: { vendor: {} },
              },
            ],
            providerOptions: { vendor: {} },
          },
        ],
      );
    });

    test('preserves ordered metadata for multiple reasoning blocks', async () => {
      const { response } = await collectStreamResponse([
        {
          type: 'reasoning-start',
          id: '10',
          providerMetadata: {
            anthropic: { redactedData: 'redacted_block' },
          },
        },
        { type: 'reasoning-end', id: '10' },
        { type: 'reasoning-start', id: '2' },
        { type: 'reasoning-delta', id: '2', delta: 'Visible thought.' },
        {
          type: 'reasoning-delta',
          id: '2',
          delta: '',
          providerMetadata: { anthropic: { signature: 'signed_block' } },
        },
        { type: 'reasoning-end', id: '2' },
      ]);

      expect(response.output).toMatchObject([
        {
          type: 'reasoning',
          id: '10',
          content: [{ type: 'input_text', text: '' }],
          providerData: {
            anthropic: { redactedData: 'redacted_block' },
          },
        },
        {
          type: 'reasoning',
          id: '2',
          content: [{ type: 'input_text', text: 'Visible thought.' }],
          providerData: {
            anthropic: { signature: 'signed_block' },
          },
        },
      ]);
    });

    test('replays merged reasoning metadata through AI SDK messages', async () => {
      const { languageModel, response } = await collectStreamResponse([
        {
          type: 'reasoning-start',
          id: '0',
          providerMetadata: {
            anthropic: { redactedData: 'redacted_thinking_data' },
          },
        },
        { type: 'reasoning-end', id: '0' },
        { type: 'reasoning-start', id: '1' },
        { type: 'reasoning-delta', id: '1', delta: 'Hidden thought.' },
        {
          type: 'reasoning-delta',
          id: '1',
          delta: '',
          providerMetadata: {
            anthropic: { signature: 'sig_from_signature_delta' },
          },
        },
        { type: 'reasoning-end', id: '1' },
      ]);

      const messages = itemsToLanguageV2Messages(
        languageModel,
        response.output,
      );
      expect(messages).toEqual([
        {
          role: 'assistant',
          content: [
            {
              type: 'reasoning',
              text: '',
              providerOptions: {
                anthropic: {
                  redactedData: 'redacted_thinking_data',
                },
              },
            },
          ],
          providerOptions: {
            anthropic: {
              redactedData: 'redacted_thinking_data',
            },
          },
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'reasoning',
              text: 'Hidden thought.',
              providerOptions: {
                anthropic: { signature: 'sig_from_signature_delta' },
              },
            },
          ],
          providerOptions: {
            anthropic: { signature: 'sig_from_signature_delta' },
          },
        },
      ]);
    });

    test.each(['v3', 'v4'])(
      'replays merged reasoning metadata through AI SDK %s messages',
      async (specificationVersion) => {
        const { languageModel, response } = await collectStreamResponse(
          [
            { type: 'reasoning-start', id: '0' },
            {
              type: 'reasoning-delta',
              id: '0',
              delta: '',
              providerMetadata: {
                anthropic: { signature: 'sig_from_signature_delta' },
              },
            },
            { type: 'reasoning-end', id: '0' },
          ],
          specificationVersion,
        );

        const messages = itemsToLanguageV2Messages(
          languageModel,
          response.output,
        );
        expect(messages).toEqual([
          {
            role: 'assistant',
            content: [
              {
                type: 'reasoning',
                text: '',
                providerOptions: {
                  anthropic: { signature: 'sig_from_signature_delta' },
                },
              },
            ],
            providerOptions: {
              anthropic: { signature: 'sig_from_signature_delta' },
            },
          },
        ]);
      },
    );

    test('handles multiple reasoning blocks in streaming', async () => {
      const parts = [
        { type: 'reasoning-start', id: 'r1' },
        { type: 'reasoning-delta', id: 'r1', delta: 'First thought.' },
        { type: 'reasoning-end', id: 'r1' },
        { type: 'reasoning-start', id: 'r2' },
        { type: 'reasoning-delta', id: 'r2', delta: 'Second thought.' },
        { type: 'reasoning-end', id: 'r2' },
        { type: 'text-delta', delta: 'Final answer.' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 10, outputTokens: 20 },
        },
      ];

      const model = new AiSdkModel(
        stubModel({
          async doStream() {
            return {
              stream: partsStream(parts),
            } as any;
          },
        }),
      );

      const events: any[] = [];
      for await (const ev of model.getStreamedResponse({
        input: 'Complex problem',
        tools: [],
        handoffs: [],
        modelSettings: {},
        outputType: 'text',
        tracing: false,
      } as any)) {
        events.push(ev);
      }

      const final = events.at(-1);
      expect(final.type).toBe('response_done');
      expect(final.response.output).toHaveLength(3);
      expect(final.response.output[0]).toMatchObject({
        type: 'reasoning',
        content: [{ type: 'input_text', text: 'First thought.' }],
      });
      expect(final.response.output[1]).toMatchObject({
        type: 'reasoning',
        content: [{ type: 'input_text', text: 'Second thought.' }],
      });
      expect(final.response.output[2]).toMatchObject({
        type: 'message',
        content: [{ type: 'output_text', text: 'Final answer.' }],
      });
    });

    test('handles reasoning-delta without reasoning-start', async () => {
      const parts = [
        {
          type: 'reasoning-delta',
          id: 'orphan',
          delta: 'Direct thinking content',
        },
        { type: 'reasoning-end', id: 'orphan' },
        { type: 'text-delta', delta: 'Response.' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 5, outputTokens: 10 },
        },
      ];

      const model = new AiSdkModel(
        stubModel({
          async doStream() {
            return {
              stream: partsStream(parts),
            } as any;
          },
        }),
      );

      const events: any[] = [];
      for await (const ev of model.getStreamedResponse({
        input: 'test',
        tools: [],
        handoffs: [],
        modelSettings: {},
        outputType: 'text',
        tracing: false,
      } as any)) {
        events.push(ev);
      }

      const final = events.at(-1);
      expect(final.response.output[0]).toMatchObject({
        type: 'reasoning',
        content: [{ type: 'input_text', text: 'Direct thinking content' }],
      });
    });
  });
});

describe('AiSdkModel', () => {
  test('should be available', () => {
    const model = new AiSdkModel({} as any);
    expect(model).toBeDefined();
  });

  test('converts trailing function_call items to messages', async () => {
    let received: any;
    const fakeModel = {
      specificationVersion: 'v2',
      provider: 'fake',
      modelId: 'm',
      supportedUrls: [],
      doGenerate: vi.fn(async (opts: any) => {
        received = opts.prompt;
        return {
          content: [{ type: 'text', text: 'ok' }],
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          providerMetadata: {},
          finishReason: 'stop',
          warnings: [],
        };
      }),
    };

    const model = new AiSdkModel(fakeModel as any);
    await withTrace('t', () =>
      model.getResponse({
        input: [
          {
            type: 'function_call',
            id: '1',
            callId: 'call1',
            name: 'do',
            arguments: '{}',
            status: 'completed',
            providerData: { meta: 1 },
          } as protocol.FunctionCallItem,
        ],
        tools: [],
        handoffs: [],
        modelSettings: {},
        outputType: 'text',
        tracing: false,
      } as any),
    );

    expect(received).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call1',
            toolName: 'do',
            input: {},
            providerOptions: { meta: 1 },
          },
        ],
        providerOptions: { meta: 1 },
      },
    ]);
  });

  test('rejects ambiguous hosted and custom tool_search names in streaming mode', async () => {
    const doStream = vi.fn();
    const model = new AiSdkModel(
      stubModel({
        async doStream(...args: any[]) {
          return doStream(...args);
        },
      }),
    );

    await expect(async () => {
      for await (const _event of model.getStreamedResponse({
        input: 'hi',
        tools: [
          {
            type: 'hosted_tool',
            name: 'tool_search',
            providerData: {
              type: 'tool_search',
              execution: 'client',
            },
          } as any,
          {
            type: 'function',
            name: 'tool_search',
            description: 'Custom tool_search function',
            parameters: {
              type: 'object',
              properties: {},
              additionalProperties: false,
            },
          } as any,
        ],
        handoffs: [],
        modelSettings: {},
        outputType: 'text',
        tracing: false,
      } as any)) {
        void _event;
      }
    }).rejects.toThrow(
      /cannot disambiguate a hosted tool_search helper from a custom tool or handoff/,
    );
    expect(doStream).not.toHaveBeenCalled();
  });

  test('rejects flattened namespace and handoff name collisions in streaming mode', async () => {
    const doStream = vi.fn();
    const model = new AiSdkModel(
      stubModel({
        async doStream(...args: any[]) {
          return doStream(...args);
        },
      }),
    );

    await expect(async () => {
      for await (const _event of model.getStreamedResponse({
        input: 'hi',
        tools: [
          {
            type: 'function',
            name: 'lookup',
            namespace: 'crm',
            description: 'Look up a CRM record.',
            parameters: {
              type: 'object',
              properties: {},
              additionalProperties: false,
            },
          } as any,
        ],
        handoffs: [
          {
            toolName: 'crm.lookup',
            toolDescription: 'Handoff with the same flattened name.',
            inputJsonSchema: {
              type: 'object',
              properties: {},
              additionalProperties: false,
            },
            strictJsonSchema: true,
          },
        ],
        modelSettings: {},
        outputType: 'text',
        tracing: false,
        _internal: { toolNameCollisionPolicy: 'error' },
      } as any)) {
        void _event;
      }
    }).rejects.toThrow(
      'AiSdkModel cannot disambiguate function tools and handoffs with the same flattened name.',
    );
    expect(doStream).not.toHaveBeenCalled();
  });

  test('rejects flattened deferred and handoff name collisions in streaming mode', async () => {
    const doStream = vi.fn();
    const model = new AiSdkModel(stubModel({ doStream }));

    await expect(async () => {
      for await (const _event of model.getStreamedResponse({
        input: 'hi',
        tools: [
          {
            type: 'function',
            name: 'lookup',
            description: 'Deferred lookup.',
            parameters: {
              type: 'object',
              properties: {},
              additionalProperties: false,
            },
            deferLoading: true,
          } as any,
        ],
        handoffs: [
          {
            toolName: 'lookup',
            toolDescription: 'Handoff with the same flattened name.',
            inputJsonSchema: {
              type: 'object',
              properties: {},
              additionalProperties: false,
            },
            strictJsonSchema: true,
          },
        ],
        modelSettings: {},
        outputType: 'text',
        tracing: false,
      } as any)) {
        void _event;
      }
    }).rejects.toThrow(
      'AiSdkModel cannot disambiguate function tools and handoffs with the same flattened name.',
    );
    expect(doStream).not.toHaveBeenCalled();
  });

  test('rejects flattened function and provider tool collisions in streaming mode', async () => {
    const doStream = vi.fn();
    const model = new AiSdkModel(stubModel({ doStream }));

    await expect(async () => {
      for await (const _event of model.getStreamedResponse({
        input: 'hi',
        tools: [
          {
            type: 'function',
            name: 'lookup',
            namespace: 'crm',
            description: 'Look up a CRM record.',
            parameters: {
              type: 'object',
              properties: {},
              additionalProperties: false,
            },
          } as any,
          {
            type: 'hosted_tool',
            name: 'crm.lookup',
            providerData: { type: 'web_search' },
          } as any,
        ],
        handoffs: [],
        modelSettings: {},
        outputType: 'text',
        tracing: false,
      } as any)) {
        void _event;
      }
    }).rejects.toThrow(
      /AiSdkModel cannot disambiguate (?:tools with the same flattened name|the flattened tool name 'crm\.lookup')/,
    );
    expect(doStream).not.toHaveBeenCalled();
  });

  test('rejects duplicate provider tool names before streaming', async () => {
    const doStream = vi.fn();
    const model = new AiSdkModel(stubModel({ doStream }));
    const providerTool = {
      type: 'hosted_tool',
      name: 'search',
      providerData: { type: 'web_search' },
    } as any;

    await expect(async () => {
      for await (const _event of model.getStreamedResponse({
        input: 'hi',
        tools: [providerTool, { ...providerTool }],
        handoffs: [],
        modelSettings: {},
        outputType: 'text',
        tracing: false,
      } as any)) {
        void _event;
      }
    }).rejects.toThrow(
      /AiSdkModel cannot disambiguate (?:provider tools with the same flattened name|the flattened provider tool name 'search')/,
    );
    expect(doStream).not.toHaveBeenCalled();
  });

  test('rejects a default-policy flattened collision before streaming', async () => {
    const doStream = vi.fn();
    const model = new AiSdkModel(stubModel({ doStream }));
    const [lookup] = toolNamespace({
      name: 'crm',
      description: 'CRM tools.',
      tools: [
        tool({
          name: 'lookup',
          description: 'Look up a CRM record.',
          parameters: z.object({}),
          execute: async () => 'record',
        }),
      ],
    });
    const lookupHandoff = handoff(new Agent({ name: 'CRM specialist' }), {
      toolNameOverride: 'crm.lookup',
    });
    const result = await run(
      new Agent({
        name: 'Routing agent',
        model,
        tools: [lookup!],
        handoffs: [lookupHandoff],
      }),
      'hi',
      { stream: true },
    );

    await expect(result.completed).rejects.toThrow(
      'AiSdkModel cannot disambiguate function tools and handoffs with the same flattened name.',
    );
    expect(doStream).not.toHaveBeenCalled();
  });

  test('rejects same-name namespaces before streaming', async () => {
    const doStream = vi.fn();
    const model = new AiSdkModel(stubModel({ doStream }));

    await expect(async () => {
      for await (const _event of model.getStreamedResponse({
        input: 'hi',
        tools: [
          {
            type: 'function',
            name: 'lookup_account',
            namespace: 'lookup_account',
            description: 'Same-name namespace lookup tool.',
            parameters: {
              type: 'object',
              properties: {},
              additionalProperties: false,
            },
          } as any,
        ],
        handoffs: [],
        modelSettings: {},
        outputType: 'text',
        tracing: false,
      } as any)) {
        void _event;
      }
    }).rejects.toThrow(
      /AiSdkModel cannot route (?:a function tool whose namespace matches its name|the function tool 'lookup_account' because its namespace matches its name)/,
    );
    expect(doStream).not.toHaveBeenCalled();
  });

  test('exposes one winner when the same function tool object is repeated in streaming mode', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const doStream = vi.fn(async (_options: any): Promise<any> => ({
      stream: partsStream([]),
    }));
    const model = new AiSdkModel(stubModel({ doStream }));
    const duplicateTool = {
      type: 'function',
      name: 'duplicate',
      description: 'Repeated tool object.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    } as any;

    try {
      for await (const _event of model.getStreamedResponse({
        input: 'hi',
        tools: [duplicateTool, duplicateTool],
        handoffs: [],
        modelSettings: {},
        outputType: 'text',
        tracing: false,
      } as any)) {
        void _event;
      }

      expect(doStream.mock.calls[0]![0].tools).toEqual([
        expect.objectContaining({ name: 'duplicate' }),
      ]);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  describe('parseArguments', () => {
    test('should parse valid JSON', () => {
      expect(parseArguments(undefined)).toEqual({});
      expect(parseArguments(null)).toEqual({});
      expect(parseArguments('')).toEqual({});
      expect(parseArguments(' ')).toEqual({});
      expect(parseArguments('{ ')).toEqual({});
      expect(parseArguments('foo')).toEqual({});
      expect(parseArguments('{}')).toEqual({});
      expect(parseArguments('{ }')).toEqual({});

      expect(parseArguments('"foo"')).toEqual('foo');
      expect(parseArguments('[]')).toEqual([]);
      expect(parseArguments('[1,2,3]')).toEqual([1, 2, 3]);
      expect(parseArguments('{"a":1}')).toEqual({ a: 1 });
      expect(parseArguments('{"a":1,"b":"c"}')).toEqual({ a: 1, b: 'c' });
    });
  });

  describe('Error handling with tracing', () => {
    test('getRetryAdvice ignores status-only AI SDK errors without provider guidance', () => {
      const aiSdkError = new Error('API call failed');
      (aiSdkError as any).statusCode = 429;

      const model = new AiSdkModel(stubModel({}));

      expect(
        model.getRetryAdvice({
          error: aiSdkError,
          request: {
            input: 'test input',
            tools: [],
            handoffs: [],
            modelSettings: {},
            outputType: 'text',
            tracing: false,
          } as any,
          stream: false,
          attempt: 1,
        }),
      ).toBeUndefined();
    });

    test('getRetryAdvice honors explicit retryable AI SDK errors', () => {
      const aiSdkError = new APICallError({
        isRetryable: true,
        message: 'Provider requested retry',
        requestBodyValues: {},
        responseBody: '{}',
        responseHeaders: {},
        statusCode: 429,
        url: 'https://example.com',
      });

      const model = new AiSdkModel(stubModel({}));

      expect(
        model.getRetryAdvice({
          error: aiSdkError,
          request: {
            input: 'test input',
            tools: [],
            handoffs: [],
            modelSettings: {},
            outputType: 'text',
            tracing: false,
          } as any,
          stream: false,
          attempt: 1,
        }),
      ).toEqual({
        suggested: true,
        reason: 'Provider requested retry',
      });
    });

    test('getRetryAdvice honors explicit non-retryable AI SDK errors', () => {
      const aiSdkError = new APICallError({
        isRetryable: false,
        message: 'Provider vetoed retry',
        requestBodyValues: {},
        responseBody: '{}',
        responseHeaders: {},
        statusCode: 429,
        url: 'https://example.com',
      });

      const model = new AiSdkModel(stubModel({}));

      expect(
        model.getRetryAdvice({
          error: aiSdkError,
          request: {
            input: 'test input',
            tools: [],
            handoffs: [],
            modelSettings: {},
            outputType: 'text',
            tracing: false,
          } as any,
          stream: false,
          attempt: 1,
        }),
      ).toEqual({
        suggested: false,
        reason: 'Provider vetoed retry',
      });
    });

    test('captures comprehensive AI SDK error details when tracing enabled', async () => {
      // Simulate an AI SDK error with responseBody and other fields.
      const aiSdkError = new Error('API call failed');
      aiSdkError.name = 'AI_APICallError';
      (aiSdkError as any).responseBody = {
        error: {
          message: 'Rate limit exceeded',
          code: 'rate_limit_exceeded',
          type: 'insufficient_quota',
        },
      };
      (aiSdkError as any).responseHeaders = {
        'x-request-id': 'req_abc123',
        'retry-after': '60',
      };
      (aiSdkError as any).statusCode = 429;

      const model = new AiSdkModel(
        stubModel({
          async doGenerate() {
            throw aiSdkError;
          },
        }),
      );

      try {
        await withTrace('test-trace', () =>
          model.getResponse({
            input: 'test input',
            tools: [],
            handoffs: [],
            modelSettings: {},
            outputType: 'text',
            tracing: true,
          } as any),
        );
        expect.fail('Should have thrown error');
      } catch (error: any) {
        // Error should be re-thrown.
        expect(error.message).toBe('API call failed');
        // Verify error has the AI SDK fields.
        expect((error as any).responseBody).toBeDefined();
        expect((error as any).statusCode).toBe(429);
      }
    });

    test('propagates error with AI SDK fields in streaming mode', async () => {
      const aiSdkError = new Error('Stream failed');
      aiSdkError.name = 'AI_StreamError';
      (aiSdkError as any).responseBody = {
        error: { message: 'Connection timeout', code: 'timeout' },
      };
      (aiSdkError as any).statusCode = 504;

      const model = new AiSdkModel(
        stubModel({
          async doStream() {
            throw aiSdkError;
          },
        }),
      );

      try {
        await withTrace('test-stream', async () => {
          const iter = model.getStreamedResponse({
            input: 'test',
            tools: [],
            handoffs: [],
            modelSettings: {},
            outputType: 'text',
            tracing: true,
          } as any);

          for await (const _ of iter) {
            // Should not get here.
          }
        });
        expect.fail('Should have thrown error');
      } catch (error: any) {
        expect(error.message).toBe('Stream failed');
        // Verify error has the AI SDK fields.
        expect((error as any).responseBody).toBeDefined();
        expect((error as any).statusCode).toBe(504);
      }
    });
  });
});
