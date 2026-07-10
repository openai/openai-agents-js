import { beforeAll, describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import {
  setTracingDisabled,
  UserError,
  withTrace,
  type ResponseStreamEvent,
} from '@openai/agents-core';
import { OpenAIResponsesModel } from '../../src/openaiResponsesModel';
import {
  OpenAIHostedMultiAgentModel,
  getHostedAgentMetadata,
} from '../../src/experimental/hostedMultiAgent';

function request(overrides: Record<string, unknown> = {}) {
  return {
    systemInstructions: 'Use hosted subagents when useful.',
    input: 'Compare alpha and beta.',
    modelSettings: {},
    tools: [],
    outputType: 'text',
    handoffs: [],
    tracing: false,
    signal: undefined,
    ...overrides,
  } as any;
}

function emptyResponse(id = 'resp_empty') {
  return {
    id,
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    output: [],
  };
}

function message(message: Record<string, any>) {
  return { type: 'message', message };
}

const STALLED_WEBSOCKET_EVENT = Symbol('stalled-websocket-event');
type FakeWebSocketEvent =
  Record<string, any> | Error | typeof STALLED_WEBSOCKET_EVENT;

class FakeResponsesWebSocket {
  readonly sent: Array<Record<string, any>> = [];
  readonly socket = { readyState: 1 };
  readonly close = vi.fn(() => {
    this.socket.readyState = 3;
  });
  #events: Array<FakeWebSocketEvent>;

  constructor(events: Array<FakeWebSocketEvent>) {
    this.#events = events.map((event) =>
      event instanceof Error || event === STALLED_WEBSOCKET_EVENT
        ? event
        : message(event),
    );
  }

  send(event: Record<string, any>) {
    this.sent.push(event);
  }

  closeFromServer() {
    this.socket.readyState = 3;
    this.#events.push({
      type: 'close',
      code: 1001,
      reason: 'Idle timeout.',
    });
  }

  queueTransportEvent(event: Record<string, any>) {
    this.#events.push(event);
  }

  [Symbol.asyncIterator](): AsyncIterator<Record<string, any>> {
    return {
      next: async () => {
        const value = this.#events.shift();
        if (value instanceof Error) {
          throw value;
        }
        if (value === STALLED_WEBSOCKET_EVENT) {
          return await new Promise<IteratorResult<Record<string, any>>>(
            () => {},
          );
        }
        return value
          ? { value, done: false as const }
          : { value: undefined, done: true as const };
      },
    };
  }
}

class TestHostedMultiAgentModel extends OpenAIHostedMultiAgentModel {
  readonly webSocketCreationOptions: Array<{
    client: OpenAI;
    headers: Record<string, string>;
  }> = [];

  constructor(
    private readonly fakeWebSocket:
      FakeResponsesWebSocket | Array<FakeResponsesWebSocket>,
    config?: { maxConcurrentSubagents?: number },
    client: OpenAI = new OpenAI({ apiKey: 'test-key' }),
  ) {
    super(client, 'gpt-5.6-sol', config);
  }

  protected override _createResponsesWebSocket(options: {
    client: OpenAI;
    headers: Record<string, string>;
  }): any {
    this.webSocketCreationOptions.push(options);
    if (!Array.isArray(this.fakeWebSocket)) {
      return this.fakeWebSocket;
    }
    const fakeWebSocket =
      this.fakeWebSocket[this.webSocketCreationOptions.length - 1];
    if (!fakeWebSocket) {
      throw new Error('No fake WebSocket is available for this connection.');
    }
    return fakeWebSocket;
  }
}

function withTestTrace<T>(fn: () => Promise<T>): Promise<T> {
  return withTrace('hosted-multi-agent-test', fn);
}

async function getTestResponse(
  model: TestHostedMultiAgentModel,
  modelRequest: ReturnType<typeof request>,
  stream: boolean,
): Promise<any> {
  if (!stream) {
    return withTestTrace(() => model.getResponse(modelRequest));
  }

  let completedResponse: any;
  await withTestTrace(async () => {
    for await (const event of model.getStreamedResponse(modelRequest)) {
      if (event.type === 'response_done') {
        completedResponse = event.response;
      }
    }
  });
  if (!completedResponse) {
    throw new Error('Stream ended without a completed response.');
  }
  return completedResponse;
}

