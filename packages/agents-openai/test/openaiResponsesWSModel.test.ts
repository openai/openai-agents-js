import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type OpenAI from 'openai';
import type { ResponseStreamEvent as OpenAIResponseStreamEvent } from 'openai/resources/responses/responses';
import {
  setTracingDisabled,
  type ResponseStreamEvent,
} from '@openai/agents-core';
import { HEADERS } from '../src/defaults';
import { OpenAIResponsesWSModel } from '../src/openaiResponsesModel';
import { ResponsesWebSocketConnection } from '../src/responsesWebSocketConnection';

type Listener = (event: any) => void;

class TestWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: TestWebSocket[] = [];
  static onCreate: ((socket: TestWebSocket) => void) | undefined;

  CONNECTING = TestWebSocket.CONNECTING;
  OPEN = TestWebSocket.OPEN;
  CLOSING = TestWebSocket.CLOSING;
  CLOSED = TestWebSocket.CLOSED;

  readonly url: string;
  readonly init: any;
  readyState = TestWebSocket.CONNECTING;
  sent: string[] = [];
  private listeners = new Map<string, Set<Listener>>();

  constructor(url: string, init?: unknown) {
    this.url = url;
    this.init = init;
    TestWebSocket.instances.push(this);
    TestWebSocket.onCreate?.(this);

    Promise.resolve().then(() => {
      if (this.readyState !== TestWebSocket.CONNECTING) {
        return;
      }
      this.readyState = TestWebSocket.OPEN;
      this.emit('open', { type: 'open' });
    });
  }

  static reset() {
    TestWebSocket.instances = [];
    TestWebSocket.onCreate = undefined;
  }

  addEventListener(type: string, listener: Listener) {
    const set = this.listeners.get(type) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string) {
    this.sent.push(String(data));
    this.emit('send', { data: String(data) });
  }

  close() {
    if (this.readyState === TestWebSocket.CLOSED) {
      return;
    }

    this.readyState = TestWebSocket.CLOSED;
    this.emit('close', { type: 'close' });
  }

  queueJSON(payload: unknown) {
    this.emit('message', { data: JSON.stringify(payload) });
  }

  onSend(handler: (data: string) => void) {
    this.addEventListener('send', (event) => {
      handler(String(event.data));
    });
  }

  private emit(type: string, event: any) {
    const listeners = [...(this.listeners.get(type) ?? [])];
    for (const listener of listeners) {
      listener(event);
    }
  }
}

function createFakeClient(): OpenAI & {
  _callApiKey: ReturnType<typeof vi.fn>;
} {
  const callApiKey = vi.fn().mockResolvedValue(false);
  return {
    apiKey: 'sk-test',
    baseURL: 'https://api.openai.example/v1',
    organization: 'org_test',
    project: 'proj_test',
    responses: {
      create: vi.fn(),
    },
    _callApiKey: callApiKey,
    _options: {
      defaultHeaders: {
        'X-Client-Header': 'client',
      },
    },
  } as unknown as OpenAI & { _callApiKey: ReturnType<typeof vi.fn> };
}

