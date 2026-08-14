import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent, run, tool, Usage } from '../../src';
import type { ModelRequest, ModelResponse } from '../../src/model';
import type { StreamEvent } from '../../src/types/protocol';
import {
  InvalidScriptedModelStepError,
  ScriptedModel,
  ScriptedModelRequestAbortedError,
  assistantMessage,
  functionCall,
  modelError,
  modelResponder,
  modelResponse,
  modelStream,
  modelStreamResponder,
  type RecordedModelCall,
} from '../../src/testing';

describe('ScriptedModel', () => {
  it('drives a multi-turn tool workflow and records calls', async () => {
    const weather = tool({
      name: 'get_weather',
      description: 'Gets the weather.',
      parameters: z.object({ city: z.string() }),
      execute: async ({ city }) => `${city}: sunny`,
    });
    const model = new ScriptedModel([
      modelResponse([
        functionCall('get_weather', { city: 'Tokyo' }, { callId: 'call_1' }),
      ]),
      modelResponse([assistantMessage('It is sunny.')]),
    ]);
    const agent = new Agent({
      name: 'Weather assistant',
      model,
      tools: [weather],
    });

    const result = await run(agent, 'Weather in Tokyo?');

    expect(result.finalOutput).toBe('It is sunny.');
    expect(model.calls).toHaveLength(2);
    expect(model.firstCall).toMatchObject({
      index: 0,
      streamed: false,
      request: {
        input: [
          {
            type: 'message',
            role: 'user',
            content: 'Weather in Tokyo?',
          },
        ],
      },
    });
    expect(model.lastCall?.request.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'function_call_result' }),
      ]),
    );
    expect(model.remainingSteps).toBe(0);
    expect(() => model.assertComplete()).not.toThrow();
  });

  it('derives a response from the recorded call', async () => {
    const model = new ScriptedModel([
      modelResponder(async (call) => {
        await Promise.resolve();
        return [
          assistantMessage(`call ${call.index}: ${String(call.request.input)}`),
        ];
      }),
    ]);

    const response = await model.getResponse(makeRequest('hello'));

    expect(response.output).toEqual([assistantMessage('call 0: hello')]);
    expect(response.responseId).toBe('scripted-response-1');
  });

  it('records request collections and model settings at call time', async () => {
    class RuntimeToken {}
    const policy = () => true;
    const controller = new AbortController();
    const input = [
      { type: 'message', role: 'user', content: 'hello' },
    ] as const;
    const reasoning: NonNullable<ModelRequest['modelSettings']['reasoning']> = {
      effort: 'high',
    };
    const cycle: { value: number; self?: unknown } = { value: 1 };
    cycle.self = cycle;
    const runtimeToken = new RuntimeToken();
    const bytes = new Uint8Array([1, 2, 3]);
    const ownProto = JSON.parse('{"__proto__":{"value":"snapshot"}}') as Record<
      string,
      unknown
    >;
    const providerData = {
      nested: { value: 1 },
      cycle,
      aliases: [cycle],
      runtimeToken,
      bytes,
      buffer: bytes.buffer,
      ownProto,
    };
    const backoff = { initialDelayMs: 10 };
    const serializedTool: ModelRequest['tools'][number] = {
      type: 'function',
      name: 'test_tool',
      description: 'A test tool.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      strict: true,
    };
    const serializedHandoff: ModelRequest['handoffs'][number] = {
      toolName: 'transfer_to_test',
      toolDescription: 'Transfer to the test agent.',
      inputJsonSchema: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      strictJsonSchema: true,
    };
    const modelSettings: ModelRequest['modelSettings'] = {
      reasoning,
      providerData,
      retry: {
        maxRetries: 1,
        backoff,
        policy,
      },
    };
    const request: ModelRequest = {
      ...makeRequest('unused'),
      input: [...input],
      modelSettings,
      tools: [serializedTool],
      handoffs: [serializedHandoff],
      signal: controller.signal,
    };
    const model = new ScriptedModel([[assistantMessage('done')]]);

    await model.getResponse(request);
    request.input = [];
    request.tools = [];
    request.handoffs = [];
    reasoning.effort = 'low';
    providerData.nested.value = 2;
    cycle.value = 2;
    backoff.initialDelayMs = 20;
    bytes[0] = 9;

    expect(model.firstCall?.request.input).toEqual(input);
    expect(model.firstCall?.request.modelSettings).toMatchObject({
      reasoning: { effort: 'high' },
      providerData: { nested: { value: 1 } },
      retry: { maxRetries: 1, backoff: { initialDelayMs: 10 } },
    });
    expect(model.firstCall?.request.modelSettings.retry?.policy).toBe(policy);
    expect(model.firstCall?.request.modelSettings).not.toBe(modelSettings);
    const recordedProviderData = model.firstCall?.request.modelSettings
      .providerData as typeof providerData;
    expect(recordedProviderData.cycle.value).toBe(1);
    expect(recordedProviderData.cycle.self).toBe(recordedProviderData.cycle);
    expect(recordedProviderData.aliases[0]).toBe(recordedProviderData.cycle);
    expect(recordedProviderData.runtimeToken).toBe(runtimeToken);
    expect(recordedProviderData.bytes).not.toBe(bytes);
    expect(recordedProviderData.bytes[0]).toBe(1);
    expect(recordedProviderData.bytes.buffer).toBe(recordedProviderData.buffer);
    expect(Object.getPrototypeOf(recordedProviderData.ownProto)).toBe(
      Object.prototype,
    );
    expect(
      Object.prototype.hasOwnProperty.call(
        recordedProviderData.ownProto,
        '__proto__',
      ),
    ).toBe(true);
    expect(recordedProviderData.ownProto.__proto__).toEqual({
      value: 'snapshot',
    });
    expect(model.firstCall?.request.tools[0]).not.toBe(serializedTool);
    expect(model.firstCall?.request.tools[0]).toStrictEqual(serializedTool);
    expect(model.firstCall?.request.handoffs[0]).not.toBe(serializedHandoff);
    expect(model.firstCall?.request.handoffs[0]).toStrictEqual(
      serializedHandoff,
    );
    expect(model.firstCall?.request.signal).toBe(controller.signal);
  });

  it('detaches plain model settings from another JavaScript realm', async () => {
    const providerData = runInNewContext(`
      (() => {
        class RuntimeToken {
          value = 'identity';
        }
        const buffer = new ArrayBuffer(8);
        const view = new DataView(buffer, 2, 3);
        view.setUint8(0, 7);
        return {
          nested: { value: 1 },
          runtimeToken: new RuntimeToken(),
          view,
        };
      })()
    `) as {
      nested: { value: number };
      runtimeToken: object;
      view: DataView;
    };
    const runtimeToken = providerData.runtimeToken;
    const model = new ScriptedModel([[assistantMessage('done')]]);

    await model.getResponse(makeRequest('hello', undefined, { providerData }));
    providerData.nested.value = 2;
    providerData.view.setUint8(0, 8);

    const recordedProviderData = model.firstCall?.request.modelSettings
      .providerData as typeof providerData;
    expect(recordedProviderData).not.toBe(providerData);
    expect(recordedProviderData.nested).not.toBe(providerData.nested);
    expect(recordedProviderData.nested.value).toBe(1);
    expect(recordedProviderData.runtimeToken).toBe(runtimeToken);
    expect(recordedProviderData.view).not.toBe(providerData.view);
    expect(recordedProviderData.view.byteOffset).toBe(2);
    expect(recordedProviderData.view.byteLength).toBe(3);
    expect(recordedProviderData.view.getUint8(0)).toBe(7);
  });

  it('isolates canonical call history from responder and accessor mutations', async () => {
    const providerData = {
      nested: { value: 1 },
      bytes: new Uint8Array([1, 2, 3]),
    };
    const model = new ScriptedModel([
      modelResponder((call) => {
        const exposed = call.request.modelSettings
          .providerData as typeof providerData;
        exposed.nested.value = 9;
        exposed.bytes[0] = 9;
        return [];
      }),
    ]);

    await model.getResponse(makeRequest('hello', undefined, { providerData }));

    const exposedCalls = [
      model.calls[0],
      model.firstCall,
      model.lastCall,
    ] as RecordedModelCall[];
    for (const call of exposedCalls) {
      const exposed = call.request.modelSettings
        .providerData as typeof providerData;
      exposed.nested.value = 8;
      exposed.bytes[0] = 8;
    }

    for (const call of [model.calls[0], model.firstCall, model.lastCall]) {
      const recorded = call?.request.modelSettings
        .providerData as typeof providerData;
      expect(recorded.nested.value).toBe(1);
      expect(recorded.bytes[0]).toBe(1);
    }
  });

  it('snapshots a complete non-streaming response when it is queued', async () => {
    const response = {
      output: [assistantMessage('hello')],
      usage: new Usage({
        requests: 1,
        inputTokensDetails: [{ cachedTokens: 2 }],
      }),
      providerData: { nested: { value: 1 } },
    };
    const model = new ScriptedModel([modelResponse(response)]);

    response.output[0] = assistantMessage('mutated');
    response.usage.inputTokensDetails[0].cachedTokens = 9;
    response.providerData.nested.value = 9;

    const result = await model.getResponse(makeRequest('hello'));

    expect(result).not.toBe(response);
    expect(result.output).toEqual([assistantMessage('hello')]);
    expect(result.usage.inputTokensDetails[0].cachedTokens).toBe(2);
    expect(result.providerData).toEqual({ nested: { value: 1 } });
  });

  it('accepts direct responses in the constructor and enqueue', async () => {
    const completeResponse = {
      output: [assistantMessage('first')],
      usage: new Usage(),
      responseId: 'response_1',
      providerData: { source: 'test' },
    };
    const output = [assistantMessage('second')];
    const model = new ScriptedModel([completeResponse]);
    model.enqueue(output);

    await expect(
      model.getResponse(makeRequest('first')),
    ).resolves.toMatchObject(completeResponse);
    await expect(
      model.getResponse(makeRequest('second')),
    ).resolves.toMatchObject({
      output,
      usage: { requests: 1 },
      responseId: 'scripted-response-2',
    });
    expect(() => model.assertComplete()).not.toThrow();
  });

  it('preserves explicit zero usage and fills omitted shorthand usage', async () => {
    const explicitUsage = new Usage({ requests: 0 });
    const completeResponse = {
      output: [assistantMessage('explicit')],
      usage: explicitUsage,
    };
    const model = new ScriptedModel([
      completeResponse,
      [assistantMessage('shorthand')],
    ]);

    await expect(
      model.getResponse(makeRequest('explicit')),
    ).resolves.toMatchObject(completeResponse);
    await expect(
      model.getResponse(makeRequest('shorthand')),
    ).resolves.toMatchObject({ usage: { requests: 1 } });
  });

  it('gates and snapshots raw usage across run modes', async () => {
    for (const streamed of [false, true]) {
      const rawUsage = { provider: { inputTokens: 3 } };
      const response = {
        output: [assistantMessage('hello')],
        usage: new Usage({ requests: 1 }),
        responseId: 'response_1',
        rawUsage,
      };
      const model = new ScriptedModel([response, response]);
      const disabledRequest = makeRequest('disabled', undefined, {
        preserveRawUsage: false,
      });
      const enabledRequest = makeRequest('enabled', undefined, {
        preserveRawUsage: true,
      });

      const disabled = streamed
        ? getCompletedResponse(
            await collectEvents(model.getStreamedResponse(disabledRequest)),
          )
        : await model.getResponse(disabledRequest);
      const enabled = streamed
        ? getCompletedResponse(
            await collectEvents(model.getStreamedResponse(enabledRequest)),
          )
        : await model.getResponse(enabledRequest);

      expect(disabled.rawUsage).toBeUndefined();
      expect(enabled.rawUsage).toEqual({ provider: { inputTokens: 3 } });
      expect(enabled.rawUsage).not.toBe(rawUsage);
      rawUsage.provider.inputTokens = 99;
      expect(enabled.rawUsage).toEqual({ provider: { inputTokens: 3 } });
    }
  });

  it('uses call-time raw usage settings after an async response', async () => {
    for (const streamed of [false, true]) {
      for (const [initial, mutated] of [
        [false, true],
        [true, false],
      ] as const) {
        let release!: () => void;
        let markStarted!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const started = new Promise<void>((resolve) => {
          markStarted = resolve;
        });
        const rawUsage = { provider: { inputTokens: 3 } };
        const model = new ScriptedModel([
          modelResponder(async () => {
            markStarted();
            await gate;
            return {
              output: [assistantMessage('hello')],
              usage: new Usage({ requests: 1 }),
              rawUsage,
            };
          }),
        ]);
        const request = makeRequest('hello', undefined, {
          preserveRawUsage: initial,
        });

        const pending = streamed
          ? collectEvents(model.getStreamedResponse(request))
          : model.getResponse(request);
        await started;
        request.modelSettings.preserveRawUsage = mutated;
        release();
        const result = await pending;
        const response = streamed
          ? getCompletedResponse(result as StreamEvent[])
          : (result as ModelResponse);

        expect(response.rawUsage).toEqual(initial ? rawUsage : undefined);
        if (initial) {
          expect(response.rawUsage).not.toBe(rawUsage);
        }
      }
    }
  });

  it('omits a throwing raw usage accessor without leaking its error', async () => {
    for (const streamed of [false, true]) {
      for (const preserveRawUsage of [false, true]) {
        const response: ModelResponse = {
          output: [assistantMessage('hello')],
          usage: new Usage({ requests: 1 }),
        };
        Object.defineProperty(response, 'rawUsage', {
          enumerable: true,
          get() {
            throw new Error('raw usage unavailable');
          },
        });
        const model = new ScriptedModel([response]);
        const request = makeRequest('hello', undefined, { preserveRawUsage });

        const normalized = streamed
          ? getCompletedResponse(
              await collectEvents(model.getStreamedResponse(request)),
            )
          : await model.getResponse(request);

        expect(normalized.output).toEqual([assistantMessage('hello')]);
        expect(normalized.rawUsage).toBeUndefined();
      }
    }
  });

  it('reads an enabled raw usage accessor only once', async () => {
    for (const streamed of [false, true]) {
      let reads = 0;
      const response: ModelResponse = {
        output: [assistantMessage('hello')],
        usage: new Usage({ requests: 1 }),
        responseId: 'response_1',
      };
      Object.defineProperty(response, 'rawUsage', {
        enumerable: true,
        get() {
          reads += 1;
          if (reads > 1) {
            throw new Error('raw usage read more than once');
          }
          return undefined;
        },
      });
      const model = new ScriptedModel([response]);
      const request = makeRequest('hello', undefined, {
        preserveRawUsage: true,
      });

      const normalized = streamed
        ? getCompletedResponse(
            await collectEvents(model.getStreamedResponse(request)),
          )
        : await model.getResponse(request);

      expect(reads).toBe(1);
      expect(normalized.rawUsage).toBeUndefined();
    }
  });

  it('assigns an ID when automatically streaming a response without one', async () => {
    const usage = new Usage({ requests: 0 });
    const model = new ScriptedModel([
      {
        output: [assistantMessage('hello')],
        usage,
      },
    ]);

    const completed = getCompletedResponse(
      await collectEvents(model.getStreamedResponse(makeRequest('hello'))),
    );

    expect(completed.id).toBe('scripted-response-1');
    expect(completed.usage.requests).toBe(0);
  });

  it('converts a response into normalized streaming events', async () => {
    const response = {
      output: [assistantMessage('hello', { id: 'message_1' })],
      usage: new Usage({
        requests: 1,
        inputTokens: 2,
        outputTokens: 1,
        totalTokens: 3,
      }),
      responseId: 'response_1',
      requestId: 'request_1',
      providerData: { vendor: 'metadata' },
    };
    const directModel = new ScriptedModel([modelResponse(response)]);
    const streamingModel = new ScriptedModel([
      modelResponder(async () => response),
    ]);

    const directResponse = await directModel.getResponse(makeRequest('hello'));

    const events: StreamEvent[] = [];
    for await (const event of streamingModel.getStreamedResponse(
      makeRequest('hello'),
    )) {
      events.push(event);
    }

    expect(directResponse.providerData).toEqual({ vendor: 'metadata' });
    expect(events).toEqual([
      { type: 'response_started' },
      {
        type: 'output_text_delta',
        itemId: 'message_1',
        delta: 'hello',
      },
      expect.objectContaining({
        type: 'response_done',
        response: expect.objectContaining({
          id: 'response_1',
          requestId: 'request_1',
          usage: expect.objectContaining({ totalTokens: 3 }),
          providerData: { vendor: 'metadata' },
        }),
      }),
    ]);
    expect(streamingModel.lastCall?.streamed).toBe(true);
  });

  it('detaches automatic stream events from later events', async () => {
    const model = new ScriptedModel([
      modelResponse([
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            {
              type: 'output_text',
              text: 'hello',
              providerData: { nested: { value: 1 } },
            },
          ],
        },
      ]),
    ]);
    const iterator = model
      .getStreamedResponse(makeRequest('hello'))
      [Symbol.asyncIterator]();

    await iterator.next();
    const delta = await iterator.next();
    if (
      delta.done ||
      delta.value.type !== 'output_text_delta' ||
      !delta.value.providerData
    ) {
      throw new Error('Expected an output text delta with provider data.');
    }
    (delta.value.providerData.nested as { value: number }).value = 99;

    const completed = await iterator.next();
    if (completed.done || completed.value.type !== 'response_done') {
      throw new Error('Expected a completed response.');
    }
    const output = completed.value.response.output[0];
    if (
      output?.type !== 'message' ||
      output.content[0]?.type !== 'output_text'
    ) {
      throw new Error('Expected an assistant output text item.');
    }

    expect(output.content[0].providerData).toEqual({ nested: { value: 1 } });
  });

  it('checks abort signals before every automatic stream event', async () => {
    const controller = new AbortController();
    const model = new ScriptedModel([
      modelResponse([
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            { type: 'output_text', text: 'first' },
            { type: 'output_text', text: 'second' },
          ],
        },
      ]),
    ]);
    const iterator = model
      .getStreamedResponse(makeRequest('hello', controller.signal))
      [Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { type: 'response_started' },
    });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: {
        type: 'output_text_delta',
        delta: 'first',
      },
    });

    controller.abort();

    await expect(iterator.next()).rejects.toMatchObject({
      name: 'AbortError',
      callIndex: 0,
    });
  });

  it.each([
    { name: 'non-streaming', streamed: false },
    { name: 'streaming', streamed: true },
  ])(
    'rechecks abort after $name response normalization',
    async ({ streamed }) => {
      const controller = new AbortController();
      const response: ModelResponse = {
        output: [assistantMessage('done')],
        usage: new Usage(),
      };
      Object.defineProperty(response, 'rawUsage', {
        enumerable: true,
        get() {
          controller.abort();
          return { provider: 'test' };
        },
      });
      const model = new ScriptedModel([modelResponse(response)]);
      const request = makeRequest('hello', controller.signal, {
        preserveRawUsage: true,
      });

      const result = streamed
        ? collectEvents(model.getStreamedResponse(request))
        : model.getResponse(request);

      await expect(result).rejects.toMatchObject({
        name: 'AbortError',
        callIndex: 0,
      });
    },
  );

  it('assigns streamed steps and records calls in invocation order', async () => {
    const model = new ScriptedModel([
      modelResponse([assistantMessage('first')]),
      modelResponse([assistantMessage('second')]),
    ]);
    const firstStream = model.getStreamedResponse(makeRequest('first call'));
    const secondStream = model.getStreamedResponse(makeRequest('second call'));

    expect(model.calls.map((call) => call.request.input)).toEqual([
      'first call',
      'second call',
    ]);
    expect(model.remainingSteps).toBe(0);

    const secondEvents = await collectEvents(secondStream);
    const firstEvents = await collectEvents(firstStream);

    expect(getStreamText(firstEvents)).toBe('first');
    expect(getStreamText(secondEvents)).toBe('second');
  });

  it('passes through a raw normalized stream', async () => {
    const events: StreamEvent[] = [
      { type: 'output_text_delta', delta: 'custom' },
      {
        type: 'response_done',
        response: {
          id: 'custom_response',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          output: [assistantMessage('custom')],
        },
      } as StreamEvent,
    ];
    const model = new ScriptedModel([modelStream(events)]);
    events[0] = { type: 'output_text_delta', delta: 'mutated' };
    const done = events[1] as Extract<StreamEvent, { type: 'response_done' }>;
    done.response.output = [assistantMessage('mutated')];

    const received: StreamEvent[] = [];
    for await (const event of model.getStreamedResponse(makeRequest('hello'))) {
      received.push(event);
    }

    expect(received).toEqual([
      { type: 'output_text_delta', delta: 'custom' },
      {
        type: 'response_done',
        response: {
          id: 'custom_response',
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          output: [assistantMessage('custom')],
        },
      },
    ]);
  });

  it('derives a raw normalized stream from the recorded call', async () => {
    const model = new ScriptedModel([
      modelStreamResponder(async (call) => {
        await Promise.resolve();
        return (async function* () {
          yield {
            type: 'output_text_delta',
            delta: `${call.index}:${String(call.request.input)}`,
          } satisfies StreamEvent;
          yield {
            type: 'response_done',
            response: {
              id: 'dynamic-stream',
              usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
              output: [assistantMessage('done')],
            },
          } as StreamEvent;
        })();
      }),
    ]);

    const events = await collectEvents(
      model.getStreamedResponse(makeRequest('hello')),
    );

    expect(events[0]).toEqual({
      type: 'output_text_delta',
      delta: '0:hello',
    });
    expect(model.firstCall).toMatchObject({ index: 0, streamed: true });
  });

  it('propagates an error and supplies scripted retry advice', async () => {
    const error = new Error('temporary failure');
    const model = new ScriptedModel([
      modelError(error, ({ attempt }) => ({
        suggested: attempt === 1,
        replaySafety: 'safe',
      })),
    ]);
    const request = makeRequest('hello');

    await expect(model.getResponse(request)).rejects.toBe(error);
    await expect(
      model.getRetryAdvice({
        request,
        error,
        stream: false,
        attempt: 1,
      }),
    ).resolves.toEqual({ suggested: true, replaySafety: 'safe' });
  });

  it('snapshots static retry advice when it is queued', async () => {
    const error = new Error('temporary failure');
    const retryAdvice = {
      suggested: true,
      replaySafety: 'safe' as const,
      normalized: { isNetworkError: true },
    };
    const model = new ScriptedModel([modelError(error, retryAdvice)]);
    const request = makeRequest('hello');

    retryAdvice.suggested = false;
    retryAdvice.normalized.isNetworkError = false;

    await expect(model.getResponse(request)).rejects.toBe(error);
    await expect(
      model.getRetryAdvice({
        request,
        error,
        stream: false,
        attempt: 1,
      }),
    ).resolves.toEqual({
      suggested: true,
      replaySafety: 'safe',
      normalized: { isNetworkError: true },
    });
  });

  it('keeps retry advice scoped to each reused error step', async () => {
    const error = new Error('shared failure');
    const nonStreamingRequest = makeRequest('non-streaming');
    const streamingRequest = makeRequest('streaming');
    const missingAdviceRequest = makeRequest('missing advice');
    const model = new ScriptedModel([
      modelError(error, { suggested: false }),
      modelError(error, { suggested: true, replaySafety: 'safe' }),
      modelError(error),
    ]);

    const nonStreamingFailure = model.getResponse(nonStreamingRequest);
    const streamingFailure = collectEvents(
      model.getStreamedResponse(streamingRequest),
    );
    const missingAdviceFailure = model.getResponse(missingAdviceRequest);
    await expect(nonStreamingFailure).rejects.toBe(error);
    await expect(streamingFailure).rejects.toBe(error);
    await expect(missingAdviceFailure).rejects.toBe(error);

    await expect(
      model.getRetryAdvice({
        request: streamingRequest,
        error,
        stream: true,
        attempt: 1,
      }),
    ).resolves.toEqual({ suggested: true, replaySafety: 'safe' });
    await expect(
      model.getRetryAdvice({
        request: nonStreamingRequest,
        error,
        stream: false,
        attempt: 1,
      }),
    ).resolves.toEqual({ suggested: false });
    await expect(
      model.getRetryAdvice({
        request: missingAdviceRequest,
        error,
        stream: false,
        attempt: 1,
      }),
    ).resolves.toBeUndefined();
  });

  it('prioritizes exact request identity for reused errors', async () => {
    const error = new Error('shared failure');
    const sharedRequest = makeRequest('shared input');
    const firstRequest = { ...sharedRequest };
    const secondRequest = { ...sharedRequest };
    const model = new ScriptedModel([
      modelError(error, { suggested: false }),
      modelError(error, { suggested: true }),
    ]);

    await Promise.allSettled([
      model.getResponse(firstRequest),
      model.getResponse(secondRequest),
    ]);

    await expect(
      model.getRetryAdvice({
        request: secondRequest,
        error,
        stream: false,
        attempt: 1,
      }),
    ).resolves.toEqual({ suggested: true });
    await expect(
      model.getRetryAdvice({
        request: firstRequest,
        error,
        stream: false,
        attempt: 1,
      }),
    ).resolves.toEqual({ suggested: false });
  });

  it('rejects raw stream steps in non-streaming mode', async () => {
    const model = new ScriptedModel([
      modelStream([]),
      modelStreamResponder(() => []),
    ]);

    await expect(model.getResponse(makeRequest('hello'))).rejects.toThrow(
      InvalidScriptedModelStepError,
    );
    await expect(model.getResponse(makeRequest('hello'))).rejects.toThrow(
      InvalidScriptedModelStepError,
    );
  });

  it('validates scripted envelopes before a model call', () => {
    expect(
      () => new ScriptedModel([{ type: 'unknown' } as never]),
    ).toThrowError(
      expect.objectContaining({
        name: 'InvalidScriptedModelStepError',
        reason: 'unknown_step_type',
        inputIndex: 0,
        stepType: 'unknown',
      }),
    );
    expect(
      () => new ScriptedModel([{ type: 'responder' } as never]),
    ).toThrowError(
      expect.objectContaining({ reason: 'missing_responder', inputIndex: 0 }),
    );
    expect(
      () =>
        new ScriptedModel([{ output: [], usage: { requests: 1 } } as never]),
    ).toThrowError(
      expect.objectContaining({ reason: 'invalid_response', inputIndex: 0 }),
    );

    const model = new ScriptedModel();
    expect(() =>
      model.enqueue(modelResponse([assistantMessage('valid')]), {
        type: 'stream',
        events: undefined,
      } as never),
    ).toThrowError(
      expect.objectContaining({ reason: 'invalid_stream', inputIndex: 1 }),
    );
    expect(model.remainingSteps).toBe(0);
  });

  it('validates responder responses with structured call details', async () => {
    const model = new ScriptedModel([
      modelResponder(() => ({ output: [], usage: {} }) as never),
    ]);

    await expect(model.getResponse(makeRequest('hello'))).rejects.toMatchObject(
      {
        name: 'InvalidScriptedModelStepError',
        reason: 'invalid_response',
        callIndex: 0,
      },
    );
  });

  it.each([
    ['synchronous', () => ({})],
    ['asynchronous', async () => ({})],
  ])(
    'validates %s stream responder results with structured call details',
    async (_kind, respond) => {
      const model = new ScriptedModel([modelStreamResponder(respond as never)]);

      await expect(
        collectEvents(model.getStreamedResponse(makeRequest('hello'))),
      ).rejects.toMatchObject({
        name: 'InvalidScriptedModelStepError',
        reason: 'invalid_stream',
        callIndex: 0,
        stepType: 'stream_responder',
      });
    },
  );

  it('keeps call history indexing private and immutable', async () => {
    const model = new ScriptedModel([modelResponse([]), modelResponse([])]);
    await model.getResponse(makeRequest('first'));

    const exposedCalls = model.calls as RecordedModelCall[];
    expect(() => exposedCalls.pop()).toThrow(TypeError);
    await model.getResponse(makeRequest('second'));

    expect(model.calls.map((call) => call.index)).toEqual([0, 1]);
  });

  it('creates provider-neutral assistant messages', () => {
    expect(assistantMessage('hello')).toEqual({
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'hello' }],
    });
  });

  it('fails on unexpected calls and unconsumed steps', async () => {
    const empty = new ScriptedModel();
    await expect(empty.getResponse(makeRequest('hello'))).rejects.toMatchObject(
      {
        name: 'UnexpectedModelCallError',
        callIndex: 0,
        streamed: false,
      },
    );

    const pending = new ScriptedModel([
      modelResponse([assistantMessage('unused')]),
    ]);
    expect(() => pending.assertComplete()).toThrowError(
      expect.objectContaining({
        name: 'UnconsumedModelStepsError',
        remainingSteps: 1,
      }),
    );
  });

  it('checks abort signals before consuming a step', async () => {
    const controller = new AbortController();
    controller.abort();
    const model = new ScriptedModel([
      modelResponse([assistantMessage('unused')]),
    ]);

    await expect(
      model.getResponse(makeRequest('hello', controller.signal)),
    ).rejects.toBeInstanceOf(ScriptedModelRequestAbortedError);
    expect(model.remainingSteps).toBe(1);
    expect(model.calls).toHaveLength(0);
  });

  it('checks abort signals before deferred stream step dispatch', async () => {
    const controller = new AbortController();
    const scriptedError = new Error('scripted failure');
    const responder = vi.fn(() => []);
    const errorModel = new ScriptedModel([modelError(scriptedError)]);
    const responderModel = new ScriptedModel([modelStreamResponder(responder)]);
    const errorStream = errorModel.getStreamedResponse(
      makeRequest('error', controller.signal),
    );
    const responderStream = responderModel.getStreamedResponse(
      makeRequest('responder', controller.signal),
    );

    controller.abort();

    await expect(collectEvents(errorStream)).rejects.toBeInstanceOf(
      ScriptedModelRequestAbortedError,
    );
    await expect(collectEvents(responderStream)).rejects.toBeInstanceOf(
      ScriptedModelRequestAbortedError,
    );
    expect(responder).not.toHaveBeenCalled();
  });

  it('rechecks abort signals after awaiting a stream responder', async () => {
    const controller = new AbortController();
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model = new ScriptedModel([
      modelStreamResponder(async () => {
        markStarted();
        await gate;
        return [];
      }),
    ]);
    const pending = collectEvents(
      model.getStreamedResponse(makeRequest('hello', controller.signal)),
    );

    await started;
    controller.abort();
    release();

    await expect(pending).rejects.toBeInstanceOf(
      ScriptedModelRequestAbortedError,
    );
  });
});

function makeRequest(
  input: string,
  signal?: AbortSignal,
  modelSettings: ModelRequest['modelSettings'] = {},
): ModelRequest {
  return {
    input,
    modelSettings,
    tools: [],
    outputType: 'text',
    handoffs: [],
    tracing: false,
    signal,
  };
}

function getCompletedResponse(events: StreamEvent[]) {
  const completed = events.find((event) => event.type === 'response_done');
  if (!completed || completed.type !== 'response_done') {
    throw new Error('Expected a completed response event.');
  }
  return completed.response;
}

async function collectEvents(
  events: AsyncIterable<StreamEvent>,
): Promise<StreamEvent[]> {
  const collected: StreamEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

function getStreamText(events: StreamEvent[]): string {
  return events
    .filter((event) => event.type === 'output_text_delta')
    .map((event) => event.delta)
    .join('');
}