describe('OpenAIHostedMultiAgentModel', () => {
  beforeAll(() => {
    setTracingDisabled(true);
  });

  it('uses response.create over WebSocket with the hosted configuration', async () => {
    const fakeWebSocket = new FakeResponsesWebSocket([
      { type: 'response.created', response: emptyResponse('resp_ws') },
      { type: 'response.completed', response: emptyResponse('resp_ws') },
    ]);
    const model = new TestHostedMultiAgentModel(fakeWebSocket, {
      maxConcurrentSubagents: 2,
    });

    await withTestTrace(() => model.getResponse(request()));

    expect(fakeWebSocket.sent).toHaveLength(1);
    expect(fakeWebSocket.sent[0]).toMatchObject({
      type: 'response.create',
      model: 'gpt-5.6-sol',
      multi_agent: {
        enabled: true,
        max_concurrent_subagents: 2,
      },
    });
    expect(fakeWebSocket.sent[0]).not.toHaveProperty('betas');
    expect(fakeWebSocket.sent[0]).not.toHaveProperty('stream');
  });

  it('omits max_concurrent_subagents to preserve the service default', async () => {
    const fakeWebSocket = new FakeResponsesWebSocket([
      { type: 'response.created', response: emptyResponse() },
      { type: 'response.completed', response: emptyResponse() },
    ]);

    await withTestTrace(() =>
      new TestHostedMultiAgentModel(fakeWebSocket).getResponse(request()),
    );

    expect(fakeWebSocket.sent[0]?.multi_agent).toEqual({ enabled: true });
  });

  it('recreates an idle WebSocket after the server closes it', async () => {
    const firstWebSocket = new FakeResponsesWebSocket([
      { type: 'response.created', response: emptyResponse('resp_first') },
      { type: 'response.completed', response: emptyResponse('resp_first') },
    ]);
    const secondWebSocket = new FakeResponsesWebSocket([
      { type: 'response.created', response: emptyResponse('resp_second') },
      { type: 'response.completed', response: emptyResponse('resp_second') },
    ]);
    const model = new TestHostedMultiAgentModel([
      firstWebSocket,
      secondWebSocket,
    ]);

    await withTestTrace(() => model.getResponse(request()));
    firstWebSocket.closeFromServer();
    const secondResponse = await withTestTrace(() =>
      model.getResponse(request({ input: 'Run another hosted response.' })),
    );

    expect(model.webSocketCreationOptions).toHaveLength(2);
    expect(firstWebSocket.close).toHaveBeenCalledOnce();
    expect(firstWebSocket.sent).toHaveLength(1);
    expect(secondWebSocket.sent).toHaveLength(1);
    expect(secondResponse.responseId).toBe('resp_second');
  });

  it('closes a hosted turn when the streaming consumer stops early', async () => {
    const firstWebSocket = new FakeResponsesWebSocket([
      { type: 'response.created', response: emptyResponse('resp_abandoned') },
      {
        type: 'response.completed',
        response: emptyResponse('resp_abandoned'),
      },
    ]);
    const secondWebSocket = new FakeResponsesWebSocket([
      { type: 'response.created', response: emptyResponse('resp_next') },
      { type: 'response.completed', response: emptyResponse('resp_next') },
    ]);
    const model = new TestHostedMultiAgentModel([
      firstWebSocket,
      secondWebSocket,
    ]);

    await withTestTrace(async () => {
      for await (const _event of model.getStreamedResponse(request())) {
        break;
      }
    });
    const nextResponse = await withTestTrace(() =>
      model.getResponse(request({ input: 'Start a clean hosted turn.' })),
    );

    expect(firstWebSocket.close).toHaveBeenCalledOnce();
    expect(model.webSocketCreationOptions).toHaveLength(2);
    expect(secondWebSocket.sent[0]?.type).toBe('response.create');
    expect(nextResponse.responseId).toBe('resp_next');
  });

  it('reconnects before injecting into a closed active hosted response', async () => {
    const functionCall = {
      type: 'function_call',
      id: 'fc_reconnect',
      call_id: 'call_reconnect',
      name: 'lookup',
      arguments: '{}',
      status: 'completed',
      agent: { agent_name: '/root/researcher' },
    };
    const rootFinal = {
      type: 'message',
      id: 'msg_reconnect_final',
      role: 'assistant',
      status: 'completed',
      phase: 'final_answer',
      agent: { agent_name: '/root' },
      content: [{ type: 'output_text', text: 'Reconnected.' }],
    };
    const firstWebSocket = new FakeResponsesWebSocket([
      { type: 'response.created', response: emptyResponse('resp_reconnect') },
      { type: 'response.output_item.done', item: functionCall },
    ]);
    const secondWebSocket = new FakeResponsesWebSocket([
      { type: 'response.inject.created', response_id: 'resp_reconnect' },
      {
        type: 'response.completed',
        response: {
          ...emptyResponse('resp_reconnect'),
          output: [functionCall, rootFinal],
        },
      },
    ]);
    const model = new TestHostedMultiAgentModel(
      [firstWebSocket, secondWebSocket],
      undefined,
      new OpenAI({
        apiKey: vi
          .fn()
          .mockResolvedValueOnce('initial-key')
          .mockRejectedValueOnce(new Error('Reconnect auth failed.'))
          .mockResolvedValue('retry-key'),
      }),
    );

    const boundary = await withTestTrace(() => model.getResponse(request()));
    firstWebSocket.closeFromServer();
    const resumeRequest = request({
      input: [
        ...boundary.output,
        {
          type: 'function_call_result',
          callId: 'call_reconnect',
          output: 'lookup result',
          status: 'completed',
        },
      ],
    });

    await expect(
      withTestTrace(() => model.getResponse(resumeRequest)),
    ).rejects.toThrow('Reconnect auth failed.');
    expect(model.webSocketCreationOptions).toHaveLength(1);

    const response = await withTestTrace(() =>
      model.getResponse(resumeRequest),
    );

    expect(model.webSocketCreationOptions).toHaveLength(2);
    expect(firstWebSocket.close).toHaveBeenCalledOnce();
    expect(secondWebSocket.sent[0]).toMatchObject({
      type: 'response.inject',
      response_id: 'resp_reconnect',
      input: [
        expect.objectContaining({
          type: 'function_call_output',
          call_id: 'call_reconnect',
          output: 'lookup result',
        }),
      ],
    });
    expect(response.output[0]?.type).toBe('message');
  });

  it('rejects a header unset when reconnecting an active response', async () => {
    const functionCall = {
      type: 'function_call',
      id: 'fc_transport_unset',
      call_id: 'call_transport_unset',
      name: 'lookup',
      arguments: '{}',
      status: 'completed',
      agent: { agent_name: '/root/researcher' },
    };
    const firstWebSocket = new FakeResponsesWebSocket([
      {
        type: 'response.created',
        response: emptyResponse('resp_transport_unset'),
      },
      { type: 'response.output_item.done', item: functionCall },
    ]);
    const secondWebSocket = new FakeResponsesWebSocket([
      {
        type: 'response.inject.created',
        response_id: 'resp_transport_unset',
      },
      {
        type: 'response.completed',
        response: emptyResponse('resp_transport_unset'),
      },
    ]);
    const model = new TestHostedMultiAgentModel([
      firstWebSocket,
      secondWebSocket,
    ]);
    const boundary = await withTestTrace(() => model.getResponse(request()));
    firstWebSocket.closeFromServer();
    const resumeInput = [
      ...boundary.output,
      {
        type: 'function_call_result',
        callId: 'call_transport_unset',
        output: 'lookup result',
        status: 'completed',
      },
    ];

    await expect(
      withTestTrace(() =>
        model.getResponse(
          request({
            input: resumeInput,
            modelSettings: {
              providerData: {
                extraHeaders: { Authorization: null },
              },
            },
          }),
        ),
      ),
    ).rejects.toThrow(
      'An active hosted response must be resumed with the same WebSocket transport headers and query.',
    );
    expect(model.webSocketCreationOptions).toHaveLength(1);
    expect(secondWebSocket.sent).toHaveLength(0);

    await withTestTrace(() =>
      model.getResponse(request({ input: resumeInput })),
    );
    expect(model.webSocketCreationOptions).toHaveLength(2);
    expect(secondWebSocket.sent[0]).toMatchObject({
      type: 'response.inject',
      response_id: 'resp_transport_unset',
    });
  });

  it.each([false, true])(
    'applies the client timeout while waiting for hosted WebSocket events (stream: %s)',
    async (stream) => {
      const fakeWebSocket = new FakeResponsesWebSocket([
        STALLED_WEBSOCKET_EVENT,
      ]);
      const model = new TestHostedMultiAgentModel(
        fakeWebSocket,
        undefined,
        new OpenAI({ apiKey: 'test-key', timeout: 25 }),
      );

      await expect(getTestResponse(model, request(), stream)).rejects.toThrow(
        'Hosted Multi-agent WebSocket frame read timed out after 25ms.',
      );
      expect(fakeWebSocket.close).toHaveBeenCalledOnce();
    },
  );

  it('preserves client and request WebSocket transport configuration', async () => {
    const fakeWebSocket = new FakeResponsesWebSocket([
      { type: 'response.created', response: emptyResponse() },
      { type: 'response.completed', response: emptyResponse() },
    ]);
    const client = new OpenAI({
      apiKey: 'transport-key',
      organization: 'org_test',
      project: 'proj_test',
      defaultHeaders: { 'X-Default': 'default-value' },
      defaultQuery: { api_version: 'base-version' },
    });
    const model = new TestHostedMultiAgentModel(
      fakeWebSocket,
      undefined,
      client,
    );

    await withTestTrace(() =>
      model.getResponse(
        request({
          modelSettings: {
            providerData: {
              extraHeaders: {
                'OpenAI-Beta': 'wrong-beta',
                'X-Request': 'request-value',
              },
              extraQuery: { region: 'test-region' },
            },
          },
        }),
      ),
    );

    const creationOptions = model.webSocketCreationOptions[0];
    expect(creationOptions?.headers).toMatchObject({
      'OpenAI-Beta': 'responses_multi_agent=v1',
      'OpenAI-Organization': 'org_test',
      'OpenAI-Project': 'proj_test',
      'X-Default': 'default-value',
      'X-Request': 'request-value',
    });
    expect(new Headers(creationOptions?.headers).get('authorization')).toBe(
      'Bearer transport-key',
    );
    const websocketURL = new URL(
      creationOptions!.client.buildURL('/responses', {}, undefined),
    );
    expect(websocketURL.searchParams.get('api_version')).toBe('base-version');
    expect(websocketURL.searchParams.get('region')).toBe('test-region');
  });

  it('refreshes async API keys before creating the WebSocket', async () => {
    const fakeWebSocket = new FakeResponsesWebSocket([
      { type: 'response.created', response: emptyResponse() },
      { type: 'response.completed', response: emptyResponse() },
    ]);
    const apiKey = vi.fn().mockResolvedValue('dynamic-key');
    const model = new TestHostedMultiAgentModel(
      fakeWebSocket,
      undefined,
      new OpenAI({ apiKey }),
    );

    await withTestTrace(() => model.getResponse(request()));

    expect(apiKey).toHaveBeenCalledTimes(1);
    expect(
      new Headers(model.webSocketCreationOptions[0]?.headers).get(
        'authorization',
      ),
    ).toBe('Bearer dynamic-key');
  });

  it('aborts while an async API key is being resolved', async () => {
    const fakeWebSocket = new FakeResponsesWebSocket([]);
    let markApiKeyStarted!: () => void;
    const apiKeyStarted = new Promise<void>((resolve) => {
      markApiKeyStarted = resolve;
    });
    const apiKey = vi.fn(async () => {
      markApiKeyStarted();
      return await new Promise<string>(() => {});
    });
    const model = new TestHostedMultiAgentModel(
      fakeWebSocket,
      undefined,
      new OpenAI({ apiKey }),
    );
    const controller = new AbortController();

    const response = withTestTrace(() =>
      model.getResponse(request({ signal: controller.signal })),
    );
    await apiKeyStarted;
    controller.abort();

    await expect(response).rejects.toBeInstanceOf(OpenAI.APIUserAbortError);
    expect(fakeWebSocket.sent).toHaveLength(0);
  });

  it.each([false, true])(
    'does not create or send on an already-aborted request (stream: %s)',
    async (stream) => {
      const fakeWebSocket = new FakeResponsesWebSocket([]);
      const model = new TestHostedMultiAgentModel(fakeWebSocket);
      const controller = new AbortController();
      controller.abort();

      await expect(
        getTestResponse(model, request({ signal: controller.signal }), stream),
      ).rejects.toBeInstanceOf(OpenAI.APIUserAbortError);

      expect(model.webSocketCreationOptions).toHaveLength(0);
      expect(fakeWebSocket.sent).toHaveLength(0);
    },
  );

  it('does not send after a cached socket aborts during reuse', async () => {
    const fakeWebSocket = new FakeResponsesWebSocket([
      { type: 'response.created', response: emptyResponse('resp_first') },
      { type: 'response.completed', response: emptyResponse('resp_first') },
    ]);
    const model = new TestHostedMultiAgentModel(fakeWebSocket);
    await withTestTrace(() => model.getResponse(request()));

    const controller = new AbortController();
    let readyState = fakeWebSocket.socket.readyState;
    Object.defineProperty(fakeWebSocket.socket, 'readyState', {
      configurable: true,
      get() {
        controller.abort();
        return readyState;
      },
      set(value: number) {
        readyState = value;
      },
    });

    await expect(
      withTestTrace(() =>
        model.getResponse(request({ signal: controller.signal })),
      ),
    ).rejects.toBeInstanceOf(OpenAI.APIUserAbortError);
    expect(fakeWebSocket.sent).toHaveLength(1);
  });

  it('preserves an active response when an aborted resume sends no injection', async () => {
    const functionCall = {
      type: 'function_call',
      id: 'fc_abort_resume',
      call_id: 'call_abort_resume',
      name: 'lookup',
      arguments: '{}',
      status: 'completed',
      agent: { agent_name: '/root/researcher' },
    };
    const fakeWebSocket = new FakeResponsesWebSocket([
      {
        type: 'response.created',
        response: emptyResponse('resp_abort_resume'),
      },
      { type: 'response.output_item.done', item: functionCall },
      {
        type: 'response.inject.created',
        response_id: 'resp_abort_resume',
      },
      {
        type: 'response.completed',
        response: emptyResponse('resp_abort_resume'),
      },
    ]);
    const model = new TestHostedMultiAgentModel(fakeWebSocket);
    const first = await withTestTrace(() => model.getResponse(request()));
    const resumeRequest = request({
      input: [
        ...first.output,
        {
          type: 'function_call_result',
          callId: 'call_abort_resume',
          output: 'result',
          status: 'completed',
        },
      ],
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      withTestTrace(() =>
        model.getResponse({ ...resumeRequest, signal: controller.signal }),
      ),
    ).rejects.toBeInstanceOf(OpenAI.APIUserAbortError);
    expect(fakeWebSocket.sent).toHaveLength(1);

    await withTestTrace(() => model.getResponse(resumeRequest));
    expect(fakeWebSocket.sent[1]).toMatchObject({
      type: 'response.inject',
      response_id: 'resp_abort_resume',
    });
  });

  it.each([false, true])(
    'applies the client timeout while preparing hosted WebSocket auth (stream: %s)',
    async (stream) => {
      const fakeWebSocket = new FakeResponsesWebSocket([]);
      const apiKey = vi.fn(async () => {
        return await new Promise<string>(() => {});
      });
      const model = new TestHostedMultiAgentModel(
        fakeWebSocket,
        undefined,
        new OpenAI({ apiKey, timeout: 25 }),
      );

      await expect(getTestResponse(model, request(), stream)).rejects.toThrow(
        'Hosted Multi-agent WebSocket auth header preparation timed out after 25ms.',
      );
      expect(fakeWebSocket.sent).toHaveLength(0);
      expect(model.webSocketCreationOptions).toHaveLength(0);
    },
  );

  it('preserves an explicit Authorization header unset', async () => {
    const fakeWebSocket = new FakeResponsesWebSocket([
      { type: 'response.created', response: emptyResponse() },
      { type: 'response.completed', response: emptyResponse() },
    ]);
    const model = new TestHostedMultiAgentModel(fakeWebSocket);

    await withTestTrace(() =>
      model.getResponse(
        request({
          modelSettings: {
            providerData: {
              extraHeaders: { Authorization: null },
            },
          },
        }),
      ),
    );

    const creationOptions = model.webSocketCreationOptions[0];
    expect(new Headers(creationOptions?.headers).has('authorization')).toBe(
      false,
    );
    expect(creationOptions?.client.apiKey).toBeNull();
  });

  it.each([0, -1, 1.5])(
    'rejects invalid maxConcurrentSubagents value %s',
    (maxConcurrentSubagents) => {
      expect(
        () =>
          new TestHostedMultiAgentModel(new FakeResponsesWebSocket([]), {
            maxConcurrentSubagents,
          }),
      ).toThrow(UserError);
    },
  );

  it('returns a local function call boundary and injects its output into the active response', async () => {
    const hostedCall = {
      type: 'multi_agent_call',
      id: 'mac_1',
      call_id: 'call_spawn',
      action: 'spawn_agent',
      arguments: '{}',
      agent: { agent_name: '/root' },
    };
    const functionCall = {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_lookup',
      name: 'lookup',
      arguments: '{"key":"alpha"}',
      status: 'completed',
      agent: { agent_name: '/root/researcher' },
    };
    const rootFinal = {
      type: 'message',
      id: 'msg_root_final',
      role: 'assistant',
      status: 'completed',
      phase: 'final_answer',
      agent: { agent_name: '/root' },
      content: [{ type: 'output_text', text: 'Final answer.' }],
    };
    const fakeWebSocket = new FakeResponsesWebSocket([
      { type: 'response.created', response: emptyResponse('resp_active') },
      { type: 'response.output_item.done', item: hostedCall },
      { type: 'response.output_item.done', item: functionCall },
      {
        type: 'response.inject.created',
        response_id: 'resp_active',
        sequence_number: 1,
      },
      {
        type: 'response.completed',
        response: {
          ...emptyResponse('resp_active'),
          output: [hostedCall, functionCall, rootFinal],
        },
      },
    ]);
    const model = new TestHostedMultiAgentModel(fakeWebSocket);

    const first = await withTestTrace(() => model.getResponse(request()));

    expect(first.output.map((item) => item.type)).toEqual(['function_call']);
    expect(first.output[0]?.providerData?.agent).toEqual({
      agent_name: '/root/researcher',
    });

    await expect(
      withTestTrace(() =>
        model.getResponse(request({ input: [...first.output] })),
      ),
    ).rejects.toThrow(
      'The hosted response is waiting for local function outputs for: call_lookup.',
    );
    expect(fakeWebSocket.sent).toHaveLength(1);
    expect(fakeWebSocket.close).not.toHaveBeenCalled();

    const second = await withTestTrace(() =>
      model.getResponse(
        request({
          input: [
            ...first.output,
            {
              type: 'function_call_result',
              callId: 'call_lookup',
              output: 'lookup result',
              status: 'completed',
            },
          ],
        }),
      ),
    );

    expect(fakeWebSocket.sent[1]).toEqual({
      type: 'response.inject',
      response_id: 'resp_active',
      input: [
        expect.objectContaining({
          type: 'function_call_output',
          call_id: 'call_lookup',
          output: 'lookup result',
        }),
      ],
    });
    expect(second.output).toHaveLength(1);
    expect(second.output[0]?.type).toBe('message');
    expect(second.output[0]?.providerData).toMatchObject({
      phase: 'final_answer',
      agent: { agent_name: '/root' },
    });
    expect(second.providerData?.output).toEqual([
      hostedCall,
      functionCall,
      rootFinal,
    ]);
  });

  it('preserves local function calls in raw streamed terminal events', async () => {
    const functionCall = {
      type: 'function_call',
      id: 'fc_raw_terminal',
      call_id: 'call_raw_terminal',
      name: 'lookup',
      arguments: '{"key":"alpha"}',
      status: 'completed',
      agent: { agent_name: '/root/researcher' },
    };
    const rootFinal = {
      type: 'message',
      id: 'msg_raw_terminal',
      role: 'assistant',
      status: 'completed',
      phase: 'final_answer',
      agent: { agent_name: '/root' },
      content: [{ type: 'output_text', text: 'Final answer.' }],
    };
    const terminalResponse = {
      ...emptyResponse('resp_raw_terminal'),
      output: [functionCall, rootFinal],
    };
    const fakeWebSocket = new FakeResponsesWebSocket([
      {
        type: 'response.created',
        response: emptyResponse('resp_raw_terminal'),
      },
      { type: 'response.output_item.done', item: functionCall },
      {
        type: 'response.inject.created',
        response_id: 'resp_raw_terminal',
      },
      { type: 'response.completed', response: terminalResponse },
    ]);
    const model = new TestHostedMultiAgentModel(fakeWebSocket);

    const boundary = await getTestResponse(model, request(), true);
    expect(boundary.output.map((item: any) => item.type)).toEqual([
      'function_call',
    ]);

    const streamEvents: ResponseStreamEvent[] = [];
    await withTestTrace(async () => {
      for await (const event of model.getStreamedResponse(
        request({
          input: [
            ...boundary.output,
            {
              type: 'function_call_result',
              callId: 'call_raw_terminal',
              output: 'lookup result',
              status: 'completed',
            },
          ],
        }),
      )) {
        streamEvents.push(event);
      }
    });

    const done = streamEvents.find((event) => event.type === 'response_done');
    if (done?.type !== 'response_done') {
      throw new Error('Stream ended without a response_done event.');
    }
    expect(done.response.output.map((item) => item.type)).toEqual(['message']);
    const rawTerminalEvent = streamEvents.find(
      (event) =>
        event.type === 'model' &&
        (event.event as any).type === 'response.completed' &&
        (event.event as any).response?.id === 'resp_raw_terminal',
    );
    if (rawTerminalEvent?.type !== 'model') {
      throw new Error('Stream ended without a raw terminal model event.');
    }
    expect((rawTerminalEvent.event as any).response.output).toEqual([
      functionCall,
      rootFinal,
    ]);
    expect(terminalResponse.output).toEqual([functionCall, rootFinal]);
  });

  it.each([false, true])(
    'does not count a synthetic local tool boundary as an API request (stream: %s)',
    async (stream) => {
      const functionCall = {
        type: 'function_call',
        id: 'fc_usage',
        call_id: 'call_usage',
        name: 'lookup',
        arguments: '{}',
        status: 'completed',
        agent: { agent_name: '/root/researcher' },
      };
      const fakeWebSocket = new FakeResponsesWebSocket([
        { type: 'response.created', response: emptyResponse('resp_usage') },
        { type: 'response.output_item.done', item: functionCall },
      ]);
      const model = new TestHostedMultiAgentModel(fakeWebSocket);

      const boundary = await getTestResponse(model, request(), stream);

      expect(boundary.usage).toMatchObject({
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      });
      expect(boundary.usage.requestUsageEntries).toBeUndefined();
    },
  );

  it('returns every function call received before an injection acknowledgement', async () => {
    const alphaCall = {
      type: 'function_call',
      id: 'fc_alpha',
      call_id: 'call_alpha',
      name: 'lookup',
      arguments: '{"key":"alpha"}',
      status: 'completed',
      agent: { agent_name: '/root/alpha' },
    };
    const betaCall = {
      type: 'function_call',
      id: 'fc_beta',
      call_id: 'call_beta',
      name: 'lookup',
      arguments: '{"key":"beta"}',
      status: 'completed',
      agent: { agent_name: '/root/beta' },
    };
    const gammaCall = {
      type: 'function_call',
      id: 'fc_gamma',
      call_id: 'call_gamma',
      name: 'lookup',
      arguments: '{"key":"gamma"}',
      status: 'completed',
      agent: { agent_name: '/root/gamma' },
    };
    const rootFinal = {
      type: 'message',
      id: 'msg_parallel_final',
      role: 'assistant',
      status: 'completed',
      phase: 'final_answer',
      agent: { agent_name: '/root' },
      content: [{ type: 'output_text', text: 'All calls completed.' }],
    };
    const fakeWebSocket = new FakeResponsesWebSocket([
      { type: 'response.created', response: emptyResponse('resp_parallel') },
      { type: 'response.output_item.done', item: alphaCall },
      { type: 'response.output_item.done', item: betaCall },
      { type: 'response.output_item.done', item: gammaCall },
      { type: 'response.inject.created', response_id: 'resp_parallel' },
      { type: 'response.inject.created', response_id: 'resp_parallel' },
      {
        type: 'response.completed',
        response: {
          ...emptyResponse('resp_parallel'),
          output: [alphaCall, betaCall, gammaCall, rootFinal],
        },
      },
    ]);
    const model = new TestHostedMultiAgentModel(fakeWebSocket);

    const first = await withTestTrace(() => model.getResponse(request()));
    expect(first.output.map((item) => (item as any).callId)).toEqual([
      'call_alpha',
    ]);

    const second = await withTestTrace(() =>
      model.getResponse(
        request({
          input: [
            ...first.output,
            {
              type: 'function_call_result',
              callId: 'call_alpha',
              output: 'alpha result',
              status: 'completed',
            },
          ],
        }),
      ),
    );
    expect(second.output.map((item) => (item as any).callId)).toEqual([
      'call_beta',
      'call_gamma',
    ]);

    await expect(
      withTestTrace(() =>
        model.getResponse(
          request({
            input: [
              ...second.output,
              {
                type: 'function_call_result',
                callId: 'call_beta',
                output: 'beta result',
                status: 'completed',
              },
            ],
          }),
        ),
      ),
    ).rejects.toThrow(
      'The hosted response is waiting for local function outputs for: call_gamma.',
    );
    expect(fakeWebSocket.sent).toHaveLength(2);
    expect(fakeWebSocket.close).not.toHaveBeenCalled();

    const third = await withTestTrace(() =>
      model.getResponse(
        request({
          input: [
            ...second.output,
            {
              type: 'function_call_result',
              callId: 'call_beta',
              output: 'beta result',
              status: 'completed',
            },
            {
              type: 'function_call_result',
              callId: 'call_gamma',
              output: 'gamma result',
              status: 'completed',
            },
          ],
        }),
      ),
    );

    expect(fakeWebSocket.sent[2]?.type).toBe('response.inject');
    expect(
      fakeWebSocket.sent[2]?.input.map(
        (item: Record<string, any>) => item.call_id,
      ),
    ).toEqual(['call_beta', 'call_gamma']);
    expect(third.output[0]?.type).toBe('message');
  });

  it('preserves failed injection input across another function call boundary', async () => {
    const alphaCall = {
      type: 'function_call',
      id: 'fc_failed_alpha',
      call_id: 'call_failed_alpha',
      name: 'lookup',
      arguments: '{"key":"alpha"}',
      status: 'completed',
      agent: { agent_name: '/root/alpha' },
    };
    const betaCall = {
      type: 'function_call',
      id: 'fc_failed_beta',
      call_id: 'call_failed_beta',
      name: 'lookup',
      arguments: '{"key":"beta"}',
      status: 'completed',
      agent: { agent_name: '/root/beta' },
    };
    const alphaOutput = {
      type: 'function_call_output',
      call_id: 'call_failed_alpha',
      output: 'alpha result',
    };
    const rootFinal = {
      type: 'message',
      id: 'msg_failed_parallel_final',
      role: 'assistant',
      status: 'completed',
      phase: 'final_answer',
      agent: { agent_name: '/root' },
      content: [{ type: 'output_text', text: 'Recovered all calls.' }],
    };
    const fakeWebSocket = new FakeResponsesWebSocket([
      {
        type: 'response.created',
        response: emptyResponse('resp_failed_parallel'),
      },
      { type: 'response.output_item.done', item: alphaCall },
      { type: 'response.output_item.done', item: betaCall },
      {
        type: 'response.completed',
        response: emptyResponse('resp_failed_parallel'),
      },
      {
        type: 'response.inject.failed',
        response_id: 'resp_failed_parallel',
        input: [alphaOutput],
        error: {
          code: 'response_already_completed',
          message: 'Already completed.',
        },
      },
      {
        type: 'response.created',
        response: emptyResponse('resp_failed_continuation'),
      },
      {
        type: 'response.completed',
        response: {
          ...emptyResponse('resp_failed_continuation'),
          output: [rootFinal],
        },
      },
    ]);
    const model = new TestHostedMultiAgentModel(fakeWebSocket);

    const first = await withTestTrace(() => model.getResponse(request()));
    const second = await withTestTrace(() =>
      model.getResponse(
        request({
          input: [
            ...first.output,
            {
              type: 'function_call_result',
              callId: 'call_failed_alpha',
              output: 'alpha result',
              status: 'completed',
            },
          ],
        }),
      ),
    );
    expect(second.output.map((item) => (item as any).callId)).toEqual([
      'call_failed_beta',
    ]);

    const third = await withTestTrace(() =>
      model.getResponse(
        request({
          input: [
            ...second.output,
            {
              type: 'function_call_result',
              callId: 'call_failed_beta',
              output: 'beta result',
              status: 'completed',
            },
          ],
        }),
      ),
    );

    expect(fakeWebSocket.sent[2]).toMatchObject({
      type: 'response.create',
      previous_response_id: 'resp_failed_parallel',
      input: [
        alphaOutput,
        expect.objectContaining({
          type: 'function_call_output',
          call_id: 'call_failed_beta',
          output: 'beta result',
        }),
      ],
    });
    expect(third.output[0]?.type).toBe('message');
  });

  it.each([false, true])(
    'continues with response.create when injection loses the completion race (stream: %s)',
    async (stream) => {
      const functionCall = {
        type: 'function_call',
        id: 'fc_race',
        call_id: 'call_race',
        name: 'lookup',
        arguments: '{}',
        status: 'completed',
        agent: { agent_name: '/root/researcher' },
      };
      const rootFinal = {
        type: 'message',
        id: 'msg_after_race',
        role: 'assistant',
        status: 'completed',
        phase: 'final_answer',
        agent: { agent_name: '/root' },
        content: [{ type: 'output_text', text: 'Recovered.' }],
      };
      const failedInput = {
        type: 'function_call_output',
        call_id: 'call_race',
        output: 'result',
      };
      const fakeWebSocket = new FakeResponsesWebSocket([
        { type: 'response.created', response: emptyResponse('resp_race') },
        { type: 'response.output_item.done', item: functionCall },
        { type: 'response.completed', response: emptyResponse('resp_race') },
        {
          type: 'response.inject.failed',
          response_id: 'resp_race',
          input: [failedInput],
          error: {
            code: 'response_already_completed',
            message: 'Already completed.',
          },
        },
        { type: 'response.created', response: emptyResponse('resp_fallback') },
        {
          type: 'response.completed',
          response: {
            ...emptyResponse('resp_fallback'),
            output: [rootFinal],
          },
        },
      ]);
      const model = new TestHostedMultiAgentModel(fakeWebSocket);
      const first = await getTestResponse(model, request(), stream);

      const second = await getTestResponse(
        model,
        request({
          input: [
            ...first.output,
            {
              type: 'function_call_result',
              callId: 'call_race',
              output: 'result',
              status: 'completed',
            },
          ],
        }),
        stream,
      );

      expect(fakeWebSocket.sent[2]).toMatchObject({
        type: 'response.create',
        previous_response_id: 'resp_race',
        input: [failedInput],
      });
      expect(second.output[0]?.type).toBe('message');
      expect(second.usage).toMatchObject({
        requests: 2,
        inputTokens: 2,
        outputTokens: 2,
        totalTokens: 4,
      });
      expect(second.usage.requestUsageEntries).toHaveLength(2);
    },
  );

  it.each([
    { stream: false, storedBaseResponseId: undefined },
    { stream: true, storedBaseResponseId: undefined },
    { stream: false, storedBaseResponseId: 'resp_stored_base' },
  ])(
    'replays stateless history after an injection race (stream: $stream, stored base: $storedBaseResponseId)',
    async ({ stream, storedBaseResponseId }) => {
      const functionCall = {
        type: 'function_call',
        id: 'fc_stateless_race',
        call_id: 'call_stateless_race',
        name: 'lookup',
        arguments: '{}',
        status: 'completed',
        agent: { agent_name: '/root/researcher' },
      };
      const failedInput = {
        type: 'function_call_output',
        call_id: 'call_stateless_race',
        output: 'result',
      };
      const fakeWebSocket = new FakeResponsesWebSocket([
        {
          type: 'response.created',
          response: { ...emptyResponse('resp_stateless_race'), store: false },
        },
        { type: 'response.output_item.done', item: functionCall },
        {
          type: 'response.completed',
          response: {
            ...emptyResponse('resp_stateless_race'),
            store: false,
            output: [functionCall],
          },
        },
        {
          type: 'response.inject.failed',
          response_id: 'resp_stateless_race',
          input: [failedInput],
          error: {
            code: 'response_already_completed',
            message: 'Already completed.',
          },
        },
        {
          type: 'response.created',
          response: {
            ...emptyResponse('resp_stateless_fallback'),
            store: false,
          },
        },
        {
          type: 'response.completed',
          response: {
            ...emptyResponse('resp_stateless_fallback'),
            store: false,
          },
        },
      ]);
      const model = new TestHostedMultiAgentModel(fakeWebSocket);
      const first = await getTestResponse(
        model,
        request({
          previousResponseId: storedBaseResponseId,
          modelSettings: { store: false },
        }),
        stream,
      );

      await getTestResponse(
        model,
        request({
          previousResponseId: storedBaseResponseId
            ? 'resp_stateless_race'
            : undefined,
          modelSettings: { store: false },
          input: [
            ...first.output,
            {
              type: 'function_call_result',
              callId: 'call_stateless_race',
              output: 'result',
              status: 'completed',
            },
          ],
        }),
        stream,
      );

      expect(fakeWebSocket.sent[2]).toMatchObject({
        type: 'response.create',
        store: false,
        input: [
          ...(fakeWebSocket.sent[0].input as Array<Record<string, any>>),
          functionCall,
          failedInput,
        ],
      });
      if (storedBaseResponseId) {
        expect(fakeWebSocket.sent[2]).toHaveProperty(
          'previous_response_id',
          storedBaseResponseId,
        );
      } else {
        expect(fakeWebSocket.sent[2]).not.toHaveProperty(
          'previous_response_id',
        );
      }
    },
  );

  it('keeps conversation continuation mutually exclusive with previous_response_id', async () => {
    const functionCall = {
      type: 'function_call',
      id: 'fc_conversation_race',
      call_id: 'call_conversation_race',
      name: 'lookup',
      arguments: '{}',
      status: 'completed',
      agent: { agent_name: '/root/researcher' },
    };
    const failedInput = {
      type: 'function_call_output',
      call_id: 'call_conversation_race',
      output: 'result',
    };
    const fakeWebSocket = new FakeResponsesWebSocket([
      {
        type: 'response.created',
        response: emptyResponse('resp_conversation_race'),
      },
      { type: 'response.output_item.done', item: functionCall },
      {
        type: 'response.completed',
        response: emptyResponse('resp_conversation_race'),
      },
      {
        type: 'response.inject.failed',
        response_id: 'resp_conversation_race',
        input: [failedInput],
        error: {
          code: 'response_already_completed',
          message: 'Already completed.',
        },
      },
      {
        type: 'response.created',
        response: emptyResponse('resp_conversation_fallback'),
      },
      {
        type: 'response.completed',
        response: emptyResponse('resp_conversation_fallback'),
      },
    ]);
    const model = new TestHostedMultiAgentModel(fakeWebSocket);
    const first = await withTestTrace(() =>
      model.getResponse(request({ conversationId: 'conv_test' })),
    );

    await withTestTrace(() =>
      model.getResponse(
        request({
          conversationId: 'conv_test',
          input: [
            ...first.output,
            {
              type: 'function_call_result',
              callId: 'call_conversation_race',
              output: 'result',
              status: 'completed',
            },
          ],
        }),
      ),
    );

    expect(fakeWebSocket.sent[2]).toMatchObject({
      type: 'response.create',
      conversation: 'conv_test',
      input: [failedInput],
    });
    expect(fakeWebSocket.sent[2]).not.toHaveProperty('previous_response_id');
  });

  it.each([
    {
      name: 'SDK handoffs',
      override: { handoffs: [{ toolName: 'transfer' }] },
      message: /does not support SDK handoffs/,
    },
    {
      name: 'reasoning summaries',
      override: { modelSettings: { reasoning: { summary: 'auto' } } },
      message: /does not support reasoning\.summary/,
    },
    {
      name: 'max tool calls',
      override: { modelSettings: { providerData: { max_tool_calls: 2 } } },
      message: /does not support max_tool_calls/,
    },
  ])('rejects $name before network I/O', async ({ override, message }) => {
    const fakeWebSocket = new FakeResponsesWebSocket([]);
    const model = new TestHostedMultiAgentModel(fakeWebSocket);

    await expect(
      withTestTrace(() => model.getResponse(request(override))),
    ).rejects.toThrow(message);
    expect(fakeWebSocket.sent).toHaveLength(0);
  });

  it('allows a server-side compaction threshold over WebSocket', async () => {
    const fakeWebSocket = new FakeResponsesWebSocket([
      { type: 'response.created', response: emptyResponse() },
      { type: 'response.completed', response: emptyResponse() },
    ]);
    const model = new TestHostedMultiAgentModel(fakeWebSocket);

    await withTestTrace(() =>
      model.getResponse(
        request({
          modelSettings: {
            contextManagement: [
              { type: 'compaction', compactThreshold: 200_000 },
            ],
          },
        }),
      ),
    );

    expect(fakeWebSocket.sent[0]?.context_management).toEqual([
      { type: 'compaction', compact_threshold: 200_000 },
    ]);
  });

  it.each([
    ['response.incomplete', 'incomplete', false],
    ['response.incomplete', 'incomplete', true],
    ['response.failed', 'failed', false],
    ['response.failed', 'failed', true],
    ['response.error', 'failed', false],
    ['response.error', 'failed', true],
  ] as const)(
    'preserves terminal hosted response %s (status: %s, stream: %s)',
    async (terminalEventType, expectedStatus, stream) => {
      const rootFinal = {
        type: 'message',
        id: 'msg_terminal',
        role: 'assistant',
        status: 'completed',
        phase: 'final_answer',
        agent: { agent_name: '/root' },
        content: [{ type: 'output_text', text: 'Partial answer.' }],
      };
      const fakeWebSocket = new FakeResponsesWebSocket([
        {
          type: 'response.created',
          response: emptyResponse('resp_terminal'),
        },
        {
          type: terminalEventType,
          response: {
            ...emptyResponse('resp_terminal'),
            status: expectedStatus,
            output: [rootFinal],
            usage: {
              input_tokens: 3,
              output_tokens: 4,
              total_tokens: 7,
            },
            ...(terminalEventType === 'response.incomplete'
              ? { incomplete_details: { reason: 'max_output_tokens' } }
              : {}),
          },
        },
      ]);
      const model = new TestHostedMultiAgentModel(fakeWebSocket);

      const response = await getTestResponse(model, request(), stream);

      expect(response.responseId ?? response.id).toBe('resp_terminal');
      expect(response.providerData.status).toBe(expectedStatus);
      expect(response.output).toHaveLength(1);
      expect(response.usage).toMatchObject({
        requests: 1,
        inputTokens: 3,
        outputTokens: 4,
        totalTokens: 7,
      });
      if (terminalEventType === 'response.incomplete') {
        expect(response.providerData.incomplete_details).toEqual({
          reason: 'max_output_tokens',
        });
      }
    },
  );

  it.each([false, true])(
    'throws standalone hosted WebSocket error events (stream: %s)',
    async (stream) => {
      const fakeWebSocket = new FakeResponsesWebSocket([
        {
          type: 'error',
          code: 'server_error',
          message: 'Something went wrong.',
          param: null,
        },
      ]);
      const model = new TestHostedMultiAgentModel(fakeWebSocket);

      await expect(getTestResponse(model, request(), stream)).rejects.toThrow(
        /Hosted Multi-agent WebSocket response failed/,
      );
    },
  );

  it('marks a non-streaming turn unsafe to replay after consuming a WebSocket event', async () => {
    const socketError = new Error('WebSocket read failed.');
    const fakeWebSocket = new FakeResponsesWebSocket([
      { type: 'response.created', response: emptyResponse('resp_started') },
      socketError,
    ]);
    const model = new TestHostedMultiAgentModel(fakeWebSocket);

    let error: (Error & { unsafeToReplay?: boolean }) | undefined;
    try {
      await withTestTrace(() => model.getResponse(request()));
    } catch (caught) {
      error = caught as Error & { unsafeToReplay?: boolean };
    }

    expect(error).toBe(socketError);
    expect(error?.unsafeToReplay).toBe(true);
    expect(
      model.getRetryAdvice({
        error,
        request: request(),
        stream: false,
        attempt: 1,
      }),
    ).toMatchObject({ suggested: false, replaySafety: 'unsafe' });
    expect(fakeWebSocket.close).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    'keeps a pre-open close with an unsent request safe to retry (stream: %s)',
    async (stream) => {
      const fakeWebSocket = new FakeResponsesWebSocket([]);
      fakeWebSocket.socket.readyState = 0;
      fakeWebSocket.queueTransportEvent({ type: 'connecting' });
      fakeWebSocket.queueTransportEvent({
        type: 'close',
        code: 1006,
        reason: 'Connection failed.',
        unsent: [
          {
            type: 'message',
            message: { type: 'response.create' },
          },
        ],
      });
      const model = new TestHostedMultiAgentModel(fakeWebSocket);

      let error: (Error & { unsafeToReplay?: boolean }) | undefined;
      try {
        await getTestResponse(model, request(), stream);
      } catch (caught) {
        error = caught as Error & { unsafeToReplay?: boolean };
      }

      expect(error).toBeInstanceOf(Error);
      expect(error?.unsafeToReplay).toBeUndefined();
      const retryAdvice = model.getRetryAdvice({
        error,
        request: request(),
        stream,
        attempt: 1,
      });
      expect(retryAdvice?.replaySafety).not.toBe('unsafe');
      expect(fakeWebSocket.close).toHaveBeenCalledOnce();
    },
  );

  it('keeps stable Responses requests free of hosted beta fields', async () => {
    const stableCreate = vi.fn().mockResolvedValue(emptyResponse());
    const client = {
      responses: { create: stableCreate },
    } as unknown as OpenAI;

    await withTestTrace(() =>
      new OpenAIResponsesModel(client, 'gpt-test').getResponse(request()),
    );

    expect(stableCreate.mock.calls[0]?.[0]).not.toHaveProperty('multi_agent');
    expect(stableCreate.mock.calls[0]?.[0]).not.toHaveProperty('betas');
  });

  it('filters streamed text to the root final message and keeps raw events', async () => {
    const reasoning = {
      type: 'reasoning',
      id: 'reasoning_root',
      summary: [],
      encrypted_content: 'encrypted-reasoning',
    };
    const subagentMessage = {
      type: 'message',
      id: 'msg_sub',
      role: 'assistant',
      status: 'completed',
      phase: 'commentary',
      agent: { agent_name: '/root/researcher' },
      content: [{ type: 'output_text', text: 'Hidden subagent text.' }],
    };
    const rootFinal = {
      type: 'message',
      id: 'msg_final',
      role: 'assistant',
      status: 'completed',
      phase: 'final_answer',
      agent: { agent_name: '/root' },
      content: [{ type: 'output_text', text: 'Root final.' }],
    };
    const fakeWebSocket = new FakeResponsesWebSocket([
      { type: 'response.created', response: emptyResponse('resp_stream') },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: subagentMessage,
        agent: { agent_name: '/root/researcher' },
      },
      {
        type: 'response.output_text.delta',
        output_index: 0,
        delta: 'Hidden subagent text.',
        agent: { agent_name: '/root/researcher' },
      },
      {
        type: 'response.output_item.added',
        output_index: 1,
        item: rootFinal,
        agent: { agent_name: '/root' },
      },
      {
        type: 'response.output_text.delta',
        output_index: 1,
        delta: 'Root final.',
      },
      {
        type: 'response.completed',
        response: {
          ...emptyResponse('resp_stream'),
          output: [reasoning, subagentMessage, rootFinal],
        },
      },
    ]);
    const model = new TestHostedMultiAgentModel(fakeWebSocket);

    const outputEvents = [];
    for await (const event of model.getStreamedResponse(request())) {
      outputEvents.push(event);
    }

    expect(
      outputEvents
        .filter((event) => event.type === 'output_text_delta')
        .map((event) => event.delta),
    ).toEqual(['Root final.']);
    expect(
      outputEvents.some(
        (event) =>
          event.type === 'model' &&
          event.event.type === 'response.output_item.added' &&
          event.event.item?.id === 'msg_sub',
      ),
    ).toBe(true);
    const done = outputEvents.find((event) => event.type === 'response_done');
    expect(done?.response.output.map((item) => item.type)).toEqual([
      'reasoning',
      'message',
    ]);
  });

  it('closes the owned WebSocket explicitly', async () => {
    const fakeWebSocket = new FakeResponsesWebSocket([
      { type: 'response.created', response: emptyResponse() },
      { type: 'response.completed', response: emptyResponse() },
    ]);
    const model = new TestHostedMultiAgentModel(fakeWebSocket);
    await withTestTrace(() => model.getResponse(request()));

    await model.close();

    expect(fakeWebSocket.close).toHaveBeenCalledTimes(1);
  });
});

describe('getHostedAgentMetadata', () => {
  it('reads raw and tool-call details attribution', () => {
    expect(
      getHostedAgentMetadata({
        type: 'message',
        agent: { agent_name: '/root/researcher' },
        phase: 'commentary',
      }),
    ).toEqual({ agentName: '/root/researcher', phase: 'commentary' });

    expect(
      getHostedAgentMetadata({
        toolCall: {
          type: 'function_call',
          providerData: {
            agent: { agent_name: '/root/reviewer' },
          },
        },
      }),
    ).toEqual({ agentName: '/root/reviewer' });
  });
});
