import { describe, it, expect, vi, beforeAll } from 'vitest';
import {
  OpenAIResponsesModel,
  OpenAIResponsesWSModel,
} from '../src/openaiResponsesModel';
import { HEADERS } from '../src/defaults';
import { ResponsesWebSocketInternalError } from '../src/responsesWebSocketConnection';
import OpenAI from 'openai';
import {
  Agent,
  retryPolicies,
  Runner,
  setDefaultModelProvider,
  setTracingDisabled,
  tool,
  withTrace,
  type ResponseStreamEvent,
  Span,
} from '@openai/agents-core';
import type { ResponseStreamEvent as OpenAIResponseStreamEvent } from 'openai/resources/responses/responses';
import { z } from 'zod';

describe('OpenAIResponsesModel', () => {
  beforeAll(() => {
    setTracingDisabled(true);
    setDefaultModelProvider({
      async getModel() {
        throw new Error('not used');
      },
    });
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
      expect(opts).toEqual({
        headers: HEADERS,
        signal: undefined,
      });

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

  it('getResponse exposes the OpenAI request ID on ModelResponse', async () => {
    await withTrace('test', async () => {
      const fakeResponse = {
        id: 'res-request-id',
        usage: {},
        output: [],
      };
      Object.defineProperty(fakeResponse, '_request_id', {
        value: 'req_nonstream_123',
        enumerable: false,
      });
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
      };

      const result = await model.getResponse(request as any);

      expect(result.responseId).toBe('res-request-id');
      expect(result.requestId).toBe('req_nonstream_123');
    });
  });

  it('getRetryAdvice does not suggest retries from transport heuristics alone', () => {
    const fakeClient = {
      responses: { create: vi.fn() },
    } as unknown as OpenAI;
    const model = new OpenAIResponsesModel(fakeClient, 'gpt-test');
    const error = new Error('terminated');

    expect(
      model.getRetryAdvice({
        error,
        request: {
          input: 'hello',
          modelSettings: {},
          tools: [],
          outputType: 'text',
          handoffs: [],
          tracing: false,
        } as any,
        stream: false,
        attempt: 1,
      }),
    ).toBeUndefined();
  });

  it('preserves SDK retries for direct callers when no runner retry policy is configured', async () => {
    await withTrace('test', async () => {
      const fakeResponse = {
        id: 'res-default-retries',
        usage: {},
        output: [],
      };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-test');

      await model.getResponse({
        systemInstructions: undefined,
        input: 'hello',
        modelSettings: {},
        tools: [],
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      } as any);

      expect(createMock).toHaveBeenCalledTimes(1);
      expect(createMock.mock.calls[0]?.[1]).toEqual({
        headers: HEADERS,
        signal: undefined,
      });
    });
  });

  it('preserves SDK retries for direct callers when a retry policy is present', async () => {
    await withTrace('test', async () => {
      const fakeResponse = {
        id: 'res-policy-no-runner-retries',
        usage: {},
        output: [],
      };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-test');

      await model.getResponse({
        systemInstructions: undefined,
        input: 'hello',
        modelSettings: {
          retry: {
            policy: () => true,
          },
        },
        tools: [],
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      } as any);

      expect(createMock).toHaveBeenCalledTimes(1);
      expect(createMock.mock.calls[0]?.[1]).toEqual({
        headers: HEADERS,
        signal: undefined,
      });
    });
  });

  it('preserves SDK retries for direct callers when maxRetries is configured', async () => {
    await withTrace('test', async () => {
      const fakeResponse = {
        id: 'res-max-retries-no-policy',
        usage: {},
        output: [],
      };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-test');

      await model.getResponse({
        systemInstructions: undefined,
        input: 'hello',
        modelSettings: {
          retry: {
            maxRetries: 2,
          },
        },
        tools: [],
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      } as any);

      expect(createMock).toHaveBeenCalledTimes(1);
      expect(createMock.mock.calls[0]?.[1]).toEqual({
        headers: HEADERS,
        signal: undefined,
      });
    });
  });

  it('disables SDK retries when runner retries are enabled', async () => {
    await withTrace('test', async () => {
      const fakeResponse = {
        id: 'res-runner-retries',
        usage: {},
        output: [],
      };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-test');

      await model.getResponse({
        systemInstructions: undefined,
        input: 'hello',
        modelSettings: {
          retry: {
            maxRetries: 2,
            policy: () => true,
          },
        },
        _internal: {
          runnerManagedRetry: true,
        },
        tools: [],
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      } as any);

      expect(createMock).toHaveBeenCalledTimes(1);
      expect(createMock.mock.calls[0]?.[1]).toEqual({
        headers: HEADERS,
        maxRetries: 0,
        signal: undefined,
      });
    });
  });

  it('getRetryAdvice honors x-should-retry=false', () => {
    const fakeClient = {
      responses: { create: vi.fn() },
    } as unknown as OpenAI;
    const model = new OpenAIResponsesModel(fakeClient, 'gpt-test');
    const error = Object.assign(new Error('internal error'), {
      headers: new Headers([['x-should-retry', 'false']]),
      status: 500,
    });

    expect(
      model.getRetryAdvice({
        error,
        request: {
          input: 'hello',
          modelSettings: {},
          tools: [],
          outputType: 'text',
          handoffs: [],
          tracing: false,
        } as any,
        stream: false,
        attempt: 1,
      }),
    ).toEqual({
      suggested: false,
      reason: 'internal error',
    });
  });

  it('getRetryAdvice honors x-should-retry=true', () => {
    const fakeClient = {
      responses: { create: vi.fn() },
    } as unknown as OpenAI;
    const model = new OpenAIResponsesModel(fakeClient, 'gpt-test');
    const error = Object.assign(new Error('provider requested retry'), {
      headers: new Headers([['x-should-retry', 'true']]),
      status: 418,
    });

    expect(
      model.getRetryAdvice({
        error,
        request: {
          input: 'hello',
          modelSettings: {},
          tools: [],
          outputType: 'text',
          handoffs: [],
          tracing: false,
        } as any,
        stream: false,
        attempt: 1,
      }),
    ).toEqual({
      suggested: true,
      replaySafety: 'safe',
      reason: 'provider requested retry',
    });
  });

  it('getRetryAdvice treats x-should-retry=true as safe replay advice for stateful requests', () => {
    const fakeClient = {
      responses: { create: vi.fn() },
    } as unknown as OpenAI;
    const model = new OpenAIResponsesModel(fakeClient, 'gpt-test');
    const error = Object.assign(new Error('provider requested retry'), {
      headers: new Headers([['x-should-retry', 'true']]),
      status: 429,
    });

    expect(
      model.getRetryAdvice({
        error,
        request: {
          input: 'hello',
          previousResponseId: 'resp_123',
          modelSettings: {},
          tools: [],
          outputType: 'text',
          handoffs: [],
          tracing: false,
        } as any,
        stream: false,
        attempt: 1,
      }),
    ).toEqual({
      suggested: true,
      replaySafety: 'safe',
      reason: 'provider requested retry',
    });
  });

  it('getRetryAdvice falls back to OpenAI retryable statuses when header is absent', () => {
    const fakeClient = {
      responses: { create: vi.fn() },
    } as unknown as OpenAI;
    const model = new OpenAIResponsesModel(fakeClient, 'gpt-test');
    const error = Object.assign(new Error('rate limited'), {
      status: 429,
    });

    expect(
      model.getRetryAdvice({
        error,
        request: {
          input: 'hello',
          modelSettings: {},
          tools: [],
          outputType: 'text',
          handoffs: [],
          tracing: false,
        } as any,
        stream: false,
        attempt: 1,
      }),
    ).toEqual({
      suggested: true,
      reason: 'rate limited',
    });
  });

  it('getRetryAdvice does not treat generic retryable statuses as safe replay advice for stateful requests', () => {
    const fakeClient = {
      responses: { create: vi.fn() },
    } as unknown as OpenAI;
    const model = new OpenAIResponsesModel(fakeClient, 'gpt-test');
    const error = Object.assign(new Error('rate limited'), {
      status: 429,
    });

    expect(
      model.getRetryAdvice({
        error,
        request: {
          input: 'hello',
          conversationId: 'conv_123',
          modelSettings: {},
          tools: [],
          outputType: 'text',
          handoffs: [],
          tracing: false,
        } as any,
        stream: false,
        attempt: 1,
      }),
    ).toBeUndefined();

    expect(
      model.getRetryAdvice({
        error,
        request: {
          input: 'hello',
          previousResponseId: 'resp_123',
          modelSettings: {},
          tools: [],
          outputType: 'text',
          handoffs: [],
          tracing: false,
        } as any,
        stream: false,
        attempt: 1,
      }),
    ).toBeUndefined();
  });

  it('retries end-to-end when provider advice opts in', async () => {
    await withTrace('test', async () => {
      const retryError = Object.assign(new Error('provider requested retry'), {
        headers: new Headers([
          ['x-should-retry', 'true'],
          ['retry-after-ms', '0'],
        ]),
        status: 429,
      });
      const fakeResponse = {
        id: 'res-retried',
        usage: {
          input_tokens: 2,
          output_tokens: 3,
          total_tokens: 5,
        },
        output: [
          {
            id: 'retry_msg',
            type: 'message',
            status: 'completed',
            content: [{ type: 'output_text', text: 'retried ok' }],
            role: 'assistant',
          },
        ],
      };
      const createMock = vi
        .fn()
        .mockRejectedValueOnce(retryError)
        .mockResolvedValueOnce(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-test');
      const agent = new Agent({
        name: 'RetryProviderAdviceAgent',
        model,
        modelSettings: {
          retry: {
            maxRetries: 1,
            policy: retryPolicies.providerSuggested(),
          },
        },
      });

      const result = await new Runner().run(agent, 'hello');

      expect(result.finalOutput).toBe('retried ok');
      expect(createMock).toHaveBeenCalledTimes(2);
      expect(result.state.usage.requests).toBe(2);
      expect(result.rawResponses[0]?.usage.requests).toBe(2);
    });
  });

  it('retries end-to-end when provider advice falls back to retryable status codes', async () => {
    await withTrace('test', async () => {
      const retryError = Object.assign(new Error('rate limited'), {
        status: 429,
      });
      const fakeResponse = {
        id: 'res-retried-from-status',
        usage: {
          input_tokens: 2,
          output_tokens: 3,
          total_tokens: 5,
        },
        output: [
          {
            id: 'retry_msg',
            type: 'message',
            status: 'completed',
            content: [{ type: 'output_text', text: 'retried from status ok' }],
            role: 'assistant',
          },
        ],
      };
      const createMock = vi
        .fn()
        .mockRejectedValueOnce(retryError)
        .mockResolvedValueOnce(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-test');
      const agent = new Agent({
        name: 'RetryProviderAdviceStatusAgent',
        model,
        modelSettings: {
          retry: {
            maxRetries: 1,
            policy: retryPolicies.providerSuggested(),
          },
        },
      });

      const result = await new Runner().run(agent, 'hello');

      expect(result.finalOutput).toBe('retried from status ok');
      expect(createMock).toHaveBeenCalledTimes(2);
      expect(result.state.usage.requests).toBe(2);
      expect(result.rawResponses[0]?.usage.requests).toBe(2);
    });
  });

  it('retries streamed requests end-to-end when provider advice opts in before any events', async () => {
    await withTrace('test', async () => {
      const retryError = Object.assign(new Error('provider requested retry'), {
        headers: new Headers([
          ['x-should-retry', 'true'],
          ['retry-after-ms', '0'],
        ]),
        status: 429,
      });
      const createdEvent: OpenAIResponseStreamEvent = {
        type: 'response.created',
        response: { id: 'res-stream-init' } as any,
        sequence_number: 0,
      };
      const completedEvent: OpenAIResponseStreamEvent = {
        type: 'response.completed',
        response: {
          id: 'res-stream-final',
          output: [
            {
              id: 'stream_msg',
              type: 'message',
              status: 'completed',
              content: [{ type: 'output_text', text: 'stream retried ok' }],
              role: 'assistant',
            },
          ],
          usage: {
            input_tokens: 2,
            output_tokens: 4,
            total_tokens: 6,
          },
        } as any,
        sequence_number: 1,
      };
      async function* fakeStream() {
        yield createdEvent;
        yield completedEvent;
      }
      const createMock = vi
        .fn()
        .mockRejectedValueOnce(retryError)
        .mockResolvedValueOnce(fakeStream());
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-test');
      const agent = new Agent({
        name: 'RetryProviderAdviceStreamingAgent',
        model,
        modelSettings: {
          retry: {
            maxRetries: 1,
            policy: retryPolicies.providerSuggested(),
          },
        },
      });

      const result = await new Runner().run(agent, 'hello', { stream: true });
      for await (const _event of result) {
        // Consume the stream to completion.
      }

      expect(result.finalOutput).toBe('stream retried ok');
      expect(createMock).toHaveBeenCalledTimes(2);
      expect(result.state.usage.requests).toBe(2);
      expect(result.rawResponses[0]?.usage.requests).toBe(2);
    });
  });

  it('does not retry streamed websocket requests when provider advice marks replay as unsafe', async () => {
    await withTrace('test', async () => {
      class UnsafeStreamingWSModel extends OpenAIResponsesWSModel {
        attempts = 0;

        /* eslint-disable require-yield */
        override async *getStreamedResponse(): AsyncIterable<ResponseStreamEvent> {
          this.attempts += 1;
          throw new Error(
            'Responses websocket connection closed after sending a request on a reused connection before any response events were received. The request may have been accepted, so the SDK will not automatically retry this websocket request.',
          );
        }
        /* eslint-enable require-yield */
      }

      const fakeClient = {
        responses: { create: vi.fn() },
      } as unknown as OpenAI;
      const model = new UnsafeStreamingWSModel(fakeClient, 'gpt-test');
      const agent = new Agent({
        name: 'UnsafeStreamingProviderAdviceAgent',
        model,
        modelSettings: {
          retry: {
            maxRetries: 1,
            policy: retryPolicies.providerSuggested(),
          },
        },
      });

      const result = await new Runner().run(agent, 'hello', { stream: true });
      const consume = async () => {
        for await (const _event of result) {
          // Consume until the stream throws.
        }
      };

      await expect(consume()).rejects.toThrow(
        'The request may have been accepted, so the SDK will not automatically retry this websocket request.',
      );
      expect(model.attempts).toBe(1);
    });
  });

  it('getRetryAdvice allows streamed websocket retries when the request never left the client', () => {
    const fakeClient = {
      responses: { create: vi.fn() },
    } as unknown as OpenAI;
    const model = new OpenAIResponsesWSModel(fakeClient, 'gpt-test');

    expect(
      model.getRetryAdvice({
        error: new ResponsesWebSocketInternalError(
          'connection_closed_before_opening',
          'Responses websocket connection closed before opening.',
        ),
        request: {
          input: 'hello',
          modelSettings: {},
          tools: [],
          outputType: 'text',
          handoffs: [],
          tracing: false,
        } as any,
        stream: true,
        attempt: 1,
      }),
    ).toEqual({
      suggested: true,
      replaySafety: 'safe',
      reason: 'Responses websocket connection closed before opening.',
    });
  });

  it('getRetryAdvice marks ambiguous websocket replay cases as unsafe', () => {
    const fakeClient = {
      responses: { create: vi.fn() },
    } as unknown as OpenAI;
    const model = new OpenAIResponsesWSModel(fakeClient, 'gpt-test');
    const error = new Error(
      'Responses websocket connection closed after sending a request on a reused connection before any response events were received. The request may have been accepted, so the SDK will not automatically retry this websocket request.',
    );

    expect(
      model.getRetryAdvice({
        error,
        request: {
          input: 'hello',
          modelSettings: {},
          tools: [],
          outputType: 'text',
          handoffs: [],
          tracing: false,
        } as any,
        stream: true,
        attempt: 1,
      }),
    ).toEqual({
      suggested: false,
      replaySafety: 'unsafe',
      reason:
        'Responses websocket connection closed after sending a request on a reused connection before any response events were received. The request may have been accepted, so the SDK will not automatically retry this websocket request.',
    });
  });

  it('getRetryAdvice marks no-event websocket closes after send as unsafe', () => {
    const fakeClient = {
      responses: { create: vi.fn() },
    } as unknown as OpenAI;
    const model = new OpenAIResponsesWSModel(fakeClient, 'gpt-test');

    expect(
      model.getRetryAdvice({
        error: new ResponsesWebSocketInternalError(
          'connection_closed_before_terminal_response_event',
          'Responses websocket connection closed before a terminal response event.',
        ),
        request: {
          input: 'hello',
          modelSettings: {},
          tools: [],
          outputType: 'text',
          handoffs: [],
          tracing: false,
        } as any,
        stream: true,
        attempt: 1,
      }),
    ).toEqual({
      suggested: false,
      replaySafety: 'unsafe',
      reason:
        'Responses websocket connection closed before a terminal response event.',
    });
  });

  it('getRetryAdvice allows non-streaming websocket retries when the request never left the client', () => {
    const fakeClient = {
      responses: { create: vi.fn() },
    } as unknown as OpenAI;
    const model = new OpenAIResponsesWSModel(fakeClient, 'gpt-test');

    expect(
      model.getRetryAdvice({
        error: new ResponsesWebSocketInternalError(
          'connection_closed_before_opening',
          'Responses websocket connection closed before opening.',
        ),
        request: {
          input: 'hello',
          modelSettings: {},
          tools: [],
          outputType: 'text',
          handoffs: [],
          tracing: false,
        } as any,
        stream: false,
        attempt: 1,
      }),
    ).toEqual({
      suggested: true,
      replaySafety: 'safe',
      reason: 'Responses websocket connection closed before opening.',
    });
  });

  it('getRetryAdvice marks non-streaming websocket errors as unsafe when collapse consumed events', () => {
    const fakeClient = {
      responses: { create: vi.fn() },
    } as unknown as OpenAI;
    const model = new OpenAIResponsesWSModel(fakeClient, 'gpt-test');
    const error = Object.assign(
      new Error(
        'Responses websocket connection closed before a terminal response event.',
      ),
      {
        unsafeToReplay: true,
      },
    );

    expect(
      model.getRetryAdvice({
        error,
        request: {
          input: 'hello',
          modelSettings: {},
          tools: [],
          outputType: 'text',
          handoffs: [],
          tracing: false,
        } as any,
        stream: false,
        attempt: 1,
      }),
    ).toEqual({
      suggested: false,
      replaySafety: 'unsafe',
      reason:
        'Responses websocket connection closed before a terminal response event.',
    });
  });

  it('ignores providerData reserved fields when building replay input items', async () => {
    await withTrace('test', async () => {
      const fakeResponse = { id: 'res-provider-data', usage: {}, output: [] };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-test');

      const request = {
        systemInstructions: undefined,
        input: [
          {
            type: 'message',
            id: 'sys_1',
            role: 'system',
            content: 'keep-system',
            providerData: {
              role: 'user',
              content: 'override',
              customFlag: 'keep-system-metadata',
            },
          },
          {
            type: 'message',
            id: 'user_1',
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: 'keep-text',
                providerData: {
                  type: 'bad_text',
                  text: 'override-text',
                  customText: 'keep-text-metadata',
                },
              },
              {
                type: 'input_image',
                image: 'https://example.com/image.png',
                providerData: {
                  type: 'bad_image',
                  imageUrl: 'https://example.com/override.png',
                  detail: 'low',
                  customImage: 'keep-image-metadata',
                },
              },
            ],
          },
          {
            type: 'tool_search_call',
            id: 'search_1',
            status: 'completed',
            arguments: {
              paths: ['crm'],
              query: 'profile',
            },
            providerData: {
              type: 'function_call',
              arguments: { paths: ['billing'] },
              customSearch: 'keep-search-metadata',
            },
          },
          {
            type: 'function_call',
            id: 'fc_1',
            callId: 'call_1',
            name: 'lookup_account',
            namespace: 'crm',
            arguments: '{"accountId":"acct_1"}',
            status: 'completed',
            providerData: {
              name: 'override_name',
              namespace: 'override_namespace',
              arguments: '{"accountId":"override"}',
              customFunction: 'keep-function-metadata',
            },
          },
          {
            type: 'function_call_result',
            id: 'fco_1',
            callId: 'call_1',
            output: 'tool output',
            status: 'completed',
            providerData: {
              type: 'message',
              output: 'override-output',
              customResult: 'keep-result-metadata',
            },
          },
        ],
        modelSettings: {},
        tools: [],
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      await model.getResponse(request as any);

      const [args] = createMock.mock.calls[0];
      expect(args.input).toEqual([
        {
          id: 'sys_1',
          role: 'system',
          content: 'keep-system',
          custom_flag: 'keep-system-metadata',
        },
        {
          id: 'user_1',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: 'keep-text',
              custom_text: 'keep-text-metadata',
            },
            {
              type: 'input_image',
              detail: 'auto',
              image_url: 'https://example.com/image.png',
              custom_image: 'keep-image-metadata',
            },
          ],
        },
        {
          type: 'tool_search_call',
          id: 'search_1',
          status: 'completed',
          arguments: {
            paths: ['crm'],
            query: 'profile',
          },
          custom_search: 'keep-search-metadata',
        },
        {
          id: 'fc_1',
          type: 'function_call',
          name: 'lookup_account',
          call_id: 'call_1',
          arguments: '{"accountId":"acct_1"}',
          status: 'completed',
          namespace: 'crm',
          custom_function: 'keep-function-metadata',
        },
        {
          type: 'function_call_output',
          id: 'fco_1',
          call_id: 'call_1',
          output: 'tool output',
          status: 'completed',
          custom_result: 'keep-result-metadata',
        },
      ]);
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

  it('prevents extra_body from overriding non-streaming request mode', async () => {
    await withTrace('test', async () => {
      const fakeResponse = { id: 'res-non-stream', usage: {}, output: [] };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-test');

      const request = {
        systemInstructions: undefined,
        input: 'hello',
        modelSettings: {
          providerData: {
            extra_body: {
              stream: true,
              metadata: { transport: 'http' },
            },
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
      expect(args.stream).toBe(false);
      expect(args.metadata).toEqual({ transport: 'http' });
    });
  });

  it('preserves null extra_headers entries as SDK header unsets on HTTP requests', async () => {
    await withTrace('test', async () => {
      const fakeResponse = { id: 'res-http-headers', usage: {}, output: [] };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-test');

      const request = {
        systemInstructions: undefined,
        input: 'hello',
        modelSettings: {
          providerData: {
            extra_headers: {
              'User-Agent': null,
              'X-Request-Header': 'present',
            },
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
      const [, opts] = createMock.mock.calls[0];
      const headers = opts.headers as Record<string, string | null>;
      expect(headers['X-Request-Header']).toBe('present');
      expect(headers['user-agent']).toBeNull();
      expect((headers as any).values).toBeUndefined();
      expect((headers as any).nulls).toBeUndefined();

      const sdkClient = new OpenAI({ apiKey: 'sk-test' });
      const sdkHeaders = (await (sdkClient as any).buildHeaders({
        options: { headers },
        method: 'post',
        bodyHeaders: undefined,
        retryCount: 0,
      })) as Headers;
      expect(sdkHeaders.get('X-Request-Header')).toBe('present');
      expect(sdkHeaders.get('User-Agent')).toBeNull();
      expect(sdkHeaders.get('values')).toBeNull();
      expect(sdkHeaders.get('nulls')).toBeNull();
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

  it('allows deferred namespace members in requests', async () => {
    await withTrace('test', async () => {
      const fakeResponse = { id: 'res-tool-search', usage: {}, output: [] };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-5.2');

      const request = {
        systemInstructions: undefined,
        input: 'look up customer_42 and list their open orders',
        modelSettings: {},
        tools: [
          {
            type: 'function',
            name: 'get_customer_profile',
            description: 'Fetch customer profile data.',
            parameters: {
              type: 'object',
              properties: {
                customer_id: { type: 'string' },
              },
              required: ['customer_id'],
              additionalProperties: false,
            },
            strict: true,
            deferLoading: true,
            namespace: 'crm',
            namespaceDescription:
              'CRM tools for customer profile and order lookup.',
          },
          {
            type: 'function',
            name: 'list_open_orders',
            description: 'List open orders for a customer.',
            parameters: {
              type: 'object',
              properties: {
                customer_id: { type: 'string' },
              },
              required: ['customer_id'],
              additionalProperties: false,
            },
            strict: true,
            deferLoading: true,
            namespace: 'crm',
            namespaceDescription:
              'CRM tools for customer profile and order lookup.',
          },
          {
            type: 'hosted_tool',
            name: 'tool_search',
            providerData: { type: 'tool_search' },
          },
        ],
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      await model.getResponse(request as any);

      expect(createMock).toHaveBeenCalledTimes(1);
      const [args] = createMock.mock.calls[0];
      expect(args.tools).toEqual([
        {
          type: 'namespace',
          name: 'crm',
          description: 'CRM tools for customer profile and order lookup.',
          tools: [
            {
              type: 'function',
              name: 'get_customer_profile',
              description: 'Fetch customer profile data.',
              parameters: {
                type: 'object',
                properties: {
                  customer_id: { type: 'string' },
                },
                required: ['customer_id'],
                additionalProperties: false,
              },
              strict: true,
              defer_loading: true,
            },
            {
              type: 'function',
              name: 'list_open_orders',
              description: 'List open orders for a customer.',
              parameters: {
                type: 'object',
                properties: {
                  customer_id: { type: 'string' },
                },
                required: ['customer_id'],
                additionalProperties: false,
              },
              strict: true,
              defer_loading: true,
            },
          ],
        },
        {
          type: 'tool_search',
          execution: undefined,
          description: undefined,
          parameters: undefined,
        },
      ]);
    });
  });

  it('rejects namespaced tools without a namespace description', async () => {
    await withTrace('test', async () => {
      const fakeResponse = {
        id: 'res-missing-namespace-description',
        usage: {},
        output: [],
      };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-5.2');

      const request = {
        systemInstructions: undefined,
        input: 'look up customer_42',
        modelSettings: {},
        tools: [
          {
            type: 'function',
            name: 'get_customer_profile',
            description: 'Fetch customer profile data.',
            parameters: {
              type: 'object',
              properties: {
                customer_id: { type: 'string' },
              },
              required: ['customer_id'],
              additionalProperties: false,
            },
            strict: true,
            namespace: 'crm',
          },
          {
            type: 'hosted_tool',
            name: 'tool_search',
            providerData: { type: 'tool_search' },
          },
        ],
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      await expect(model.getResponse(request as any)).rejects.toThrow(
        'All tools in namespace "crm" must provide a non-empty description.',
      );
      expect(createMock).not.toHaveBeenCalled();
    });
  });

  it('allows namespace tools that mix immediate and deferred members', async () => {
    await withTrace('test', async () => {
      const fakeResponse = {
        id: 'res-mixed-namespace-members',
        usage: {},
        output: [],
      };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-5.2');

      const request = {
        systemInstructions: undefined,
        input: 'look up customer_42',
        modelSettings: {},
        tools: [
          {
            type: 'function',
            name: 'get_customer_profile',
            description: 'Fetch customer profile data.',
            parameters: {
              type: 'object',
              properties: {
                customer_id: { type: 'string' },
              },
              required: ['customer_id'],
              additionalProperties: false,
            },
            strict: true,
            namespace: 'crm',
            namespaceDescription:
              'CRM tools for customer profile and order lookup.',
          },
          {
            type: 'function',
            name: 'list_recent_support_tickets',
            description: 'List recent support tickets.',
            parameters: {
              type: 'object',
              properties: {
                customer_id: { type: 'string' },
              },
              required: ['customer_id'],
              additionalProperties: false,
            },
            strict: true,
            deferLoading: true,
            namespace: 'crm',
            namespaceDescription:
              'CRM tools for customer profile and order lookup.',
          },
          {
            type: 'hosted_tool',
            name: 'tool_search',
            providerData: { type: 'tool_search' },
          },
        ],
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      await model.getResponse(request as any);

      expect(createMock).toHaveBeenCalledTimes(1);
      const [args] = createMock.mock.calls[0];
      expect(args.tools).toEqual([
        {
          type: 'namespace',
          name: 'crm',
          description: 'CRM tools for customer profile and order lookup.',
          tools: [
            {
              type: 'function',
              name: 'get_customer_profile',
              description: 'Fetch customer profile data.',
              parameters: {
                type: 'object',
                properties: {
                  customer_id: { type: 'string' },
                },
                required: ['customer_id'],
                additionalProperties: false,
              },
              strict: true,
            },
            {
              type: 'function',
              name: 'list_recent_support_tickets',
              description: 'List recent support tickets.',
              parameters: {
                type: 'object',
                properties: {
                  customer_id: { type: 'string' },
                },
                required: ['customer_id'],
                additionalProperties: false,
              },
              strict: true,
              defer_loading: true,
            },
          ],
        },
        {
          type: 'tool_search',
          execution: undefined,
          description: undefined,
          parameters: undefined,
        },
      ]);
    });
  });

  it('rejects duplicate function tool names within a namespace', async () => {
    await withTrace('test', async () => {
      const fakeResponse = {
        id: 'res-duplicate-namespace-function',
        usage: {},
        output: [],
      };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-5.2');

      const request = {
        systemInstructions: undefined,
        input: 'look up customer_42',
        modelSettings: {},
        tools: [
          {
            type: 'function',
            name: 'lookup_account',
            description: 'Look up an account in CRM.',
            parameters: {
              type: 'object',
              properties: {
                account_id: { type: 'string' },
              },
              required: ['account_id'],
              additionalProperties: false,
            },
            strict: true,
            namespace: 'crm',
            namespaceDescription: 'CRM tools.',
          },
          {
            type: 'function',
            name: 'lookup_account',
            description: 'Look up a premium account in CRM.',
            parameters: {
              type: 'object',
              properties: {
                account_id: { type: 'string' },
              },
              required: ['account_id'],
              additionalProperties: false,
            },
            strict: true,
            namespace: 'crm',
            namespaceDescription: 'CRM tools.',
          },
          {
            type: 'hosted_tool',
            name: 'tool_search',
            providerData: { type: 'tool_search' },
          },
        ],
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      await expect(model.getResponse(request as any)).rejects.toThrow(
        'Namespace "crm" cannot contain duplicate function tool name "lookup_account".',
      );
      expect(createMock).not.toHaveBeenCalled();
    });
  });

  it('keeps top-level deferred function tools flat in requests', async () => {
    await withTrace('test', async () => {
      const fakeResponse = {
        id: 'res-top-level-deferred',
        usage: {},
        output: [],
      };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-5.2');

      const request = {
        systemInstructions: undefined,
        input: 'look up the shipment eta',
        modelSettings: {},
        tools: [
          {
            type: 'function',
            name: 'get_shipping_eta',
            description: 'Look up a shipment ETA by tracking number.',
            parameters: {
              type: 'object',
              properties: {
                tracking_number: { type: 'string' },
              },
              required: ['tracking_number'],
              additionalProperties: false,
            },
            strict: true,
            deferLoading: true,
          },
          {
            type: 'hosted_tool',
            name: 'tool_search',
            providerData: { type: 'tool_search' },
          },
        ],
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      await model.getResponse(request as any);

      const [args] = createMock.mock.calls[0];
      expect(args.tools).toEqual([
        {
          type: 'function',
          name: 'get_shipping_eta',
          description: 'Look up a shipment ETA by tracking number.',
          parameters: {
            type: 'object',
            properties: {
              tracking_number: { type: 'string' },
            },
            required: ['tracking_number'],
            additionalProperties: false,
          },
          strict: true,
          defer_loading: true,
        },
        {
          type: 'tool_search',
        },
      ]);
    });
  });

  it('passes normalized discriminated union schemas to Responses function tools', async () => {
    await withTrace('test', async () => {
      const fakeResponse = {
        id: 'res-normalized-discriminated-union',
        usage: {},
        output: [],
      };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-5.2');
      const recurrenceTool = tool({
        name: 'plan_recurrence',
        description: 'Plan a recurrence rule.',
        parameters: z.object({
          recurrence: z.discriminatedUnion('type', [
            z.object({
              type: z.literal('once'),
              date: z.string(),
            }),
            z.object({
              type: z.literal('weekly'),
              dayOfWeek: z.number(),
            }),
          ]),
        }),
        execute: async () => 'ok',
      });

      await model.getResponse({
        systemInstructions: undefined,
        input: 'plan the recurrence',
        modelSettings: {},
        tools: [recurrenceTool],
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      } as any);

      const [args] = createMock.mock.calls[0];
      expect(args.tools).toEqual([
        {
          type: 'function',
          name: 'plan_recurrence',
          description: 'Plan a recurrence rule.',
          parameters: {
            $schema: 'http://json-schema.org/draft-07/schema#',
            type: 'object',
            properties: {
              recurrence: {
                type: 'object',
                properties: {
                  type: {
                    type: 'string',
                    enum: ['once', 'weekly'],
                  },
                  date: {
                    type: ['string', 'null'],
                    description: 'Set to null unless type is "once".',
                  },
                  dayOfWeek: {
                    type: ['number', 'null'],
                    description: 'Set to null unless type is "weekly".',
                  },
                },
                required: ['type', 'date', 'dayOfWeek'],
                additionalProperties: false,
              },
            },
            required: ['recurrence'],
            additionalProperties: false,
          },
          strict: true,
        },
      ]);
    });
  });

  it('rejects deferLoading without toolSearchTool', async () => {
    await withTrace('test', async () => {
      const fakeResponse = {
        id: 'res-missing-tool-search',
        usage: {},
        output: [],
      };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-5.2');

      const request = {
        systemInstructions: undefined,
        input: 'look up the shipment eta',
        modelSettings: {},
        tools: [
          {
            type: 'function',
            name: 'get_shipping_eta',
            description: 'Look up a shipment ETA by tracking number.',
            parameters: {
              type: 'object',
              properties: {
                tracking_number: { type: 'string' },
              },
              required: ['tracking_number'],
              additionalProperties: false,
            },
            strict: true,
            deferLoading: true,
          },
        ],
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      await expect(model.getResponse(request as any)).rejects.toThrow(
        'Deferred function tools and hosted MCP tools with deferLoading: true require toolSearchTool() in the same request.',
      );
      expect(createMock).not.toHaveBeenCalled();
    });
  });

  it('includes deferred hosted MCP tools when paired with toolSearchTool', async () => {
    await withTrace('test', async () => {
      const fakeResponse = {
        id: 'res-deferred-mcp',
        usage: {},
        output: [],
      };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-5.2');

      const request = {
        systemInstructions: undefined,
        input: 'find the latest order',
        modelSettings: {},
        tools: [
          {
            type: 'hosted_tool',
            name: 'hosted_mcp',
            providerData: {
              type: 'mcp',
              server_label: 'shopify',
              server_url: 'https://mcp.example.com/shopify',
              server_description: 'Orders and customer records.',
              defer_loading: true,
              require_approval: 'never',
            },
          },
          {
            type: 'hosted_tool',
            name: 'tool_search',
            providerData: { type: 'tool_search' },
          },
        ],
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      await model.getResponse(request as any);

      const [args] = createMock.mock.calls[0];
      expect(args.tools).toEqual([
        {
          type: 'mcp',
          server_label: 'shopify',
          server_url: 'https://mcp.example.com/shopify',
          server_description: 'Orders and customer records.',
          defer_loading: true,
          require_approval: 'never',
        },
        {
          type: 'tool_search',
        },
      ]);
    });
  });

  it('rejects deferred hosted MCP tools without toolSearchTool', async () => {
    await withTrace('test', async () => {
      const fakeResponse = {
        id: 'res-missing-tool-search-mcp',
        usage: {},
        output: [],
      };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-5.2');

      const request = {
        systemInstructions: undefined,
        input: 'find the latest order',
        modelSettings: {},
        tools: [
          {
            type: 'hosted_tool',
            name: 'hosted_mcp',
            providerData: {
              type: 'mcp',
              server_label: 'shopify',
              server_url: 'https://mcp.example.com/shopify',
              defer_loading: true,
              require_approval: 'never',
            },
          },
        ],
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      await expect(model.getResponse(request as any)).rejects.toThrow(
        'Deferred function tools and hosted MCP tools with deferLoading: true require toolSearchTool() in the same request.',
      );
      expect(createMock).not.toHaveBeenCalled();
    });
  });

  it('rejects deferred function tools when a prompt is present without explicit toolSearchTool', async () => {
    await withTrace('test', async () => {
      const fakeResponse = {
        id: 'res-prompt-tool-search',
        usage: {},
        output: [],
      };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-5.2');

      const request = {
        systemInstructions: undefined,
        prompt: { promptId: 'pmpt_tool_search_support' },
        input: 'look up the shipment eta',
        modelSettings: {},
        tools: [
          {
            type: 'function',
            name: 'get_shipping_eta',
            description: 'Look up a shipment ETA by tracking number.',
            parameters: {
              type: 'object',
              properties: {
                tracking_number: { type: 'string' },
              },
              required: ['tracking_number'],
              additionalProperties: false,
            },
            strict: true,
            deferLoading: true,
          },
        ],
        toolsExplicitlyProvided: false,
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      await expect(model.getResponse(request as any)).rejects.toThrow(
        'Deferred function tools and hosted MCP tools with deferLoading: true require toolSearchTool() in the same request.',
      );
      expect(createMock).not.toHaveBeenCalled();
    });
  });

  it('rejects deferred function tools from explicit prompt-backed tool config without explicit toolSearchTool', async () => {
    await withTrace('test', async () => {
      const fakeResponse = {
        id: 'res-prompt-tool-search-explicit-tools',
        usage: {},
        output: [],
      };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-5.2');

      const request = {
        systemInstructions: undefined,
        prompt: { promptId: 'pmpt_tool_search_support' },
        input: 'look up the shipment eta',
        modelSettings: {},
        tools: [
          {
            type: 'function',
            name: 'get_shipping_eta',
            description: 'Look up a shipment ETA by tracking number.',
            parameters: {
              type: 'object',
              properties: {
                tracking_number: { type: 'string' },
              },
              required: ['tracking_number'],
              additionalProperties: false,
            },
            strict: true,
            deferLoading: true,
          },
        ],
        toolsExplicitlyProvided: true,
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      await expect(model.getResponse(request as any)).rejects.toThrow(
        'Deferred function tools and hosted MCP tools with deferLoading: true require toolSearchTool() in the same request.',
      );
      expect(createMock).not.toHaveBeenCalled();
    });
  });

  it('allows deferred function tools with explicit toolSearchTool when a prompt is present', async () => {
    await withTrace('test', async () => {
      const fakeResponse = {
        id: 'res-prompt-tool-search-explicit-helper',
        usage: {},
        output: [],
      };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-5.2');

      const request = {
        systemInstructions: undefined,
        prompt: { promptId: 'pmpt_tool_search_support' },
        input: 'look up the shipment eta',
        modelSettings: {},
        tools: [
          {
            type: 'function',
            name: 'get_shipping_eta',
            description: 'Look up a shipment ETA by tracking number.',
            parameters: {
              type: 'object',
              properties: {
                tracking_number: { type: 'string' },
              },
              required: ['tracking_number'],
              additionalProperties: false,
            },
            strict: true,
            deferLoading: true,
          },
          {
            type: 'hosted_tool',
            name: 'tool_search',
            providerData: { type: 'tool_search' },
          },
        ],
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      await model.getResponse(request as any);

      expect(createMock).toHaveBeenCalledTimes(1);
      const [args] = createMock.mock.calls[0];
      expect(args.prompt).toMatchObject({ id: 'pmpt_tool_search_support' });
      expect(args.tools).toEqual([
        {
          type: 'function',
          name: 'get_shipping_eta',
          description: 'Look up a shipment ETA by tracking number.',
          parameters: {
            type: 'object',
            properties: {
              tracking_number: { type: 'string' },
            },
            required: ['tracking_number'],
            additionalProperties: false,
          },
          strict: true,
          defer_loading: true,
        },
        {
          type: 'tool_search',
        },
      ]);
    });
  });

  it.each([false, true])(
    'preserves explicit tool_search for prompt-backed requests when toolsExplicitlyProvided=%s',
    async (toolsExplicitlyProvided) => {
      await withTrace('test', async () => {
        const fakeResponse = {
          id: 'res-prompt-tool-search-helper',
          usage: {},
          output: [],
        };
        const createMock = vi.fn().mockResolvedValue(fakeResponse);
        const fakeClient = {
          responses: { create: createMock },
        } as unknown as OpenAI;
        const model = new OpenAIResponsesModel(fakeClient, 'gpt-5.2');

        const request = {
          systemInstructions: undefined,
          prompt: { promptId: 'pmpt_tool_search_support' },
          input: 'look up the shipment eta',
          modelSettings: {},
          tools: [
            {
              type: 'hosted_tool',
              name: 'tool_search',
              providerData: { type: 'tool_search' },
            },
          ],
          toolsExplicitlyProvided,
          outputType: 'text',
          handoffs: [],
          tracing: false,
          signal: undefined,
        };

        await model.getResponse(request as any);

        expect(createMock).toHaveBeenCalledTimes(1);
        const [args] = createMock.mock.calls[0];
        expect(args.tools).toEqual([
          {
            type: 'tool_search',
          },
        ]);
      });
    },
  );

  it('rejects deferred namespaced function tools before toolChoice validation', async () => {
    await withTrace('test', async () => {
      const fakeResponse = {
        id: 'res-namespaced-tool-choice',
        usage: {},
        output: [],
      };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-5.2');

      const request = {
        systemInstructions: undefined,
        input: 'look up customer_42',
        modelSettings: { toolChoice: 'crm.lookup_account' },
        tools: [
          {
            type: 'function',
            name: 'lookup_account',
            description: 'Look up an account in CRM.',
            parameters: {
              type: 'object',
              properties: {
                account_id: { type: 'string' },
              },
              required: ['account_id'],
              additionalProperties: false,
            },
            strict: true,
            deferLoading: true,
            namespace: 'crm',
            namespaceDescription: 'CRM tools.',
          },
          {
            type: 'hosted_tool',
            name: 'tool_search',
            providerData: { type: 'tool_search' },
          },
        ],
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      await expect(model.getResponse(request as any)).rejects.toThrow(
        'modelSettings.toolChoice="crm.lookup_account" cannot force a deferred function tool in Responses. Use "auto" so tool_search can load it.',
      );
      expect(createMock).not.toHaveBeenCalled();
    });
  });

  it('rejects forced toolChoice for top-level deferred function tools', async () => {
    await withTrace('test', async () => {
      const fakeResponse = {
        id: 'res-top-level-deferred-tool-choice',
        usage: {},
        output: [],
      };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-5.2');

      const request = {
        systemInstructions: undefined,
        input: 'look up shipment ZX-123',
        modelSettings: { toolChoice: 'get_shipping_eta' },
        tools: [
          {
            type: 'function',
            name: 'get_shipping_eta',
            description: 'Look up a shipment ETA.',
            parameters: {
              type: 'object',
              properties: {
                tracking_number: { type: 'string' },
              },
              required: ['tracking_number'],
              additionalProperties: false,
            },
            strict: true,
            deferLoading: true,
          },
          {
            type: 'hosted_tool',
            name: 'tool_search',
            providerData: { type: 'tool_search' },
          },
        ],
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      await expect(model.getResponse(request as any)).rejects.toThrow(
        'modelSettings.toolChoice="get_shipping_eta" cannot force a deferred function tool in Responses. Use "auto" so tool_search can load it.',
      );
      expect(createMock).not.toHaveBeenCalled();
    });
  });

  it('allows namespaced function tool_choice values for immediate namespace tools', async () => {
    await withTrace('test', async () => {
      const fakeResponse = {
        id: 'res-immediate-namespaced-tool-choice',
        usage: {},
        output: [],
      };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-5.2');

      const request = {
        systemInstructions: undefined,
        input: 'look up customer_42',
        modelSettings: { toolChoice: 'crm.lookup_account' },
        tools: [
          {
            type: 'function',
            name: 'lookup_account',
            description: 'Look up an account in CRM.',
            parameters: {
              type: 'object',
              properties: {
                account_id: { type: 'string' },
              },
              required: ['account_id'],
              additionalProperties: false,
            },
            strict: true,
            namespace: 'crm',
            namespaceDescription: 'CRM tools.',
          },
        ],
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      await model.getResponse(request as any);

      expect(createMock).toHaveBeenCalledTimes(1);
      const [args] = createMock.mock.calls[0];
      expect(args.tools).toEqual([
        {
          type: 'namespace',
          name: 'crm',
          description: 'CRM tools.',
          tools: [
            {
              type: 'function',
              name: 'lookup_account',
              description: 'Look up an account in CRM.',
              parameters: {
                type: 'object',
                properties: {
                  account_id: { type: 'string' },
                },
                required: ['account_id'],
                additionalProperties: false,
              },
              strict: true,
            },
          ],
        },
      ]);
      expect(args.tool_choice).toEqual({
        type: 'function',
        name: 'crm.lookup_account',
      });
    });
  });

  it('preserves explicit server toolSearchTool when no deferred function tools remain', async () => {
    await withTrace('test', async () => {
      const fakeResponse = {
        id: 'res-orphan-tool-search',
        usage: {},
        output: [],
      };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-5.2');

      const request = {
        systemInstructions: undefined,
        input: 'look up the shipment eta',
        modelSettings: {},
        tools: [
          {
            type: 'function',
            name: 'get_shipping_eta',
            description: 'Look up a shipment ETA by tracking number.',
            parameters: {
              type: 'object',
              properties: {
                tracking_number: { type: 'string' },
              },
              required: ['tracking_number'],
              additionalProperties: false,
            },
            strict: true,
          },
          {
            type: 'hosted_tool',
            name: 'tool_search',
            providerData: { type: 'tool_search' },
          },
        ],
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      await model.getResponse(request as any);

      expect(createMock).toHaveBeenCalledTimes(1);
      const [args] = createMock.mock.calls[0];
      expect(args.tools).toEqual([
        {
          type: 'function',
          name: 'get_shipping_eta',
          description: 'Look up a shipment ETA by tracking number.',
          parameters: {
            type: 'object',
            properties: {
              tracking_number: { type: 'string' },
            },
            required: ['tracking_number'],
            additionalProperties: false,
          },
          strict: true,
        },
        {
          type: 'tool_search',
        },
      ]);
    });
  });

  it('keeps explicit toolSearchTool when a prompt is present', async () => {
    await withTrace('test', async () => {
      const fakeResponse = {
        id: 'res-prompt-deferred-tool',
        usage: {},
        output: [],
      };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-5.2');

      const request = {
        systemInstructions: undefined,
        prompt: { promptId: 'pmpt_deferred_tool_support' },
        input: 'look up the shipment eta',
        modelSettings: {},
        tools: [
          {
            type: 'hosted_tool',
            name: 'tool_search',
            providerData: { type: 'tool_search' },
          },
        ],
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      await model.getResponse(request as any);

      expect(createMock).toHaveBeenCalledTimes(1);
      const [args] = createMock.mock.calls[0];
      expect(args.tools).toEqual([
        {
          type: 'tool_search',
        },
      ]);
    });
  });

  it('keeps explicit client toolSearchTool even without deferred local tools', async () => {
    await withTrace('test', async () => {
      const fakeResponse = {
        id: 'res-client-tool-search-helper',
        usage: {},
        output: [],
      };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-5.2');

      const request = {
        systemInstructions: undefined,
        input: 'load deferred tools from the client runtime',
        modelSettings: {},
        tools: [
          {
            type: 'hosted_tool',
            name: 'tool_search',
            providerData: {
              type: 'tool_search',
              execution: 'client',
              description: 'Search local deferred tools.',
              parameters: {
                type: 'object',
                properties: {
                  namespace: { type: 'string' },
                },
              },
            },
          },
        ],
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      await model.getResponse(request as any);

      expect(createMock).toHaveBeenCalledTimes(1);
      const [args] = createMock.mock.calls[0];
      expect(args.tools).toEqual([
        {
          type: 'tool_search',
          execution: 'client',
          description: 'Search local deferred tools.',
          parameters: {
            type: 'object',
            properties: {
              namespace: { type: 'string' },
            },
          },
        },
      ]);
    });
  });

  it('keeps explicit server toolSearchTool without deferred local tools', async () => {
    await withTrace('test', async () => {
      const fakeResponse = {
        id: 'res-server-tool-search-helper',
        usage: {},
        output: [],
      };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-5.2');

      const request = {
        systemInstructions: undefined,
        input: 'look up the shipment eta',
        modelSettings: { parallelToolCalls: true },
        tools: [
          {
            type: 'hosted_tool',
            name: 'tool_search',
            providerData: { type: 'tool_search' },
          },
        ],
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      await model.getResponse(request as any);

      expect(createMock).toHaveBeenCalledTimes(1);
      const [args] = createMock.mock.calls[0];
      expect(args.tools).toEqual([
        {
          type: 'tool_search',
        },
      ]);
      expect(args.parallel_tool_calls).toBe(true);
    });
  });

  it('treats tool_search toolChoice as a custom function name even when the hosted tool is present', async () => {
    await withTrace('test', async () => {
      const fakeResponse = {
        id: 'res-function-tool-search-choice',
        usage: {},
        output: [],
      };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-5.2');

      const request = {
        systemInstructions: undefined,
        input: 'look up the shipment eta',
        modelSettings: { toolChoice: 'tool_search' },
        tools: [
          {
            type: 'function',
            name: 'tool_search',
            description: 'Force a custom tool named tool_search.',
            parameters: {
              type: 'object',
              properties: {
                tracking_number: { type: 'string' },
              },
              required: ['tracking_number'],
              additionalProperties: false,
            },
            strict: true,
          },
          {
            type: 'function',
            name: 'get_shipping_eta',
            description: 'Look up a shipment ETA by tracking number.',
            parameters: {
              type: 'object',
              properties: {
                tracking_number: { type: 'string' },
              },
              required: ['tracking_number'],
              additionalProperties: false,
            },
            strict: true,
          },
          {
            type: 'hosted_tool',
            name: 'tool_search',
            providerData: { type: 'tool_search' },
          },
        ],
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      await model.getResponse(request as any);

      expect(createMock).toHaveBeenCalledTimes(1);
      const [args] = createMock.mock.calls[0];
      expect(args.tool_choice).toEqual({
        type: 'function',
        name: 'tool_search',
      });
    });
  });

  it('treats tool_search toolChoice as a custom function name when no hosted tool is present', async () => {
    await withTrace('test', async () => {
      const fakeResponse = {
        id: 'res-function-tool-search-choice-no-hosted-tool',
        usage: {},
        output: [],
      };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-5.2');

      const request = {
        systemInstructions: undefined,
        input: 'look up the shipment eta',
        modelSettings: { toolChoice: 'tool_search' },
        tools: [
          {
            type: 'function',
            name: 'tool_search',
            description: 'Force a custom tool named tool_search.',
            parameters: {
              type: 'object',
              properties: {
                tracking_number: { type: 'string' },
              },
              required: ['tracking_number'],
              additionalProperties: false,
            },
            strict: true,
          },
        ],
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      await model.getResponse(request as any);

      expect(createMock).toHaveBeenCalledTimes(1);
      const [args] = createMock.mock.calls[0];
      expect(args.tool_choice).toEqual({
        type: 'function',
        name: 'tool_search',
      });
    });
  });

  it('rejects tool_search toolChoice when only the built-in tool_search tool is available', async () => {
    await withTrace('test', async () => {
      const fakeResponse = {
        id: 'res-hosted-tool-search-choice',
        usage: {},
        output: [],
      };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-5.2');

      const request = {
        systemInstructions: undefined,
        input: 'look up the shipment eta',
        modelSettings: { toolChoice: 'tool_search' },
        tools: [
          {
            type: 'function',
            name: 'get_shipping_eta',
            description: 'Look up a shipment ETA by tracking number.',
            parameters: {
              type: 'object',
              properties: {
                tracking_number: { type: 'string' },
              },
              required: ['tracking_number'],
              additionalProperties: false,
            },
            strict: true,
            deferLoading: true,
          },
          {
            type: 'hosted_tool',
            name: 'tool_search',
            providerData: { type: 'tool_search' },
          },
        ],
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      await expect(model.getResponse(request as any)).rejects.toThrow(
        /modelSettings\.toolChoice="tool_search" is only supported for a custom function named "tool_search"/,
      );
      expect(createMock).not.toHaveBeenCalled();
    });
  });

  it('rejects tool_search toolChoice when only a prompt may supply the built-in tool', async () => {
    await withTrace('test', async () => {
      const fakeResponse = {
        id: 'res-prompt-hosted-tool-search-choice',
        usage: {},
        output: [],
      };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-5.2');

      const request = {
        systemInstructions: undefined,
        prompt: { promptId: 'pmpt_tool_search_support' },
        input: 'look up the shipment eta',
        modelSettings: { toolChoice: 'tool_search' },
        tools: [],
        toolsExplicitlyProvided: false,
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      await expect(model.getResponse(request as any)).rejects.toThrow(
        /modelSettings\.toolChoice="tool_search" is only supported for a custom function named "tool_search"/,
      );
      expect(createMock).not.toHaveBeenCalled();
    });
  });

  it('rejects a named function tool choice when no matching tool remains', async () => {
    await withTrace('test', async () => {
      const fakeResponse = {
        id: 'res-missing-function-tool-choice',
        usage: {},
        output: [],
      };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-5.2');

      const request = {
        systemInstructions: undefined,
        input: 'look up customer_42',
        modelSettings: { toolChoice: 'lookup_account' },
        tools: [
          {
            type: 'function',
            name: 'get_shipping_eta',
            description: 'Look up a shipment ETA by tracking number.',
            parameters: {
              type: 'object',
              properties: {
                tracking_number: { type: 'string' },
              },
              required: ['tracking_number'],
              additionalProperties: false,
            },
            strict: true,
          },
        ],
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      await expect(model.getResponse(request as any)).rejects.toThrow(
        /modelSettings\.toolChoice="lookup_account" does not match any available tool/,
      );
      expect(createMock).not.toHaveBeenCalled();
    });
  });

  it('rejects required tool choice when the outgoing tool list is empty', async () => {
    await withTrace('test', async () => {
      const fakeResponse = {
        id: 'res-empty-tool-choice',
        usage: {},
        output: [],
      };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-5.2');

      const request = {
        systemInstructions: undefined,
        input: 'look up the shipment eta',
        modelSettings: { toolChoice: 'required' },
        tools: [],
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      await expect(model.getResponse(request as any)).rejects.toThrow(
        /modelSettings\.toolChoice="required" requires at least one available tool/,
      );
      expect(createMock).not.toHaveBeenCalled();
    });
  });

  it('accepts named tool choice when extra_body supplies the selected tool', async () => {
    await withTrace('test', async () => {
      const fakeResponse = {
        id: 'res-extra-body-tool-choice',
        usage: {},
        output: [],
      };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-5.2');

      const request = {
        systemInstructions: undefined,
        input: 'look up customer_42',
        modelSettings: {
          toolChoice: 'prompt_lookup',
          providerData: {
            extra_body: {
              tools: [
                {
                  type: 'function',
                  name: 'prompt_lookup',
                  description:
                    'Look up a customer from a prompt-supplied tool.',
                  parameters: {
                    type: 'object',
                    properties: {},
                    additionalProperties: false,
                  },
                  strict: true,
                },
              ],
            },
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
      expect(args.tools).toEqual([
        {
          type: 'function',
          name: 'prompt_lookup',
          description: 'Look up a customer from a prompt-supplied tool.',
          parameters: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
          strict: true,
        },
      ]);
      expect(args.tool_choice).toEqual({
        type: 'function',
        name: 'prompt_lookup',
      });
    });
  });

  it('accepts required tool choice when extra_body supplies tools', async () => {
    await withTrace('test', async () => {
      const fakeResponse = {
        id: 'res-extra-body-required-tool-choice',
        usage: {},
        output: [],
      };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-5.2');

      const request = {
        systemInstructions: undefined,
        input: 'look up customer_42',
        modelSettings: {
          toolChoice: 'required',
          providerData: {
            extra_body: {
              tools: [
                {
                  type: 'function',
                  name: 'prompt_lookup',
                  description:
                    'Look up a customer from a prompt-supplied tool.',
                  parameters: {
                    type: 'object',
                    properties: {},
                    additionalProperties: false,
                  },
                  strict: true,
                },
              ],
            },
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
      expect(args.tools).toEqual([
        {
          type: 'function',
          name: 'prompt_lookup',
          description: 'Look up a customer from a prompt-supplied tool.',
          parameters: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
          strict: true,
        },
      ]);
      expect(args.tool_choice).toBe('required');
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

  it('keeps named tool_choice when a prompt may supply the selected tool', async () => {
    await withTrace('test', async () => {
      const fakeResponse = {
        id: 'res-tool-choice-prompt-only',
        usage: {},
        output: [],
      };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-default');

      const request = {
        systemInstructions: undefined,
        prompt: { promptId: 'pmpt_tool_choice_omit' },
        input: 'hello',
        modelSettings: { toolChoice: 'web_search_preview' },
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
      expect(args.tool_choice).toEqual({
        type: 'web_search_preview',
      });
    });
  });

  it('defaults prompt-managed computer tools to the preview wire shape', async () => {
    await withTrace('test', async () => {
      const fakeResponse = {
        id: 'res-prompt-preview-computer-tool',
        usage: {},
        output: [],
      };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-5.4');

      const request = {
        systemInstructions: undefined,
        prompt: { promptId: 'pmpt_computer_preview_default' },
        input: 'hello',
        modelSettings: {},
        tools: [
          {
            type: 'computer',
            name: 'computer_use_preview',
            environment: 'browser',
            dimensions: [1024, 768],
          },
        ],
        toolsExplicitlyProvided: false,
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      await model.getResponse(request as any);

      expect(createMock).toHaveBeenCalledTimes(1);
      const [args] = createMock.mock.calls[0];
      expect('model' in args).toBe(false);
      expect(args.tools).toEqual([
        {
          type: 'computer_use_preview',
          environment: 'browser',
          display_width: 1024,
          display_height: 768,
        },
      ]);
    });
  });

  it('uses the GA computer tool when the request model is explicit', async () => {
    await withTrace('test', async () => {
      const fakeResponse = {
        id: 'res-ga-computer-tool',
        usage: {},
        output: [],
      };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-5.4');

      const request = {
        systemInstructions: undefined,
        input: 'hello',
        modelSettings: {},
        tools: [
          {
            type: 'computer',
            name: 'computer_use_preview',
          },
        ],
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      await model.getResponse(request as any);

      expect(createMock).toHaveBeenCalledTimes(1);
      const [args] = createMock.mock.calls[0];
      expect(args.model).toBe('gpt-5.4');
      expect(args.tools).toEqual([{ type: 'computer' }]);
    });
  });

  it('rejects preview computer fallback without display metadata before sending the request', async () => {
    await withTrace('test', async () => {
      const createMock = vi.fn();
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-5.4');

      const request = {
        systemInstructions: undefined,
        prompt: { promptId: 'pmpt_computer_preview_missing_display' },
        input: 'hello',
        modelSettings: {},
        tools: [
          {
            type: 'computer',
            name: 'computer_use_preview',
          },
        ],
        toolsExplicitlyProvided: false,
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      await expect(model.getResponse(request as any)).rejects.toThrow(
        'Preview computer tools require environment and dimensions.',
      );
      expect(createMock).not.toHaveBeenCalled();
    });
  });

  it('lets prompt-managed requests opt into the GA computer tool via tool_choice', async () => {
    await withTrace('test', async () => {
      const fakeResponse = {
        id: 'res-prompt-ga-computer-tool',
        usage: {},
        output: [],
      };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-5.4');

      const request = {
        systemInstructions: undefined,
        prompt: { promptId: 'pmpt_computer_ga_opt_in' },
        input: 'hello',
        modelSettings: { toolChoice: 'computer' },
        tools: [
          {
            type: 'computer',
            name: 'computer_use_preview',
            environment: 'browser',
            dimensions: [1024, 768],
          },
        ],
        toolsExplicitlyProvided: false,
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      await model.getResponse(request as any);

      expect(createMock).toHaveBeenCalledTimes(1);
      const [args] = createMock.mock.calls[0];
      expect('model' in args).toBe(false);
      expect(args.tools).toEqual([{ type: 'computer' }]);
      expect(args.tool_choice).toEqual({ type: 'computer' });
    });
  });

  it('keeps the built-in computer tool_choice when a prompt manages the computer tool', async () => {
    await withTrace('test', async () => {
      const fakeResponse = {
        id: 'res-prompt-ga-computer-tool-no-local-tools',
        usage: {},
        output: [],
      };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-5.4');

      const request = {
        systemInstructions: undefined,
        prompt: { promptId: 'pmpt_computer_ga_opt_in_no_local_tools' },
        input: 'hello',
        modelSettings: { toolChoice: 'computer' },
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
      expect(args.tool_choice).toEqual({ type: 'computer' });
    });
  });

  it('keeps the built-in computer tool_choice when extraBody.tools provides the computer tool', async () => {
    await withTrace('test', async () => {
      const fakeResponse = {
        id: 'res-extra-body-ga-computer-tool',
        usage: {},
        output: [],
      };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-5.4');

      const request = {
        systemInstructions: undefined,
        input: 'hello',
        modelSettings: {
          toolChoice: 'computer',
          providerData: {
            extraBody: {
              tools: [{ type: 'computer' }],
            },
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
      expect(args.tool_choice).toEqual({ type: 'computer' });
      expect(args.tools).toEqual([{ type: 'computer' }]);
    });
  });

  it('normalizes preview computer tool_choice aliases to the GA selector on GA models', async () => {
    await withTrace('test', async () => {
      const fakeResponse = {
        id: 'res-ga-computer-tool-choice-alias',
        usage: {},
        output: [],
      };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-5.4');

      const request = {
        systemInstructions: undefined,
        input: 'hello',
        modelSettings: { toolChoice: 'computer_use_preview' },
        tools: [
          {
            type: 'computer',
            name: 'computer_use_preview',
            environment: 'browser',
            dimensions: [1024, 768],
          },
        ],
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      await model.getResponse(request as any);

      expect(createMock).toHaveBeenCalledTimes(1);
      const [args] = createMock.mock.calls[0];
      expect(args.tools).toEqual([{ type: 'computer' }]);
      expect(args.tool_choice).toEqual({ type: 'computer' });
    });
  });

  it('keeps named tool_choice when a prompt may supply the selected function alongside local tools', async () => {
    await withTrace('test', async () => {
      const fakeResponse = {
        id: 'res-tool-choice-prompt-plus-local-tools',
        usage: {},
        output: [],
      };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-default');

      const request = {
        systemInstructions: undefined,
        prompt: { promptId: 'pmpt_tool_choice_prompt_plus_local_tools' },
        input: 'hello',
        modelSettings: { toolChoice: 'prompt_lookup' },
        tools: [
          {
            type: 'function',
            name: 'local_lookup',
            description: 'Available locally but not selected by toolChoice.',
            parameters: {
              type: 'object',
              properties: {},
              additionalProperties: false,
            },
            strict: true,
          },
        ],
        toolsExplicitlyProvided: false,
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      await model.getResponse(request as any);

      expect(createMock).toHaveBeenCalledTimes(1);
      const [args] = createMock.mock.calls[0];
      expect(args.tools).toEqual([
        {
          type: 'function',
          name: 'local_lookup',
          description: 'Available locally but not selected by toolChoice.',
          parameters: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
          strict: true,
        },
      ]);
      expect(args.tool_choice).toEqual({
        type: 'function',
        name: 'prompt_lookup',
      });
    });
  });

  it('keeps named tool_choice when a prompt may supply the selected function alongside explicitly provided local tools', async () => {
    await withTrace('test', async () => {
      const fakeResponse = {
        id: 'res-tool-choice-explicit-prompt-tools',
        usage: {},
        output: [],
      };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-default');

      const request = {
        systemInstructions: undefined,
        prompt: { promptId: 'pmpt_tool_choice_explicit_tools' },
        input: 'hello',
        modelSettings: { toolChoice: 'missing_tool' },
        tools: [
          {
            type: 'function',
            name: 'available_tool',
            description: 'Available locally.',
            parameters: {
              type: 'object',
              properties: {},
              additionalProperties: false,
            },
            strict: true,
          },
        ],
        toolsExplicitlyProvided: true,
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      await model.getResponse(request as any);

      expect(createMock).toHaveBeenCalledTimes(1);
      const [args] = createMock.mock.calls[0];
      expect(args.tools).toEqual([
        {
          type: 'function',
          name: 'available_tool',
          description: 'Available locally.',
          parameters: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
          strict: true,
        },
      ]);
      expect(args.tool_choice).toEqual({
        type: 'function',
        name: 'missing_tool',
      });
    });
  });

  it('keeps tool_choice="none" when prompt omits outgoing tools', async () => {
    await withTrace('test', async () => {
      const fakeResponse = {
        id: 'res-tool-choice-literal',
        usage: {},
        output: [],
      };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-default');
      const request = {
        systemInstructions: undefined,
        prompt: { promptId: 'pmpt_tool_choice_literal' },
        input: 'hello',
        modelSettings: { toolChoice: 'none' as const },
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
      expect(args.tool_choice).toBe('none');
    });
  });

  it('keeps tool_choice="required" when a prompt may supply tools', async () => {
    await withTrace('test', async () => {
      const fakeResponse = {
        id: 'res-tool-choice-literal-required',
        usage: {},
        output: [],
      };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-default');

      const request = {
        systemInstructions: undefined,
        prompt: { promptId: 'pmpt_tool_choice_literal' },
        input: 'hello',
        modelSettings: { toolChoice: 'required' as const },
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
      expect(args.tool_choice).toBe('required');
    });
  });

  it('rejects tool_choice="required" when prompt-backed tools were explicitly disabled', async () => {
    await withTrace('test', async () => {
      const fakeResponse = {
        id: 'res-tool-choice-literal-required-disabled',
        usage: {},
        output: [],
      };
      const createMock = vi.fn().mockResolvedValue(fakeResponse);
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-default');

      const request = {
        systemInstructions: undefined,
        prompt: { promptId: 'pmpt_tool_choice_literal' },
        input: 'hello',
        modelSettings: { toolChoice: 'required' as const },
        tools: [],
        toolsExplicitlyProvided: true,
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      await expect(model.getResponse(request as any)).rejects.toThrow(
        /modelSettings\.toolChoice="required" requires at least one available tool in the outgoing Responses request/,
      );
      expect(createMock).not.toHaveBeenCalled();
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
      expect(opts).toEqual({
        headers: HEADERS,
        signal: abort.signal,
      });
      expect(received).toEqual([
        {
          type: 'response_started',
          providerData: events[0],
        },
        {
          type: 'model',
          event: events[0],
          providerData: {
            rawModelEventSource: 'openai-responses',
          },
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
          providerData: {
            rawModelEventSource: 'openai-responses',
          },
        },
      ]);
    });
  });

  it('prevents extra_body from overriding streamed request mode', async () => {
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
          usage: {},
        } as any,
        sequence_number: 1,
      };
      async function* fakeStream() {
        yield createdEvent;
        yield completedEvent;
      }
      const createMock = vi.fn().mockResolvedValue(fakeStream());
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'model-stream');

      const request = {
        systemInstructions: undefined,
        input: 'data',
        modelSettings: {
          providerData: {
            extra_body: {
              stream: false,
              metadata: { transport: 'http' },
            },
          },
        },
        tools: [],
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      for await (const _event of model.getStreamedResponse(request as any)) {
        // Consume the stream to exercise the public path.
      }

      expect(createMock).toHaveBeenCalledTimes(1);
      const [args] = createMock.mock.calls[0];
      expect(args.stream).toBe(true);
      expect(args.metadata).toEqual({ transport: 'http' });
    });
  });

  it('rejects non-plain transport override mappings', async () => {
    await withTrace('test', async () => {
      const createMock = vi.fn();
      const fakeClient = {
        responses: { create: createMock },
      } as unknown as OpenAI;
      const model = new OpenAIResponsesModel(fakeClient, 'gpt-test');

      const request = {
        systemInstructions: undefined,
        input: 'hello',
        modelSettings: {
          providerData: {
            extra_query: new URLSearchParams({ tenant: 'acme' }),
          },
        },
        tools: [],
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      await expect(model.getResponse(request as any)).rejects.toThrow(
        'Responses websocket extra query must be a mapping.',
      );
      expect(createMock).not.toHaveBeenCalled();
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

  it('getStreamedResponse preserves request IDs from HTTP streaming responses', async () => {
    await withTrace('test', async () => {
      const createdEvent: OpenAIResponseStreamEvent = {
        type: 'response.created',
        response: { id: 'res-stream-init' } as any,
        sequence_number: 0,
      };
      const completedEvent: OpenAIResponseStreamEvent = {
        type: 'response.completed',
        response: {
          id: 'res-stream-request-id',
          output: [],
          usage: {},
        },
        sequence_number: 1,
      } as any;
      async function* fakeStream() {
        yield createdEvent;
        yield completedEvent;
      }

      const withResponse = vi.fn().mockResolvedValue({
        data: fakeStream(),
        request_id: 'req_stream_123',
      });
      const createMock = vi.fn().mockReturnValue({
        withResponse,
      });
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
      };

      const received: ResponseStreamEvent[] = [];
      for await (const ev of model.getStreamedResponse(request as any)) {
        received.push(ev);
      }

      expect(withResponse).toHaveBeenCalledTimes(1);
      const responseDone = received.find((ev) => ev.type === 'response_done');
      expect(responseDone).toBeDefined();
      expect((responseDone as any).response.id).toBe('res-stream-request-id');
      expect((responseDone as any).response.requestId).toBe('req_stream_123');
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