describe('OpenAIResponsesWSModel', () => {
  const originalWebSocket = (globalThis as any).WebSocket;

  beforeAll(() => {
    setTracingDisabled(true);
  });

  beforeEach(() => {
    TestWebSocket.reset();
    (globalThis as any).WebSocket = TestWebSocket as any;
  });

  afterEach(() => {
    if (typeof originalWebSocket === 'undefined') {
      delete (globalThis as any).WebSocket;
    } else {
      (globalThis as any).WebSocket = originalWebSocket;
    }
    TestWebSocket.reset();
  });

  it('streams responses over websocket and maps events', async () => {
    const fakeClient = createFakeClient();
    const sentFrames: Record<string, any>[] = [];

    TestWebSocket.onCreate = (socket) => {
      socket.onSend((rawFrame) => {
        const frame = JSON.parse(rawFrame);
        sentFrames.push(frame);

        const createdEvent: OpenAIResponseStreamEvent = {
          type: 'response.created',
          response: { id: 'resp_init' } as any,
          sequence_number: 0,
        };
        const deltaEvent: OpenAIResponseStreamEvent = {
          type: 'response.output_text.delta',
          content_index: 0,
          delta: 'hello',
          item_id: 'item_1',
          logprobs: [],
          output_index: 0,
          sequence_number: 1,
        } as any;
        const completedEvent: OpenAIResponseStreamEvent = {
          type: 'response.completed',
          response: {
            id: 'resp_done',
            output: [
              {
                id: 'msg_1',
                type: 'message',
                status: 'completed',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'hello' }],
              },
            ],
            usage: {
              input_tokens: 2,
              output_tokens: 1,
              total_tokens: 3,
            },
          } as any,
          sequence_number: 2,
        } as any;

        socket.queueJSON(createdEvent);
        socket.queueJSON(deltaEvent);
        socket.queueJSON(completedEvent);
      });
    };

    const model = new OpenAIResponsesWSModel(fakeClient, 'gpt-ws', {
      websocketBaseURL: 'wss://proxy.example.test/v1?base_param=1',
    });

    const request = {
      systemInstructions: 'inst',
      input: 'hello',
      modelSettings: {
        providerData: {
          extra_headers: { 'X-Extra-Header': 'extra' },
          extra_query: { tenant: 'acme' },
          extra_body: { metadata: { transport: 'ws' } },
        },
      },
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
      signal: undefined,
    };

    const received: ResponseStreamEvent[] = [];
    for await (const event of model.getStreamedResponse(request as any)) {
      received.push(event);
    }

    expect(fakeClient.responses.create as any).not.toHaveBeenCalled();
    expect(fakeClient._callApiKey).toHaveBeenCalledTimes(1);
    expect(TestWebSocket.instances).toHaveLength(1);
    expect(TestWebSocket.instances[0]?.url).toBe(
      'wss://proxy.example.test/v1/responses?base_param=1&tenant=acme',
    );
    expect(TestWebSocket.instances[0]?.init).toMatchObject({
      headers: {
        Authorization: 'Bearer sk-test',
        'OpenAI-Organization': 'org_test',
        'OpenAI-Project': 'proj_test',
        'X-Client-Header': 'client',
        'X-Extra-Header': 'extra',
        'User-Agent': HEADERS['User-Agent'],
      },
    });

    expect(sentFrames).toHaveLength(1);
    expect(sentFrames[0]).toMatchObject({
      type: 'response.create',
      model: 'gpt-ws',
      stream: true,
      instructions: 'inst',
      metadata: { transport: 'ws' },
    });
    expect(sentFrames[0]?.extra_headers).toBeUndefined();
    expect(sentFrames[0]?.extra_query).toBeUndefined();
    expect(sentFrames[0]?.extra_body).toBeUndefined();

    expect(received.some((event) => event.type === 'response_started')).toBe(
      true,
    );
    expect(received.some((event) => event.type === 'output_text_delta')).toBe(
      true,
    );
    const responseDone = received.find(
      (event) => event.type === 'response_done',
    );
    expect(responseDone).toBeDefined();
    expect((responseDone as any).response.id).toBe('resp_done');
  });

  it('serializes websocket query array params with bracket-style encoding', async () => {
    const fakeClient = createFakeClient();

    TestWebSocket.onCreate = (socket) => {
      socket.onSend(() => {
        socket.queueJSON({
          type: 'response.created',
          response: { id: 'resp_init' },
          sequence_number: 0,
        });
        socket.queueJSON({
          type: 'response.completed',
          response: {
            id: 'resp_done',
            output: [],
            usage: {},
          },
          sequence_number: 1,
        });
      });
    };

    const model = new OpenAIResponsesWSModel(fakeClient, 'gpt-ws', {
      websocketBaseURL: 'wss://proxy.example.test/v1',
    });

    const request = {
      systemInstructions: undefined,
      input: 'hello',
      modelSettings: {
        providerData: {
          extra_query: {
            scopes: ['alpha', 'beta'],
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
      // Consume stream to capture the websocket URL.
    }

    const wsURL = new URL(TestWebSocket.instances[0]!.url);
    expect(wsURL.searchParams.getAll('scopes[]')).toEqual(['alpha', 'beta']);
    expect(wsURL.searchParams.getAll('scopes')).toEqual([]);
  });

  it('serializes nested websocket query params with bracket-style object encoding', async () => {
    const fakeClient = createFakeClient() as any;
    fakeClient._options.defaultQuery = {
      filters: {
        tenant: 'client',
        tags: ['client-a'],
      },
    };

    TestWebSocket.onCreate = (socket) => {
      socket.onSend(() => {
        socket.queueJSON({
          type: 'response.created',
          response: { id: 'resp_init' },
          sequence_number: 0,
        });
        socket.queueJSON({
          type: 'response.completed',
          response: {
            id: 'resp_done',
            output: [],
            usage: {},
          },
          sequence_number: 1,
        });
      });
    };

    const model = new OpenAIResponsesWSModel(fakeClient, 'gpt-ws', {
      websocketBaseURL: 'wss://proxy.example.test/v1',
    });

    const request = {
      systemInstructions: undefined,
      input: 'hello',
      modelSettings: {
        providerData: {
          extra_query: {
            filters: {
              tenant: 'request',
              tags: ['alpha', 'beta'],
              nested: {
                region: 'us',
              },
            },
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
      // Consume stream to capture the websocket URL.
    }

    const wsURL = new URL(TestWebSocket.instances[0]!.url);
    expect(wsURL.searchParams.get('filters[tenant]')).toBe('request');
    expect(wsURL.searchParams.getAll('filters[tags][]')).toEqual([
      'alpha',
      'beta',
    ]);
    expect(wsURL.searchParams.get('filters[nested][region]')).toBe('us');
    expect(wsURL.searchParams.get('filters')).toBeNull();
    expect(Array.from(wsURL.searchParams.values())).not.toContain(
      '[object Object]',
    );
  });

  it('uses the client authHeaders strategy for websocket handshakes', async () => {
    const fakeClient = createFakeClient() as any;
    fakeClient._options.defaultQuery = { client_default: '1' };
    const authHeadersSpy = vi.fn().mockResolvedValue({
      values: new Headers({ 'api-key': 'azure-key' }),
      nulls: new Set<string>(),
    });
    fakeClient.authHeaders = authHeadersSpy;

    TestWebSocket.onCreate = (socket) => {
      socket.onSend(() => {
        socket.queueJSON({
          type: 'response.created',
          response: { id: 'resp_init' },
          sequence_number: 0,
        });
        socket.queueJSON({
          type: 'response.completed',
          response: {
            id: 'resp_done',
            output: [],
            usage: {},
          },
          sequence_number: 1,
        });
      });
    };

    const model = new OpenAIResponsesWSModel(fakeClient, 'gpt-ws', {
      websocketBaseURL: 'wss://proxy.example.test/v1?base_param=1',
    });
    const request = {
      systemInstructions: undefined,
      input: 'ping',
      modelSettings: {
        providerData: {
          extra_query: {
            tenant: 'acme',
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
      // Consume the stream to trigger the websocket handshake.
    }

    expect(authHeadersSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        path: '/v1/responses',
        query: expect.objectContaining({
          base_param: '1',
          client_default: '1',
          tenant: 'acme',
        }),
      }),
    );
    expect(TestWebSocket.instances[0]?.init).toMatchObject({
      headers: {
        'api-key': 'azure-key',
      },
    });
    expect(
      TestWebSocket.instances[0]?.init?.headers?.Authorization,
    ).toBeUndefined();
  });

  it('preserves NullableHeaders null unsets across websocket header merges', async () => {
    const fakeClient = createFakeClient() as any;
    fakeClient.authHeaders = vi.fn().mockResolvedValue({
      values: new Headers({ 'api-key': 'azure-key' }),
      nulls: new Set<string>([
        'OpenAI-Organization',
        'OpenAI-Project',
        'X-Client-Header',
        'User-Agent',
      ]),
    });

    TestWebSocket.onCreate = (socket) => {
      socket.onSend(() => {
        socket.queueJSON({
          type: 'response.created',
          response: { id: 'resp_init' },
          sequence_number: 0,
        });
        socket.queueJSON({
          type: 'response.completed',
          response: {
            id: 'resp_done',
            output: [],
            usage: {},
          },
          sequence_number: 1,
        });
      });
    };

    const model = new OpenAIResponsesWSModel(fakeClient, 'gpt-ws');
    const request = {
      systemInstructions: undefined,
      input: 'ping',
      modelSettings: {},
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
      signal: undefined,
    };

    for await (const _event of model.getStreamedResponse(request as any)) {
      // Consume the stream to trigger the websocket handshake.
    }

    const wsHeaders = TestWebSocket.instances[0]?.init?.headers ?? {};
    expect(wsHeaders['api-key']).toBe('azure-key');
    expect(wsHeaders['OpenAI-Organization']).toBeUndefined();
    expect(wsHeaders['OpenAI-Project']).toBeUndefined();
    expect(wsHeaders['X-Client-Header']).toBeUndefined();
    expect(wsHeaders['User-Agent']).toBeUndefined();
  });

  it.each([
    ['response.incomplete', 'incomplete'],
    ['response.failed', 'failed'],
    ['response.error', 'failed'],
  ] as const)(
    'emits response_done for terminal websocket stream event %s',
    async (terminalEventType, expectedStatus) => {
      const fakeClient = createFakeClient();

      TestWebSocket.onCreate = (socket) => {
        socket.onSend(() => {
          socket.queueJSON({
            type: 'response.created',
            response: { id: 'resp_init', status: 'in_progress' },
            sequence_number: 0,
          } as any);
          socket.queueJSON({
            type: terminalEventType,
            response: {
              id: 'resp_terminal',
              status: expectedStatus,
              output: [],
              usage: {},
              ...(terminalEventType === 'response.incomplete'
                ? { incomplete_details: { reason: 'max_output_tokens' } }
                : {}),
            },
            sequence_number: 1,
          } as any);
        });
      };

      const model = new OpenAIResponsesWSModel(fakeClient, 'gpt-ws');
      const request = {
        systemInstructions: undefined,
        input: 'ping',
        modelSettings: {},
        tools: [],
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      const received: ResponseStreamEvent[] = [];
      for await (const event of model.getStreamedResponse(request as any)) {
        received.push(event);
      }

      expect(received.some((event) => event.type === 'response_started')).toBe(
        true,
      );
      const responseDone = received.find(
        (event) => event.type === 'response_done',
      );
      expect(responseDone).toBeDefined();
      expect((responseDone as any).response.id).toBe('resp_terminal');
      expect((responseDone as any).response.providerData?.status).toBe(
        expectedStatus,
      );
      expect(
        received.some(
          (event) =>
            event.type === 'model' &&
            (event as any).event?.type === terminalEventType,
        ),
      ).toBe(true);
    },
  );

  it('merges client defaultQuery into websocket request URLs', async () => {
    const fakeClient = createFakeClient();
    (fakeClient as any)._options.defaultQuery = {
      client_param: 'client',
      tenant: 'client',
    };

    TestWebSocket.onCreate = (socket) => {
      socket.onSend(() => {
        socket.queueJSON({
          type: 'response.created',
          response: { id: 'resp_init' },
          sequence_number: 0,
        });
        socket.queueJSON({
          type: 'response.completed',
          response: {
            id: 'resp_done',
            output: [],
            usage: {},
          },
          sequence_number: 1,
        });
      });
    };

    const model = new OpenAIResponsesWSModel(fakeClient, 'gpt-ws', {
      websocketBaseURL: 'wss://proxy.example.test/v1?base_param=1',
    });
    const request = {
      systemInstructions: undefined,
      input: 'ping',
      modelSettings: {
        providerData: {
          extra_query: {
            tenant: 'request',
            request_param: 'request',
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
      // Consume stream.
    }

    const wsURL = new URL(TestWebSocket.instances[0]!.url);
    expect(wsURL.searchParams.get('base_param')).toBe('1');
    expect(wsURL.searchParams.get('client_param')).toBe('client');
    expect(wsURL.searchParams.get('tenant')).toBe('request');
    expect(wsURL.searchParams.get('request_param')).toBe('request');
  });

  it('preserves explicit websocketBaseURL query params over client defaultQuery', async () => {
    const fakeClient = createFakeClient();
    (fakeClient as any)._options.defaultQuery = {
      'api-version': '2024-01-01',
      tenant: 'client',
      client_param: 'client',
    };

    TestWebSocket.onCreate = (socket) => {
      socket.onSend(() => {
        socket.queueJSON({
          type: 'response.created',
          response: { id: 'resp_init' },
          sequence_number: 0,
        });
        socket.queueJSON({
          type: 'response.completed',
          response: {
            id: 'resp_done',
            output: [],
            usage: {},
          },
          sequence_number: 1,
        });
      });
    };

    const model = new OpenAIResponsesWSModel(fakeClient, 'gpt-ws', {
      websocketBaseURL:
        'wss://proxy.example.test/v1?base_param=1&api-version=2025-02-01-preview&tenant=base',
    });
    const request = {
      systemInstructions: undefined,
      input: 'ping',
      modelSettings: {
        providerData: {
          extra_query: {
            tenant: 'request',
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
      // Consume stream.
    }

    const wsURL = new URL(TestWebSocket.instances[0]!.url);
    expect(wsURL.searchParams.get('base_param')).toBe('1');
    expect(wsURL.searchParams.get('client_param')).toBe('client');
    expect(wsURL.searchParams.get('api-version')).toBe('2025-02-01-preview');
    expect(wsURL.searchParams.get('tenant')).toBe('request');
  });

  it('does not append /responses twice when websocketBaseURL already targets /responses', async () => {
    const fakeClient = createFakeClient();

    TestWebSocket.onCreate = (socket) => {
      socket.onSend(() => {
        socket.queueJSON({
          type: 'response.created',
          response: { id: 'resp_init' },
          sequence_number: 0,
        });
        socket.queueJSON({
          type: 'response.completed',
          response: {
            id: 'resp_done',
            output: [],
            usage: {},
          },
          sequence_number: 1,
        });
      });
    };

    const model = new OpenAIResponsesWSModel(fakeClient, 'gpt-ws', {
      websocketBaseURL: 'wss://proxy.example.test/v1/responses?base_param=1',
    });
    const request = {
      systemInstructions: undefined,
      input: 'ping',
      modelSettings: {
        providerData: {
          extra_query: { tenant: 'acme' },
        },
      },
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
      signal: undefined,
    };

    for await (const _event of model.getStreamedResponse(request as any)) {
      // Consume stream.
    }

    expect(TestWebSocket.instances[0]?.url).toBe(
      'wss://proxy.example.test/v1/responses?base_param=1&tenant=acme',
    );
  });

  it.each([
    ['response.incomplete', 'incomplete'],
    ['response.failed', 'failed'],
    ['response.error', 'failed'],
  ] as const)(
    'returns terminal websocket responses in non-stream mode (%s)',
    async (terminalEventType, expectedStatus) => {
      const fakeClient = createFakeClient();

      TestWebSocket.onCreate = (socket) => {
        socket.onSend(() => {
          socket.queueJSON({
            type: 'response.created',
            response: { id: 'resp_init' },
            sequence_number: 0,
          } as any);
          socket.queueJSON({
            type: terminalEventType,
            response: {
              id: 'resp_done',
              status: expectedStatus,
              output: [],
              usage: {},
            },
            sequence_number: 1,
          } as any);
        });
      };

      const model = new OpenAIResponsesWSModel(fakeClient, 'gpt-ws');
      const request = {
        systemInstructions: undefined,
        input: 'ping',
        modelSettings: {},
        tools: [],
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      const result = await (model as any)._fetchResponse(request as any, false);

      expect(result.id).toBe('resp_done');
      expect(result.status).toBe(expectedStatus);
      expect(TestWebSocket.instances[0]?.sent).toHaveLength(1);
    },
  );

  it('surfaces first-frame websocket error payloads without feature-disabled wrapping', async () => {
    const fakeClient = createFakeClient();

    TestWebSocket.onCreate = (socket) => {
      socket.onSend(() => {
        socket.queueJSON({
          type: 'error',
          error: {
            message: 'invalid request',
          },
        });
      });
    };

    const model = new OpenAIResponsesWSModel(fakeClient, 'gpt-ws');
    const request = {
      systemInstructions: undefined,
      input: 'ping',
      modelSettings: {},
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
      signal: undefined,
    };

    const error = await (model as any)
      ._fetchResponse(request as any, false)
      .catch((err: unknown) => err as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('Responses websocket error:');
    expect(error.message).toContain('invalid request');
    expect(error.message).not.toContain('feature may not be enabled');
  });

  it('preserves local websocket setup errors before first event', async () => {
    const fakeClient = createFakeClient();
    const model = new OpenAIResponsesWSModel(fakeClient, 'gpt-ws', {
      websocketBaseURL: 'ftp://proxy.example.test/v1',
    });
    const request = {
      systemInstructions: undefined,
      input: 'ping',
      modelSettings: {},
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
      signal: undefined,
    };

    const error = await (model as any)
      ._fetchResponse(request as any, false)
      .catch((err: unknown) => err as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain(
      'Unsupported websocket base URL protocol: ftp:',
    );
    expect(error.message).not.toContain('feature may not be enabled');
  });

  it('preserves websocket constructor errors as the cause of header-support failures', async () => {
    class ThrowingCtorWebSocket {
      constructor(_url: string, _init?: unknown) {
        throw new Error('ctor exploded');
      }
    }

    (globalThis as any).WebSocket = ThrowingCtorWebSocket as any;
    const fakeClient = createFakeClient();
    const model = new OpenAIResponsesWSModel(fakeClient, 'gpt-ws');
    const request = {
      systemInstructions: undefined,
      input: 'ping',
      modelSettings: {},
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
      signal: undefined,
    };

    const error = await (model as any)
      ._fetchResponse(request as any, false)
      .catch((err: unknown) => err as Error & { cause?: unknown });

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain(
      'Responses websocket transport requires a WebSocket implementation that supports custom headers.',
    );
    expect((error.cause as Error | undefined)?.message).toBe('ctor exploded');
    expect(error.message).not.toContain('feature may not be enabled');
  });

  it('fails fast when websocket closes before waitForOpen attaches listeners', async () => {
    class FailFastCloseWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;

      CONNECTING = FailFastCloseWebSocket.CONNECTING;
      OPEN = FailFastCloseWebSocket.OPEN;
      CLOSING = FailFastCloseWebSocket.CLOSING;
      CLOSED = FailFastCloseWebSocket.CLOSED;

      readyState = FailFastCloseWebSocket.CONNECTING;
      private listeners = new Map<string, Set<(event: any) => void>>();

      constructor(_url: string, _init?: unknown) {}

      addEventListener(type: string, listener: (event: any) => void) {
        const set = this.listeners.get(type) ?? new Set<(event: any) => void>();
        set.add(listener);
        this.listeners.set(type, set);

        // Trigger a fail-fast close after the connection object's persistent close
        // listener is attached but before waitForOpen() registers its temporary listeners.
        if (
          type === 'close' &&
          this.readyState === FailFastCloseWebSocket.CONNECTING
        ) {
          this.readyState = FailFastCloseWebSocket.CLOSED;
          this.emit('close', { type: 'close' });
        }
      }

      removeEventListener(type: string, listener: (event: any) => void) {
        this.listeners.get(type)?.delete(listener);
      }

      send(_data: string) {
        throw new Error('unexpected send');
      }

      close() {
        if (this.readyState === FailFastCloseWebSocket.CLOSED) {
          return;
        }
        this.readyState = FailFastCloseWebSocket.CLOSED;
        this.emit('close', { type: 'close' });
      }

      private emit(type: string, event: any) {
        const listeners = [...(this.listeners.get(type) ?? [])];
        for (const listener of listeners) {
          listener(event);
        }
      }
    }

    (globalThis as any).WebSocket = FailFastCloseWebSocket as any;
    const fakeClient = createFakeClient();
    const model = new OpenAIResponsesWSModel(fakeClient, 'gpt-ws');
    const request = {
      systemInstructions: undefined,
      input: 'ping',
      modelSettings: {},
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
      signal: undefined,
    };

    const result = await Promise.race([
      (model as any)._fetchResponse(request as any, false).then(
        () => ({ kind: 'resolved' as const }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      ),
      new Promise<{ kind: 'timeout' }>((resolve) =>
        setTimeout(() => resolve({ kind: 'timeout' }), 100),
      ),
    ]);

    expect(result.kind).toBe('rejected');
    expect((result as any).error).toBeInstanceOf(Error);
    expect(((result as any).error as Error).message).toContain(
      'feature may not be enabled',
    );
    expect(
      (((result as any).error as Error & { cause?: unknown }).cause as Error)
        ?.message ?? '',
    ).toContain('closed before opening');
  });

  it('times out a stalled websocket handshake and unblocks queued requests', async () => {
    const fakeClient = createFakeClient() as any;
    fakeClient.timeout = 25;
    fakeClient._options = { ...(fakeClient._options ?? {}), timeout: 25 };
    let socketCreateCount = 0;
    let resolveFirstSocketCreated!: () => void;
    const firstSocketCreated = new Promise<void>((resolve) => {
      resolveFirstSocketCreated = resolve;
    });

    TestWebSocket.onCreate = (socket) => {
      socketCreateCount += 1;
      if (socketCreateCount === 1) {
        socket.readyState = 99 as any;
        resolveFirstSocketCreated();
        return;
      }

      socket.onSend(() => {
        socket.queueJSON({
          type: 'response.created',
          response: { id: 'resp_init_2' },
          sequence_number: 0,
        });
        socket.queueJSON({
          type: 'response.completed',
          response: {
            id: 'resp_done_2',
            output: [],
            usage: {},
          },
          sequence_number: 1,
        });
      });
    };

    const model = new OpenAIResponsesWSModel(fakeClient, 'gpt-ws');
    const baseRequest = {
      systemInstructions: undefined,
      input: 'ping',
      modelSettings: {},
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
      signal: undefined,
    };

    const firstResponsePromise = (model as any)._fetchResponse(
      {
        ...baseRequest,
        input: 'first',
      } as any,
      false,
    );
    await firstSocketCreated;

    // The second request snapshots timeout at request start (before queue wait),
    // so give it a larger budget explicitly to keep this test focused on lock
    // release/unblocking behavior after the first handshake timeout.
    fakeClient.timeout = 1000;
    fakeClient._options.timeout = 1000;

    const secondResponsePromise = (model as any)._fetchResponse(
      {
        ...baseRequest,
        input: 'second',
      } as any,
      false,
    );

    await expect(firstResponsePromise).rejects.toThrow(
      'Responses websocket connection timed out before opening after 25ms.',
    );
    await expect(secondResponsePromise).resolves.toMatchObject({
      id: 'resp_done_2',
    });
    expect(TestWebSocket.instances).toHaveLength(2);
    expect(TestWebSocket.instances[0]?.sent).toHaveLength(0);
    expect(TestWebSocket.instances[1]?.sent).toHaveLength(1);
  });

  it('times out stalled websocket auth header preparation and unblocks queued requests', async () => {
    const fakeClient = createFakeClient() as any;
    fakeClient.timeout = 25;
    fakeClient._options = { ...(fakeClient._options ?? {}), timeout: 25 };
    let authHeadersCallCount = 0;
    let resolveFirstAuthHeadersStarted!: () => void;
    const firstAuthHeadersStarted = new Promise<void>((resolve) => {
      resolveFirstAuthHeadersStarted = resolve;
    });

    fakeClient.authHeaders = vi.fn(async () => {
      authHeadersCallCount += 1;
      if (authHeadersCallCount === 1) {
        resolveFirstAuthHeadersStarted();
        return await new Promise<never>(() => {
          // Intentionally never resolves; timeout handling should release the lock.
        });
      }

      return {
        values: new Headers({ 'api-key': 'azure-key' }),
        nulls: new Set<string>(),
      };
    });

    TestWebSocket.onCreate = (socket) => {
      socket.onSend(() => {
        socket.queueJSON({
          type: 'response.created',
          response: { id: 'resp_init_auth' },
          sequence_number: 0,
        });
        socket.queueJSON({
          type: 'response.completed',
          response: {
            id: 'resp_done_auth',
            output: [],
            usage: {},
          },
          sequence_number: 1,
        });
      });
    };

    const model = new OpenAIResponsesWSModel(fakeClient, 'gpt-ws');
    const baseRequest = {
      systemInstructions: undefined,
      input: 'ping',
      modelSettings: {},
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
      signal: undefined,
    };

    const firstResponsePromise = (model as any)._fetchResponse(
      {
        ...baseRequest,
        input: 'first',
      } as any,
      false,
    );
    await firstAuthHeadersStarted;

    // Timeout is captured at request start, so explicitly give the queued
    // request enough budget to wait for the first timeout and then proceed.
    fakeClient.timeout = 1000;
    fakeClient._options.timeout = 1000;

    const secondResponsePromise = (model as any)._fetchResponse(
      {
        ...baseRequest,
        input: 'second',
      } as any,
      false,
    );

    await expect(firstResponsePromise).rejects.toThrow(
      'Responses websocket auth header preparation timed out after 25ms.',
    );
    await expect(secondResponsePromise).resolves.toMatchObject({
      id: 'resp_done_auth',
    });
    expect(fakeClient.authHeaders).toHaveBeenCalledTimes(2);
    expect(TestWebSocket.instances).toHaveLength(1);
    expect(TestWebSocket.instances[0]?.sent).toHaveLength(1);
  });

  it('prevents request providerData from overriding websocket frame type', async () => {
    const fakeClient = createFakeClient();
    const sentFrames: Record<string, any>[] = [];

    TestWebSocket.onCreate = (socket) => {
      socket.onSend((rawFrame) => {
        sentFrames.push(JSON.parse(rawFrame));
        socket.queueJSON({
          type: 'response.created',
          response: { id: 'resp_init' },
          sequence_number: 0,
        });
        socket.queueJSON({
          type: 'response.completed',
          response: {
            id: 'resp_done',
            output: [],
            usage: {},
          },
          sequence_number: 1,
        });
      });
    };

    const model = new OpenAIResponsesWSModel(fakeClient, 'gpt-ws');
    const request = {
      systemInstructions: undefined,
      input: 'ping',
      modelSettings: {
        providerData: {
          extra_body: {
            type: 'user.overridden.type',
            metadata: { transport: 'ws' },
          },
        },
      },
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
      signal: undefined,
    };

    await (model as any)._fetchResponse(request as any, false);

    expect(sentFrames).toHaveLength(1);
    expect(sentFrames[0]).toMatchObject({
      type: 'response.create',
      metadata: { transport: 'ws' },
      stream: true,
    });
  });

  it('reuses the websocket connection across sequential requests', async () => {
    const fakeClient = createFakeClient();
    let sendCount = 0;

    TestWebSocket.onCreate = (socket) => {
      socket.onSend(() => {
        sendCount += 1;
        socket.queueJSON({
          type: 'response.created',
          response: { id: `resp_init_${sendCount}` },
          sequence_number: 0,
        });
        socket.queueJSON({
          type: 'response.completed',
          response: {
            id: `resp_done_${sendCount}`,
            output: [],
            usage: {},
          },
          sequence_number: 1,
        });
      });
    };

    const model = new OpenAIResponsesWSModel(fakeClient, 'gpt-ws');
    const request = {
      systemInstructions: undefined,
      input: 'ping',
      modelSettings: {},
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
      signal: undefined,
    };

    const consumeStream = async () => {
      let responseId = '';
      for await (const event of model.getStreamedResponse(request as any)) {
        if (event.type === 'response_done') {
          responseId = event.response.id;
        }
      }
      return responseId;
    };

    const first = await consumeStream();
    const second = await consumeStream();

    expect(first).toBe('resp_done_1');
    expect(second).toBe('resp_done_2');
    expect(TestWebSocket.instances).toHaveLength(1);
    expect(fakeClient._callApiKey).toHaveBeenCalledTimes(2);
  });

  it('drops the websocket connection after terminal events when reuse is disabled', async () => {
    const fakeClient = createFakeClient();
    let sendCount = 0;

    TestWebSocket.onCreate = (socket) => {
      socket.onSend(() => {
        sendCount += 1;
        socket.queueJSON({
          type: 'response.created',
          response: { id: `resp_init_${sendCount}` },
          sequence_number: 0,
        });
        socket.queueJSON({
          type: 'response.completed',
          response: {
            id: `resp_done_${sendCount}`,
            output: [],
            usage: {},
          },
          sequence_number: 1,
        });
      });
    };

    const model = new OpenAIResponsesWSModel(fakeClient, 'gpt-ws', {
      reuseConnection: false,
    });
    const request = {
      systemInstructions: undefined,
      input: 'ping',
      modelSettings: {},
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
      signal: undefined,
    };

    const consumeStream = async () => {
      let responseId = '';
      for await (const event of model.getStreamedResponse(request as any)) {
        if (event.type === 'response_done') {
          responseId = event.response.id;
        }
      }
      return responseId;
    };

    const first = await consumeStream();
    expect(TestWebSocket.instances[0]?.readyState).toBe(TestWebSocket.CLOSED);
    const second = await consumeStream();

    expect(first).toBe('resp_done_1');
    expect(second).toBe('resp_done_2');
    expect(TestWebSocket.instances).toHaveLength(2);
  });

  it('releases the request lock before awaiting websocket close', async () => {
    const fakeClient = createFakeClient() as any;
    fakeClient.timeout = 25;
    fakeClient._options = { ...(fakeClient._options ?? {}), timeout: 25 };
    let sendCount = 0;
    let resolveFirstCloseStarted!: () => void;
    let releaseFirstClose!: () => void;

    const firstCloseStarted = new Promise<void>((resolve) => {
      resolveFirstCloseStarted = resolve;
    });
    const firstCloseReleased = new Promise<void>((resolve) => {
      releaseFirstClose = resolve;
    });

    TestWebSocket.onCreate = (socket) => {
      const socketId = TestWebSocket.instances.length;
      if (socketId === 1) {
        let closeDelayed = false;
        socket.close = (() => {
          if (socket.readyState === TestWebSocket.CLOSED) {
            return;
          }
          if (closeDelayed) {
            return;
          }
          closeDelayed = true;
          socket.readyState = TestWebSocket.CLOSING;
          resolveFirstCloseStarted();
          void firstCloseReleased.then(() => {
            socket.readyState = TestWebSocket.CLOSED;
            (socket as any).emit('close', { type: 'close' });
          });
        }) as TestWebSocket['close'];
      }

      socket.onSend(() => {
        sendCount += 1;
        socket.queueJSON({
          type: 'response.created',
          response: { id: `resp_init_${socketId}` },
          sequence_number: 0,
        });
        socket.queueJSON({
          type: 'response.completed',
          response: {
            id: `resp_done_${socketId}`,
            output: [],
            usage: {},
          },
          sequence_number: 1,
        });
      });
    };

    const model = new OpenAIResponsesWSModel(fakeClient, 'gpt-ws', {
      reuseConnection: false,
    });
    const baseRequest = {
      systemInstructions: undefined,
      input: 'ping',
      modelSettings: {},
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
      signal: undefined,
    };

    const firstResponsePromise = (model as any)._fetchResponse(
      { ...baseRequest, input: 'first' } as any,
      false,
    );
    void firstResponsePromise.catch(() => undefined);

    await firstCloseStarted;

    const secondResponsePromise = (model as any)._fetchResponse(
      { ...baseRequest, input: 'second' } as any,
      false,
    );
    void secondResponsePromise.catch(() => undefined);

    const queuedOutcome = await Promise.race([
      secondResponsePromise.then(
        (response: any) => ({ kind: 'resolved' as const, response }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      ),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        setTimeout(() => resolve({ kind: 'timeout' }), 200);
      }),
    ]);

    try {
      expect(queuedOutcome.kind).toBe('resolved');
      if (queuedOutcome.kind === 'resolved') {
        expect(queuedOutcome.response).toMatchObject({ id: 'resp_done_2' });
      }
      expect(sendCount).toBe(2);
      expect(TestWebSocket.instances).toHaveLength(2);
    } finally {
      releaseFirstClose();
    }

    await expect(firstResponsePromise).resolves.toMatchObject({
      id: 'resp_done_1',
    });
  });

  it('reconnects before reuse when the cached websocket has been closed', async () => {
    const fakeClient = createFakeClient();
    let socketCreateCount = 0;

    TestWebSocket.onCreate = (socket) => {
      const socketId = ++socketCreateCount;
      socket.onSend(() => {
        socket.queueJSON({
          type: 'response.created',
          response: { id: `resp_init_${socketId}` },
          sequence_number: 0,
        });
        socket.queueJSON({
          type: 'response.completed',
          response: {
            id: `resp_done_${socketId}`,
            output: [],
            usage: {},
          },
          sequence_number: 1,
        });
      });
    };

    const model = new OpenAIResponsesWSModel(fakeClient, 'gpt-ws');
    const request = {
      systemInstructions: undefined,
      input: 'ping',
      modelSettings: {},
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
      signal: undefined,
    };

    const consumeStream = async () => {
      let responseId = '';
      for await (const event of model.getStreamedResponse(request as any)) {
        if (event.type === 'response_done') {
          responseId = event.response.id;
        }
      }
      return responseId;
    };

    const first = await consumeStream();
    TestWebSocket.instances[0]?.close();
    const second = await consumeStream();

    expect(first).toBe('resp_done_1');
    expect(second).toBe('resp_done_2');
    expect(TestWebSocket.instances).toHaveLength(2);
  });

  it('reconnects when a reused websocket closes before the request frame is sent', async () => {
    const fakeClient = createFakeClient();
    let socketCreateCount = 0;

    TestWebSocket.onCreate = (socket) => {
      const socketId = ++socketCreateCount;
      socket.onSend(() => {
        socket.queueJSON({
          type: 'response.created',
          response: { id: `resp_init_${socketId}` },
          sequence_number: 0,
        });
        socket.queueJSON({
          type: 'response.completed',
          response: {
            id: `resp_done_${socketId}`,
            output: [],
            usage: {},
          },
          sequence_number: 1,
        });
      });
    };

    const model = new OpenAIResponsesWSModel(fakeClient, 'gpt-ws');
    const request = {
      systemInstructions: undefined,
      input: 'ping',
      modelSettings: {},
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
      signal: undefined,
    };

    const consumeStream = async () => {
      let responseId = '';
      for await (const event of model.getStreamedResponse(request as any)) {
        if (event.type === 'response_done') {
          responseId = event.response.id;
        }
      }
      return responseId;
    };

    const first = await consumeStream();
    const firstSocket = TestWebSocket.instances[0];
    expect(firstSocket).toBeDefined();

    let readyState = firstSocket!.readyState;
    let closeBeforeSendScheduled = false;
    Object.defineProperty(firstSocket!, 'readyState', {
      configurable: true,
      get() {
        if (!closeBeforeSendScheduled && readyState === TestWebSocket.OPEN) {
          closeBeforeSendScheduled = true;
          void Promise.resolve().then(() => {
            firstSocket!.close();
          });
        }
        return readyState;
      },
      set(value) {
        readyState = value as number;
      },
    });

    const second = await consumeStream();

    expect(first).toBe('resp_done_1');
    expect(second).toBe('resp_done_2');
    expect(TestWebSocket.instances).toHaveLength(2);
    expect(TestWebSocket.instances[0]?.sent).toHaveLength(1);
    expect(TestWebSocket.instances[1]?.sent).toHaveLength(1);
  });

  it('does not replay after a reused websocket closes post-send before the first response frame', async () => {
    const fakeClient = createFakeClient();
    let socketCreateCount = 0;

    TestWebSocket.onCreate = (socket) => {
      const socketId = ++socketCreateCount;
      let sendCount = 0;
      socket.onSend(() => {
        sendCount += 1;
        if (socketId === 1 && sendCount === 2) {
          void Promise.resolve().then(() => {
            socket.close();
          });
          return;
        }

        socket.queueJSON({
          type: 'response.created',
          response: { id: `resp_init_${socketId}` },
          sequence_number: 0,
        });
        socket.queueJSON({
          type: 'response.completed',
          response: {
            id: `resp_done_${socketId}`,
            output: [],
            usage: {},
          },
          sequence_number: 1,
        });
      });
    };

    const model = new OpenAIResponsesWSModel(fakeClient, 'gpt-ws');
    const request = {
      systemInstructions: undefined,
      input: 'ping',
      modelSettings: {},
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
      signal: undefined,
    };

    const consumeStream = async () => {
      let responseId = '';
      for await (const event of model.getStreamedResponse(request as any)) {
        if (event.type === 'response_done') {
          responseId = event.response.id;
        }
      }
      return responseId;
    };

    const first = await consumeStream();
    await expect(consumeStream()).rejects.toThrow(
      'The request may have been accepted, so the SDK will not automatically retry this websocket request.',
    );

    expect(first).toBe('resp_done_1');
    expect(TestWebSocket.instances).toHaveLength(1);
    expect(TestWebSocket.instances[0]?.sent).toHaveLength(2);
  });

  it('reconnects when a reused websocket send throws native InvalidStateError', async () => {
    const fakeClient = createFakeClient();
    let socketCreateCount = 0;

    TestWebSocket.onCreate = (socket) => {
      const socketId = ++socketCreateCount;
      socket.onSend(() => {
        socket.queueJSON({
          type: 'response.created',
          response: { id: `resp_init_${socketId}` },
          sequence_number: 0,
        });
        socket.queueJSON({
          type: 'response.completed',
          response: {
            id: `resp_done_${socketId}`,
            output: [],
            usage: {},
          },
          sequence_number: 1,
        });
      });
    };

    const model = new OpenAIResponsesWSModel(fakeClient, 'gpt-ws');
    const request = {
      systemInstructions: undefined,
      input: 'ping',
      modelSettings: {},
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
      signal: undefined,
    };

    const consumeStream = async () => {
      let responseId = '';
      for await (const event of model.getStreamedResponse(request as any)) {
        if (event.type === 'response_done') {
          responseId = event.response.id;
        }
      }
      return responseId;
    };

    const first = await consumeStream();
    const firstSocket = TestWebSocket.instances[0];
    expect(firstSocket).toBeDefined();

    const originalSend = firstSocket!.send.bind(firstSocket!);
    let throwNativeInvalidStateOnce = true;
    firstSocket!.send = ((data: string) => {
      if (throwNativeInvalidStateOnce) {
        throwNativeInvalidStateOnce = false;
        firstSocket!.close();
        const invalidStateError = new Error(
          'WebSocket is already in CLOSING or CLOSED state.',
        );
        invalidStateError.name = 'InvalidStateError';
        throw invalidStateError;
      }
      originalSend(data);
    }) as TestWebSocket['send'];

    const second = await consumeStream();

    expect(first).toBe('resp_done_1');
    expect(second).toBe('resp_done_2');
    expect(TestWebSocket.instances).toHaveLength(2);
    expect(TestWebSocket.instances[0]?.sent).toHaveLength(1);
    expect(TestWebSocket.instances[1]?.sent).toHaveLength(1);
  });

  it('reconnects when a reused websocket send throws ws readyState error', async () => {
    const fakeClient = createFakeClient();
    let socketCreateCount = 0;

    TestWebSocket.onCreate = (socket) => {
      const socketId = ++socketCreateCount;
      socket.onSend(() => {
        socket.queueJSON({
          type: 'response.created',
          response: { id: `resp_init_${socketId}` },
          sequence_number: 0,
        });
        socket.queueJSON({
          type: 'response.completed',
          response: {
            id: `resp_done_${socketId}`,
            output: [],
            usage: {},
          },
          sequence_number: 1,
        });
      });
    };

    const model = new OpenAIResponsesWSModel(fakeClient, 'gpt-ws');
    const request = {
      systemInstructions: undefined,
      input: 'ping',
      modelSettings: {},
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
      signal: undefined,
    };

    const consumeStream = async () => {
      let responseId = '';
      for await (const event of model.getStreamedResponse(request as any)) {
        if (event.type === 'response_done') {
          responseId = event.response.id;
        }
      }
      return responseId;
    };

    const first = await consumeStream();
    const firstSocket = TestWebSocket.instances[0];
    expect(firstSocket).toBeDefined();

    const originalSend = firstSocket!.send.bind(firstSocket!);
    let throwWsReadyStateErrorOnce = true;
    firstSocket!.send = ((data: string) => {
      if (throwWsReadyStateErrorOnce) {
        throwWsReadyStateErrorOnce = false;
        firstSocket!.close();
        throw new Error('WebSocket is not open: readyState 2 (CLOSING)');
      }
      originalSend(data);
    }) as TestWebSocket['send'];

    const second = await consumeStream();

    expect(first).toBe('resp_done_1');
    expect(second).toBe('resp_done_2');
    expect(TestWebSocket.instances).toHaveLength(2);
    expect(TestWebSocket.instances[0]?.sent).toHaveLength(1);
    expect(TestWebSocket.instances[1]?.sent).toHaveLength(1);
  });

  it('times out silent websocket frame reads and unblocks queued requests', async () => {
    const fakeClient = createFakeClient() as any;
    fakeClient.timeout = 25;
    fakeClient._options = { ...(fakeClient._options ?? {}), timeout: 25 };
    let sendCount = 0;
    let resolveFirstFrameWaitStarted!: () => void;
    const firstFrameWaitStarted = new Promise<void>((resolve) => {
      resolveFirstFrameWaitStarted = resolve;
    });
    const originalNextFrame = ResponsesWebSocketConnection.prototype.nextFrame;
    let sawFirstNextFrameCall = false;
    const nextFrameSpy = vi
      .spyOn(ResponsesWebSocketConnection.prototype, 'nextFrame')
      .mockImplementation(function (
        this: ResponsesWebSocketConnection,
        signal,
      ) {
        if (!sawFirstNextFrameCall) {
          sawFirstNextFrameCall = true;
          resolveFirstFrameWaitStarted();
        }
        return originalNextFrame.call(this, signal);
      });

    try {
      TestWebSocket.onCreate = (socket) => {
        socket.onSend(() => {
          sendCount += 1;
          if (sendCount === 1) {
            return;
          }

          socket.queueJSON({
            type: 'response.created',
            response: { id: 'resp_init_2' },
            sequence_number: 0,
          });
          socket.queueJSON({
            type: 'response.completed',
            response: {
              id: 'resp_done_2',
              output: [],
              usage: {},
            },
            sequence_number: 1,
          });
        });
      };

      const model = new OpenAIResponsesWSModel(fakeClient, 'gpt-ws');
      const baseRequest = {
        systemInstructions: undefined,
        input: 'ping',
        modelSettings: {},
        tools: [],
        outputType: 'text',
        handoffs: [],
        tracing: false,
        signal: undefined,
      };

      const firstResponsePromise = (model as any)._fetchResponse(
        {
          ...baseRequest,
          input: 'first',
        } as any,
        false,
      );
      await firstFrameWaitStarted;

      // Keep the first request on a short frame-read timeout while allowing the
      // queued request to wait long enough to proceed after the first fails.
      fakeClient.timeout = 1000;
      fakeClient._options.timeout = 1000;

      const secondResponsePromise = (model as any)._fetchResponse(
        {
          ...baseRequest,
          input: 'second',
        } as any,
        false,
      );
      void secondResponsePromise.catch(() => undefined);

      await expect(firstResponsePromise).rejects.toThrow(
        'Responses websocket frame read timed out after 25ms.',
      );
      await expect(secondResponsePromise).resolves.toMatchObject({
        id: 'resp_done_2',
      });
      expect(TestWebSocket.instances).toHaveLength(2);
      expect(TestWebSocket.instances[0]?.sent).toHaveLength(1);
      expect(TestWebSocket.instances[1]?.sent).toHaveLength(1);
    } finally {
      nextFrameSpy.mockRestore();
    }
  });

  it('bounds websocket requests by the total client timeout even while frames keep arriving', async () => {
    const fakeClient = createFakeClient() as any;
    fakeClient.timeout = 25;
    fakeClient._options = { ...(fakeClient._options ?? {}), timeout: 25 };
    let deltaInterval: ReturnType<typeof setInterval> | undefined;

    TestWebSocket.onCreate = (socket) => {
      let startedStreaming = false;
      let sequenceNumber = 1;
      socket.onSend(() => {
        if (startedStreaming) {
          return;
        }
        startedStreaming = true;

        socket.queueJSON({
          type: 'response.created',
          response: { id: 'resp_init' },
          sequence_number: 0,
        });

        deltaInterval = setInterval(() => {
          socket.queueJSON({
            type: 'response.output_text.delta',
            content_index: 0,
            delta: '.',
            item_id: 'item_1',
            logprobs: [],
            output_index: 0,
            sequence_number: sequenceNumber++,
          } as any);
        }, 5);
      });
      socket.addEventListener('close', () => {
        if (deltaInterval) {
          clearInterval(deltaInterval);
          deltaInterval = undefined;
        }
      });
    };

    const model = new OpenAIResponsesWSModel(fakeClient, 'gpt-ws');
    const request = {
      systemInstructions: undefined,
      input: 'ping',
      modelSettings: {},
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
      signal: undefined,
    };

    const responsePromise = (model as any)._fetchResponse(
      request as any,
      false,
    );
    const outcome = await Promise.race([
      responsePromise.then(
        (response: any) => ({ kind: 'resolved' as const, response }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      ),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        setTimeout(() => resolve({ kind: 'timeout' }), 150);
      }),
    ]);

    try {
      expect(outcome.kind).toBe('rejected');
      if (outcome.kind === 'rejected') {
        expect(outcome.error).toBeInstanceOf(Error);
        expect((outcome.error as Error).message).toContain(
          'Responses websocket frame read timed out after 25ms.',
        );
      }
    } finally {
      if (deltaInterval) {
        clearInterval(deltaInterval);
      }
      await model.close();
    }
  });

  it('applies the client timeout while waiting for queued websocket requests', async () => {
    const fakeClient = createFakeClient() as any;
    fakeClient.timeout = 1000;
    fakeClient._options = { ...(fakeClient._options ?? {}), timeout: 1000 };
    let sendCount = 0;
    let resolveFirstSend!: () => void;
    let resolveFirstRequest!: () => void;
    const firstSendSeen = new Promise<void>((resolve) => {
      resolveFirstSend = resolve;
    });
    const firstRequestReleased = new Promise<void>((resolve) => {
      resolveFirstRequest = resolve;
    });

    TestWebSocket.onCreate = (socket) => {
      socket.onSend(() => {
        sendCount += 1;
        if (sendCount === 1) {
          resolveFirstSend();
          socket.queueJSON({
            type: 'response.created',
            response: { id: 'resp_init_1' },
            sequence_number: 0,
          });
          void firstRequestReleased.then(() => {
            socket.queueJSON({
              type: 'response.completed',
              response: {
                id: 'resp_done_1',
                output: [],
                usage: {},
              },
              sequence_number: 1,
            });
          });
          return;
        }

        socket.queueJSON({
          type: 'response.created',
          response: { id: `resp_init_${sendCount}` },
          sequence_number: 0,
        });
        socket.queueJSON({
          type: 'response.completed',
          response: {
            id: `resp_done_${sendCount}`,
            output: [],
            usage: {},
          },
          sequence_number: 1,
        });
      });
    };

    const model = new OpenAIResponsesWSModel(fakeClient, 'gpt-ws');
    const baseRequest = {
      systemInstructions: undefined,
      input: 'ping',
      modelSettings: {},
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
      signal: undefined,
    };

    const firstResponsePromise = (model as any)._fetchResponse(
      {
        ...baseRequest,
        input: 'first',
      } as any,
      false,
    );
    await firstSendSeen;

    fakeClient.timeout = 25;
    fakeClient._options.timeout = 25;

    const queuedResponsePromise = (model as any)._fetchResponse(
      {
        ...baseRequest,
        input: 'queued',
      } as any,
      false,
    );
    void queuedResponsePromise.catch(() => undefined);

    const queuedOutcome = await Promise.race([
      queuedResponsePromise.then(
        () => ({ kind: 'resolved' as const }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      ),
      new Promise<{ kind: 'timeout' }>((resolve) => {
        setTimeout(() => resolve({ kind: 'timeout' }), 200);
      }),
    ]);

    try {
      expect(queuedOutcome.kind).toBe('rejected');
      expect((queuedOutcome as any).error).toBeInstanceOf(Error);
      expect(((queuedOutcome as any).error as Error).message).toContain(
        'Responses websocket request queue wait timed out after 25ms.',
      );
      expect(sendCount).toBe(1);
      expect(TestWebSocket.instances).toHaveLength(1);
      expect(TestWebSocket.instances[0]?.sent).toHaveLength(1);
    } finally {
      resolveFirstRequest();
    }

    await expect(firstResponsePromise).resolves.toMatchObject({
      id: 'resp_done_1',
    });
    await expect(queuedResponsePromise).rejects.toThrow(
      'Responses websocket request queue wait timed out after 25ms.',
    );
  });

  it('does not send an already-aborted queued websocket request', async () => {
    const fakeClient = createFakeClient();
    let sendCount = 0;
    let resolveFirstRequest!: () => void;
    let resolveFirstSend!: () => void;

    const firstRequestReleased = new Promise<void>((resolve) => {
      resolveFirstRequest = resolve;
    });
    const firstSendSeen = new Promise<void>((resolve) => {
      resolveFirstSend = resolve;
    });

    TestWebSocket.onCreate = (socket) => {
      socket.onSend(() => {
        sendCount += 1;
        if (sendCount === 1) {
          resolveFirstSend();
          socket.queueJSON({
            type: 'response.created',
            response: { id: 'resp_init_1' },
            sequence_number: 0,
          });
          void firstRequestReleased.then(() => {
            socket.queueJSON({
              type: 'response.completed',
              response: {
                id: 'resp_done_1',
                output: [],
                usage: {},
              },
              sequence_number: 1,
            });
          });
        }
      });
    };

    const model = new OpenAIResponsesWSModel(fakeClient, 'gpt-ws');
    const baseRequest = {
      systemInstructions: undefined,
      input: 'ping',
      modelSettings: {},
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
    };

    const firstResponsePromise = (model as any)._fetchResponse(
      {
        ...baseRequest,
        signal: undefined,
      } as any,
      false,
    );
    await firstSendSeen;

    const abortController = new AbortController();
    const queuedAbortedResponsePromise = (model as any)._fetchResponse(
      {
        ...baseRequest,
        input: 'queued',
        signal: abortController.signal,
      } as any,
      false,
    );
    abortController.abort();

    const queuedAbortOutcome = await Promise.race([
      queuedAbortedResponsePromise.then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      ),
      new Promise<'timeout'>((resolve) => {
        setTimeout(() => resolve('timeout'), 50);
      }),
    ]);
    try {
      expect(queuedAbortOutcome).toBe('rejected');
    } finally {
      resolveFirstRequest();
    }

    await expect(firstResponsePromise).resolves.toMatchObject({
      id: 'resp_done_1',
    });
    await expect(queuedAbortedResponsePromise).rejects.toThrow();
    expect(TestWebSocket.instances).toHaveLength(1);
    expect(TestWebSocket.instances[0]?.sent).toHaveLength(1);
  });

  it('does not emit unhandled rejection when aborted between websocket events', async () => {
    const fakeClient = createFakeClient();

    TestWebSocket.onCreate = (socket) => {
      socket.onSend(() => {
        socket.queueJSON({
          type: 'response.created',
          response: { id: 'resp_init_1' },
          sequence_number: 0,
        });
      });
    };

    const model = new OpenAIResponsesWSModel(fakeClient, 'gpt-ws');
    const abortController = new AbortController();
    const request = {
      systemInstructions: undefined,
      input: 'ping',
      modelSettings: {},
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
      signal: abortController.signal,
    };

    const rawStream = (await (model as any)._fetchResponse(
      request as any,
      true,
    )) as AsyncIterable<OpenAIResponseStreamEvent>;
    const iterator = rawStream[Symbol.asyncIterator]();
    const rejections: unknown[] = [];
    const handler = (error: unknown) => {
      rejections.push(error);
    };
    process.on('unhandledRejection', handler);

    try {
      const first = await iterator.next();
      expect(first.done).toBe(false);
      expect((first.value as any).type).toBe('response.created');

      abortController.abort();

      await expect(iterator.next()).rejects.toThrow();

      // Give socket cleanup a tick to surface any orphaned waiter rejection.
      await new Promise((resolve) => setImmediate(resolve));
      expect(rejections).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', handler);
      await iterator.return?.();
    }
  });

  it('refreshes auth only after a queued websocket request acquires the request lock', async () => {
    const fakeClient = createFakeClient();
    let sendCount = 0;
    let resolveFirstRequest!: () => void;
    let resolveFirstSend!: () => void;

    fakeClient._callApiKey.mockImplementation(async () => {
      const callIndex = fakeClient._callApiKey.mock.calls.length;
      (fakeClient as any).apiKey = `sk-dynamic-${callIndex}`;
      return true;
    });

    const firstRequestReleased = new Promise<void>((resolve) => {
      resolveFirstRequest = resolve;
    });
    const firstSendSeen = new Promise<void>((resolve) => {
      resolveFirstSend = resolve;
    });

    TestWebSocket.onCreate = (socket) => {
      socket.onSend(() => {
        sendCount += 1;
        if (sendCount === 1) {
          resolveFirstSend();
          socket.queueJSON({
            type: 'response.created',
            response: { id: 'resp_init_1' },
            sequence_number: 0,
          });
          void firstRequestReleased.then(() => {
            socket.queueJSON({
              type: 'response.completed',
              response: {
                id: 'resp_done_1',
                output: [],
                usage: {},
              },
              sequence_number: 1,
            });
          });
          return;
        }

        socket.queueJSON({
          type: 'response.created',
          response: { id: 'resp_init_2' },
          sequence_number: 0,
        });
        socket.queueJSON({
          type: 'response.completed',
          response: {
            id: 'resp_done_2',
            output: [],
            usage: {},
          },
          sequence_number: 1,
        });
      });
    };

    const model = new OpenAIResponsesWSModel(fakeClient, 'gpt-ws');
    const baseRequest = {
      systemInstructions: undefined,
      input: 'ping',
      modelSettings: {},
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
      signal: undefined,
    };

    const firstResponsePromise = (model as any)._fetchResponse(
      baseRequest as any,
      false,
    );
    await firstSendSeen;
    expect(fakeClient._callApiKey).toHaveBeenCalledTimes(1);

    const queuedResponsePromise = (model as any)._fetchResponse(
      {
        ...baseRequest,
        input: 'queued',
      } as any,
      false,
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(fakeClient._callApiKey).toHaveBeenCalledTimes(1);

    resolveFirstRequest();

    await expect(firstResponsePromise).resolves.toMatchObject({
      id: 'resp_done_1',
    });
    await expect(queuedResponsePromise).resolves.toMatchObject({
      id: 'resp_done_2',
    });
    expect(fakeClient._callApiKey).toHaveBeenCalledTimes(2);
  });

  it('drops the websocket connection when a stream is ended early', async () => {
    const fakeClient = createFakeClient();
    let socketCreateCount = 0;

    TestWebSocket.onCreate = (socket) => {
      const socketId = ++socketCreateCount;
      socket.onSend(() => {
        if (socketId === 1) {
          socket.queueJSON({
            type: 'response.created',
            response: { id: 'resp_init_1' },
            sequence_number: 0,
          });
          socket.queueJSON({
            type: 'response.output_text.delta',
            delta: 'partial',
            content_index: 0,
            item_id: 'item_1',
            logprobs: [],
            output_index: 0,
            sequence_number: 1,
          });
          socket.queueJSON({
            type: 'response.completed',
            response: {
              id: 'resp_done_1',
              output: [],
              usage: {},
            },
            sequence_number: 2,
          });
          return;
        }

        socket.queueJSON({
          type: 'response.created',
          response: { id: 'resp_init_2' },
          sequence_number: 0,
        });
        socket.queueJSON({
          type: 'response.completed',
          response: {
            id: 'resp_done_2',
            output: [],
            usage: {},
          },
          sequence_number: 1,
        });
      });
    };

    const model = new OpenAIResponsesWSModel(fakeClient, 'gpt-ws');
    const request = {
      systemInstructions: undefined,
      input: 'ping',
      modelSettings: {},
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
      signal: undefined,
    };

    for await (const _event of model.getStreamedResponse(request as any)) {
      break;
    }

    expect(TestWebSocket.instances[0]?.readyState).toBe(TestWebSocket.CLOSED);

    let secondResponseId = '';
    for await (const event of model.getStreamedResponse(request as any)) {
      if (event.type === 'response_done') {
        secondResponseId = event.response.id;
      }
    }

    expect(secondResponseId).toBe('resp_done_2');
    expect(TestWebSocket.instances).toHaveLength(2);
  });

  it('validates extra_query transport overrides', async () => {
    const fakeClient = createFakeClient();
    const model = new OpenAIResponsesWSModel(fakeClient, 'gpt-ws');

    const request = {
      systemInstructions: undefined,
      input: 'ping',
      modelSettings: {
        providerData: {
          extra_query: 'not-a-mapping',
        },
      },
      tools: [],
      outputType: 'text',
      handoffs: [],
      tracing: false,
      signal: undefined,
    };

    const consumeStream = async () => {
      for await (const _event of model.getStreamedResponse(request as any)) {
        // No-op.
      }
    };

    await expect(consumeStream()).rejects.toThrow(
      'Responses websocket extra query must be a mapping.',
    );
    expect(TestWebSocket.instances).toHaveLength(0);
  });
});
