import { describe, it, expect, vi, beforeAll } from 'vitest';
import { OpenAIResponsesModel } from '../src/openaiResponsesModel';
import { HEADERS } from '../src/defaults';
import type OpenAI from 'openai';
import {
  setTracingDisabled,
  withTrace,
  type ResponseStreamEvent,
  Span,
} from '@openai/agents-core';
import type { ResponseStreamEvent as OpenAIResponseStreamEvent } from 'openai/resources/responses/responses';

describe('OpenAIResponsesModel', () => {
  beforeAll(() => {
    setTracingDisabled(true);
  });
  it('getResponse returns correct ModelResponse and calls client with right parameters', async () => {
    await withTrace('test', async () => {
      const fakeResponse = {
        id: 'res1',
        usage: {
          input_tokens: 3,
          output_tokens: 4,
          total_tokens: 7,
        },
        output: [
          {
            id: 'test_id',
            type: 'message',
            status: 'completed',
            content: [{ type: 'output_text', text: 'hi' }],
            role: 'assistant',
          },
        ],
      };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-test');

      const request = {
        systemInstructions: 'inst',
        input: 'hello',
        modelSettings: {},
        tools: [],
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      const result = await model.getResponse(request as any);
      expect(createMock).toHaveBeenCalledTimes(1);
      const [args, opts] = createMock.mock.calls[0];
      expect(args.instructions).toBe('inst');
      expect(args.model).toBe('gpt-test');
      expect(args.input).toEqual([{ role: 'user', content: 'hello' }]);
      expect(opts).toEqual({ headers: HEADERS, signal: undefined });

      expect(result.usage.requests).toBe(1);
      expect(result.usage.inputTokens).toBe(3);
      expect(result.usage.outputTokens).toBe(4);
      expect(result.usage.totalTokens).toBe(7);
      expect(result.output).toEqual([
        {
          type: 'message',
          id: 'test_id',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'hi' }],
          providerData: {},
        },
      ]);
      expect(result.responseId).toBe('res1');
    });
  });

  it('omits previous_response_id when conversation is provided', async () => {
    await withTrace('test', async () => {
      const fakeResponse = { id: 'res-conv', usage: {}, output: [] };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-test');

      const request = {
        systemInstructions: undefined,
        input: 'hello',
        modelSettings: {},
        tools: [],
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
        conversationId: 'conv_123',
        previousResponseId: 'resp_123',
      };

      await model.getResponse(request as any);

      const [args] = createMock.mock.calls[0];
      expect(args.conversation).toBe('conv_123');
      expect(args.previous_response_id).toBeUndefined();
    });
  });

  it('sends prompt cache retention setting to the Responses API', async () => {
    await withTrace('test', async () => {
      const fakeResponse = { id: 'res-cache', usage: {}, output: [] };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-cache');

      const request = {
        systemInstructions: undefined,
        input: 'hello',
        modelSettings: { promptCacheRetention: 'in-memory' },
        tools: [],
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      await model.getResponse(request as any);

      const [args] = createMock.mock.calls[0];
      expect(args.prompt_cache_retention).toBe('in-memory');
    });
  });

  it('still sends an empty tools array when no prompt is provided', async () => {
    await withTrace('test', async () => {
      const fakeResponse = { id: 'res-no-prompt', usage: {}, output: [] };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-default');

      const request = {
        systemInstructions: undefined,
        input: 'hello',
        modelSettings: {},
        tools: [],
        toolsExplicitlyProvided: false,
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      await model.getResponse(request as any);

      expect(createMock).toHaveBeenCalledTimes(1);
      const [args] = createMock.mock.calls[0];
      expect(args.tools).toEqual([]);
      expect(args.prompt).toBeUndefined();
    });
  });

  it('includes handoff tools in the request', async () => {
    await withTrace('test', async () => {
      const fakeResponse = { id: 'res-handoff', usage: {}, output: [] };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-handoff');

      const request = {
        systemInstructions: undefined,
        input: 'hello',
        modelSettings: {},
        tools: [],
        outputType: 'text',
        handoffs: [
          {
            toolName: 'handoff_tool',
            toolDescription: 'handoff description',
            inputJsonSchema: { type: 'object', properties: {} },
            strictJsonSchema: true,
          },
        ],
        tracing: false,
        signal: undefined,
      };

      await model.getResponse(request as any);

      const [args] = createMock.mock.calls[0];
      expect(args.tools).toEqual([
        {
          type: 'function',
          name: 'handoff_tool',
          description: 'handoff description',
          parameters: { type: 'object', properties: {} },
          strict: true,
        },
      ]);
    });
  });

  it('omits model when a prompt is provided', async () => {
    await withTrace('test', async () => {
      const fakeResponse = { id: 'res-prompt', usage: {}, output: [] };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-default');

      const request = {
        systemInstructions: undefined,
        prompt: { promptId: 'pmpt_123' },
        input: 'hello',
        modelSettings: {},
        tools: [],
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      await model.getResponse(request as any);

      expect(createMock).toHaveBeenCalledTimes(1);
      const [args] = createMock.mock.calls[0];
      expect('model' in args).toBe(false);
      expect(args.prompt).toMatchObject({ id: 'pmpt_123' });
    });
  });

  it('merges prompt variables using input content transforms', async () => {
    await withTrace('test', async () => {
      const fakeResponse = { id: 'res-prompt-vars', usage: {}, output: [] };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-vars');

      const request = {
        systemInstructions: undefined,
        prompt: {
          promptId: 'pmpt_vars',
          variables: {
            name: 'Ada',
            avatar: { type: 'input_image', image: 'https://example.com/a.png' },
            document: { type: 'input_file', file: { id: 'file_doc' } },
          },
        },
        input: 'hello',
        modelSettings: {},
        tools: [],
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      await model.getResponse(request as any);

      const [args] = createMock.mock.calls[0];
      expect(args.prompt).toMatchObject({
        id: 'pmpt_vars',
        variables: {
          name: 'Ada',
          avatar: {
            type: 'input_image',
            detail: 'auto',
            image_url: 'https://example.com/a.png',
          },
          document: {
            type: 'input_file',
            file_id: 'file_doc',
          },
        },
      });
    });
  });

  it('includes response format for non-text output types', async () => {
    await withTrace('test', async () => {
      const fakeResponse = { id: 'res-format', usage: {}, output: [] };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-format');

      const request = {
        systemInstructions: undefined,
        input: 'hello',
        modelSettings: {
          text: { schema: { type: 'object' } },
        },
        tools: [],
        outputType: 'json_object',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      await model.getResponse(request as any);

      const [args] = createMock.mock.calls[0];
      expect(args.text).toEqual({
        schema: { type: 'object' },
        format: 'json_object',
      });
    });
  });

  it('includes model when overridePromptModel is true', async () => {
    await withTrace('test', async () => {
      const fakeResponse = { id: 'res-prompt-override', usage: {}, output: [] };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-override');

      const request = {
        systemInstructions: undefined,
        prompt: { promptId: 'pmpt_456' },
        input: 'hello',
        modelSettings: {},
        tools: [],
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
        overridePromptModel: true,
      };

      await model.getResponse(request as any);

      expect(createMock).toHaveBeenCalledTimes(1);
      const [args] = createMock.mock.calls[0];
      expect(args.model).toBe('gpt-override');
      expect(args.prompt).toMatchObject({ id: 'pmpt_456' });
    });
  });

  it('omits tools when agent did not configure any and prompt should supply them', async () => {
    await withTrace('test', async () => {
      const fakeResponse = { id: 'res-no-tools', usage: {}, output: [] };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-default');

      const request = {
        systemInstructions: undefined,
        prompt: { promptId: 'pmpt_789' },
        input: 'hello',
        modelSettings: {},
        tools: [],
        toolsExplicitlyProvided: false,
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      await model.getResponse(request as any);

      expect(createMock).toHaveBeenCalledTimes(1);
      const [args] = createMock.mock.calls[0];
      expect('tools' in args).toBe(false);
      expect(args.prompt).toMatchObject({ id: 'pmpt_789' });
    });
  });

  it('sends an explicit empty tools array when the agent intentionally disabled tools', async () => {
    await withTrace('test', async () => {
      const fakeResponse = { id: 'res-empty-tools', usage: {}, output: [] };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-default');

      const request = {
        systemInstructions: undefined,
        prompt: { promptId: 'pmpt_999' },
        input: 'hello',
        modelSettings: {},
        tools: [],
        toolsExplicitlyProvided: true,
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      await model.getResponse(request as any);

      expect(createMock).toHaveBeenCalledTimes(1);
      const [args] = createMock.mock.calls[0];
      expect(args.tools).toEqual([]);
      expect(args.prompt).toMatchObject({ id: 'pmpt_999' });
    });
  });

  it('normalizes systemInstructions so empty strings are omitted', async () => {
    await withTrace('test', async () => {
      const fakeResponse = {
        id: 'res-empty-instructions',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
        },
        output: [],
      };
      for (const systemInstructions of ['', '   ']) {
        const request = {
          systemInstructions,
          input: 'hello',
          modelSettings: {},
          tools: [],
          outputType: 'text',
          handoffs: [],
          tracing: false,
          signal: undefined,
        };
        const createMock = vi.fn().mockResolvedValue(fakeResponse);
        await new OpenAIResponsesModel(
          { responses: { create: createMock } } as unknown as OpenAI,
          'gpt-test',
        ).getResponse(request as any);

        expect(createMock).toHaveBeenCalledTimes(1);
        const [args] = createMock.mock.calls[0];
        expect('instructions' in args).toBe(true);
        expect(args.instructions).toBeUndefined();
      }

      for (const systemInstructions of [' a ', 'foo']) {
        const request = {
          systemInstructions,
          input: 'hello',
          modelSettings: {},
          tools: [],
          outputType: 'text',
          handoffs: [],
          tracing: false,
          signal: undefined,
        };
        const createMock = vi.fn().mockResolvedValue(fakeResponse);
        await new OpenAIResponsesModel(
          { responses: { create: createMock } } as unknown as OpenAI,
          'gpt-test',
        ).getResponse(request as any);

        expect(createMock).toHaveBeenCalledTimes(1);
        const [args] = createMock.mock.calls[0];
        expect('instructions' in args).toBe(true);
        expect(args.instructions).toBe(systemInstructions);
      }
    });
  });

  it('merges top-level reasoning and text settings into provider data for Responses API', async () => {
    await withTrace('test', async () => {
      const fakeResponse = {
        id: 'res-settings',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
        },
        output: [],
      };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-settings');

      const request = {
        systemInstructions: undefined,
        input: 'hi',
        modelSettings: {
          reasoning: { effort: 'medium', summary: 'concise' },
          text: { verbosity: 'low' },
          providerData: {
            reasoning: { summary: 'override', note: 'provider' },
            text: { tone: 'playful' },
            customFlag: true,
          },
        },
        tools: [],
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      await model.getResponse(request as any);

      expect(createMock).toHaveBeenCalledTimes(1);
      const [args] = createMock.mock.calls[0];
      expect(args.reasoning).toEqual({
        effort: 'medium',
        summary: 'override',
        note: 'provider',
      });
      expect(args.text).toEqual({ verbosity: 'low', tone: 'playful' });
      expect(args.customFlag).toBe(true);

      // ensure original provider data object was not mutated
      expect(request.modelSettings.providerData.reasoning).toEqual({
        summary: 'override',
        note: 'provider',
      });
      expect(request.modelSettings.providerData.text).toEqual({
        tone: 'playful',
      });
    });
  });

  it('passes none reasoning effort to the Responses API payload', async () => {
    await withTrace('test', async () => {
      const fakeResponse = {
        id: 'res-none',
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
        },
        output: [],
      };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-5.1');
      const request = {
        systemInstructions: undefined,
        input: 'hi',
        modelSettings: {
          reasoning: { effort: 'none' },
        },
        tools: [],
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      await model.getResponse(request as any);

      expect(createMock).toHaveBeenCalledTimes(1);
      const [args] = createMock.mock.calls[0];
      expect(args.reasoning).toEqual({ effort: 'none' });
    });
  });

  it('getStreamedResponse yields events and calls client with stream flag', async () => {
    await withTrace('test', async () => {
      const fakeResponse = { id: 'res2', usage: {}, output: [] };
      const events: OpenAIResponseStreamEvent[] = [
        {
          type: 'response.created',
          response: fakeResponse as any,
          sequence_number: 0,
        },
        {
          type: 'response.output_text.delta',
          content_index: 0,
          delta: 'delta',
          item_id: 'item-1',
          logprobs: [],
          output_index: 0,
          sequence_number: 1,
        } as any,
      ];
      async function* fakeStream() {
        yield* events;
      }
      const createMock = vi.fn().mockResolvedValue(fakeStream());
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'model2');

      const abort = new AbortController();
      const request = {
        systemInstructions: undefined,
        input: 'data',
        modelSettings: {},
        tools: [],
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: abort.signal,
      };

      const received: ResponseStreamEvent[] = [];
      for await (const ev of model.getStreamedResponse(request as any)) {
        received.push(ev);
      }

      expect(createMock).toHaveBeenCalledTimes(1);
      const [args, opts] = createMock.mock.calls[0];
      expect(args.model).toBe('model2');
      expect(opts).toEqual({ headers: HEADERS, signal: abort.signal });
      expect(received).toEqual([
        {
          type: 'response_started',
          providerData: events[0],
        },
        {
          type: 'model',
          event: events[0],
        },
        {
          type: 'output_text_delta',
          delta: 'delta',
          providerData: {
            content_index: 0,
            item_id: 'item-1',
            logprobs: [],
            output_index: 0,
            sequence_number: 1,
            type: 'response.output_text.delta',
          },
        },
        {
          type: 'model',
          event: events[1],
        },
      ]);
    });
  });

  it('getStreamedResponse maps streamed usage data onto response_done events', async () => {
    await withTrace('test', async () => {
      const createdEvent: OpenAIResponseStreamEvent = {
        type: 'response.created',
        response: { id: 'res-stream-init' } as any,
        sequence_number: 0,
      };
      const completedEvent: OpenAIResponseStreamEvent = {
        type: 'response.completed',
        response: {
          id: 'res-stream',
          output: [],
          usage: {
            input_tokens: 11,
            output_tokens: 5,
            total_tokens: 16,
            input_tokens_details: { cached_tokens: 2 },
            output_tokens_details: { reasoning_tokens: 3 },
          },
        },
        sequence_number: 1,
      } as any;
      async function* fakeStream() {
        yield createdEvent;
        yield completedEvent;
      }
      const createMock = vi.fn().mockResolvedValue(fakeStream());
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'model-usage');

      const request = {
        systemInstructions: undefined,
        input: 'payload',
        modelSettings: {},
        tools: [],
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      const received: ResponseStreamEvent[] = [];
      for await (const ev of model.getStreamedResponse(request as any)) {
        received.push(ev);
      }

      const responseDone = received.find((ev) => ev.type === 'response_done');
      expect(responseDone).toBeDefined();
      expect((responseDone as any).response.id).toBe('res-stream');
      expect((responseDone as any).response.usage).toMatchObject({
        inputTokens: 11,
        outputTokens: 5,
        totalTokens: 16,
        inputTokensDetails: { cached_tokens: 2 },
        outputTokensDetails: { reasoning_tokens: 3 },
        requestUsageEntries: [
          {
            inputTokens: 11,
            outputTokens: 5,
            totalTokens: 16,
            inputTokensDetails: { cached_tokens: 2 },
            outputTokensDetails: { reasoning_tokens: 3 },
            endpoint: 'responses.create',
          },
        ],
      });
    });
  });

  it('getStreamedResponse records span errors and rethrows when streaming fails', async () => {
    setTracingDisabled(false);
    const createdEvent: OpenAIResponseStreamEvent = {
      type: 'response.created',
      response: { id: 'res-error-init' } as any,
      sequence_number: 0,
    };
    async function* failingStream() {
      yield createdEvent;
      throw new Error('stream failed');
    }
    const createMock = vi.fn().mockResolvedValue(failingStream());
    const fakeClient = {
      responses: { create: createMock },
    } as unknown as OpenAI;
    const model = new OpenAIResponsesModel(fakeClient, 'model-error');
    const request = {
      systemInstructions: undefined,
      input: 'payload',
      modelSettings: {},
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: true,
      signal: undefined,
    };

    const setErrorSpy = vi.spyOn(Span.prototype, 'setError');
    await withTrace('test', async () => {
      const consume = async () => {
        for await (const _event of model.getStreamedResponse(request as any)) {
          /* consume */
        }
      };
      await expect(consume()).rejects.toThrow('stream failed');
    });
    expect(setErrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Error streaming response',
        data: { error: expect.stringContaining('stream failed') },
      }),
    );
    setErrorSpy.mockRestore();
    setTracingDisabled(true);
  });
});
